import type { DatabaseSync } from "node:sqlite";
import { type AgentRuntime, contextBudget } from "@pibot/agent";
import { type KernelMethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { BotSessionsRepo, BotsRepo, ConversationsRepo } from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import { topicModel } from "../../runtime/models/run-model.ts";

type ModelRef = { provider: string; id: string };

function same(left: ModelRef, right: ModelRef) {
  return left.provider === right.provider && left.id === right.id;
}

/**
 * After a model switch, a topic whose history already exceeds the new model's
 * background-compaction line is worth organizing before the next turn. The estimate stays here
 * because only the brain can read the pi session; the UI just shows or hides the notice.
 *
 * The switch is read from the session itself (the model of the newest assistant turn), not from a
 * remembered "changed" flag: that survives a brain restart, a second window and an unchanged save.
 */
export class ContextHintService {
  /** Refusals per topic, keyed by the model that was current when the user said 「不用」. */
  private readonly dismissed = new Map<string, string>();

  constructor(private readonly deps: { db: DatabaseSync; agent: AgentRuntime }) {}

  async check(
    input: KernelMethodParams["chat.contextHint"],
    signal: AbortSignal,
  ): Promise<{ show: boolean }> {
    const { db, agent } = this.deps;
    const bot = new BotsRepo(db).get(input.botId);
    const conversations = new ConversationsRepo(db);
    const topic = conversations.get(input.conversationId);
    // Same scope as chat.compact: a routine topic and an internal one have no user to advise.
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
      throw new RpcError(RpcErrorCodes.invalidParams, "context_hint_unavailable");
    const key = `${bot.id}:${topic.id}`;
    const effective = topicModel(bot, topic);
    const current: ModelRef | undefined =
      effective.modelProvider && effective.modelId
        ? { provider: effective.modelProvider, id: effective.modelId }
        : undefined;
    // An unset model is not a switch to a smaller window; the composer already asks for one.
    if (!current) return { show: false };
    if (input.dismiss) {
      // The client names the model it was showing, so a save racing the click cannot record the
      // refusal against a model the user never saw.
      this.dismissed.set(
        key,
        input.modelProvider && input.modelId
          ? `${input.modelProvider}:${input.modelId}`
          : `${current.provider}:${current.id}`,
      );
      return { show: false };
    }
    if (this.dismissed.get(key) === `${current.provider}:${current.id}`) return { show: false };
    const sessionFile = new BotSessionsRepo(db).get(bot.id, topic.id) ?? topic.piSessionFile;
    const estimate = agent.estimateContext;
    if (!sessionFile || !estimate) return { show: false };
    const measured = await estimate({
      botId: bot.id,
      sessionFile,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!measured?.model) return { show: false };
    // Same model as the last turn: nothing was switched, so a topic that merely grew past the
    // line belongs to the automatic scheduler, not to this notice.
    if (same(measured.model, current)) return { show: false };
    const infos = await agent.listModels({ availableOnly: true });
    signal.throwIfAborted();
    const currentInfo = infos.find((entry) => same(entry, current));
    const previousInfo = infos.find((entry) => same(entry, measured.model as ModelRef));
    // Without both windows there is no "smaller than before" to claim; a removed model or an
    // unlisted custom one stays silent rather than warning about a window we cannot compare.
    if (!currentInfo || !previousInfo) return { show: false };
    const line = contextBudget(currentInfo.contextWindow).backgroundFromTokens;
    if (line >= contextBudget(previousInfo.contextWindow).backgroundFromTokens)
      return { show: false };
    return { show: measured.tokens >= line };
  }
}

export function registerChatContextHint(handle: KernelRegisterRpc, hints: ContextHintService) {
  handle("chat.contextHint", (input, context) => hints.check(input, context.signal));
}
