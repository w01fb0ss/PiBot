import { execFile } from "node:child_process";
import { win32 } from "node:path";

/** Windows lets a child of the foreground process pass activation to the attached GUI. */
export async function grantIslandForeground(
  systemRoot: string | undefined,
  pid: number,
  signal: AbortSignal,
): Promise<void> {
  if (
    !systemRoot ||
    !win32.isAbsolute(systemRoot) ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    pid > 0xffffffff ||
    signal.aborted
  )
    return;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace PiBot -Name IslandForeground -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool AllowSetForegroundWindow(uint processId);
'@
[void][PiBot.IslandForeground]::AllowSetForegroundWindow([uint32]${pid})
`;
  await new Promise<void>((resolve) => {
    execFile(
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { signal, timeout: 5000, windowsHide: true, maxBuffer: 4096 },
      () => resolve(),
    );
  });
}
