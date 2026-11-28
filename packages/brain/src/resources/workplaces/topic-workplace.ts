import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationsRepo,
  ManagedWorktreesRepo,
  TopicsRepo,
  transaction,
} from "@pibot/storage";
import type { ChatService } from "../../conversations/chat/chat.ts";
import { auditText } from "../../core/audit-fields.ts";
import type { LocalService } from "../../local-service.ts";
import { workplaceUnavailableReason } from "./run-workplace.ts";

/** A topic owns its roots; changing another topic never changes this one's authority. */
export class TopicWorkplaceService {
  constructor(
    private readonly local: LocalService,
    private readonly chat: ChatService,
    private readonly signal: AbortSignal,
  ) {}
  private topic(botId: string, topicId: string) {
    const bot = new BotsRepo(this.local.deps.db).get(botId);
    if (!bot || bot.archivedAt) throw new RpcError(-32602, "Unknown active Bot");
    const topic = new ConversationsRepo(this.local.deps.db).get(topicId);
    if (topic?.kind !== "dm" || topic.botId !== botId || topic.archivedAt)
      throw new RpcError(-32602, "Unknown topic");
    return topic;
  }
  async get({ botId, topicId }: KernelMethodParams["topics.workplace.get"]) {
    this.topic(botId, topicId);
    const place = this.local.workplaces.topic(topicId);
    let runnerOffline = false;
    const workplace = await this.local.workplaces
      .context(botId, this.signal, place)
      .then((resolved) => resolved.value)
      .catch(async (error: unknown) => {
        if (workplaceUnavailableReason(error) !== "runner") throw error;
        // A runner that is away must not lock the topic onto it: the header showed "couldn't
        // load" with no picker, so the user could not move back (maintainers 2026-11-14). Show the
        // stored choice unresolved; runs still refuse until the runner returns or the user moves.
        runnerOffline = true;
        const registered = await this.local.workplaces.list(botId, this.signal);
        // The topic's own folders, hidden registry records included: without them a topic left
        // on a forgotten runner folder read as "Bot's own folder" on the phone (v0.0.2 B7).
        const ids = [
          place.selection.primary,
          ...place.selection.readonly,
          ...(place.selection.writable ?? []),
        ].filter((id) => id !== "home");
        const listed = new Set(registered.folders.map((folder) => folder.id));
        const own = [...this.local.workplaces.repo.folders(botId, ids).values()].filter(
          (folder) => !listed.has(folder.id),
        );
        return {
          ...registered,
          folders: [...own, ...registered.folders].slice(0, 200),
          currentId: place.selection.primary,
          revision: place.revision ?? 0,
        };
      });
    // A change while the folders were checked would show the old ones as current.
    if (this.local.workplaces.topic(topicId).revision !== place.revision)
      throw new RpcError(-32602, "topic_workplace_changed");
    return {
      topicId,
      folderId: place.selection.primary,
      revision: place.revision ?? 0,
      readonly: place.selection.readonly,
      writable: place.selection.writable ?? [],
      busy: this.chat.topicBusy(botId, topicId) || new TopicsRepo(this.local.deps.db).busy(topicId),
      workplace,
      ...(runnerOffline ? { runnerOffline } : {}),
    };
  }
  /**
   * An ACP client continues an existing topic instead of opening a new one. The topic must be
   * this Bot's private topic, not archived, and the client's working directory must be one of the
   * topic's folders — otherwise the client would silently work somewhere else than the topic says.
   * Fixed codes keep the topic's title and content out of the error.
   */
  async attach({ botId, topicId, cwd }: KernelMethodParams["topics.acp.attach"]) {
    const bot = new BotsRepo(this.local.deps.db).get(botId);
    if (!bot || bot.archivedAt) throw new RpcError(-32602, "topic_not_found");
    const topic = new ConversationsRepo(this.local.deps.db).get(topicId);
    if (!topic) throw new RpcError(-32602, "topic_not_found");
    if (topic.kind !== "dm" || topic.botId !== botId) throw new RpcError(-32602, "topic_wrong_bot");
    if (topic.archivedAt) throw new RpcError(-32602, "topic_archived");
    const place = this.local.workplaces.topic(topicId);
    const resolved = await this.local.workplaces.context(botId, this.signal, place);
    // Folder paths are stored canonical (workplaces.pick realpaths them), so the client's path
    // must be canonical too or a symlinked worktree would look like a different folder.
    const canonical = await realpath(cwd).catch(() => resolve(cwd));
    const byId = new Map(resolved.value.folders.map((folder) => [folder.id, folder.path]));
    const paths = [
      place.selection.primary,
      ...place.selection.readonly,
      ...(place.selection.writable ?? []),
    ].map((id) => (id === "home" ? resolved.value.home : byId.get(id)));
    if (!paths.includes(canonical)) throw new RpcError(-32602, "topic_folder_mismatch");
    return { topicId };
  }
  async initial({ botId }: KernelMethodParams["topics.workplace.initial"]) {
    const bot = new BotsRepo(this.local.deps.db).get(botId);
    if (!bot || bot.archivedAt) throw new RpcError(-32602, "Unknown active Bot");
    const selection = this.local.workplaces.initial(botId);
    // A moved or removed previous folder must not block a new topic: offer the Bot's own folder.
    const resolved = await this.local.workplaces
      .context(botId, this.signal, { selection })
      .catch((error: unknown) => {
        if (error instanceof RpcError || (error as { code?: unknown } | null)?.code) return null;
        throw error;
      });
    if (resolved) return { selection, workplace: resolved.value };
    const home = { primary: "home" as const, readonly: [] };
    const fallback = await this.local.workplaces.context(botId, this.signal, { selection: home });
    return { selection: home, workplace: fallback.value };
  }
  /** Sets the primary folder only (older clients; `null` = the Bot's own folder). */
  async set({ botId, topicId, folderId }: KernelMethodParams["topics.workplace.set"]) {
    this.topic(botId, topicId);
    const current = this.local.workplaces.topic(topicId).selection;
    const primary = folderId ?? "home";
    return this.update({
      botId,
      topicId,
      selection: {
        primary,
        readonly: current.readonly.filter((id) => id !== primary),
        writable: (current.writable ?? []).filter((id) => id !== primary),
      },
    });
  }
  async update(
    { botId, topicId, selection, acpSession }: KernelMethodParams["topics.workplace.update"],
    trusted?: { assertCurrent(): void; recordReference(): void },
    parent = this.signal,
  ) {
    const signal = AbortSignal.any([parent, this.signal, AbortSignal.timeout(20_000)]);
    this.topic(botId, topicId);
    const repo = new TopicsRepo(this.local.deps.db);
    if (repo.busy(topicId)) throw new RpcError(-32011, "topic_workplace_busy");
    return this.chat.changeTopicWorkplace(botId, topicId, async () => {
      const before = this.local.workplaces.topic(topicId);
      // Older clients have no writable field: omission preserves explicit existing associations.
      selection = {
        ...selection,
        writable:
          selection.writable ??
          (before.selection.writable ?? []).filter(
            (id) => id !== selection.primary && !selection.readonly.includes(id),
          ),
      };
      // A live sandbox keeps its frozen write roots until the process really exits.
      const revokesWritable = (before.selection.writable ?? []).some(
        (id) => id !== selection.primary && !selection.writable?.includes(id),
      );
      const assertBackgroundDrained = () => {
        if (revokesWritable && this.local.background.topicBusy(topicId))
          throw new RpcError(-32011, "topic_workplace_busy");
      };
      assertBackgroundDrained();
      const place = await this.local.workplaces.context(botId, signal, { selection });
      if (place.boundary.conflict !== "none") throw new RpcError(-32602, "workspace_conflict");
      signal.throwIfAborted();
      transaction(this.local.deps.db, () => {
        signal.throwIfAborted();
        this.topic(botId, topicId);
        trusted?.assertCurrent();
        if (repo.busy(topicId)) throw new RpcError(-32011, "topic_workplace_busy");
        assertBackgroundDrained();
        if (this.local.workplaces.topic(topicId).revision !== before.revision)
          throw new RpcError(-32602, "topic_workplace_changed");
        try {
          repo.setFolders(botId, topicId, selection, { acpSession });
          if (before.selection.primary !== selection.primary)
            new ManagedWorktreesRepo(this.local.deps.db).unbind(`dm:${botId}|${topicId}`);
          const oldRoots = new Set(before.selection.writable ?? []);
          const nextRoots = new Set(selection.writable ?? []);
          for (const id of new Set([...oldRoots, ...nextRoots])) {
            if (oldRoots.has(id) === nextRoots.has(id)) continue;
            const folder = this.local.workplaces.repo.folders(botId, [id]).get(id);
            this.local.approvals.audit.append({
              botId,
              kind: nextRoots.has(id) ? "topic.folder.added" : "topic.folder.removed",
              summary: nextRoots.has(id)
                ? "Topic writable folder added / 话题追加可写文件夹"
                : "Topic writable folder removed / 话题移除可写文件夹",
              detail: {
                actor: "user",
                conversationId: topicId,
                reasonCode: "topic_writable",
                path: auditText(folder?.path ?? "", this.local.deps.redactor, 4096),
              },
            });
          }
          trusted?.recordReference();
        } catch (error) {
          if (error instanceof TypeError) throw new RpcError(-32602, error.message);
          throw error;
        }
      });
      // Awaited callers receive authoritative metadata. Side effects are never automatically resent.
      this.local.deps.peer.emit("sidebar.changed", { conversationKey: `dm:${botId}` });
      this.local.deps.peer.emit("changes.changed", {
        conversationKey: `dm:${botId}`,
        topicId,
        reason: "folder",
      });
      const after = this.local.workplaces.topic(topicId);
      return {
        topicId,
        folderId: after.selection.primary,
        revision: after.revision ?? 0,
        readonly: after.selection.readonly,
        writable: after.selection.writable ?? [],
        busy: false,
        workplace: place.value,
      };
    });
  }
}
