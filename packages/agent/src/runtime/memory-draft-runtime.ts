import { createHash } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isChatGPTPlanProvider, isRetiredModel } from "@pibot/protocol-base";
import { AgentError, MemoryDraftBudgetError } from "../core/errors.ts";
import type {
  AgentRuntime,
  MemoryDraftRequest,
  MemoryDraftResult,
  MemoryDraftUsage,
} from "../core/types.ts";
import { isLoopbackHost } from "../network/network.ts";
import { textTokens } from "./context-estimate.ts";
import {
  knownRate,
  memoryDraftInstruction,
  memoryDraftUsage,
  parseMemoryDraft,
} from "./memory-draft.ts";
import { draftLocalMemories, quoteLocalMemoryDraft } from "./memory-draft-local.ts";
import { memoryRequestError, recoverMemoryDraft } from "./memory-draft-recovery.ts";
import { retryAfterMillis } from "./request-recovery.ts";
import type { RuntimeContext } from "./runtime.ts";

type Model = Parameters<ModelRuntime["completeSimple"]>[0];

function localOrigin(model: Model) {
  // Native SDKs can bypass guarded fetch, so only the OpenAI-compatible transport is eligible.
  if (model.api !== "openai-completions" || !URL.canParse(model.baseUrl)) return undefined;
  const url = new URL(model.baseUrl);
  return isLoopbackHost(url.hostname) &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? url.origin
    : undefined;
}

function maxOutput(model: Model) {
  return Math.min(
    model.reasoning && model.thinkingLevelMap?.off === null ? 3072 : 2048,
    model.maxTokens,
  );
}

function importRouteKey(model: Model) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        model.provider,
        model.id,
        model.api,
        model.baseUrl,
        model.cost,
        model.contextWindow,
        maxOutput(model),
      ]),
    )
    .digest("hex");
}

export function createMemoryDraftQuote({
  buildRuntime,
  catalog,
}: Pick<RuntimeContext, "buildRuntime" | "catalog">): NonNullable<
  AgentRuntime["quoteMemoryDraft"]
> {
  return async (request) => {
    const local = await quoteLocalMemoryDraft(request);
    if (local) return local;
    const { runtime, custom } = await buildRuntime();
    request.signal.throwIfAborted();
    const inputOverhead = textTokens(memoryDraftInstruction()) + 64;
    for (const ref of request.models) {
      const model = runtime.getModel(ref.provider, ref.id);
      if (!model || isRetiredModel(model.provider, model.id)) continue;
      const outputTokens = maxOutput(model);
      const maxTextBytes =
        Math.min(request.maxTokens, model.contextWindow - 1) - inputOverhead - outputTokens;
      if (maxTextBytes < 4) continue;
      const { input, output } = model.cost;
      return {
        model: { provider: model.provider, id: model.id },
        modelName: model.name,
        providerName:
          custom.find(({ id }) => id === model.provider)?.name ??
          catalog.find(({ id }) => id === model.provider)?.name ??
          model.provider,
        local: false,
        routeKey: importRouteKey(model),
        inputOverhead,
        outputTokens,
        maxTextBytes,
        prices:
          Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0
            ? { input, output }
            : null,
      };
    }
  };
}

function reserve(model: Model, inputTokens: number) {
  const output = maxOutput(model);
  return {
    tokens: inputTokens + output,
    costUsd:
      (inputTokens * knownRate(model.cost.input) + output * knownRate(model.cost.output)) /
      1_000_000,
    modelProvider: model.provider,
    modelId: model.id,
  };
}

function fitsBudget(usage: MemoryDraftUsage, budget: MemoryDraftRequest["budget"]) {
  return !budget || (usage.tokens <= budget.tokens && (usage.costUsd ?? 0) <= budget.costUsd);
}

function sameProvider(a: string, b: string) {
  return a === b || (isChatGPTPlanProvider(a) && isChatGPTPlanProvider(b));
}

async function chooseFallback(
  runtime: ModelRuntime,
  request: MemoryDraftRequest,
  fits: (model: Model) => boolean,
  authenticate: (model: Model) => Promise<unknown>,
) {
  const catalog = runtime.getModels();
  const preferred = (request.fallbackModels ?? []).flatMap(({ provider, id }) =>
    catalog.filter((model) => model.provider === provider && model.id === id),
  );
  const unavailable = new Set<string>();
  const seen = new Set<Model>();
  for (const model of [...preferred, ...catalog]) {
    request.signal.throwIfAborted();
    if (
      sameProvider(model.provider, request.model.provider) ||
      seen.has(model) ||
      unavailable.has(model.provider) ||
      isRetiredModel(model.provider, model.id) ||
      !fits(model)
    )
      continue;
    seen.add(model);
    try {
      if (await authenticate(model)) return model;
    } catch {
      // A disconnected account or an unavailable credential excludes this provider from selection.
      request.signal.throwIfAborted();
    }
    unavailable.add(model.provider);
  }
  return undefined;
}

export function createMemoryDraft({
  deps,
  buildRuntime,
  injectKey,
}: Pick<RuntimeContext, "deps" | "buildRuntime" | "injectKey">) {
  return async (request: MemoryDraftRequest): Promise<MemoryDraftResult> => {
    try {
      request.signal.throwIfAborted();
      if (request.useLocalOllama)
        return await recoverMemoryDraft(request, (attempt) =>
          draftLocalMemories(attempt, attempt.signal),
        );
      const instruction = request.instruction ?? memoryDraftInstruction();
      const inputTokens =
        (request.importRoute ? Buffer.byteLength(request.text) : textTokens(request.text)) +
        textTokens(instruction) +
        64;
      if (request.importRoute && Buffer.byteLength(request.text) > request.importRoute.maxTextBytes)
        throw new AgentError("budget_exhausted");
      if (inputTokens > 16_000) throw new AgentError("context_too_large");
      const network = deps.network;
      const local = (model: Model) =>
        !request.localOnly || (!!localOrigin(model) && !!network?.withLocalModelOrigin);
      const fits = (model: Model) => inputTokens + maxOutput(model) < model.contextWindow;
      const authenticate = async (runtime: ModelRuntime, model: Model, signal: AbortSignal) => {
        await injectKey(runtime, model.provider);
        signal.throwIfAborted();
        return runtime.getAuth(model, { signal });
      };
      let primaryRef = request.model;
      const primary = async (attempt: MemoryDraftRequest) => {
        try {
          const { runtime } = await buildRuntime();
          attempt.signal.throwIfAborted();
          const choices = attempt.localOnly
            ? [attempt.model, ...(attempt.localModelChoices ?? [])]
            : [attempt.model];
          const model = choices
            .map(({ provider, id }) => runtime.getModel(provider, id))
            .find((model) => model && local(model));
          if (!model || (attempt.importRoute && attempt.importRoute.key !== importRouteKey(model)))
            throw new AgentError("no_model");
          primaryRef = { provider: model.provider, id: model.id };
          if (!fits(model)) throw new AgentError("context_too_large");
          if (!(await authenticate(runtime, model, attempt.signal)))
            throw new AgentError("auth_failed");
          return await complete(runtime, model, attempt, instruction, inputTokens, network);
        } catch (error) {
          if (error instanceof SyntaxError) throw error;
          throw memoryRequestError(error);
        }
      };
      const fallbackModels = request.importRoute ? undefined : request.fallbackModels;
      return await recoverMemoryDraft(
        request,
        primary,
        fallbackModels &&
          (async (attempt) => {
            const { runtime } = await buildRuntime();
            const model = await chooseFallback(
              runtime,
              { ...attempt, model: primaryRef },
              (candidate) =>
                local(candidate) &&
                fits(candidate) &&
                fitsBudget(reserve(candidate, inputTokens), attempt.budget),
              (candidate) => authenticate(runtime, candidate, attempt.signal),
            );
            if (!model) return undefined;
            const fallback = { from: primaryRef, to: { provider: model.provider, id: model.id } };
            attempt.signal.throwIfAborted();
            request.onFallback?.(fallback);
            const result = await complete(
              runtime,
              model,
              attempt,
              instruction,
              inputTokens,
              network,
            );
            return { ...result, fallback };
          }),
      );
    } catch (error) {
      if (request.signal.aborted) throw new AgentError("aborted");
      // A parser exception can quote the provider response, including parts of the prompt.
      if (error instanceof SyntaxError) throw new SyntaxError("memory_draft_invalid");
      throw memoryRequestError(error);
    }
  };
}

async function complete(
  runtime: ModelRuntime,
  model: Model,
  request: MemoryDraftRequest,
  instruction: string,
  inputTokens: number,
  network: RuntimeContext["deps"]["network"],
): Promise<MemoryDraftResult> {
  const { signal } = request;
  signal.throwIfAborted();
  const reserved = reserve(model, inputTokens);
  if (!fitsBudget(reserved, request.budget))
    throw new MemoryDraftBudgetError({ tokens: reserved.tokens, costUsd: reserved.costUsd });
  let status: number | undefined;
  let retryAfterMs: number | undefined;
  const dispatch = () =>
    runtime.completeSimple(
      model,
      {
        systemPrompt: instruction,
        messages: [{ role: "user", content: request.text, timestamp: Date.now() }],
      },
      {
        maxTokens: maxOutput(model),
        maxRetries: 0,
        ...(model.reasoning && model.thinkingLevelMap?.off === null
          ? { reasoning: "minimal" as const, thinkingBudgets: { minimal: 1024 } }
          : {}),
        signal,
        onResponse(response) {
          const nextStatus = response.status >= 400 ? response.status : undefined;
          const after = retryAfterMillis(
            Object.entries(response.headers).find(
              ([key]) => key.toLowerCase() === "retry-after",
            )?.[1],
          );
          retryAfterMs = after ?? (status === nextStatus ? retryAfterMs : undefined);
          status = nextStatus;
        },
      },
    );
  const origin = request.localOnly ? localOrigin(model) : undefined;
  const result = await (origin && network?.withLocalModelOrigin
    ? network.withLocalModelOrigin(origin, dispatch)
    : dispatch()
  ).catch((error: unknown) => {
    throw memoryRequestError(error, status, retryAfterMs);
  });
  const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const hasOutput =
    !!text ||
    result.usage.output > 0 ||
    result.content.some(
      (part) => part.type === "toolCall" || (part.type === "thinking" && !!part.thinking),
    );
  const receipt = memoryDraftUsage(model, result.usage);
  const settled =
    (status === undefined && hasOutput) || (request.importRoute && receipt.tokens > 0)
      ? { ...reserved, ...(receipt.tokens > 0 ? receipt : {}) }
      : { ...reserved, tokens: 0, costUsd: 0 };
  if (settled.tokens || settled.costUsd) request.onUsage?.(settled);
  signal.throwIfAborted();
  if (result.stopReason === "length") throw new AgentError("output_limit");
  if (result.stopReason === "aborted") throw new AgentError("aborted");
  if (result.stopReason !== "stop")
    throw memoryRequestError(result.errorMessage, status, retryAfterMs);
  if (!text.trim() || text.length > 50_000) throw new AgentError("provider_error");
  try {
    return { draft: parseMemoryDraft(text), tokens: settled.tokens, costUsd: settled.costUsd };
  } catch {
    // Invalid output needs its own reason without carrying the original text or parser diagnostic.
    throw new SyntaxError("memory_draft_invalid");
  }
}
