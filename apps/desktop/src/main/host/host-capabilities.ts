import type { Logger } from "@pibot/observability";
import {
  type BotNavigation,
  BotNavigationSchema,
  type GuiHostMethods,
  type HostParams,
  type HostResults,
  type Peer,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { Redactor } from "@pibot/secrets";
import { BrowserWindow, dialog, Notification, shell } from "electron";
import { allowedFile, selectedFolder } from "./host-paths.ts";
import { revealFile } from "./reveal-file.ts";
import { teamExportFilename } from "./team-file-io.ts";
import { createTeamFiles } from "./team-files.ts";

// The brain waits 630 s for any picker; the forward to the window must not expire first.
const GUI_PICK = { timeoutMs: 620_000 };

export const skillDialogOptions: Electron.OpenDialogOptions = {
  properties: ["openFile"],
  filters: [{ name: "Skill (SKILL.md, .zip)", extensions: ["md", "markdown", "txt", "zip"] }],
};

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
      reject(
        new RpcError(
          timedOut ? RpcErrorCodes.timeout : RpcErrorCodes.closed,
          "host_operation_cancelled",
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/**
 * "New folder…": the same directory dialog with its "New Folder" button (macOS needs
 * `createDirectory`; Windows `promptToCreate` accepts a typed name that does not exist yet).
 */
export function folderDialogOptions(
  create: boolean,
  defaultPath?: string,
): Electron.OpenDialogOptions {
  return {
    ...(defaultPath ? { defaultPath } : {}),
    properties: create ? ["openDirectory", "createDirectory", "promptToCreate"] : ["openDirectory"],
  };
}

export function createHostCapabilities(options: {
  window?: BrowserWindow;
  takeSkillDrop?(params: { dropId: string }): string[] | null;
  gui?: Pick<Peer<typeof GuiHostMethods, Record<string, never>>, "call">;
  foreground?(): boolean;
  redactor: Redactor;
  logger: Logger;
  focusBot(
    botId: string,
    tab: NonNullable<HostParams["host.notify"]["tab"]>,
    target?: BotNavigation,
  ): void;
}) {
  const shutdown = new AbortController();
  const notices = new Map<string, { dispose(): void }>();
  let picking = false;
  let pickerAbort: AbortController | undefined;
  const cancelPicker = () => {
    pickerAbort?.abort();
    teams.cancel();
  };
  options.window?.on("close", cancelPicker);
  options.window?.on("closed", cancelPicker);
  const check = () => {
    if (shutdown.signal.aborted || options.window?.isDestroyed())
      throw new RpcError(RpcErrorCodes.closed, "host_closed");
  };
  const teams = createTeamFiles({
    check,
    redactor: options.redactor,
    logger: options.logger,
    choose: async () => {
      if (!options.window)
        return (
          options.gui?.call("gui.pick", { kind: "team-open" }, GUI_PICK) ??
          Promise.reject(new RpcError(RpcErrorCodes.unsupported, "gui_offline"))
        );
      const result = await dialog.showOpenDialog(options.window, {
        properties: ["openFile"],
        filters: [{ name: "Pi Bot", extensions: ["pibot"] }],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    save: async (defaultName?: string) => {
      if (!options.window)
        return (
          options.gui?.call(
            "gui.pick",
            { kind: "team-save", ...(defaultName ? { defaultName } : {}) },
            GUI_PICK,
          ) ?? Promise.reject(new RpcError(RpcErrorCodes.unsupported, "gui_offline"))
        );
      const result = await dialog.showSaveDialog(options.window, {
        defaultPath: teamExportFilename(defaultName),
        filters: [{ name: "Pi Bot", extensions: ["pibot"] }],
        properties: ["showOverwriteConfirmation"],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
  });
  return {
    teams,
    async takeSkillDrop(params: HostParams["host.skills.takeDrop"]) {
      check();
      if (options.window) return options.takeSkillDrop?.(params) ?? null;
      return (await options.gui?.call("gui.skills.takeDrop", params)) ?? null;
    },
    async pickFolder({
      create = false,
      defaultPath,
    }: {
      create?: boolean;
      defaultPath?: string;
    } = {}): Promise<string | null> {
      check();
      if (!options.window) {
        if (!options.gui) throw new RpcError(RpcErrorCodes.unsupported, "gui_offline");
        const path = await options.gui.call(
          "gui.pick",
          { kind: create ? "folder-create" : "folder", defaultPath },
          GUI_PICK,
        );
        return path ? selectedFolder(path, true) : null;
      }
      if (picking) throw new RpcError(RpcErrorCodes.busy, "folder_picker_busy");
      picking = true;
      const stop = new AbortController();
      pickerAbort = stop;
      let pending: Promise<Electron.OpenDialogReturnValue> | undefined;
      try {
        const cancelled = AbortSignal.any([shutdown.signal, stop.signal]);
        const waiting = AbortSignal.any([cancelled, AbortSignal.timeout(600_000)]);
        pending = dialog.showOpenDialog(options.window, folderDialogOptions(create, defaultPath));
        // Timing out the RPC cannot close a native dialog; keep the guard until it actually closes.
        void pending.then(
          () => {
            picking = false;
          },
          () => {
            picking = false;
          },
        );
        const result = await untilAborted(pending, waiting);
        waiting.throwIfAborted();
        const [path] = result.filePaths;
        if (result.canceled || !path) return null;
        const signal = AbortSignal.any([cancelled, AbortSignal.timeout(20_000)]);
        const folder = await untilAborted(selectedFolder(path, true), signal);
        check();
        signal.throwIfAborted();
        return folder;
      } finally {
        if (!pending) picking = false;
        if (pickerAbort === stop) pickerAbort = undefined;
      }
    },
    /** Workflow input picker: select one arbitrary file without reading it in the renderer. */
    async pickFile({
      defaultPath,
      filters,
    }: {
      defaultPath?: string;
      filters?: { name: string; extensions: string[] }[];
    } = {}): Promise<string | null> {
      check();
      if (!options.window) {
        if (!options.gui) throw new RpcError(RpcErrorCodes.unsupported, "gui_offline");
        return options.gui.call("gui.pick", { kind: "file", defaultPath, filters }, GUI_PICK);
      }
      if (picking) throw new RpcError(RpcErrorCodes.busy, "folder_picker_busy");
      picking = true;
      const stop = new AbortController();
      pickerAbort = stop;
      let pending: Promise<Electron.OpenDialogReturnValue> | undefined;
      try {
        const waiting = AbortSignal.any([
          shutdown.signal,
          stop.signal,
          AbortSignal.timeout(600_000),
        ]);
        pending = dialog.showOpenDialog(options.window, {
          properties: ["openFile"],
          defaultPath,
          ...(filters?.length ? { filters } : {}),
        });
        void pending.then(
          () => {
            picking = false;
          },
          () => {
            picking = false;
          },
        );
        const result = await untilAborted(pending, waiting);
        check();
        return result.canceled ? null : (result.filePaths[0] ?? null);
      } finally {
        if (!pending) picking = false;
        if (pickerAbort === stop) pickerAbort = undefined;
      }
    },
    /** Skill import: one SKILL.md (or Markdown/text file) or a .zip; brain reads it. */
    async pickSkillFile(): Promise<string | null> {
      check();
      if (!options.window) {
        if (!options.gui) throw new RpcError(RpcErrorCodes.unsupported, "gui_offline");
        return options.gui.call("gui.pick", { kind: "skill-import" }, GUI_PICK);
      }
      if (picking) throw new RpcError(RpcErrorCodes.busy, "folder_picker_busy");
      picking = true;
      const stop = new AbortController();
      pickerAbort = stop;
      let pending: Promise<Electron.OpenDialogReturnValue> | undefined;
      try {
        const waiting = AbortSignal.any([
          shutdown.signal,
          stop.signal,
          AbortSignal.timeout(600_000),
        ]);
        pending = dialog.showOpenDialog(options.window, skillDialogOptions);
        // As with folders: an RPC timeout cannot close the native dialog; release on real close.
        void pending.then(
          () => {
            picking = false;
          },
          () => {
            picking = false;
          },
        );
        const result = await untilAborted(pending, waiting);
        check();
        return result.canceled ? null : (result.filePaths[0] ?? null);
      } finally {
        if (!pending) picking = false;
        if (pickerAbort === stop) pickerAbort = undefined;
      }
    },
    async openPath(params: HostParams["host.openPath"]): Promise<void> {
      check();
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]);
      const path = await untilAborted(allowedFile(params.path, params.allowedRoots), signal);
      check();
      signal.throwIfAborted();
      const error = options.window
        ? await untilAborted(shell.openPath(path), signal)
        : await untilAborted(
            options.gui?.call("gui.openPath", { path }) ??
              Promise.reject(new RpcError(RpcErrorCodes.unsupported, "gui_offline")),
            signal,
          );
      if (error) throw new RpcError(RpcErrorCodes.internal, "path_open_failed");
      options.logger.info(JSON.stringify({ module: "host", event: "path.opened", audit: true }));
    },
    async revealPath(params: HostParams["host.revealPath"]): Promise<void> {
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]);
      check();
      const path = await untilAborted(
        allowedFile(params.path, params.allowedRoots, { folders: true }),
        signal,
      );
      check();
      signal.throwIfAborted();
      if (!options.window) {
        if (!options.gui) throw new RpcError(RpcErrorCodes.unsupported, "gui_offline");
        await untilAborted(options.gui.call("gui.revealPath", { path }), signal);
      } else await untilAborted(revealFile(path, check, signal), signal);
      check();
      signal.throwIfAborted();
      options.logger.info(JSON.stringify({ module: "host", event: "path.revealed", audit: true }));
    },
    async notify(params: HostParams["host.notify"]): Promise<HostResults["host.notify"]> {
      check();
      const target = BotNavigationSchema.parse({
        botId: params.botId,
        tab: params.tab ?? (params.conversationId ? "topics" : "details"),
        ...(params.conversationId ? { conversationId: params.conversationId } : {}),
        ...(params.messageId ? { messageId: params.messageId } : {}),
      });
      if (options.foreground?.() ?? BrowserWindow.getFocusedWindow())
        return { shown: false, reason: "foreground" };
      if (!Notification.isSupported()) return { shown: false, reason: "unsupported" };
      notices.get(params.botId)?.dispose();
      // Bound retained native handles even when a future multi-Bot caller produces many notices.
      if (notices.size >= 100) notices.values().next().value?.dispose();
      const clean = (text: string) =>
        options.redactor.redact(text).replace(/[\p{Cc}\p{Cf}]/gu, " ");
      let notification: Notification | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const dispose = () => {
        clearTimeout(timer);
        notices.delete(params.botId);
        notification?.removeAllListeners();
        notification?.close();
      };
      try {
        notification = new Notification({
          title: clean(params.title),
          body: [...clean(params.body)].slice(0, params.routineRunId ? 80 : 2000).join(""),
        });
        notification.once("click", () => {
          dispose();
          if (!shutdown.signal.aborted && !options.window?.isDestroyed())
            options.focusBot(target.botId, target.tab, target);
        });
        notification.once("close", dispose);
        notification.once("failed", () => {
          options.logger.warn("system notification unavailable");
          dispose();
        });
        notices.set(params.botId, { dispose });
        timer = setTimeout(dispose, 600_000);
        notification.show();
        return { shown: true };
      } catch {
        dispose();
        options.logger.warn("system notification unavailable");
        return { shown: false, reason: "failed" };
      }
    },
    dispose() {
      shutdown.abort();
      teams.dispose();
      options.window?.off("close", cancelPicker);
      options.window?.off("closed", cancelPicker);
      for (const notice of notices.values()) notice.dispose();
    },
  };
}
