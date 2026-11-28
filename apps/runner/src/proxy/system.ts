// One entry for the operating system's proxy; each platform reads it with a tool it ships.
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ProxySettings } from "./route.ts";
import { parseScutilProxy } from "./system-mac.ts";
import { INTERNET_SETTINGS_KEY, parseNetshWinhttp, parseRegQuery } from "./system-windows.ts";

export type SystemProxyNote = "wpad_unsupported" | "unsupported" | "unavailable";
export interface SystemProxy {
  settings?: ProxySettings;
  /** Why no system proxy is used, as a fixed word for the log. */
  note?: SystemProxyNote;
}
export type ReadCommand = (file: string, args: string[]) => Promise<string>;

const READ_MS = 5000;

export const readCommand: ReadCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: READ_MS, windowsHide: true, maxBuffer: 256 * 1024, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/**
 * Linux has no single system proxy outside the environment (desktop settings differ per
 * environment and a headless runner has none), so there it is the environment variables only.
 */
export async function systemProxy(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  read: ReadCommand = readCommand,
): Promise<SystemProxy> {
  try {
    if (platform === "darwin") {
      const parsed = parseScutilProxy(await read("/usr/sbin/scutil", ["--proxy"]));
      return parsed.settings
        ? { settings: parsed.settings }
        : { note: parsed.wpad ? "wpad_unsupported" : undefined };
    }
    if (platform === "win32") {
      // System32 from the environment: Windows may live on any drive.
      const root = env.SystemRoot ?? env.windir;
      if (!root) return { note: "unavailable" };
      const system32 = join(root, "System32");
      const user = parseRegQuery(
        await read(join(system32, "reg.exe"), ["query", INTERNET_SETTINGS_KEY]),
      );
      if (user.settings) return { settings: user.settings };
      const machine = parseNetshWinhttp(
        await read(join(system32, "netsh.exe"), ["winhttp", "show", "proxy"]),
      );
      if (machine) return { settings: machine };
      return { note: user.wpad ? "wpad_unsupported" : undefined };
    }
    return { note: "unsupported" };
  } catch {
    // A missing or slow tool only means no system proxy; the environment and --proxy still apply.
    return { note: "unavailable" };
  }
}
