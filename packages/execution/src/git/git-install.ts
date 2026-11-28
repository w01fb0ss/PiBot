import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { findGit, type GitProcessOptions, gitEnvironment, gitSpawnError } from "./git-process.ts";

export type ProtectionPackage = "bubblewrap" | "socat";

export type GitPackageManager = "apt-get" | "dnf" | "pacman" | "zypper";

/**
 * How this computer gets Git system-wide (maintainers 2026-11-21): macOS opens Apple's own
 * Command Line Tools installer, Linux uses the distribution's package manager through polkit.
 * Windows ships MinGit in its installer, so it never installs anything here.
 */
export type GitInstallPlan =
  | { kind: "xcode"; command: string; manualCommand: string }
  | {
      kind: "package";
      manager: GitPackageManager;
      /** What runs, without the elevation prefix (shown on the card). */
      command: string;
      /** What the user can type in a terminal when the polkit prompt is unavailable. */
      manualCommand: string;
      program: string;
      args: string[];
      /** Fixed pkexec path, or absent when the computer has none. */
      elevate?: string;
    }
  | { kind: "manual" }
  | { kind: "unsupported" };

export type GitInstallOutcome =
  | { outcome: "started" | "installed"; exitCode: number | null }
  | { outcome: "denied" | "failed" | "no_elevation"; exitCode: number | null };

const MANAGERS: Record<GitPackageManager, { args: string[]; distros: string[] }> = {
  "apt-get": { args: ["install", "-y"], distros: ["debian", "ubuntu"] },
  dnf: { args: ["install", "-y"], distros: ["fedora", "rhel", "centos"] },
  pacman: { args: ["-S", "--noconfirm"], distros: ["arch"] },
  zypper: { args: ["--non-interactive", "install"], distros: ["opensuse", "suse", "sles"] },
};
const ORDER = Object.keys(MANAGERS) as GitPackageManager[];
// Fixed system locations only: a PATH lookup could pick a planted program that then runs as root.
const SYSTEM_BIN = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const XCODE_SELECT = "/usr/bin/xcode-select";
const INSTALL_TIMEOUT_MS = 20 * 60_000;

async function executable(path: string) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    // Absent is the expected answer for most candidates.
    return false;
  }
}

async function systemProgram(name: string) {
  for (const dir of SYSTEM_BIN) {
    const path = posix.join(dir, name);
    if (await executable(path)) return path;
  }
  return undefined;
}

/** ID and ID_LIKE tokens of /etc/os-release, most specific first. */
export function osReleaseFamilies(text: string) {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(ID|ID_LIKE)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined)
      fields.set(match[1], match[2].replace(/^["']|["']$/g, "").toLowerCase());
  }
  return [fields.get("ID") ?? "", ...(fields.get("ID_LIKE") ?? "").split(/\s+/)].filter((token) =>
    /^[a-z0-9._-]{1,64}$/.test(token),
  );
}

function managerFor(families: readonly string[]) {
  for (const family of families)
    for (const manager of ORDER)
      if (MANAGERS[manager].distros.some((id) => family === id || family.startsWith(`${id}-`)))
        return manager;
  return undefined;
}

/** Reads only fixed system files; never spawns. */
export async function gitInstallPlan(platform: NodeJS.Platform): Promise<GitInstallPlan> {
  if (platform === "darwin")
    return {
      kind: "xcode",
      command: "xcode-select --install",
      manualCommand: "xcode-select --install",
    };
  if (platform !== "linux") return { kind: "unsupported" };
  return systemPackageInstallPlan("git");
}

/** Both installers share the fixed system paths and distribution lookup. */
export async function systemPackageInstallPlan(
  dependency: "git" | ProtectionPackage,
): Promise<Extract<GitInstallPlan, { kind: "package" | "manual" }>> {
  const release = await readFile("/etc/os-release", "utf8").catch(() =>
    // Older systems keep it only under /usr/lib; neither existing just means no distro hint.
    readFile("/usr/lib/os-release", "utf8").catch(() => ""),
  );
  const preferred = managerFor(osReleaseFamilies(release));
  const candidates = preferred ? [preferred, ...ORDER.filter((m) => m !== preferred)] : ORDER;
  for (const manager of candidates) {
    const program = await systemProgram(manager);
    if (!program) continue;
    const args = [...MANAGERS[manager].args, dependency];
    const command = [manager, ...args].join(" ");
    const elevate = await systemProgram("pkexec");
    return {
      kind: "package",
      manager,
      command,
      manualCommand: `sudo ${command}`,
      program,
      args,
      ...(elevate ? { elevate } : {}),
    };
  }
  return { kind: "manual" };
}

/** `git --version` of a fixed executable, outside any repository; undefined when it cannot run. */
export function gitVersion(
  options: GitProcessOptions,
  program: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    let out = "";
    const child = spawn(program, ["--version"], {
      cwd: options.platform === "win32" ? win32.dirname(program) : "/",
      env: { ...gitEnvironment(options, program), GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < 256) out += chunk.toString("utf8");
    });
    // A failure to run is answered as "no version"; the caller still knows Git exists.
    child.once("error", () => resolve(undefined));
    child.once("close", (code) =>
      resolve(code === 0 ? /git version (\S{1,60})/.exec(out)?.[1] : undefined),
    );
  }).catch((error: unknown) => {
    if (signal.aborted || gitSpawnError(options.platform, error).code === "git_unavailable")
      return undefined;
    throw error;
  });
}

/**
 * Runs the system installer once, outside the sandbox: the user's click on the card is the
 * confirmation, and the caller audits it. Output is discarded (it never reaches logs).
 * macOS: xcode-select only opens Apple's installer window and returns; the caller then waits
 * for Git to appear. Linux: the package manager runs under pkexec and finishes before return.
 */
export async function runSystemInstaller(
  plan: GitInstallPlan,
  options: { platform: NodeJS.Platform; env: Readonly<NodeJS.ProcessEnv>; signal: AbortSignal },
): Promise<GitInstallOutcome> {
  if (plan.kind === "manual" || plan.kind === "unsupported")
    return { outcome: "failed", exitCode: null };
  if (plan.kind === "package" && !plan.elevate) return { outcome: "no_elevation", exitCode: null };
  const [program, args] =
    plan.kind === "xcode"
      ? [XCODE_SELECT, ["--install"]]
      : [plan.elevate as string, [plan.program, ...plan.args]];
  // pkexec's GUI agent and Apple's installer need the desktop session; nothing else is passed.
  const session = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"]
    .map((name) => [name, options.env[name]] as const)
    .filter(
      (entry): entry is readonly [string, string] => !!entry[1] && !/[\0\r\n]/.test(entry[1]),
    );
  const runtime = options.env.XDG_RUNTIME_DIR;
  const env: NodeJS.ProcessEnv = {
    PATH: SYSTEM_BIN.join(":"),
    LANG: options.env.LANG && /^[\w.@-]{1,64}$/.test(options.env.LANG) ? options.env.LANG : "C",
    ...Object.fromEntries(session),
    ...(runtime && posix.isAbsolute(runtime) ? { XDG_RUNTIME_DIR: runtime } : {}),
    ...(options.env.HOME && posix.isAbsolute(options.env.HOME) ? { HOME: options.env.HOME } : {}),
  };
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(program, args, {
      cwd: "/",
      env,
      stdio: "ignore",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(INSTALL_TIMEOUT_MS)]),
      windowsHide: true,
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  if (plan.kind === "xcode")
    // Exit 1 also covers "already installed / an update is pending": the caller's poll decides.
    return exitCode === 0 || exitCode === 1
      ? { outcome: "started", exitCode }
      : { outcome: "failed", exitCode };
  if (exitCode === 0) return { outcome: "installed", exitCode };
  // pkexec: 126 = the user dismissed the password dialog, 127 = not authorized / no agent.
  return {
    outcome: exitCode === 126 || exitCode === 127 ? "denied" : "failed",
    exitCode,
  };
}

export const runGitInstaller = runSystemInstaller;

/** Polls the fixed Git locations until one appears, the deadline passes or the signal aborts. */
export async function waitForGit(
  options: GitProcessOptions,
  input: { signal: AbortSignal; timeoutMs: number; intervalMs?: number },
) {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    if (input.signal.aborted) return undefined;
    const found = await findGit(options);
    if (found && (await gitVersion(options, found, input.signal)) && !input.signal.aborted)
      return found;
    if (input.signal.aborted || Date.now() >= deadline) return undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, input.intervalMs ?? 3000);
      function done() {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", done);
        resolve();
      }
      input.signal.addEventListener("abort", done, { once: true });
    });
  }
}
