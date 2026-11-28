import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { containsPath } from "@pibot/policy";
import { type Group, type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import {
  AuditRepo,
  GroupFoldersRepo,
  GroupWorkflowsRepo,
  type ManagedRecord,
  ManagedWorktreesRepo,
  transaction,
} from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import { auditLeaf, auditText } from "../../core/audit-fields.ts";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import { workspaceBoundary } from "../workplaces/workspace-boundary.ts";
import { selectGroupFolder } from "./group-folder-selection.ts";
import { groupWorkplace } from "./group-workplace.ts";

export class GroupFoldersService {
  private shutdown = new AbortController();
  private readonly pending = new Map<string, Promise<Group>>();
  constructor(private readonly service: GroupOrchestrationPort) {}
  present(group: Group): Group {
    const { userHome, platform } = this.service.deps.local.deps;
    const api = platform === "win32" ? path.win32 : path.posix;
    return {
      ...group,
      folders: group.folders?.map((folder) => ({
        ...folder,
        displayPath:
          folder.displayPath === folder.path &&
          !folder.location &&
          containsPath(userHome, folder.path, platform)
            ? `~${api.sep}${api.relative(userHome, folder.path)}`
            : folder.displayPath,
      })),
    };
  }
  private active(id: string) {
    this.shutdown.signal.throwIfAborted();
    if (this.service.changing(id)) throw new RpcError(-32011, "Group changing");
    return this.service.active(id);
  }
  add(
    id: string,
    create = false,
    remote: Pick<KernelMethodParams["groups.folders.add"], "location" | "path"> = {},
    parent?: AbortSignal,
  ) {
    if (this.pending.has(id) || this.pending.size >= 8)
      throw new RpcError(-32011, "Folder picker busy");
    this.active(id);
    const operation = this.pick(id, create, remote, parent)
      .catch((error: unknown) => {
        if (this.shutdown.signal.aborted) throw new RpcError(-32001, "Brain stopping");
        if (error instanceof RpcError) throw error;
        if (
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
        )
          throw new RpcError(-32602, "Group folder unavailable");
        throw error;
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, operation);
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(630_000)]);
    return abortable(operation, signal).catch((error: unknown) => {
      if (signal.aborted) throw new RpcError(-32001, "Folder request cancelled");
      throw error;
    });
  }
  private async pick(
    id: string,
    create: boolean,
    remote: Pick<KernelMethodParams["groups.folders.add"], "location" | "path">,
    parent?: AbortSignal,
  ) {
    const previous = this.active(id);
    const signal = AbortSignal.any([
      this.shutdown.signal,
      this.service.deps.local.shutdown.signal,
      AbortSignal.timeout(630_000),
      ...(parent ? [parent] : []),
    ]);
    const selected = await selectGroupFolder(this.service.deps.local, create, remote, signal);
    signal.throwIfAborted();
    if (!selected) return this.present(this.active(id));
    const sameDevice = (folder: NonNullable<Group["folders"]>[number]) =>
      folder.location === selected.location;
    const retained = (previous.folders ?? []).filter(sameDevice);
    const existing = retained.find((folder) => folder.path === selected.path);
    const choice = existing ?? {
      id: randomUUID(),
      name: selected.name,
      path: selected.path,
      displayPath: selected.displayPath,
      location: selected.location,
    };
    if (!existing && retained.length >= 32) throw new RpcError(-32602, "Group folder limit");
    const changingDevice = previous.folders?.some((folder) => !sameDevice(folder));
    const primary =
      changingDevice || (selected.location && !previous.primaryFolderId)
        ? choice.id
        : (previous.primaryFolderId ??
          (retained.length ||
          new GroupFoldersRepo(this.service.deps.db).identity(id).primaryInitialized
            ? null
            : choice.id));
    if (selected.location)
      await groupWorkplace(
        this.service.deps.local,
        previous.coordinatorBotId,
        {
          ...previous,
          folders: existing ? retained : [...retained, choice],
          primaryFolderId: primary,
        },
        signal,
      );
    signal.throwIfAborted();
    await this.service.mutate(
      id,
      () => {
        signal.throwIfAborted();
        const group = this.service.groups.get(id);
        if (!group || group.archivedAt || group.topicArchivedAt)
          throw new RpcError(-32602, "Group folder unavailable");
        if (
          group.conversationId !== previous.conversationId ||
          group.workspaceRevision !== previous.workspaceRevision ||
          group.coordinatorBotId !== previous.coordinatorBotId
        )
          throw new RpcError(-32602, "group_topic_stale");
        transaction(this.service.deps.db, () => {
          const repo = new GroupFoldersRepo(this.service.deps.db);
          this.retainDevice(group, selected.location);
          if (repo.add(id, selected.path, selected.location, selected.displayPath))
            this.audit(group, selected.path, "added");
          if (primary === choice.id) {
            const saved = repo
              .list(id)
              .find(
                (folder) => folder.location === selected.location && folder.path === selected.path,
              );
            if (!saved) throw new RpcError(-32602, "Group folder unavailable");
            repo.setPrimary(id, saved.id);
          }
          this.reconcile(id, group.primaryFolderId ?? null);
        });
        return this.service.groups.get(id) as Group;
      },
      "updated",
      false,
      false,
      // Replacing devices removes roots, so old plan runs must drain like an explicit removal.
      !changingDevice,
    );
    return this.present(this.active(id));
  }
  private retainDevice(group: Group, location?: string) {
    const repo = new GroupFoldersRepo(this.service.deps.db);
    for (const folder of group.folders ?? []) {
      if (folder.location === location) continue;
      repo.remove(group.id, folder.id);
      new GroupWorkflowsRepo(this.service.deps.db).revokeWorkplaces(group.id, folder.id);
      this.audit(group, folder.path, "removed");
    }
  }
  async remove(id: string, folderId: string) {
    const group = this.active(id);
    const folder = group.folders?.find((f) => f.id === folderId);
    if (!folder) throw new RpcError(-32602, "Unknown group folder");
    await this.service.mutate(
      id,
      () => {
        transaction(this.service.deps.db, () => {
          if (folder.location && group.primaryFolderId === folderId) this.retainDevice(group);
          if (new GroupFoldersRepo(this.service.deps.db).remove(id, folderId)) {
            new GroupWorkflowsRepo(this.service.deps.db).revokeWorkplaces(id, folderId);
            this.audit(group, folder.path, "removed");
          }
          this.reconcile(id, group.primaryFolderId ?? null);
        });
        const changed = this.service.groups.get(id);
        if (!changed) throw new RpcError(-32602, "Unknown group");
        return changed;
      },
      "updated",
    );
    return this.present(this.active(id));
  }
  async setPrimary(id: string, folderId: string | null) {
    const group = this.active(id);
    const folder = group.folders?.find((f) => f.id === folderId);
    if (folderId && !folder) throw new RpcError(-32602, "Unknown group folder");
    if (
      folder &&
      group.folders?.some(
        (f) =>
          f.id !== folderId &&
          f.location === folder.location &&
          containsPath(
            f.path,
            folder.path,
            folder.location
              ? this.service.deps.local.executionTargets.require(folder.location).platform
              : this.service.deps.local.deps.platform,
          ),
      )
    )
      throw new RpcError(-32602, "workspace_conflict");
    await this.service.mutate(
      id,
      () => {
        transaction(this.service.deps.db, () => {
          this.retainDevice(group, folder?.location);
          new GroupFoldersRepo(this.service.deps.db).setPrimary(id, folderId);
          if (folderId === null) new GroupWorkflowsRepo(this.service.deps.db).revokeWorkplaces(id);
          this.reconcile(id, group.primaryFolderId ?? null);
        });
        const changed = this.service.groups.get(id);
        if (!changed) throw new RpcError(-32602, "Unknown group");
        return changed;
      },
      "updated",
      false,
      false,
      folderId !== null,
    );
    return this.present(this.active(id));
  }
  private reconcile(id: string, previousPrimary: string | null) {
    if (new GroupFoldersRepo(this.service.deps.db).identity(id).primaryFolderId !== previousPrimary)
      new ManagedWorktreesRepo(this.service.deps.db).unbind(`group:${id}|`);
  }
  /** Only the managed registry adapter supplies this hook; no RPC accepts a filesystem path. */
  async bindManaged(
    id: string,
    folderPath: string,
    assertCurrent: () => void,
    recordReference: () => void,
    managed: { tree: ManagedRecord; restoreSource: boolean; signal: AbortSignal },
  ) {
    const group = this.active(id);
    const canonical = await realpath(folderPath);
    if (canonical !== folderPath || !(await stat(canonical)).isDirectory())
      throw new RpcError(-32602, "managed_root_changed");
    if (group.folders?.some((folder) => folder.location))
      throw new RpcError(-32601, "group_workspace_platform_unsupported");
    const paths = new Set(group.folders?.map((folder) => folder.path));
    paths.add(canonical);
    if (managed.restoreSource) paths.delete(managed.tree.path);
    else paths.add(managed.tree.sourcePath);
    const boundary = await workspaceBoundary(
      [...paths].map((path, index) => ({
        id: index === 0 ? "home" : randomUUID(),
        path,
        role: path === canonical ? "primary" : "readonly",
      })),
      group.workspaceRevision ?? 0,
      this.service.deps.local.deps.platform,
      managed.signal,
      managed.restoreSource ? undefined : managed.tree,
    );
    if (boundary.conflict !== "none") throw new RpcError(-32602, "workspace_conflict");
    await this.service.mutate(
      id,
      () => {
        transaction(this.service.deps.db, () => {
          assertCurrent();
          const folders = new GroupFoldersRepo(this.service.deps.db);
          if (!managed.restoreSource) folders.add(id, managed.tree.sourcePath);
          folders.add(id, canonical);
          const selected = folders.list(id).find((folder) => folder.path === canonical);
          if (!selected) throw new RpcError(-32602, "managed_root_changed");
          folders.setPrimary(id, selected.id);
          if (managed.restoreSource) {
            const previous = folders.list(id).find((folder) => folder.path === managed.tree.path);
            if (previous && folders.remove(id, previous.id))
              new GroupWorkflowsRepo(this.service.deps.db).revokeWorkplaces(id, previous.id);
          }
          this.reconcile(id, group.primaryFolderId ?? null);
          recordReference();
        });
        const changed = this.service.groups.get(id);
        if (!changed) throw new RpcError(-32602, "Unknown group");
        return changed;
      },
      "updated",
    );
  }
  private audit(group: Group, folderPath: string, action: "added" | "removed") {
    const { db, redactor } = this.service.deps;
    new AuditRepo(db, redactor).append({
      botId: group.coordinatorBotId,
      kind: `group.folder.${action}`,
      summary: action === "added" ? "Group folder associated" : "Group folder removed",
      detail: {
        groupId: group.id,
        groupName: auditText(group.name, redactor),
        target: auditLeaf(folderPath, redactor),
        actor: "user",
      },
    });
  }
  async stop() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending.values()]);
  }
  async drainInteractive() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending.values()]);
    this.shutdown = new AbortController();
  }
}
