import { join } from "node:path";
import type { Logger } from "@pibot/observability";
import { screen } from "electron";
import { createWindow } from "../window/window.ts";
import { desktopState } from "./desktop-state.ts";
import { trackWindowForeground } from "./window-foreground.ts";

/**
 * The GUI window is created and its document starts loading before the GUI role graph (the
 * protocol, i18n and connection modules, ~0.3-1 s of main-thread evaluation) is imported, so the
 * renderer process boots and paints the cached screen in parallel with it. Only light modules are
 * imported here. The GUI client adopts the window; until then its callbacks use safe defaults and
 * the renderer holds the live App back (`ready` IPC) so no request reaches a handler that the
 * client has not registered yet.
 */
export function createEarlyWindow(options: {
  dataDir: string;
  outputDir: string;
  dev: boolean;
  rendererUrl?: string;
  logger: Logger;
  /** Windows reads its display language with PowerShell; the locale IPC waits for it. */
  systemLocale?: Promise<string>;
}) {
  const saved = desktopState(
    options.dataDir,
    screen.getAllDisplays().map((display) => display.workArea),
    options.logger,
  );
  const hooks = {
    isQuitting: () => false,
    onClose: () => {},
  };
  let resolveAdopted: () => void = () => {};
  const adopted = new Promise<void>((resolve) => {
    resolveAdopted = resolve;
  });
  let served = 0;
  let resolveFirstFrame: () => void = () => {};
  const firstFrame = new Promise<void>((resolve) => {
    resolveFirstFrame = resolve;
  });
  const createdAtMs = Math.round(performance.now());
  const { window, takeSkillDrop } = createWindow({
    systemLocale: options.systemLocale,
    bounds: saved.state.bounds,
    outputDir: options.outputDir,
    logger: options.logger,
    isQuitting: () => hooks.isQuitting(),
    saveBounds: (bounds) => {
      saved.state.bounds = bounds;
      saved.save();
    },
    onClose: () => hooks.onClose(),
    adopted,
    displayServed: () => {
      if (++served >= 3) resolveFirstFrame();
    },
  });
  const foreground = trackWindowForeground(window, process.platform);
  window.webContents.once("did-fail-load", resolveFirstFrame);
  window.once("closed", resolveFirstFrame);
  const documentLoad =
    options.dev && options.rendererUrl
      ? window.loadURL(options.rendererUrl)
      : window.loadFile(join(options.outputDir, "..", "renderer", "index.html"));
  void documentLoad.catch(() => {}); // The GUI client's bounded startup path owns load failures.
  options.logger.info(
    JSON.stringify({
      module: "startup",
      event: "gui_window_created",
      sinceProcessMs: createdAtMs,
      durationMs: Math.round(performance.now() - createdAtMs),
    }),
  );
  return {
    window,
    takeSkillDrop,
    foreground,
    saved,
    documentLoad,
    /** The renderer has its first-frame data; main may now evaluate the role graph. */
    firstFrame,
    /** Called by the GUI client once every pre-attach handler is registered. */
    adopt(next: { isQuitting(): boolean; onClose(): void }) {
      hooks.isQuitting = next.isQuitting;
      hooks.onClose = next.onClose;
      resolveAdopted();
    },
  };
}
export type EarlyWindow = ReturnType<typeof createEarlyWindow>;
