import { createPeer, GuiHostMethods, type Port, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { type BrowserWindow, dialog, shell } from "electron";
import { folderDialogOptions, skillDialogOptions } from "../host/host-capabilities.ts";
import { revealFile } from "../host/reveal-file.ts";
import { teamExportFilename } from "../host/team-file-io.ts";

export function createGuiHost(
  window: BrowserWindow,
  port: Port,
  takeSkillDrop: (params: { dropId: string }) => string[] | null,
  setUpdateProxy: (url: string | null | undefined) => Promise<void>,
) {
  const peer = createPeer(port, { methods: GuiHostMethods, events: {} });
  const lifetime = new AbortController();
  let busy = false,
    closed = false;
  const check = () => {
    if (closed || window.isDestroyed()) throw new RpcError(RpcErrorCodes.closed, "gui_offline");
  };
  peer.handle("gui.updates.proxy", async ({ url }) => {
    check();
    await setUpdateProxy(url);
    return null;
  });
  peer.handle("gui.pick", async (params) => {
    const { kind, defaultName } = params;
    check();
    if (busy) throw new RpcError(RpcErrorCodes.busy, "gui_dialog_busy");
    busy = true;
    try {
      if (kind === "team-save") {
        const result = await dialog.showSaveDialog(window, {
          defaultPath: teamExportFilename(defaultName),
          filters: [{ name: "Pi Bot", extensions: ["pibot"] }],
          properties: ["showOverwriteConfirmation"],
        });
        check();
        return result.canceled ? null : (result.filePath ?? null);
      }
      const result = await dialog.showOpenDialog(
        window,
        kind === "folder" || kind === "folder-create"
          ? folderDialogOptions(kind === "folder-create", params.defaultPath)
          : kind === "plugin-folder"
            ? { properties: ["openDirectory"] }
            : kind === "skill-import"
              ? skillDialogOptions
              : kind === "file"
                ? {
                    properties: ["openFile"],
                    defaultPath: params.defaultPath,
                    ...(params.filters?.length ? { filters: params.filters } : {}),
                  }
                : kind === "plugin-file"
                  ? {
                      properties: ["openFile"],
                      filters: [{ name: "Plugin or JSON", extensions: ["zip", "json"] }],
                    }
                  : {
                      properties: ["openFile"],
                      filters: [{ name: "Pi Bot", extensions: ["pibot"] }],
                    },
      );
      check();
      return result.canceled ? null : (result.filePaths[0] ?? null);
    } finally {
      busy = false;
    }
  });
  peer.handle("gui.skills.takeDrop", async (params) => {
    check();
    return takeSkillDrop(params);
  });
  peer.handle("gui.openPath", async ({ path }) => {
    check();
    const error = await shell.openPath(path);
    if (error) throw new RpcError(RpcErrorCodes.internal, "path_open_failed");
    return null;
  });
  peer.handle("gui.confirm", async (params, context) => {
    check();
    if (busy) throw new RpcError(RpcErrorCodes.busy, "gui_dialog_busy");
    busy = true;
    try {
      // Same native, window-modal dialog the owner shows when it has the window itself.
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        noLink: true,
        ...params,
        signal: AbortSignal.any([lifetime.signal, context.signal]),
      });
      context.signal.throwIfAborted();
      check();
      return { response: result.response };
    } finally {
      busy = false;
    }
  });
  peer.handle("gui.revealPath", async ({ path }) => {
    await revealFile(path, check, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]));
    return null;
  });
  peer.handle("gui.openExternal", async ({ url }) => {
    check();
    const parsed = new URL(url);
    if (parsed.username || parsed.password)
      throw new RpcError(RpcErrorCodes.invalidParams, "url_credentials");
    await shell.openExternal(url);
    return null;
  });
  return {
    dispose() {
      closed = true;
      lifetime.abort();
      peer.dispose();
    },
  };
}
