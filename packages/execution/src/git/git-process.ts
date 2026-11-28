import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { ExecError } from "../core/types.ts";
import { bundledGit, prepareBundledGit } from "./bundled-git.ts";
import { gitPrograms } from "./git-program.ts";

/** Shared by the read-only runner and the Windows user-write path: no shell, ever. */
export interface GitProcessOptions {
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  userHome: string;
  /** Packaged app resources; on Windows the bundled MinGit there is the last Git candidate. */
  resourcesDir?: string;
  onBundledGitEvent?: (
    event: "unpack_started" | "unpack_finished" | "old_copy_removed" | "old_copy_remove_failed",
  ) => void;
}

export interface GitProcessResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
  /** Output exceeded maxBytes; stdout is empty rather than a truncated, misleading prefix. */
  overflow: boolean;
  bytes: number;
  durationMs: number;
}

export async function findGit(
  options: Pick<GitProcessOptions, "platform" | "env" | "resourcesDir" | "onBundledGitEvent">,
) {
  for (const candidate of gitPrograms(options.platform, options.env, options.resourcesDir)) {
    try {
      await access(candidate, options.platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Missing candidates are expected; the next fixed location is checked.
    }
  }
  return unpackBundledGit(options);
}

/**
 * No installed Git and no unpacked copy yet: unpack the bundled MinGit (Windows packages only).
 * A failure is the same as having no Git, so callers fall back as before (git_unavailable, take
 * turns); the next need after the failure backoff tries again.
 */
export async function unpackBundledGit(
  options: Pick<GitProcessOptions, "platform" | "env" | "resourcesDir" | "onBundledGitEvent">,
) {
  const git = bundledGit(options.platform, options.env, options.resourcesDir);
  if (!git) return undefined;
  return prepareBundledGit(git, options.onBundledGitEvent).catch(() => undefined);
}

export function gitEnvironment(options: GitProcessOptions, executable: string): NodeJS.ProcessEnv {
  const windows = options.platform === "win32";
  const paths = windows ? win32 : posix;
  const systemRoot =
    Object.entries(options.env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1] ?? "";
  const xdg = options.env.XDG_CONFIG_HOME;
  // A clean environment: no GIT_* from the host. HOME/XDG stay so Git resolves the user's config
  //. System config is kept too: it is admin-owned, and on Windows it carries core.autocrlf
  // and the LFS filter, without which every file would look modified.
  return {
    PATH: [
      paths.dirname(executable),
      ...(windows
        ? [paths.join(systemRoot, "System32")]
        : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
    ].join(paths.delimiter),
    HOME: options.userHome,
    ...(xdg && paths.isAbsolute(xdg) && !/[\0\r\n]/.test(xdg) ? { XDG_CONFIG_HOME: xdg } : {}),
    LC_ALL: "C",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    ...(windows ? { SystemRoot: systemRoot, USERPROFILE: options.userHome } : {}),
  };
}

export function killGit(options: Pick<GitProcessOptions, "platform" | "env">, child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    // Filters (e.g. git-lfs) are grandchildren; the whole group goes on POSIX.
    if (options.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else killWindowsGitTree(options.env, child);
  } catch {
    // Already exited between the check and the signal; nothing remains to release.
  }
}

/**
 * Git for Windows' fixed `cmd\git.exe` is a launcher: terminating it alone (what child.kill does)
 * leaves `mingw64\bin\git.exe` running. Measured on Windows 11 / Git 2.54: a killed `git add`
 * kept running for 30+ s holding `.git/index.lock` and the stdout pipe, so `close` (and a
 * "cancelled" commit) waited for it and the commit could still land. taskkill /T ends the tree
 * while the launcher is alive to anchor it; if taskkill cannot run, kill the launcher anyway.
 */
function killWindowsGitTree(env: Readonly<NodeJS.ProcessEnv>, child: ChildProcess) {
  const systemRoot =
    Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1] ?? "";
  if (!win32.isAbsolute(systemRoot) || /[\0\r\n]/.test(systemRoot)) {
    child.kill("SIGKILL");
    return;
  }
  const killer = spawn(
    win32.join(systemRoot, "System32", "taskkill.exe"),
    ["/PID", String(child.pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true, shell: false },
  );
  const fallback = () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  killer.once("error", fallback);
  killer.once("close", (code) => {
    if (code !== 0) fallback();
  });
}

/** Native spawn errors are the same whether delivered by throw or by the child. */
export function gitSpawnError(platform: NodeJS.Platform, error: unknown): ExecError {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return new ExecError(
    code === "ENOENT" ||
      (platform === "win32" && (code === "EACCES" || code === "EPERM" || code === "UNKNOWN"))
      ? "git_unavailable"
      : "command_failed",
  );
}

/** Runs one fixed argv with bounded output; `signal` covers both cancellation and the timeout. */
export async function spawnGit(
  options: GitProcessOptions,
  input: {
    executable: string;
    args: string[];
    cwd: string;
    signal: AbortSignal;
    cancelled: () => boolean;
    maxBytes: number;
    live?: Set<ChildProcess>;
    assertAuthorized?(): void;
  },
): Promise<GitProcessResult> {
  const { signal } = input;
  const started = performance.now();
  signal.throwIfAborted();
  input.assertAuthorized?.();
  signal.throwIfAborted();
  const child = (() => {
    try {
      return spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: gitEnvironment(options, input.executable),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        detached: options.platform !== "win32",
      });
    } catch (error) {
      throw gitSpawnError(options.platform, error);
    }
  })();
  input.live?.add(child);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (overflow) return;
    if (bytes > input.maxBytes) {
      overflow = true;
      chunks.length = 0;
      killGit(options, child);
      return;
    }
    chunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
  });
  const abort = () => killGit(options, child);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", (error) => {
        reject(
          signal.aborted
            ? new ExecError("command_failed", input.cancelled() ? "cancelled" : "timeout")
            : gitSpawnError(options.platform, error),
        );
      });
      child.once("close", (code) => resolve(code));
    });
    if (signal.aborted)
      throw new ExecError("command_failed", input.cancelled() ? "cancelled" : "timeout");
    return {
      stdout: overflow ? Buffer.alloc(0) : Buffer.concat(chunks),
      stderr,
      exitCode,
      overflow,
      bytes,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    killGit(options, child);
    input.live?.delete(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
