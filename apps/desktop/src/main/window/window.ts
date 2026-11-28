import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "@pibot/observability";
import { SKILL_DROP_CHANNEL, SkillDropPathsSchema } from "@pibot/protocol-base/desktop-bridge";
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { pickStartupLabels } from "../../shared/startup-labels.ts";
import { STARTUP_SNAPSHOT_CHANNEL } from "../../shared/startup-snapshot.ts";
import { parseSystemProxy, SYSTEM_PROXY_CHANNEL } from "../../shared/system-proxy.ts";
import { TITLE_OVERLAY_ARG } from "../../shared/title-overlay.ts";
import type { Bounds } from "../gui/desktop-state.ts";
import { createStartupSnapshotStore } from "../gui/startup-snapshot.ts";
import { openExternalUrl } from "./external-url.ts";
import { windowColors } from "./theme-tokens.ts";

// Windows/Linux window controls live in the renderer's own 32px title strip
// (renderer window-titlebar.css --titlebar-height); keep the two in step.
const TITLE_STRIP_HEIGHT = 32;

export function createWindow(options: {
  bounds: Bounds;
  outputDir: string;
  logger: Logger;
  systemLocale?: string | Promise<string>;
  /** Settles when the GUI client has registered its handlers; absent means already. */
  adopted?: Promise<void>;
  /** One first-frame read (read / locale / labels) was answered. */
  displayServed?(): void;
  onClose(): void;
  isQuitting(): boolean;
  saveBounds(bounds: Bounds): void;
}) {
  const colors = windowColors(nativeTheme.shouldUseDarkColors);
  const overlay = process.platform !== "darwin";
  const base: Electron.BrowserWindowConstructorOptions = {
    ...options.bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // The product name, as in every translation table; @pibot/i18n is not loaded yet.
    title: app.getName(),
    backgroundColor: colors.background,
    webPreferences: {
      preload: join(options.outputDir, "..", "preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
  let window: BrowserWindow;
  let hasOverlay = overlay;
  let candidate: BrowserWindow | undefined;
  try {
    candidate = new BrowserWindow({
      ...base,
      titleBarStyle: overlay ? "hidden" : "hiddenInset",
      ...(overlay
        ? {
            // Only this window carries the flag; the system-title-bar fallback below does not.
            webPreferences: { ...base.webPreferences, additionalArguments: [TITLE_OVERLAY_ARG] },
            titleBarOverlay: {
              color: colors.color,
              symbolColor: colors.symbolColor,
              height: TITLE_STRIP_HEIGHT,
            },
          }
        : {}),
    });
    if (overlay)
      candidate.setTitleBarOverlay({
        color: colors.color,
        symbolColor: colors.symbolColor,
        height: TITLE_STRIP_HEIGHT,
      });
    window = candidate;
  } catch (error) {
    if (!overlay) throw error;
    candidate?.destroy();
    options.logger.warn("titleBarOverlay unavailable, using system title bar");
    hasOverlay = false;
    window = new BrowserWindow(base);
  }
  // Keep the native paths in the host. A renderer can redeem only a fresh, one-use drop ID.
  const skillDrops = new Map<string, { paths: string[]; expires: number }>();
  ipcMain.handle(SKILL_DROP_CHANNEL, (event, value: unknown) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      options.isQuitting()
    )
      return null;
    const paths = SkillDropPathsSchema.safeParse(value);
    if (!paths.success) return null;
    const now = Date.now();
    for (const [id, drop] of skillDrops) if (drop.expires <= now) skillDrops.delete(id);
    if (skillDrops.size >= 8) return null;
    const id = randomUUID();
    skillDrops.set(id, { paths: paths.data, expires: now + 30_000 });
    return id;
  });
  const takeSkillDrop = ({ dropId }: { dropId: string }) => {
    const drop = skillDrops.get(dropId);
    skillDrops.delete(dropId);
    return drop && drop.expires > Date.now() ? drop.paths : null;
  };
  let cacheRequests = 0;
  let timingCount = 0;
  let firstScreen = false;
  const snapshot = createStartupSnapshotStore(
    join(app.getPath("userData"), "gui-display"),
    options.logger,
  );
  const adopted = options.adopted ?? Promise.resolve();
  ipcMain.handle(STARTUP_SNAPSHOT_CHANNEL, async (event, action: unknown, value: unknown) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      options.isQuitting()
    )
      return null;
    // Holds the live App until the client's handlers exist; one shared promise, no IO, so it is
    // outside the request bound below.
    if (action === "ready") return adopted.then(() => true);
    // The first frame asks read, locale and labels at once.
    if (cacheRequests >= 3) return null;
    cacheRequests++;
    try {
      if (action === "locale")
        return (
          (await options.systemLocale) ?? app.getPreferredSystemLanguages()[0] ?? app.getLocale()
        );
      if (action === "labels") {
        // Loaded on demand: the window must not wait for both translation tables.
        const { en, zh } = await import("@pibot/i18n");
        return { zh: pickStartupLabels(zh), en: pickStartupLabels(en) };
      }
      if (action === "read") return await snapshot.read();
      if (action === "save") {
        await snapshot.save(value);
        return null;
      }
      if (action === "clear") {
        await snapshot.clear();
        return { ok: true };
      }
    } catch {
      options.logger.warn("Startup display cache operation failed");
      return { ok: false };
    } finally {
      cacheRequests--;
      if (action === "read" || action === "locale" || action === "labels")
        options.displayServed?.();
    }
    return null;
  });
  // Only the address goes back (no credentials exist in Chromium's answer); nothing is saved here.
  ipcMain.handle(SYSTEM_PROXY_CHANNEL, async (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      return null;
    try {
      return parseSystemProxy(
        await window.webContents.session.resolveProxy("https://generativelanguage.googleapis.com/"),
      );
    } catch {
      // A failed lookup only means no suggestion; the user types the address instead.
      options.logger.warn("System proxy lookup failed");
      return null;
    }
  });
  const requestTiming = (event: Electron.IpcMainEvent, value: unknown) => {
    if (
      firstScreen ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      timingCount >= 128 ||
      !value ||
      typeof value !== "object"
    )
      return;
    const row = value as { method?: unknown; durationMs?: unknown; ok?: unknown };
    if (
      typeof row.method !== "string" ||
      ![
        "settings.get",
        "bots.list",
        "groups.list",
        "sidebar.list",
        "topics.list",
        "chat.history",
        "inbox.list",
        "inbox.counts",
        "cached_screen",
      ].includes(row.method) ||
      typeof row.durationMs !== "number" ||
      !Number.isFinite(row.durationMs) ||
      row.durationMs < 0 ||
      row.durationMs > 120_000 ||
      typeof row.ok !== "boolean"
    )
      return;
    timingCount++;
    options.logger.info(
      JSON.stringify({
        module: "startup",
        event: row.method === "cached_screen" ? "gui_cached_screen_ready" : "first_screen_request",
        method: row.method,
        durationMs: Math.round(row.durationMs),
        ok: row.ok,
        sinceProcessMs: Math.round(performance.now()),
      }),
    );
  };
  ipcMain.on("pibot:startup-timing", requestTiming);
  const firstScreenReady = (event: Electron.IpcMainEvent) => {
    if (
      firstScreen ||
      options.isQuitting() ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return;
    firstScreen = true;
    const atMs = Math.round(performance.now());
    options.logger.info(
      JSON.stringify({
        module: "startup",
        event: "gui_first_screen_ready",
        totalMs: atMs,
        sinceProcessMs: atMs,
        startMs: 0,
        endMs: atMs,
      }),
    );
  };
  ipcMain.on("pibot:first-screen-ready", firstScreenReady);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => options.saveBounds(window.getNormalBounds());
  const scheduleSave = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 200);
  };
  window.on("resize", scheduleSave);
  window.on("move", scheduleSave);
  window.on("close", (event) => {
    clearTimeout(timer);
    save();
    if (!options.isQuitting()) {
      event.preventDefault();
      window.hide();
      options.onClose();
    }
  });
  const updateTheme = () => {
    const colors = windowColors(nativeTheme.shouldUseDarkColors);
    window.setBackgroundColor(colors.background);
    if (hasOverlay) {
      try {
        window.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor });
      } catch {
        options.logger.warn("titleBarOverlay theme update unavailable");
      }
    }
  };
  nativeTheme.on("updated", updateTheme);
  // Local UI is the only navigation target. window.open / target=_blank with http(s) goes to the
  // system browser after the same validation as host.openExternal; everything else is dropped.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url, (approved) => shell.openExternal(approved), options.logger).catch(
      () => {
        /* The shared opener already recorded a sanitized warning. */
      },
    );
    return { action: "deny" };
  });
  // Renderer-initiated navigations (links, location.reload()) are refused; the UI never leaves
  // its document. Business ports are reset on a committed navigation only (did-navigate), so a
  // refused reload no longer cuts the live document off.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // A crashed renderer would otherwise stay blank until the app restarts. A browser-initiated
  // reload brings back a fresh document, which asks for a new business port. Bounded so a
  // document that crashes while loading cannot loop.
  const crashes: number[] = [];
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || options.isQuitting()) return;
    const now = Date.now();
    while (crashes.length && now - (crashes[0] ?? now) > 60_000) crashes.shift();
    if (crashes.length >= 3) {
      options.logger.error(`Renderer keeps crashing (${details.reason}); not reloading`);
      return;
    }
    crashes.push(now);
    options.logger.warn(`Renderer gone (${details.reason}); reloading`);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (!window.isDestroyed() && !options.isQuitting()) window.webContents.reload();
    }, 500);
  });
  window.once("closed", () => {
    ipcMain.removeHandler(STARTUP_SNAPSHOT_CHANNEL);
    ipcMain.removeHandler(SYSTEM_PROXY_CHANNEL);
    ipcMain.removeHandler(SKILL_DROP_CHANNEL);
    skillDrops.clear();
    ipcMain.off("pibot:startup-timing", requestTiming);
    ipcMain.off("pibot:first-screen-ready", firstScreenReady);
    nativeTheme.off("updated", updateTheme);
    clearTimeout(timer);
    clearTimeout(reloadTimer);
  });
  window.once("ready-to-show", () => {
    if (!window.isDestroyed() && !options.isQuitting()) {
      window.show();
      options.logger.info(
        JSON.stringify({
          module: "startup",
          event: "gui_window_shown",
          sinceProcessMs: Math.round(performance.now()),
        }),
      );
    }
  });
  return { window, takeSkillDrop };
}

/**
 * Placeholder shown while a cold start waits for the background service and brain, which can take
 * several seconds before the UI document may load. Plain text in system colours over the window's
 * themed background; no script, nothing remote.
 */
export function startingPageUrl(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  // Only a top strip drags: Chromium can keep a page's drag regions after navigation, and a
  // whole-page region left the next page (onboarding has none of its own) unclickable.
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{height:100%;margin:0;background:transparent;color:GrayText;font:13px system-ui,sans-serif;display:flex;align-items:center;justify-content:center}i{position:fixed;inset:0 0 auto 0;height:40px;-webkit-app-region:drag}</style><i></i><p>${escaped}</p>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
