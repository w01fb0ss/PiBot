import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { samePathSpelling } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import { abortable } from "../../core/abort.ts";
import type { LocalService } from "../../local-service.ts";
import { workspaceBoundary } from "./workspace-boundary.ts";
import { assertWritableFolders } from "./writable-folders.ts";

export type DispatchFolder = {
  source: string;
  path: string;
  name: string;
  device: string;
  inode: string;
};

/** A dispatch card can consent to one local directory on the same host as the folder picker. */
export async function resolveDispatchFolder(
  local: LocalService,
  input: string,
  botId: string,
  remotePaths: readonly string[],
  parent: AbortSignal,
): Promise<DispatchFolder> {
  const { platform, userHome, executionLocation } = local.deps;
  const api = platform === "win32" ? path.win32 : path.posix;
  const homePath = platform === "win32" ? /^~[\\/]/u : /^~\//u;
  const absolute = platform === "win32" ? /^[a-z]:[\\/]/iu : /^\//u;
  if (
    executionLocation?.target.startsWith("runner:") ||
    /^runner:/iu.test(input) ||
    /^\\\\/u.test(input)
  )
    throw new RpcError(-32602, "dispatch_folder_runner");
  if (
    input.length > 1024 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) ||
    (input !== "~" && !homePath.test(input) && !absolute.test(input))
  )
    throw new RpcError(-32602, "dispatch_folder_invalid");
  // Drive-relative, UNC/device names and alternate streams are not directory choices.
  if (platform === "win32" && input.slice(input.startsWith("~") ? 1 : 2).includes(":"))
    throw new RpcError(-32602, "dispatch_folder_invalid");
  const source =
    input === "~" ? userHome : homePath.test(input) ? api.join(userHome, input.slice(2)) : input;
  if (
    remotePaths.some((root) => {
      const remotePlatform = /^[a-z]:[\\/]|^\\\\/iu.test(root) ? "win32" : "linux";
      return (
        containsPath(root, input, remotePlatform) || containsPath(root, source, remotePlatform)
      );
    })
  )
    throw new RpcError(-32602, "dispatch_folder_runner");
  const signal = AbortSignal.any([parent, local.shutdown.signal, AbortSignal.timeout(10_000)]);
  try {
    const canonical = await abortable(realpath(source), signal);
    if (!absolute.test(canonical)) throw new RpcError(-32602, "dispatch_folder_runner");
    if (!(await abortable(stat(canonical), signal)).isDirectory())
      throw new RpcError(-32602, "dispatch_folder_missing");
    const home = local.workplaces.repo.home(botId);
    await assertWritableFolders(local.deps, [source, canonical], home, signal);
    await abortable(
      access(canonical, constants.R_OK | (platform === "win32" ? 0 : constants.X_OK)),
      signal,
    );
    const boundary = await workspaceBoundary(
      [{ id: "home", path: canonical, role: "primary" }],
      0,
      platform,
      signal,
    );
    const root = boundary.roots[0];
    if (!root?.device || !root.inode) throw new RpcError(-32602, "dispatch_folder_invalid");
    return {
      source,
      path: root.canonicalPath,
      name: api.basename(root.canonicalPath) || root.canonicalPath,
      device: root.device,
      inode: root.inode,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RpcError) throw error;
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new RpcError(-32602, "dispatch_folder_missing");
    if (code === "EACCES" || code === "EPERM" || code === "ELOOP")
      throw new RpcError(-32602, "dispatch_folder_unreadable");
    throw error;
  }
}

export async function verifyDispatchFolder(
  local: LocalService,
  botId: string,
  folder: DispatchFolder,
  signal: AbortSignal,
) {
  const current = await resolveDispatchFolder(local, folder.source, botId, [], signal);
  if (
    !samePathSpelling(current.path, folder.path) ||
    current.device !== folder.device ||
    current.inode !== folder.inode
  )
    throw new RpcError(-32602, "workspace_boundary_changed");
}

export interface DispatchTopicOptions {
  title: string;
  folder?: DispatchFolder;
  assertCurrent(): void;
  recordWorkplace?(conversationId: string): void;
  model?: import("@pibot/protocol-base").ModelOverride;
  recordModels?(conversationId: string): void;
  signal: AbortSignal;
}
