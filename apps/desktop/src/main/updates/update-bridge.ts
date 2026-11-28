import type { Logger } from "@pibot/observability";
import {
  DESKTOP_UPDATES_CHANNEL,
  DESKTOP_UPDATES_STATE_CHANNEL,
  DesktopUpdateActionSchema,
  type DesktopUpdateState,
} from "@pibot/protocol";
import { app, type BrowserWindow, ipcMain, autoUpdater as nativeUpdater } from "electron";
import { type AppUpdater, createAppUpdater, type UpdateChannel } from "./app-updater.ts";
import { createUpdateProxy } from "./update-proxy.ts";
import { updateBlocker } from "./update-support.ts";

/**
 * In-app updates for the window's process (the GUI client on macOS / Linux, the embedded desktop
 * on Windows). The background owner never runs this, so it never loads electron-updater.
 */
export function startAppUpdates(options: {
  window: BrowserWindow;
  logger: Logger;
  /** The AppImage runtime's APPIMAGE variable, read by the entry point. */
  appImage: string | undefined;
  /** Optional update channel override (PIBOT_UPDATE_CHANNEL=rc for release-candidate tests). */
  channel?: UpdateChannel;
  shutdown(): Promise<boolean>;
}) {
  const { window, logger } = options;
  const proxy = createUpdateProxy();
  let proxyReady = false;
  let updater: AppUpdater | undefined;
  let disposed = false;
  const push = (state: DesktopUpdateState) => {
    if (!window.isDestroyed()) window.webContents.send(DESKTOP_UPDATES_STATE_CHANNEL, state);
  };
  const ready = updateBlocker({
    packaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    appImage: options.appImage,
  }).then((blocker) => {
    if (blocker) logger.info(`In-app update unavailable (${blocker}); download page offered`);
    const created = createAppUpdater({
      logger,
      prepare: (instance) => {
        if (!proxyReady) throw new Error("update_proxy_unavailable");
        return proxy.apply(instance);
      },
      proxyLogin: proxy.login,
      platform: process.platform,
      currentVersion: app.getVersion(),
      channel: options.channel,
      blocker,
      load: () => import("electron-updater").then(commonJs),
      ...(process.platform === "darwin" ? { nativeUpdater } : {}),
      shutdown: options.shutdown,
      relaunch: () => {
        app.relaunch();
        app.quit();
      },
    });
    updater = created;
    created.subscribe(push);
    if (disposed) created.dispose();
    else created.start();
    return created;
  });
  ipcMain.handle(DESKTOP_UPDATES_CHANNEL, async (event, value: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("updates_unavailable");
    const { action } = DesktopUpdateActionSchema.parse(value);
    const active = await ready;
    if (disposed) throw new Error("updates_unavailable");
    return active.run(action);
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    app.off("will-quit", dispose);
    ipcMain.removeHandler(DESKTOP_UPDATES_CHANNEL);
    updater?.dispose();
    proxy.dispose();
  };
  app.once("will-quit", dispose);
  return {
    setProxy: async (url: string | null | undefined) => {
      proxy.set(url);
      proxyReady = url !== undefined;
    },
    /** True while a downloaded update waits to be installed when the app quits. */
    installPending: () => updater?.installPending() ?? false,
    dispose,
  };
}

/** Node hands an ES module the CommonJS exports object as its default export. */
function commonJs(module: typeof import("electron-updater")) {
  return (module as { default?: typeof import("electron-updater") }).default ?? module;
}
