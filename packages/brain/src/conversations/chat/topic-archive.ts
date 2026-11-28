import { type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import { ConversationsRepo, TopicsRepo, transaction } from "@pibot/storage";
import type { LocalService } from "../../local-service.ts";
import type { ChatService } from "./chat.ts";

/** Archiving changes visibility, never task lifetime or retention of the conversation. */
export class TopicArchiveService {
  constructor(
    private readonly local: LocalService,
    private readonly chat: ChatService,
    private readonly signal: AbortSignal,
    private readonly activeBot: (botId: string) => unknown,
  ) {}

  private topic(botId: string, topicId: string) {
    this.signal.throwIfAborted();
    this.activeBot(botId);
    const repo = new ConversationsRepo(this.local.deps.db);
    const topic = repo.get(topicId);
    if (topic?.kind !== "dm" || topic.botId !== botId || repo.isInternal(topicId))
      throw new RpcError(-32602, "topic_unavailable");
    if (topic.routineId && this.routineLive(topic.routineId))
      throw new RpcError(-32602, "topic_archive_routine");
    return topic;
  }

  // A deleted routine leaves its topic behind as an ordinary one. Without an owner we cannot tell,
  // so the topic stays pinned as before rather than hiding a task's only conversation.
  private routineLive(routineId: string) {
    const owner = this.local.unattended;
    if (!owner) return true;
    const routine = owner.definition(routineId);
    return !!routine && !routine.deletedAt;
  }

  private assertIdle(topicId: string) {
    if (
      new TopicsRepo(this.local.deps.db).busy(topicId) ||
      this.local.background.repo.conversationBusy(topicId)
    )
      throw new RpcError(-32011, "topic_archive_busy");
  }

  async archive({ botId, topicId }: KernelMethodParams["topics.archive"]) {
    this.topic(botId, topicId);
    this.assertIdle(topicId);
    // Share the admission barrier with folder changes so a preflight cannot slip past idle.
    await this.chat.changeTopicWorkplace(botId, topicId, async () => {
      transaction(this.local.deps.db, () => {
        const topic = this.topic(botId, topicId);
        this.assertIdle(topicId);
        if (topic.archivedAt) return;
        new ConversationsRepo(this.local.deps.db).archive(topicId);
        this.audit(botId, topicId, "topic.archived");
      });
    });
    this.changed(botId);
    return { ok: true as const };
  }

  async restore({ botId, topicId }: KernelMethodParams["topics.restore"]) {
    this.topic(botId, topicId);
    const topic = transaction(this.local.deps.db, () => {
      const before = this.topic(botId, topicId);
      if (!before.archivedAt) return before;
      new ConversationsRepo(this.local.deps.db).restore(topicId);
      this.audit(botId, topicId, "topic.restored");
      return this.topic(botId, topicId);
    });
    this.changed(botId);
    return topic;
  }

  private audit(botId: string, conversationId: string, kind: "topic.archived" | "topic.restored") {
    this.local.approvals.audit.append({
      botId,
      kind,
      summary: kind === "topic.archived" ? "Topic archived" : "Topic restored",
      detail: { conversationId, actor: "user" },
    });
  }

  private changed(botId: string) {
    const route = { conversationKey: `dm:${botId}` };
    this.local.deps.peer.emit("sidebar.topicsChanged", route);
    this.local.deps.peer.emit("sidebar.changed", route);
  }
}
