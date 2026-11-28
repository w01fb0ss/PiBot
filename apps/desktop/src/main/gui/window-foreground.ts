import type { BrowserWindow } from "electron";

const WM_ACTIVATEAPP = 0x001c;

export function trackWindowForeground(window: BrowserWindow, platform: NodeJS.Platform) {
  let appActive = platform !== "win32";
  let changed: (() => void) | undefined;
  let pending: ReturnType<typeof setImmediate> | undefined;
  if (platform === "win32") {
    // Windows can activate a window in its own input queue while Explorer still owns the
    // foreground. WM_ACTIVATEAPP reports the switch between applications.
    window.hookWindowMessage(WM_ACTIVATEAPP, (wParam) => {
      appActive = wParam.readUInt32LE() !== 0;
      pending ??= setImmediate(() => {
        pending = undefined;
        changed?.();
      });
    });
    window.once("closed", () => {
      clearImmediate(pending);
      changed = undefined;
    });
  }
  return {
    isFocused: () =>
      appActive &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized() &&
      window.isFocused(),
    onApplicationActivation(callback: () => void) {
      if (platform === "win32") changed = callback;
    },
  };
}
