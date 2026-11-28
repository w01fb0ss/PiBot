// Quotes and processes the same redacted message text, one conversation at a time.
import { randomUUID } from "node:crypto";
import type { CapabilityContext } from "@pibot/brain/kit";
import type {
  DistillationFailureReason,
  ImportDistillationQuote,
  ImportStatus,
} from "@pibot/import-contract";
import { AgentErrorCodeSchema } from "@pibot/protocol-base";
import { ImportFailure } from "../store/failure.ts";
import type { ImportStore } from "../store/index.ts";
import { normalized, type ReviewedMemory } from "../store/memories.ts";
import { type DistillationSource, distillationText, redactImportText } from "./records.ts";

type Port = NonNullable<CapabilityContext["local"]["memoryImportDistillation"]>;
type ModelQuote = NonNullable<Awaited<ReturnType<Port["estimate"]>>>;
export type DistillationScope = {
  conversations: boolean;
  projectKeys: readonly string[];
};
export type DistillationPlan = {
  port: Port;
  model: ModelQuote;
  quote: ImportDistillationQuote;
};

function chunkTexts(maxBytes: number) {
  let parts: Buffer[] = [];
  let size = 0;
  function flush() {
    const chunk = Buffer.concat(parts, size).toString("utf8");
    parts = [];
    size = 0;
    return chunk;
  }
  return {
    *add(text: string) {
      const bytes = Buffer.from(text);
      let start = 0;
      while (start < bytes.length) {
        let end = Math.min(start + maxBytes - size, bytes.length);
        // A code point split at the byte limit would change both the prompt and its estimate.
        while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
        if (end > start) {
          parts.push(bytes.subarray(start, end));
          size += end - start;
        }
        if (end < bytes.length || size === maxBytes) yield flush();
        start = end;
      }
    },
    flush,
  };
}

export function sameDistillationScope(a: DistillationScope, b: DistillationScope) {
  return (
    a.conversations === b.conversations &&
    a.projectKeys.length === b.projectKeys.length &&
    a.projectKeys.every((key) => b.projectKeys.includes(key))
  );
}

export function quoteImport(
  model: ModelQuote,
  sources: readonly DistillationSource[],
  scope: DistillationScope,
): ImportDistillationQuote | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let conversationCount = 0;
  const projects = new Set(scope.projectKeys);
  for (const { projectKey, bytes } of sources) {
    if (!bytes || !(projectKey ? projects.has(projectKey) : scope.conversations)) continue;
    // A split can leave up to three unused bytes at a UTF-8 boundary.
    const chunks = Math.ceil(bytes / (model.maxTextBytes - 3));
    inputTokens += bytes + chunks * model.inputOverhead;
    outputTokens += chunks * model.outputTokens;
    conversationCount++;
  }
  if (!conversationCount) return undefined;
  return {
    quoteId: randomUUID(),
    modelId: model.model.id,
    modelName: model.modelName,
    provider: model.model.provider,
    providerName: model.providerName,
    local: model.local,
    conversationCount,
    inputTokens,
    outputTokens,
    costUsd: model.prices
      ? (inputTokens * model.prices.input + outputTokens * model.prices.output) / 1_000_000
      : null,
  };
}

type Result = NonNullable<ImportStatus["distillation"]>;
const DISTILLATION_MS = 5 * 60_000;

function extractFailureCode(error: unknown, timedOut: boolean): string {
  if (timedOut) return "timeout";
  if (error instanceof ImportFailure) return error.reason;
  if (error && typeof error === "object") {
    const raw = "code" in error ? error.code : undefined;
    const parsed = AgentErrorCodeSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    if (typeof raw === "string" && /^[A-Z0-9_]{2,40}$/i.test(raw)) return raw;
    if ("name" in error && error.name === "TimeoutError") return "timeout";
  }
  return "internal";
}

function mapFailureReason(code: string): DistillationFailureReason {
  switch (code) {
    case "timeout":
    case "compaction_timeout":
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return "timeout";
    case "network":
    case "proxy_unavailable":
    case "proxy_auth_failed":
    case "proxy_credentials_unavailable":
    case "proxy_unsupported":
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "ENETUNREACH":
    case "EHOSTUNREACH":
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "UND_ERR_SOCKET":
      return "network";
    case "auth_failed":
    case "chatgpt_reconnect_required":
    case "chatgpt_plan_denied":
    case "chatgpt_plan_not_eligible":
    case "claude_subscription_unsupported":
    case "subscription_unsupported":
    case "openai_approval_required":
      return "auth";
    case "quota_exhausted":
    case "billing":
      return "quota";
    case "rate_limited":
      return "rate_limited";
    case "provider_overloaded":
      return "overloaded";
    case "no_model":
      return "no_model";
    case "provider_error":
    case "provider_rejected":
    case "context_overflow":
    case "output_limit":
      return "provider";
    case "memory_quota":
      return "memory_quota";
    default:
      return "internal";
  }
}

export async function distilImport(
  { port, model, quote }: DistillationPlan,
  importId: string,
  botId: string,
  signal: AbortSignal,
  store: ImportStore,
  redactor: Pick<CapabilityContext["redactor"], "redact">,
  logger: Pick<CapabilityContext["logger"], "warn">,
): Promise<{ result: Result; selected: ReviewedMemory[] }> {
  const deadline = AbortSignal.timeout(DISTILLATION_MS);
  const workSignal = AbortSignal.any([signal, deadline]);
  const tokenLimit = Math.ceil((quote.inputTokens + quote.outputTokens) * 1.2);
  const costLimit = quote.costUsd === null ? Infinity : quote.costUsd * 1.2;
  const result: Result = { conversations: 0, state: "completed" };
  const selected = new Map<string, ReviewedMemory>();
  let tokens = 0;
  let costUsd = 0;
  try {
    const inspect = store.memories.inspection(botId, "bot");
    async function draft(text: string, candidates: ReviewedMemory[]) {
      workSignal.throwIfAborted();
      const input = model.inputOverhead + Buffer.byteLength(text);
      const reservedCost = model.prices
        ? (input * model.prices.input + model.outputTokens * model.prices.output) / 1_000_000
        : 0;
      if (tokens + input + model.outputTokens > tokenLimit || costUsd + reservedCost > costLimit) {
        result.state = "budget";
        return false;
      }
      let usage = { tokens: 0, costUsd: 0 };
      try {
        const notes = await port.run(
          {
            botId,
            quote: model,
            text,
            budget: { tokens: tokenLimit - tokens, costUsd: costLimit - costUsd },
            onUsage: ({ tokens, costUsd }) => {
              usage = { tokens, costUsd: costUsd ?? 0 };
            },
          },
          workSignal,
        );
        for (const { text, category } of notes) {
          if (selected.size + candidates.length >= 100) break;
          const safe = redactImportText(redactor, text).trim();
          if (!safe || safe.includes("\0")) continue;
          const candidate = inspect({ id: randomUUID(), text: safe, category });
          if (candidate.item.outcome === "add") candidates.push(candidate);
        }
        return true;
      } finally {
        tokens += usage.tokens;
        costUsd += usage.costUsd;
      }
    }

    conversations: for (const topicId of store.distillationTopics(importId)) {
      const chunks = chunkTexts(model.maxTextBytes);
      const candidates: ReviewedMemory[] = [];
      let processed = false;
      for await (const message of store.distillationMessages(importId, topicId, workSignal)) {
        for (const chunk of chunks.add(distillationText(message.role, message.text))) {
          if (!(await draft(chunk, candidates))) break conversations;
          processed = true;
        }
      }
      const tail = chunks.flush();
      if (tail && !(await draft(tail, candidates))) break;
      if (processed || tail) {
        result.conversations++;
        for (const candidate of candidates) {
          if (selected.size >= 100) break;
          const key = normalized(candidate.item.text);
          if (!selected.has(key)) selected.set(key, candidate);
        }
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "budget_exhausted"
    ) {
      result.state = "budget";
    } else {
      const failureCode = extractFailureCode(error, deadline.aborted);
      result.state = "failed";
      result.reason = mapFailureReason(failureCode);
      logger.warn(
        JSON.stringify({
          module: "import",
          importId,
          reasonCode: "import_distillation_failed",
          failureCode,
        }),
      );
    }
  }
  return { result, selected: [...selected.values()] };
}
