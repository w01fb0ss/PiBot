// Owns committed group topic selection and its workspace bindings.

import { randomUUID } from "node:crypto";
import {
  abortable,
  type DispatchTopicOptions,
  GroupTopicFolderChoices,
  groupWorkplace,
  verifyDispatchFolder,
  workspaceBoundary,
} from "@pibot/brain/orchestration-kit";
import { type Group, type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import {
  ConversationsRepo,
  GroupAcpRepo,
  GroupTopicsRepo,
  type ManagedIdentity,
  type ManagedRecord,
  ManagedWorktreesRepo,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
export class GroupTopicsService {
  readonly repo: GroupTopicsRepo;
  private readonly choices: GroupTopicFolderChoices;
  private readonly shutdown = new AbortController();
  constructor(private readonly service: GroupService) {
    this.repo = new GroupTopicsRepo(service.deps.db);
    this.choices = new GroupTopicFolderChoices(service, this.shutdown);
  }
  private idle(groupId: string) {
    const { chat, local } = this.service.deps;
    if (!this.service.interactive) throw new RpcError(-32001, "Interactive client unavailable");
    if (
      this.service.changing(groupId) ||
      chat.queue.resources().contexts.some((r) => r.groupId === groupId) ||
      this.repo.busy(groupId)
    )
      throw new RpcError(-32011, "group_topic_busy");
    this.shutdown.signal.throwIfAborted();
    local.shutdown.signal.throwIfAborted();
  }
  list(params: KernelMethodParams["groups.topics.list"]) {
    this.required(params.groupId);
    return this.repo.list(params.groupId, {
      before: params.before,
      limit: params.limit,
      query: params.query,
      archived: params.archived,
    });
  }
  history(params: KernelMethodParams["groups.topics.history"]) {
    this.topic(params.groupId, params.topicId);
    this.service.deps.chat.openConversation(params.topicId);
    return new MessagesRepo(this.service.deps.db).list(params.topicId, {
      before: params.before,
      limit: params.limit,
    });
  }
  private topic(groupId: string, topicId: string) {
    try {
      return this.repo.get(groupId, topicId);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new RpcError(-32602, "group_topic_unavailable");
    }
  }
  rename({ groupId, topicId, title }: KernelMethodParams["groups.topics.rename"]) {
    const topic = this.topic(groupId, topicId);
    if (topic.archivedAt) throw new RpcError(-32602, "group_topic_unavailable");
    const result = transaction(this.service.deps.db, () => {
      const value = this.repo.rename(groupId, topicId, this.service.deps.redactor.redact(title));
      this.audit(groupId, topicId, "group.topic.renamed");
      return value;
    });
    this.invalidateList(groupId);
    this.service.changed(groupId, "updated");
    return result;
  }
  restore({ groupId, topicId }: KernelMethodParams["groups.topics.restore"]) {
    this.topic(groupId, topicId);
    const result = transaction(this.service.deps.db, () => {
      const value = this.repo.restore(groupId, topicId);
      this.audit(groupId, topicId, "group.topic.restored");
      return value;
    });
    this.invalidateList(groupId);
    this.service.changed(groupId, "updated");
    return result;
  }
  async switch(
    { groupId, topicId }: KernelMethodParams["groups.topics.switch"],
    parent?: AbortSignal,
  ) {
    const signal = this.requestSignal(parent);
    signal.throwIfAborted();
    const target = this.topic(groupId, topicId);
    if (target.archivedAt) throw new RpcError(-32602, "group_topic_unavailable");
    if (this.required(groupId).conversationId === topicId)
      return this.service.folders.present(this.required(groupId));
    this.idle(groupId);
    const previous = this.required(groupId);
    await this.validateRemote(previous, target.folders, target.primaryFolderId, signal);
    const binding = await this.binding(previous, target.folders, target.primaryFolderId);
    this.idle(groupId);
    await this.service.mutate(
      groupId,
      () =>
        transaction(this.service.deps.db, () => {
          this.assertSource(groupId, previous);
          signal.throwIfAborted();
          if (this.topic(groupId, topicId).archivedAt)
            throw new RpcError(-32602, "group_topic_unavailable");
          this.repo.snapshot(groupId, previous.conversationId);
          this.repo.activate(groupId, topicId);
          this.service.cycles.reset(groupId);
          this.bind(groupId, binding);
          this.audit(groupId, topicId, "group.topic.switched");
          return this.required(groupId);
        }),
      "updated",
      false,
      true,
    );
    this.service.deps.local.memoryExtraction?.boundary(previous.conversationId);
    return this.service.folders.present(this.required(groupId));
  }
  async archive(
    { groupId, topicId }: KernelMethodParams["groups.topics.archive"],
    options?: { requireInactive: true },
  ) {
    const target = this.topic(groupId, topicId);
    if (target.archivedAt) return this.service.folders.present(this.required(groupId));
    this.idle(groupId);
    await this.service.mutate(
      groupId,
      () =>
        transaction(this.service.deps.db, () => {
          // ACP compensation must not invalidate the live projection if restoring its
          // predecessor failed, or a user selected this topic while cleanup was awaiting.
          if (options?.requireInactive && this.required(groupId).conversationId === topicId)
            throw new RpcError(-32602, "group_topic_stale");
          if (this.required(groupId).conversationId === topicId) {
            this.repo.snapshot(groupId, topicId);
            this.service.cycles.reset(groupId);
          }
          new ConversationsRepo(this.service.deps.db).archive(topicId);
          // Saved group references of this topic leave the Bots' session files; a
          // restored topic starts from a fresh reference.
          this.service.purge.enqueue({
            groupId,
            botId: this.required(groupId).coordinatorBotId,
            conversationId: topicId,
            reason: "topic_archived",
          });
          this.audit(groupId, topicId, "group.topic.archived");
          return this.required(groupId);
        }),
      "updated",
      false,
      true,
    );
    this.invalidateList(groupId);
    await this.service.purge.sweep();
    return this.service.folders.present(this.required(groupId));
  }
  private invalidateList(groupId: string) {
    this.service.deps.peer.emit("sidebar.topicsChanged", { conversationKey: `group:${groupId}` });
  }
  pickFolder(
    { groupId, location, path }: KernelMethodParams["groups.topics.pickFolder"],
    signal?: AbortSignal,
  ) {
    this.required(groupId);
    return this.choices.pick(groupId, { location, path }, signal);
  }
  async create(
    params: KernelMethodParams["groups.topics.create"],
    parent?: AbortSignal,
    dispatch?: DispatchTopicOptions,
  ) {
    const signal = this.requestSignal(parent);
    signal.throwIfAborted();
    const { groupId, requestId } = params;
    this.idle(groupId);
    const previous = this.required(groupId),
      duplicate = requestId ? this.repo.created(groupId, requestId) : undefined;
    if (duplicate) {
      if (previous.conversationId !== duplicate) throw new RpcError(-32602, "group_topic_stale");
      return this.service.folders.present(previous);
    }
    let choiceId = params.folderChoiceId;
    if (params.selectFolder) {
      const picked = await this.pickFolder({ groupId }, signal);
      if (!picked) return previous;
      choiceId = picked.choiceId;
    }
    const choice = choiceId ? this.choices.get(choiceId) : undefined;
    if (choiceId && (!choice || choice.groupId !== groupId || choice.expires < Date.now()))
      throw new RpcError(-32602, "group_topic_folder_expired");
    if (choice) await this.choices.verify(choice, signal);
    let selectionFolders:
        | Pick<NonNullable<Group["folders"]>[number], "id" | "path" | "location" | "displayPath">[]
        | undefined,
      primary: string | null = null;
    if (params.selection) {
      if (params.selection.writable?.length)
        throw new RpcError(-32602, "runner_writable_unsupported");
      const ids = [
        ...new Set([
          ...(params.selection.primary === "home" ? [] : [params.selection.primary]),
          ...params.selection.readonly,
        ]),
      ];
      if (ids.length > 32) throw new RpcError(-32602, "Group folder limit");
      selectionFolders = [];
      for (const id of ids) {
        const existing = previous.folders?.find((folder) => folder.id === id),
          picked = this.choices.get(id);
        if (existing)
          selectionFolders.push({
            id,
            path: existing.path,
            location: existing.location,
            displayPath: existing.displayPath,
          });
        else if (picked?.groupId === groupId && picked.expires >= Date.now()) {
          await this.choices.verify(picked, signal);
          selectionFolders.push({
            id,
            path: picked.path,
            location: picked.location,
            displayPath: picked.displayPath,
          });
        } else throw new RpcError(-32602, "group_topic_folder_expired");
      }
      primary = params.selection.primary === "home" ? null : params.selection.primary;
      const selected = selectionFolders.find((folder) => folder.id === primary);
      if (selected && !selectionFolders.some((folder) => folder.location)) {
        const boundary = await workspaceBoundary(
          selectionFolders.map((folder) => ({
            ...folder,
            role: folder.id === primary ? "primary" : "readonly",
          })),
          0,
          this.service.deps.local.deps.platform,
          AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20000)]),
          new ManagedWorktreesRepo(this.service.deps.db).byPath(selected.path),
        );
        if (boundary.conflict !== "none") throw new RpcError(-32602, "workspace_conflict");
      }
    }
    if (dispatch?.folder) {
      const folder = dispatch.folder;
      const existing = previous.folders?.find(
        (entry) => !entry.location && entry.path === folder.path,
      );
      primary = existing?.id ?? randomUUID();
      selectionFolders = [
        {
          id: primary,
          path: folder.path,
          displayPath: existing?.displayPath ?? folder.path,
        },
      ];
    }
    const finalFolders =
      selectionFolders ??
      (choice
        ? [
            {
              id: choiceId as string,
              path: choice.path,
              location: choice.location,
              displayPath: choice.displayPath,
            },
          ]
        : params.inheritWorkspace === false
          ? []
          : (previous.folders ?? []));
    const finalPrimary = selectionFolders
      ? primary
      : choice
        ? (choiceId as string)
        : params.inheritWorkspace === false
          ? null
          : (previous.primaryFolderId ?? null);
    await this.validateRemote(previous, finalFolders, finalPrimary, signal);
    const binding = await this.binding(previous, finalFolders, finalPrimary);
    if (dispatch?.folder)
      await verifyDispatchFolder(
        this.service.deps.local,
        previous.coordinatorBotId,
        dispatch.folder,
        signal,
      );
    this.idle(groupId);
    this.assertSource(groupId, previous);
    const created = (await this.service.mutate(
      groupId,
      () =>
        transaction(this.service.deps.db, () => {
          this.assertSource(groupId, previous);
          dispatch?.assertCurrent();
          signal.throwIfAborted();
          this.repo.snapshot(groupId, previous.conversationId);
          if (selectionFolders || choice)
            this.repo.setWorkspace(groupId, finalFolders, finalPrimary);
          else if (choice || params.inheritWorkspace === false) this.repo.resetWorkspace(groupId);
          const topic = new ConversationsRepo(this.service.deps.db).createGroup(groupId);
          if (dispatch) {
            this.repo.rename(groupId, topic.id, dispatch.title);
            dispatch.recordWorkplace?.(topic.id);
            dispatch.recordModels?.(topic.id);
          }
          if (requestId) this.repo.recordCreation(groupId, requestId, topic.id);
          this.service.cycles.reset(groupId);
          this.bind(groupId, binding);
          this.audit(groupId, topic.id, "group.topic.created");
          return this.required(groupId);
        }),
      "updated",
      false,
      true,
    )) as Group;
    if (created.conversationId !== previous.conversationId)
      this.service.deps.local.memoryExtraction?.boundary(previous.conversationId);
    return created;
  }
  /** Only short-lived group picker choices reach ACP; client paths never enter folder tables. */
  async acpSelection(
    groupId: string,
    selection: { primary: string; readonly: string[] },
    signal: AbortSignal,
  ) {
    const ids = [selection.primary, ...selection.readonly];
    if (new Set(ids).size !== ids.length || ids.length > 21)
      throw new RpcError(-32602, "group_acp_folder_invalid");
    const roots = [];
    for (const id of ids) {
      const choice = this.choices.get(id);
      if (!choice || choice.location || choice.groupId !== groupId || choice.expires < Date.now())
        throw new RpcError(-32602, "group_topic_folder_expired");
      await abortable(this.choices.verify(choice, signal), signal);
      signal.throwIfAborted();
      roots.push({ id, path: choice.path, device: choice.device, inode: choice.inode });
    }
    return roots;
  }
  async acpRebind(
    groupId: string,
    topicId: string,
    selection: { primary: string; readonly: string[] },
    signal: AbortSignal,
  ) {
    this.idle(groupId);
    if (!this.repo.isAcp(groupId, topicId)) throw new RpcError(-32602, "group_acp_topic_required");
    const previous = this.required(groupId);
    if (previous.conversationId !== topicId) throw new RpcError(-32602, "group_topic_stale");
    const roots = await this.acpSelection(groupId, selection, signal);
    const boundary = await workspaceBoundary(
      roots.map((root) => ({
        ...root,
        role: root.id === selection.primary ? ("primary" as const) : ("readonly" as const),
      })),
      previous.workspaceRevision ?? 0,
      this.service.deps.local.deps.platform,
      AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20000)]),
    );
    if (boundary.conflict !== "none") throw new RpcError(-32602, "workspace_conflict");
    const binding = await this.binding(previous, roots, selection.primary);
    this.idle(groupId);
    signal.throwIfAborted();
    await this.service.mutate(
      groupId,
      () =>
        transaction(this.service.deps.db, () => {
          signal.throwIfAborted();
          this.assertSource(groupId, previous);
          this.repo.setWorkspace(
            groupId,
            roots,
            selection.primary,
            (previous.workspaceRevision ?? 0) + 1,
          );
          this.repo.snapshot(groupId, topicId);
          new GroupAcpRepo(this.service.deps.db).setRoots(topicId, roots);
          this.bind(groupId, binding);
          return this.required(groupId);
        }),
      "updated",
      false,
      true,
    );
  }
  private assertSource(groupId: string, expected: Group) {
    const current = this.required(groupId);
    if (
      current.conversationId !== expected.conversationId ||
      current.coordinatorBotId !== expected.coordinatorBotId ||
      current.workspaceRevision !== expected.workspaceRevision
    )
      throw new RpcError(-32602, "group_topic_stale");
  }
  private requestSignal(parent?: AbortSignal) {
    return AbortSignal.any([
      this.shutdown.signal,
      this.service.deps.local.shutdown.signal,
      ...(parent ? [parent] : []),
    ]);
  }
  private async validateRemote(
    group: Group,
    folders: Pick<NonNullable<Group["folders"]>[number], "id" | "path" | "location">[],
    primary: string | null,
    parent: AbortSignal,
  ) {
    parent.throwIfAborted();
    if (!folders.some((folder) => folder.location)) return;
    const place = await groupWorkplace(
      this.service.deps.local,
      group.coordinatorBotId,
      {
        ...group,
        folders: folders.map((folder) => ({
          ...folder,
          name: folder.path,
          displayPath: folder.path,
        })),
        primaryFolderId: primary,
      },
      AbortSignal.any([
        parent,
        this.shutdown.signal,
        this.service.deps.local.shutdown.signal,
        AbortSignal.timeout(20_000),
      ]),
    );
    if (place.boundary.conflict !== "none") throw new RpcError(-32602, "workspace_conflict");
  }
  private async binding(
    group: Group,
    folders: Pick<NonNullable<Group["folders"]>[number], "id" | "path" | "location">[],
    primary: string | null,
  ) {
    const registry = new ManagedWorktreesRepo(this.service.deps.db);
    const selected = folders.find((folder) => folder.id === primary);
    const tree = selected && !selected.location ? registry.byPath(selected.path) : undefined;
    if (!tree || tree.botId !== group.coordinatorBotId || registry.taskOwned(tree.id))
      return undefined;
    const actual = await this.service.memberWorktrees.verify(
      tree,
      AbortSignal.any([
        this.shutdown.signal,
        this.service.deps.local.shutdown.signal,
        AbortSignal.timeout(20000),
      ]),
    );
    return { tree, identity: actual.root };
  }
  private bind(
    groupId: string,
    binding: { tree: ManagedRecord; identity: ManagedIdentity } | undefined,
  ) {
    const registry = new ManagedWorktreesRepo(this.service.deps.db),
      key = `group:${groupId}|`;
    registry.unbind(key);
    if (!binding) return;
    const current = registry.get(binding.tree.id);
    if (current?.state !== "ready" || current.version !== binding.tree.version)
      throw new RpcError(-32602, "group_topic_stale");
    registry.bind(key, binding.tree.botId, binding.tree.id, binding.identity);
  }
  private audit(
    groupId: string,
    conversationId: string,
    kind:
      | "group.topic.archived"
      | "group.topic.created"
      | "group.topic.restored"
      | "group.topic.renamed"
      | "group.topic.switched",
  ) {
    this.service.deps.local.approvals.audit.append({
      botId: this.required(groupId).coordinatorBotId,
      kind,
      summary: "Group topic updated",
      detail: { groupId, conversationId, actor: "user" },
    });
  }
  private required(groupId: string) {
    const group = this.service.groups.get(groupId);
    if (!group) throw new RpcError(-32602, "Unknown group");
    return group;
  }
  async stop() {
    this.shutdown.abort();
    await this.choices.drain();
    this.choices.clear();
  }
}
