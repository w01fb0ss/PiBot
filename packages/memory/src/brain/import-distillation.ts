import { setTimeout as wait } from "node:timers/promises";
import { AgentError } from "@pibot/agent";
import type { CapabilityContext } from "@pibot/brain/kit";
import { BotsRepo } from "@pibot/storage";
import { parseExtractionDraft } from "./memory-extraction.ts";
import { memoryModelRoute } from "./memory-organization-model.ts";

const MAX_TOKENS = 9216;
type ImportPort = NonNullable<
  Parameters<CapabilityContext["memory"]["provide"]>[0]["importDistillation"]
>;

export function createImportDistillation(
  { db, agent, redactor }: Pick<CapabilityContext, "db" | "agent" | "redactor">,
  workersIdle: () => boolean,
): ImportPort & { idle(): boolean } {
  let busy = false;
  const bots = new BotsRepo(db);

  return {
    idle: () => !busy,
    async estimate(botId, signal) {
      const bot = bots.get(botId);
      if (!agent.draftMemories || !bot || bot.archivedAt) return undefined;
      const route = memoryModelRoute(db, bots.getMain()?.id ?? botId);
      return agent.quoteMemoryDraft?.({
        models: route?.modelChoices ?? [],
        localModelChoices: [
          ...(bot.modelProvider && bot.modelId
            ? [{ provider: bot.modelProvider, id: bot.modelId }]
            : []),
          ...(route?.modelChoices ?? []),
        ],
        maxTokens: MAX_TOKENS,
        signal,
      });
    },
    async run({ botId, quote, text, budget, onUsage }, signal) {
      // Give an in-flight chat or maintenance operation time to release its lease.
      for (const delay of [1000, 2000]) {
        if (!busy && workersIdle()) break;
        await wait(delay, undefined, { signal });
      }
      signal.throwIfAborted();
      if (busy || !workersIdle()) throw new AgentError("provider_overloaded");
      const bot = bots.get(botId);
      if (!bot || bot.archivedAt || !agent.draftMemories) throw new AgentError("no_model");
      busy = true;
      try {
        let reported = false;
        const result = await agent.draftMemories({
          text: redactor.redact(text),
          model: quote.model,
          ...(quote.local
            ? { useLocalOllama: true }
            : { importRoute: { key: quote.routeKey, maxTextBytes: quote.maxTextBytes } }),
          signal,
          budget,
          onUsage(usage) {
            reported = true;
            onUsage(usage);
          },
        });
        if (!reported) onUsage(result);
        signal.throwIfAborted();
        return parseExtractionDraft(result.draft)
          .candidates.filter(({ action }) => action === "add")
          .map(({ text, category }) => ({
            text: redactor.redact(text),
            category: category ?? "work",
          }));
      } finally {
        busy = false;
      }
    },
  };
}
