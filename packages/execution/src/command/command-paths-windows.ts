import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { windowsSystemRoot } from "../core/windows-environment.ts";

export async function readWindowsCommandPath(
  env: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal,
) {
  const powershell = win32.join(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  // The machine and current-user registry values reflect installs after Pi Bot was launched.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "$user = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "[Console]::Write((($machine, $user) -join ';'))",
  ].join("; ");
  const { stdout } = await promisify(execFile)(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { env, signal, windowsHide: true, timeout: 5000, maxBuffer: 32768, encoding: "utf8" },
  );
  return stdout;
}
