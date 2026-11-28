import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";

const TIMEOUT_MS = 3_000;
const MAX_OUTPUT = 64 * 1024;
const MARK_START = "__PIBOT_PATH_START__";
const MARK_END = "__PIBOT_PATH_END__";

export function readCachedLoginShellPath(dataDir: string, platform: NodeJS.Platform): string[] {
  if (platform === "win32") return [];
  try {
    const raw = readFileSync(join(dataDir, "cache", "terminal-path.json"), "utf8");
    const value = JSON.parse(raw);
    if (!Array.isArray(value?.path) || value.path.length > 256) return [];
    return value.path.filter((entry: unknown): entry is string => {
      if (
        typeof entry !== "string" ||
        entry.length > 4096 ||
        !isAbsolute(entry) ||
        /[\0\r\n]/.test(entry)
      )
        return false;
      try {
        return statSync(entry).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export async function writeCachedLoginShellPath(dataDir: string, path: readonly string[]) {
  const file = join(dataDir, "cache", "terminal-path.json");
  const temp = `${file}.tmp`;
  await mkdir(join(dataDir, "cache"), { recursive: true, mode: 0o700 });
  await writeFile(temp, JSON.stringify({ path }), { mode: 0o600 });
  await rename(temp, file);
}

const MARK_RE = new RegExp(`${MARK_START}(.*?)${MARK_END}`, "s");

export interface LoginShellChild {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  once(event: "error", listener: () => void): this;
  once(event: "exit" | "close", listener: (code: number | null) => void): this;
  off(event: "error", listener: () => void): this;
  off(event: "exit" | "close", listener: (code: number | null) => void): this;
}

export async function collectLoginShellPath(
  child: LoginShellChild,
  options?: {
    timeoutMs?: number;
    maxOutput?: number;
    killGroup?: () => void;
    checkDir?: (entry: string) => Promise<boolean>;
  },
): Promise<string[] | undefined> {
  const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;
  const maxOutput = options?.maxOutput ?? MAX_OUTPUT;
  const killGroup =
    options?.killGroup ??
    (() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone: nothing left to stop.
      }
    });
  const checkDir =
    options?.checkDir ??
    (async (entry: string) => {
      try {
        return (await stat(entry)).isDirectory();
      } catch {
        return false;
      }
    });
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let parsing = false;
    let exitCode: number | null | undefined;
    let stdoutEnded = false;
    const stdout = child.stdout;
    if (!stdout) {
      resolve(undefined);
      return;
    }
    const onData = (chunk: string) => {
      if (settled) return;
      output += chunk;
      if (output.length > maxOutput) {
        killGroup();
        finish(undefined);
        return;
      }
      if (exitCode === 0 && output.includes(MARK_END)) tryParse();
    };
    const onEnd = () => {
      stdoutEnded = true;
      tryParse();
    };
    const onError = () => finish(undefined);
    const onClose = (code: number | null) => {
      stdoutEnded = true;
      if (exitCode === undefined) exitCode = code;
      if (exitCode !== 0) return finish(undefined);
      tryParse();
    };
    const onExit = (code: number | null) => {
      exitCode = code;
      if (code !== 0) return finish(undefined);
      tryParse();
    };
    const finish = (value: string[] | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onData);
      stdout.off("end", onEnd);
      child.off("error", onError);
      child.off("close", onClose);
      child.off("exit", onExit);
      if (!stdoutEnded) stdout.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(undefined);
    }, timeoutMs);
    const tryParse = () => {
      if (settled || parsing || exitCode !== 0) return;
      const match = MARK_RE.exec(output);
      if (!match) {
        if (stdoutEnded) finish(undefined);
        return;
      }
      parsing = true;
      const candidates = (match[1] ?? "").split(":");
      void Promise.all(
        candidates.map(async (entry) => {
          if (!isAbsolute(entry) || /[\0\r\n]/.test(entry)) return undefined;
          return (await checkDir(entry)) ? entry : undefined;
        }),
      ).then(
        (entries) =>
          finish([...new Set(entries.filter((entry): entry is string => Boolean(entry)))]),
        () => finish(undefined),
      );
    };
    stdout.setEncoding("utf8");
    stdout.on("data", onData);
    stdout.once("end", onEnd);
    child.once("error", onError);
    child.once("close", onClose);
    child.once("exit", onExit);
  });
}

/** Read only PATH from the user's login shell; failures deliberately return no override. */
export async function readLoginShellPath(
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<string[] | undefined> {
  if (platform === "win32") return undefined;
  const shell =
    env.SHELL === "/bin/zsh" || env.SHELL === "/bin/bash"
      ? env.SHELL
      : platform === "darwin"
        ? "/bin/zsh"
        : "/bin/bash";
  const child = spawn(shell, ["-lic", `printf '${MARK_START}%s${MARK_END}' "$PATH"`], {
    env: { ...env, PATH: env.PATH ?? "" },
    stdio: ["ignore", "pipe", "ignore"],
    // An interactive zsh often starts helpers (gitstatusd, instant prompt): own process group,
    // so a timeout ends all of them, not only the shell.
    detached: true,
  });
  return collectLoginShellPath(child);
}
