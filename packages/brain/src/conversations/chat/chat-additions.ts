import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import {
  type ChatAdditionMode,
  chatAddition,
  type KernelEvents,
  type KernelMethodParams,
  type KernelMethods,
  type Peer,
  RpcError,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  ChatAdditionsRepo,
  ConversationsRepo,
  GroupsRepo,
  MessagesRepo,
  RunsRepo,
  transaction,
} from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import type { BrainRedactor } from "../../core/privacy.ts";
import type { LocalService } from "../../local-service.ts";
import type { RunQueue } from "../../runtime/queue/run-queue.ts";
import type { AttachmentService, PreparedAttachments } from "../attachments/attachments.ts";

interface Dependencies {
  db: DatabaseSync;
  agent: AgentRuntime;
  peer: Peer<typeof KernelMethods, typeof KernelEvents>;
  logger: Logger;
  redactor: BrainRedactor;
  queue: RunQueue;
  local?: LocalService;
  attachments: AttachmentService;
  preparing: Map<string, AbortController>;
  preflights: Map<Promise<unknown>, string>;
  retired: Set<string>;
  shutdown: AbortSignal;
  language(): "zh" | "en";
  isStopping(): boolean;
}

type AppendParams = KernelMethodParams["chat.append"] & { groupId?: string; targetBotId?: string };
type StatusParams = KernelMethodParams["chat.appendStatus"] & { groupId?: string };

// Shares ordinary send's preflight and retirement lock, without owning a second run loop.
export class ChatAdditionService {
  private readonly appendRequests = new Map<
    string,
    {
      fingerprint: string;
      botId: string;
      topicId: string;
      groupId?: string;
      pending: Promise<import("@pibot/protocol-base").Message>;
    }
  >();
  private readonly bots: BotsRepo;
  private readonly conversations: ConversationsRepo;
  private readonly messages: MessagesRepo;
  constructor(private readonly deps: Dependencies) {
    this.bots = new BotsRepo(deps.db);
    this.conversations = new ConversationsRepo(deps.db);
    this.messages = new MessagesRepo(deps.db);
  }
  append(params: AppendParams) {
    const { attachments, ...identity } = params;
    const hash = createHash("sha256").update(JSON.stringify(identity));
    for (const input of attachments ?? []) hash.update(JSON.stringify(input));
    const fingerprint = hash.digest("hex");
    const pending = this.appendRequests.get(params.requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new RpcError(-32602, "append_identity");
      return pending.pending;
    }
    const existing = new ChatAdditionsRepo(this.deps.db).get(params.requestId);
    if (existing) {
      const usage = existing.usage;
      if (
        existing.conversationId !== params.topicId ||
        existing.runId !== params.runId ||
        !usage ||
        typeof usage !== "object" ||
        Array.isArray(usage) ||
        usage.appendFingerprint !== fingerprint
      )
        throw new RpcError(-32602, "append_identity");
      this.appendStatus(params);
      return Promise.resolve(existing);
    }
    if (this.messages.get(params.requestId)) throw new RpcError(-32602, "append_identity");
    const request = this.prepareAppend(params, fingerprint);
    this.appendRequests.set(params.requestId, {
      fingerprint,
      botId: params.botId,
      topicId: params.topicId,
      groupId: params.groupId,
      pending: request,
    });
    this.deps.preflights.set(request, params.botId);
    void request
      .finally(() => {
        this.appendRequests.delete(params.requestId);
        this.deps.preflights.delete(request);
      })
      .catch(() => {
        /* RPC owns the error; only its receipt can certify admission. */
      });
    return request;
  }

  /**
   * Moves an addition that is still waiting in the run's queue between "add to the current task"
   * and "after the current task" (maintainers 2026-11-18, as OpenCode's inbox allows). Once the run
   * has taken it, it is too late: `append_delivered`.
   */
  async switchMode(params: StatusParams & { mode: ChatAdditionMode }) {
    const { botId, topicId, requestId, groupId, mode } = params;
    const message = this.appendStatus(params).message;
    const addition = message ? chatAddition(message) : undefined;
    if (!message?.runId || !addition) throw new RpcError(-32011, "append_unavailable");
    if (addition.state !== "queued") throw new RpcError(-32011, "append_delivered");
    if (addition.mode === mode) return message;
    if (mode === "steer" && this.bots.get(botId)?.category === "image")
      throw new RpcError(-32602, "image_steer_unsupported");
    const runId = message.runId;
    const { run } = groupId
      ? this.deps.queue.groupAppendTarget(groupId, botId, message.conversationId, runId, botId)
      : this.deps.queue.appendTarget(botId, topicId, runId);
    if (!(await run.session?.switchAddition?.(requestId, mode)))
      throw new RpcError(-32011, "append_delivered");
    const updated = new ChatAdditionsRepo(this.deps.db).mode(requestId, mode) ?? message;
    this.deps.peer.emit("chat.message", {
      botId,
      conversationId: message.conversationId,
      runId,
      messageId: updated.id,
      message: updated,
    });
    return updated;
  }

  appendStatus({ botId, topicId, requestId, groupId }: StatusParams) {
    const topic = this.conversations.get(topicId);
    if (groupId) {
      const group = new GroupsRepo(this.deps.db).get(groupId),
        current = group ? this.conversations.get(group.conversationId) : undefined;
      if (
        !group ||
        !current ||
        current.archivedAt ||
        !topic ||
        topic.archivedAt ||
        topic.groupId !== groupId ||
        !group.members.some((member) => member.botId === botId) ||
        (topic.kind === "group"
          ? topic.id !== group.conversationId
          : topic.kind !== "thread" || topic.threadOf !== group.conversationId)
      )
        throw new RpcError(-32602, "append_identity");
    } else if (topic?.kind !== "dm" || topic.botId !== botId || topic.archivedAt)
      throw new RpcError(-32602, "append_identity");
    const pending = this.appendRequests.get(requestId);
    if (
      pending &&
      (pending.botId !== botId || pending.topicId !== topicId || pending.groupId !== groupId)
    )
      throw new RpcError(-32602, "append_identity");
    const message = new ChatAdditionsRepo(this.deps.db).get(requestId);
    if (message) {
      const run = message.runId ? new RunsRepo(this.deps.db).get(message.runId) : undefined;
      if (
        message.conversationId !== topicId ||
        !run ||
        run.botId !== botId ||
        (run.groupId ?? undefined) !== groupId
      )
        throw new RpcError(-32602, "append_identity");
    }
    return {
      state: message
        ? ("accepted" as const)
        : this.appendRequests.has(requestId)
          ? ("preparing" as const)
          : ("absent" as const),
      message: message ?? null,
    };
  }

  private async prepareAppend(params: AppendParams, fingerprint: string) {
    const { botId, topicId, runId, requestId, mode, groupId } = params;
    const admission = `${botId}:${topicId}`;
    if (this.deps.isStopping() || this.deps.preparing.has(admission))
      throw new RpcError(-32011, "busy");
    this.appendStatus(params);
    const targetConversationId = groupId
      ? new RunsRepo(this.deps.db).get(runId)?.conversationId
      : topicId;
    if (!targetConversationId) throw new RpcError(-32011, "append_unavailable");
    if (groupId) {
      const targetTopic = this.conversations.get(targetConversationId),
        group = new GroupsRepo(this.deps.db).get(groupId);
      if (
        (this.conversations.get(topicId)?.kind === "thread" && topicId !== targetConversationId) ||
        !targetTopic ||
        targetTopic.archivedAt ||
        targetTopic.groupId !== groupId ||
        !group ||
        (targetTopic.kind === "group"
          ? targetTopic.id !== group.conversationId
          : targetTopic.kind !== "thread" || targetTopic.threadOf !== group.conversationId)
      )
        throw new RpcError(-32602, "append_identity");
    }
    const target = () =>
      groupId
        ? this.deps.queue.groupAppendTarget(
            groupId,
            botId,
            targetConversationId,
            runId,
            params.targetBotId,
          )
        : this.deps.queue.appendTarget(botId, topicId, runId);
    const { bot, run } = target();
    // A live SDK session has a fixed registration set. Use the existing queue fallback so this
    // message gets its own turn and its tools are registered against that turn's permissions.
    if (
      bot.kind !== "agent" &&
      bot.category !== "image" &&
      this.deps.local?.needsConnectionTurn(
        { botId, groupId, conversationId: targetConversationId },
        this.deps.redactor.redact(params.text.trim()),
        run.signal,
      )
    )
      throw new RpcError(-32011, "append_unavailable");
    const additions = new ChatAdditionsRepo(this.deps.db);
    if (additions.pending(runId) >= 16) throw new RpcError(-32011, "append_full");
    const controller = new AbortController();
    this.deps.preparing.set(admission, controller);
    const signal = AbortSignal.any([
      controller.signal,
      this.deps.shutdown,
      run.signal,
      AbortSignal.timeout(25_000),
    ]);
    let prepared: PreparedAttachments | undefined;
    let committed = false;
    try {
      const provider =
        run.session?.model?.provider ?? run.selectedModel?.provider ?? bot.modelProvider;
      const id = run.session?.model?.id ?? run.selectedModel?.id ?? bot.modelId;
      const model = (
        await abortable(this.deps.agent.listModels({ availableOnly: true }), signal)
      ).find((value) => value.provider === provider && value.id === id);
      if (!model) throw new RpcError(-32010, "no_model");
      prepared = await this.deps.attachments.prepare(
        botId,
        params.attachments ?? [],
        params.attachmentIds ?? [],
        model,
        signal,
        groupId,
      );
      signal.throwIfAborted();
      const current = this.bots.get(botId);
      if (!current || current.archivedAt || this.deps.retired.has(botId))
        throw new RpcError(-32602, "Bot archived");
      if (target().run !== run) throw new RpcError(-32011, "append_unavailable");
      this.appendStatus(params);
      const input =
        this.deps.redactor.redact([params.text, prepared.text].filter(Boolean).join("\n\n")) ||
        (this.deps.language() === "zh" ? "请查看附图。" : "Please review the attached image.");
      if (run.session?.hasPendingInput?.(input)) throw new RpcError(-32011, "append_duplicate");
      const message = transaction(this.deps.db, () => {
        const user = this.messages.create({
          id: requestId,
          conversationId: topicId,
          runId,
          role: "user",
          status: "done",
          content: this.deps.redactor.redact(params.text),
          markUnread: false,
          usage: {
            chatAddition: { requestId, mode, state: "queued" },
            appendFingerprint: fingerprint,
          },
        });
        this.deps.attachments.persist(
          user.id,
          prepared as PreparedAttachments,
          groupId ? botId : undefined,
        );
        return user;
      });
      committed = true;
      const publish = (updated: import("@pibot/protocol-base").Message) =>
        this.deps.peer.emit("chat.message", {
          botId,
          conversationId: topicId,
          runId,
          messageId: updated.id,
          message: updated,
        });
      publish(this.messages.get(message.id) as import("@pibot/protocol-base").Message);
      let accepted = false;
      try {
        accepted = (await run.session?.append?.(requestId, mode, input, prepared.images)) ?? false;
      } catch {
        this.deps.logger.warn(
          JSON.stringify({ module: "chat", event: "addition_not_admitted", botId, runId }),
        );
      }
      if (!accepted) {
        const updated = additions.state(requestId, "interrupted");
        if (updated) publish(updated);
      }
      this.deps.peer.emit("sidebar.changed", {
        conversationKey: groupId ? `group:${groupId}` : `dm:${botId}`,
      });
      return this.messages.get(requestId) as import("@pibot/protocol-base").Message;
    } finally {
      if (this.deps.preparing.get(admission) === controller) this.deps.preparing.delete(admission);
      if (!committed) await prepared?.discard();
    }
  }
}
