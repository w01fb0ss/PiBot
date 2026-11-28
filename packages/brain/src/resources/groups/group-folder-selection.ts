import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileIdentity, samePathSpelling, windowsPathName } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import type { LocalService } from "../../local-service.ts";
import { assertWritableFolders } from "../workplaces/writable-folders.ts";

type Remote = Pick<KernelMethodParams["groups.topics.pickFolder"], "location" | "path">;

/** The UI picker registers a directory; it grants no model read or write capability. */
export async function selectGroupFolder(
  local: LocalService,
  create: boolean,
  remote: Remote,
  parent: AbortSignal,
) {
  if (remote.location) {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
    const entry = local.executionTargets.require(remote.location);
    const paths = entry.platform === "win32" ? path.win32 : path.posix;
    if (
      !remote.path ||
      create ||
      !paths.isAbsolute(remote.path) ||
      /[\p{Cc}\p{Cf}]/u.test(remote.path)
    )
      throw new RpcError(-32602, "runner_folder_invalid");
    const canonical = await entry.target.canonicalizePath(remote.path, remote.path, signal);
    if (!canonical.device || !canonical.inode) throw new RpcError(-32602, "runner_folder_invalid");
    await entry.target.listDir({
      path: canonical.path,
      cwd: canonical.path,
      expectedPath: canonical.path,
      writeRoots: [],
      rootIdentities: [
        {
          canonicalPath: canonical.path,
          device: canonical.device,
          inode: canonical.inode,
          role: "readonly",
        },
      ],
      signal,
    });
    signal.throwIfAborted();
    if (local.executionTargets.require(remote.location) !== entry)
      throw new RpcError(-32602, "execution_target_changed");
    return {
      path: canonical.path,
      name: paths.basename(canonical.path) || canonical.path,
      displayPath: canonical.path,
      location: remote.location,
      device: canonical.device,
      inode: canonical.inode,
    };
  }
  if (remote.path) throw new RpcError(-32602, "runner_folder_invalid");
  const { host, platform, dataDir } = local.deps;
  if (!host.pickFolder) throw new RpcError(-32603, "Folder picker unavailable");
  const selected = await host.pickFolder(parent, { create });
  parent.throwIfAborted();
  if (!selected) return null;
  if (!path.isAbsolute(selected) || /[\p{Cc}\p{Cf}]/u.test(selected))
    throw new RpcError(-32602, "Invalid folder");
  const canonical = await realpath(selected);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory() || containsPath(await realpath(dataDir), canonical, platform))
    throw new RpcError(-32602, "Group folder unavailable");
  const displayPath = platform === "win32" ? windowsPathName(selected).path : canonical;
  if (!samePathSpelling(displayPath, canonical))
    await assertWritableFolders(local.deps, [canonical], dataDir, parent);
  parent.throwIfAborted();
  return {
    path: canonical,
    displayPath,
    name: path.basename(canonical) || canonical,
    location: undefined,
    ...fileIdentity(info),
  };
}
