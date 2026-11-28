import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ExecError } from "../core/types.ts";
import { readWindowsCommandPath } from "./command-paths-windows.ts";

/** Importing paths grants neither writes nor an exception to sandbox read/execute rules. */
export function commandPaths(platform: NodeJS.Platform, value: string): string[] {
  const path = platform === "win32" ? win32 : posix;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of value.split(path.delimiter)) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !path.isAbsolute(entry) || /[\p{Cc}\p{Cf}]/u.test(entry)) continue;
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (statSync(entry).isDirectory()) entries.push(entry);
    } catch {
      // Uninstalled or inaccessible tools are not imported, and permissions are never changed.
    }
    if (entries.length === 200) break;
  }
  return entries;
}

/** User-triggered only: initialization files execute outside the command sandbox. No env dump. */
export async function discoverCommandPaths(options: {
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  home: string;
  source: "process" | "terminal" | "windows";
  signal: AbortSignal;
}): Promise<{ paths: string[]; source: "process" | "terminal" | "windows"; shell?: string }> {
  const { platform, env, source, signal } = options;
  signal.throwIfAborted();
  if (source === "windows") {
    if (platform !== "win32") throw new ExecError("command_path_discovery_failed");
    try {
      return { paths: commandPaths(platform, await readWindowsCommandPath(env, signal)), source };
    } catch {
      throw new ExecError("command_path_discovery_failed");
    }
  }
  if (source === "process" || platform === "win32") {
    const value = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
    return { paths: commandPaths(platform, value), source: "process" };
  }
  // Fixed shell programs only. The UI cannot supply an executable, command or working folder.
  const shells = ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash"];
  const shell =
    env.SHELL && shells.includes(env.SHELL)
      ? env.SHELL
      : platform === "darwin"
        ? "/bin/zsh"
        : "/bin/bash";
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-ilc", "printf '%s\\0' \"$PATH\" >&3"], {
      cwd: options.home,
      env: { ...env, HOME: options.home },
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    let output = "";
    let settled = false;
    const decoder = new StringDecoder("utf8");
    const channel = child.stdio[3];
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The shell may already have exited. */
        }
      }
    };
    const finish = (result?: {
      paths: string[];
      source: "process" | "terminal";
      shell: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      kill();
      // An escaped descendant retaining fd3 must not keep the RPC or event loop alive.
      if (channel && "destroy" in channel) channel.destroy();
      child.unref();
      if (result) resolve(result);
      else reject(new ExecError("command_path_discovery_failed"));
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 5000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    if (channel && "on" in channel)
      channel.on("data", (data: Buffer) => {
        output += decoder.write(data);
        if (Buffer.byteLength(output) > 32768) finish();
      });
    child.once("error", abort);
    child.once("close", (code) => {
      output += decoder.end();
      if (code !== 0 || !output.endsWith("\0") || output.slice(0, -1).includes("\0")) {
        finish();
        return;
      }
      finish({ paths: commandPaths(platform, output.slice(0, -1)), source, shell });
    });
  });
}
