import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLanguage } from "@pibot/i18n";
import type { Logger } from "@pibot/observability";
import { createRoutineHost, type TrayState } from "@pibot/routines/host";
import type { Redactor } from "@pibot/secrets";
import { resolveDataDir } from "@pibot/storage";
import { app, ipcMain, nativeTheme, powerMonitor, powerSaveBlocker, screen } from "electron";
import type { BackgroundPresentation } from "../../shared/background-presentation.ts";
import { registerBackgroundBridge } from "../background/background-bridge.ts";
import { startBrainHost } from "../brain/brain-host.ts";
import { createWindowFramePorts } from "../browser-frames/browser-frames-window.ts";
import { createComputerGuard } from "../computer/computer-guard-adapter.ts";
import { createComputerHost } from "../computer/computer-host.ts";
import { startAppUpdates } from "../updates/update-bridge.ts";
import { installAppMenu } from "../window/app-menu.ts";
import { readSystemLocale } from "../window/system-locale.ts";
import { createTray, notifyBackground } from "../window/tray.ts";
import { createWindow } from "../window/window.ts";
import { desktopState } from "./desktop-state.ts";
import { exportLogs } from "./export-logs.ts";

export async function startEmbeddedDesktop(options: {
  dataDir: string;
  outputDir: string;
  resourcesDir: string;
  dev: boolean;
  originalEnv: Readonly<NodeJS.ProcessEnv>;
  logger: Logger;
  redactor: Redactor;
}) {
  const { dataDir, outputDir, resourcesDir, dev, originalEnv, logger, redactor } = options;
  const startup = new AbortController();
  let quitting = false;
  let shutdownComplete = false;
  let openWindow: (() => void) | undefined;
  let hideWindow: (() => void) | undefined;
  let brain: ReturnType<typeof startBrainHost> | undefined;
  let tray: ReturnType<typeof createTray> | undefined;
  let devHooks: { stop(): Promise<void> } | undefined;
  let removeBackground: (() => void) | undefined;
  let routineHost: ReturnType<typeof createRoutineHost> | undefined;
  // Windows / Linux run the computer driver in this process; created lazily-loading.
  let computer: ReturnType<typeof createComputerHost> | undefined;
  let computerGuard: ReturnType<typeof createComputerGuard> | undefined;
  app.on("second-instance", () => openWindow?.());
  app.on("activate", () => openWindow?.());
  app.on("window-all-closed", () => {
    /* Tray keeps the process alive on every platform. */
  });
  app.on("before-quit", (event) => {
    startup.abort();
    if (quitting && !shutdownComplete) {
      event.preventDefault();
      return;
    }
    quitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    void stopWriter().then((stopped) => {
      if (stopped) app.quit();
      else logger.error("Embedded writer exit unconfirmed; canonical ownership retained");
    });
  });
  // Resolves true once everything this process runs has stopped and quitting may proceed.
  const stopWriter = async () => {
    // Stopping brain first would repaint the window as the not-connected page before it closes.
    hideWindow?.();
    removeBackground?.();
    try {
      await devHooks?.stop();
      await brain?.stop();
      if (!brain) await routineHost?.stop();
      await computer?.dispose();
      computerGuard?.dispose();
    } catch {
      quitting = false;
      return false;
    }
    tray?.destroy();
    shutdownComplete = true;
    return true;
  };

  const saved = desktopState(
    dataDir,
    screen.getAllDisplays().map((display) => display.workArea),
    logger,
  );
  // Resolve before loading the document: the renderer's startup IPC has a 300 ms deadline.
  const systemLocale = await readSystemLocale({
    platform: process.platform,
    fallback: app.getLocale(),
    systemRoot: originalEnv.SystemRoot ?? originalEnv.SYSTEMROOT,
    logger,
    signal: startup.signal,
  });
  let language = resolveLanguage("system", systemLocale);
  if (quitting) return;
  const { window, takeSkillDrop } = createWindow({
    systemLocale: process.platform === "win32" ? systemLocale : undefined,
    bounds: saved.state.bounds,
    outputDir,
    logger,
    isQuitting: () => quitting,
    saveBounds: (bounds) => {
      saved.state.bounds = bounds;
      saved.save();
    },
    onClose: () => {
      if (!saved.state.closeToTrayHintShown && notifyBackground(language)) {
        saved.state.closeToTrayHintShown = true;
        saved.save();
        brain?.markCloseHint();
      }
    },
  });
  // The NSIS installer replaces this process's files, so everything stops before it starts.
  const updates = startAppUpdates({
    window,
    logger,
    appImage: undefined,
    shutdown: async () => {
      if (quitting) return false;
      quitting = true;
      const stopped = await stopWriter();
      if (!stopped) {
        logger.error("Embedded writer stop before update unconfirmed; update postponed");
        openWindow?.();
      }
      return stopped;
    },
  });
  hideWindow = () => {
    if (!window.isDestroyed()) window.hide();
  };
  openWindow = () => {
    // While quitting the window stays hidden: it would only show the stopped page.
    if (quitting || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  let routineTray: TrayState | null = null;
  let activeRuns = 0;
  // This process is the background here, so its brain's status is what the tray reports.
  let trayBackground: BackgroundPresentation = { lifecycle: "starting" };
  const trayOptions = (): Parameters<typeof createTray>[0] => ({
    resourcesDir: fileURLToPath(new URL("../../resources/", import.meta.url)),
    language,
    open: () => openWindow?.(),
    show: (view) => {
      openWindow?.();
      brain?.navigate({ view });
    },
    // The window's close button already hides to the tray and leaves this process (and its
    // routines) running; the tray item does the same, so it is shown only while there is a window.
    closeWindow: {
      available: () => !window.isDestroyed() && window.isVisible(),
      run: () => hideWindow?.(),
    },
    // The old "Quit": stops the brain and its routines with the app.
    quitAll: () => app.quit(),
    inbox: {
      count: (signal) => {
        if (!brain) return Promise.reject(new Error("brain_unavailable"));
        return brain.inboxCount(signal);
      },
    },
    routines: {
      pause: async (until: string) => {
        if (!brain) throw new Error("brain_unavailable");
        await brain.pauseAll(until);
      },
      resume: async () => {
        if (!brain) throw new Error("brain_unavailable");
        await brain.resumeAll();
      },
      failed: () => logger.warn("tray routine action failed"),
    },
  });
  const menuNavigation: Parameters<typeof installAppMenu>[1] = (target) => {
    openWindow?.();
    brain?.navigate(target);
  };
  installAppMenu(language, menuNavigation, options.dev);
  tray = createTray(trayOptions());
  tray.updateBackground(trayBackground);
  const trayWindow = () => tray?.refresh();
  window.on("show", trayWindow);
  window.on("hide", trayWindow);
  let testDirectory: string | undefined;
  let devModule: typeof import("@pibot/routines/host/dev") | undefined;
  if (__PIBOT_DEV_BUILD__ && dev && originalEnv.PIBOT_ROUTINE_TEST_DIR) {
    devModule = await import("@pibot/routines/host/dev");
    const normal = resolveDataDir({
      platform: process.platform,
      env: {},
      homedir: homedir(),
      dev: true,
    });
    if (!originalEnv.PIBOT_DATA_DIR) throw new Error("routine_test_isolation_required");
    testDirectory = await devModule.routineTestDirectory(
      dataDir,
      originalEnv.PIBOT_ROUTINE_TEST_DIR,
      normal,
    );
  }
  let fakeBlockerId = 0;
  const host = createRoutineHost({
    platform: process.platform,
    monitor: powerMonitor,
    window,
    blocker: testDirectory ? { start: () => ++fakeBlockerId, stop: () => {} } : powerSaveBlocker,
    test: testDirectory !== undefined,
    logger,
    send: (control) => brain?.control(control),
    tray: (state) => {
      routineTray = state;
      tray?.updateRoutines(state);
    },
  });
  routineHost = host;
  let trayVisible = true;
  let requestedLoginItem = saved.state.openAtLogin;
  computerGuard = createComputerGuard({ logger, outputDir });
  computer = createComputerHost({
    logger,
    blocked: computerGuard.blocked,
    officeBlocked: computerGuard.listed,
  });
  // The Bot browsers run in this process here, so overlay frames go straight to the window.
  const frames = createWindowFramePorts(window);
  brain = startBrainHost({
    updateProxy: updates.setProxy,
    systemLocale,
    window,
    takeSkillDrop,
    computer,
    computerGuard,
    frames,
    originalEnv,
    dataDir,
    outputDir,
    dev,
    resourcesDir,
    routines: host,
    routineTesting: testDirectory !== undefined,
    focusBot: (botId, tab, target) => {
      openWindow?.();
      brain?.navigate(target ?? { botId, tab });
    },
    logger,
    redactor,
    onStatus: (next) => {
      trayBackground = { lifecycle: next === "restarting" ? "starting" : next };
      tray?.updateBackground(trayBackground);
      if (next === "ready") tray?.refreshInbox();
    },
    onInboxChanged: () => tray?.refreshInbox(),
    onActiveRuns: (count) => {
      activeRuns = count;
      tray?.updateActiveRuns(count);
    },
    onLoginItem: (openAtLogin) => {
      saved.state.openAtLogin = openAtLogin;
      saved.save();
    },
    onSettings: (settings) => {
      nativeTheme.themeSource = settings.theme;
      const nextLanguage = resolveLanguage(settings.language, systemLocale);
      installAppMenu(nextLanguage, menuNavigation, options.dev);
      if (language !== nextLanguage || trayVisible !== settings.showTrayIcon) {
        language = nextLanguage;
        trayVisible = settings.showTrayIcon;
        tray?.destroy();
        tray = trayVisible ? createTray(trayOptions()) : undefined;
        tray?.updateRoutines(routineTray);
        tray?.updateActiveRuns(activeRuns);
        tray?.updateBackground(trayBackground);
      }
      saved.state.closeToTrayHintShown =
        settings.closeToTrayHintShown || saved.state.closeToTrayHintShown;
      if (saved.state.closeToTrayHintShown && !settings.closeToTrayHintShown)
        brain?.markCloseHint();
      if (requestedLoginItem !== settings.openAtLogin) {
        requestedLoginItem = settings.openAtLogin;
        void brain?.loginItem(settings.openAtLogin).catch(() => {
          /* Login item synchronization logs failures and restores actual state. */
        });
      }
      saved.save();
    },
  });
  removeBackground = registerBackgroundBridge(ipcMain, window, brain, true);
  if (testDirectory && devModule) {
    devHooks = devModule.registerRoutineDev({
      directory: testDirectory,
      host,
      send: (control) => {
        if (!brain?.devControl) throw new Error("routine_dev_unavailable");
        brain.devControl(control);
      },
      failed: () => logger.warn("routine dev command failed"),
    });
  }
  const ready = (event: Electron.IpcMainEvent) => {
    if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) {
      brain?.rendererReady();
    }
  };
  ipcMain.on("pibot:renderer-ready", ready);
  ipcMain.handle("pibot:export-logs", (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      return "failed";
    return exportLogs(
      window,
      join(dataDir, "logs"),
      [{ name: "gui-logs", path: join(dataDir, "gui-logs") }],
      (signal) => {
        if (!brain) throw new Error("brain_unavailable");
        return brain.diagnostics(signal);
      },
    );
  });
  // Committed main-frame navigations only: a refused location.reload() must not retire the
  // live document's port (see gui-client.ts).
  window.webContents.on("did-navigate", () => brain?.rendererReloading());
  window.on("closed", () => {
    frames.dispose();
    removeBackground?.();
    ipcMain.off("pibot:renderer-ready", ready);
    ipcMain.removeHandler("pibot:export-logs");
  });
  if (saved.state.openAtLogin !== undefined)
    void brain.loginItem(saved.state.openAtLogin).catch(() => {
      /* Login item synchronization logs failures and restores actual state. */
    });
  const devUrl = originalEnv.ELECTRON_RENDERER_URL;
  if (dev && devUrl) return window.loadURL(devUrl);
  return window.loadFile(join(outputDir, "..", "renderer", "index.html"));
}
