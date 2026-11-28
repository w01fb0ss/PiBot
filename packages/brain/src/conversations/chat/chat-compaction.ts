import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import { type KernelMethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import {
  AuditRepo,
  BotSessionsRepo,
  BotsRepo,
  ConversationsRepo,
  MessagesRepo,
  RunEventsRepo,
  transaction,
} from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { BrainRedactor } from "../../core/privacy.ts";
import { topicModel } from "../../runtime/models/run-model.ts";
import type { ChatService } from "./chat.ts";

/** Explicit user action; no tools, automatic replay, authority transfer or second session writer. */
export function registerChatCompaction(
  handle: KernelRegisterRpc,
  deps: {
    db: DatabaseSync;
    chat: ChatService;
    agent: AgentRuntime;
    redactor: BrainRedactor;
    changed(botId: string, conversationId: string, forked: boolean): void;
  },
) {
  const { db, chat, agent, redactor } = deps;
  const pending = new Map<
    string,
    { input: KernelMethodParams["chat.compact"]; controller: AbortController }
  >();
  handle("chat.compact.cancel", async (input) => {
    const active = pending.get(input.requestId);
    if (
      active &&
      active.input.botId === input.botId &&
      active.input.conversationId === input.conversationId
    )
      active.controller.abort();
    return { ok: true };
  });
  handle("chat.compact", async (input, context) => {
    if (pending.has(input.requestId)) throw new RpcError(RpcErrorCodes.busy, "compaction_busy");
    const bot = new BotsRepo(db).get(input.botId);
    const conversations = new ConversationsRepo(db);
    const topic = conversations.get(input.conversationId);
    if (
      !bot ||
      bot.archivedAt ||
      bot.category === "image" ||
      topic?.kind !== "dm" ||
      topic.botId !== bot.id ||
      topic.archivedAt ||
      topic.routineId ||
      conversations.isInternal(topic.id)
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "compaction_scope_unavailable");
    const sessionFile = new BotSessionsRepo(db).get(bot.id, topic.id) ?? topic.piSessionFile;
    if (!sessionFile || !agent.compactHistory)
      throw new RpcError(RpcErrorCodes.invalidParams, "session_unavailable");
    const controller = new AbortController();
    pending.set(input.requestId, { input, controller });
    try {
      return await chat.withTopicOperation(bot.id, topic.id, async (lifetime) => {
        const signal = AbortSignal.any([
          context.signal,
          lifetime,
          controller.signal,
          AbortSignal.timeout(1_200_000),
        ]);
        const effective = topicModel(bot, conversations.get(topic.id) ?? topic);
        if (!effective.modelProvider || !effective.modelId)
          throw new RpcError(RpcErrorCodes.invalidParams, "session_unavailable");
        const result = await agent.compactHistory?.({
          botId: bot.id,
          sessionFile,
          model: { provider: effective.modelProvider, id: effective.modelId },
          ...(effective !== bot ? { compactWithSelectedModel: true } : {}),
          fork: input.fork,
          signal,
          redact: (text) => redactor.redact(text),
        });
        signal.throwIfAborted();
        const currentBot = new BotsRepo(db).get(bot.id),
          current = conversations.get(topic.id);
        if (
          !result ||
          !currentBot ||
          currentBot.archivedAt ||
          !current ||
          current.archivedAt ||
          current.piSessionFile !== topic.piSessionFile ||
          current.workplaceRevision !== topic.workplaceRevision
        )
          throw new RpcError(RpcErrorCodes.invalidParams, "compaction_scope_changed");
        const target = transaction(db, () => {
          const next = input.fork
            ? conversations.create({
                botId: bot.id,
                piSessionFile: result.sessionFile,
                // A summary handoff carries no authority: the new topic starts in the Bot's home,
                // never inheriting the source topic's folder binding or read-only references.
                workplace: { primary: "home", readonly: [] },
              })
            : topic;
          if (input.fork) {
            new MessagesRepo(db).create({
              conversationId: next.id,
              botId: bot.id,
              role: "assistant",
              status: "done",
              content: `上下文交接摘要 / Context handoff checkpoint\n\n${result.summary}`,
            });
            conversations.switchTopic(bot.id, next.id);
          }
          new AuditRepo(db, redactor).append({
            botId: bot.id,
            kind: "exec.finished",
            summary: "Context compacted / 上下文已整理",
            detail: {
              actor: "user",
              reasonCode: input.fork ? "compaction_handoff" : "compaction_manual",
            },
          });
          const source = db
            .prepare(
              "SELECT id FROM runs WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(topic.id);
          if (source)
            new RunEventsRepo(db).append({
              runId: String(source.id),
              conversationId: topic.id,
              kind: "compaction.completed",
              payload: {
                requestId: input.requestId,
                fork: input.fork,
                targetConversationId: next.id,
                summary: redactor.redact(result.summary),
                mechanical: result.mechanical,
              },
            });
          return next;
        });
        deps.changed(bot.id, target.id, input.fork);
        return { conversationId: target.id, mechanical: result.mechanical };
      });
    } finally {
      pending.delete(input.requestId);
    }
  });
}
