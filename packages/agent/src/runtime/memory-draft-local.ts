// Use Ollama's native loopback server only when it attests that cloud features are disabled.
import { request as httpRequest } from "node:http";
import { z } from "zod";
import { AgentError } from "../core/errors.ts";
import type { AgentRuntime, MemoryDraftQuote, MemoryDraftRequest } from "../core/types.ts";
import { memoryDraftInstruction, parseMemoryDraft } from "./memory-draft.ts";
import { memoryRequestError } from "./memory-draft-recovery.ts";
import { retryAfterMillis } from "./request-recovery.ts";

const statusSchema = z.object({ cloud: z.object({ disabled: z.literal(true) }) });
const tagsSchema = z.object({ models: z.array(z.object({ name: z.string() })).max(1000) });
const modelSchema = z.object({
  capabilities: z.array(z.string()),
  remote_host: z.string().optional(),
  remote_model: z.string().optional(),
});
const localContext = 8192;
const localOutput = 1024;
const localOverhead = 128;

function isLocalModel(id: string) {
  return (
    id.length <= 256 &&
    /^[\w.-]+(?:\/[\w.-]+)?(?::[\w.-]+)?$/u.test(id) &&
    !/cloud|remote/i.test(id)
  );
}

const resultSchema = z.object({
  message: z.object({ content: z.string().min(1).max(50_000) }),
  done: z.literal(true),
  done_reason: z.enum(["stop", "length"]),
  prompt_eval_count: z.number().int().nonnegative(),
  eval_count: z.number().int().nonnegative(),
});

function requestJson(
  path: "/api/status" | "/api/tags" | "/api/show" | "/api/chat",
  signal: AbortSignal,
  body?: string,
) {
  return new Promise<unknown>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: 11434,
        path,
        method: body ? "POST" : "GET",
        signal,
        agent: false,
        ...(body
          ? {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              },
            }
          : {}),
      },
      async (response) => {
        try {
          if (response.statusCode !== 200)
            throw memoryRequestError(
              "Local model request failed",
              response.statusCode,
              retryAfterMillis(response.headers["retry-after"]),
            );
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            bytes += chunk.length;
            if (bytes > 128 * 1024) throw new AgentError("output_limit");
            chunks.push(chunk);
          }
          resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
        } catch (error) {
          response.destroy();
          reject(error instanceof SyntaxError ? error : memoryRequestError(error));
        }
      },
    );
    request.once("error", (error) => reject(memoryRequestError(error)));
    request.end(body);
  });
}

export async function quoteLocalMemoryDraft({
  localModelChoices,
  maxTokens,
  signal,
}: Parameters<NonNullable<AgentRuntime["quoteMemoryDraft"]>>[0]): Promise<
  MemoryDraftQuote | undefined
> {
  const probe = AbortSignal.any([signal, AbortSignal.timeout(1500)]);
  try {
    const status = await requestJson("/api/status", probe);
    if (!statusSchema.safeParse(status).success) return undefined;
    const tags = tagsSchema.safeParse(await requestJson("/api/tags", probe));
    if (!tags.success) return undefined;
    const installed = tags.data.models.map(({ name }) => name).filter(isLocalModel);
    const preferred = localModelChoices
      .filter(({ provider }) => provider === "ollama")
      .flatMap(({ id }) => installed.filter((name) => name === id || name === `${id}:latest`));
    const inputOverhead = Buffer.byteLength(memoryDraftInstruction()) + localOverhead;
    const maxTextBytes = Math.min(localContext, maxTokens) - inputOverhead - localOutput;
    if (maxTextBytes < 4) return undefined;
    for (const id of new Set([...preferred, ...installed])) {
      try {
        const details = modelSchema.safeParse(
          await requestJson("/api/show", probe, JSON.stringify({ model: id })),
        );
        if (
          !details.success ||
          !details.data.capabilities.includes("completion") ||
          details.data.remote_host ||
          details.data.remote_model
        )
          continue;
        return {
          model: { provider: "ollama", id },
          modelName: id,
          providerName: "Ollama",
          local: true,
          inputOverhead,
          outputTokens: localOutput,
          maxTextBytes,
          prices: { input: 0, output: 0 },
        };
      } catch {
        // An unreadable tag can disappear during discovery. Try the remaining installed tags.
        probe.throwIfAborted();
      }
    }
  } catch {
    // A stopped or unverified server is unavailable. Probing sends no conversation text.
    signal.throwIfAborted();
    return undefined;
  }
}

export async function draftLocalMemories(request: MemoryDraftRequest, signal: AbortSignal) {
  const { model, text, budget } = request;
  if (model.provider !== "ollama" || !isLocalModel(model.id)) throw new AgentError("no_model");
  const instruction = request.instruction ?? memoryDraftInstruction();
  const tokens =
    Buffer.byteLength(instruction) + Buffer.byteLength(text) + localOverhead + localOutput;
  if (!budget || tokens > budget.tokens || tokens > localContext)
    throw new AgentError("budget_exhausted");
  const status = await requestJson("/api/status", signal);
  if (!statusSchema.safeParse(status).success) throw new AgentError("no_model");
  const usage = { tokens, costUsd: 0, modelProvider: model.provider, modelId: model.id };
  const result = resultSchema.parse(
    await requestJson(
      "/api/chat",
      signal,
      JSON.stringify({
        model: model.id,
        stream: false,
        think: false,
        format: "json",
        options: { num_ctx: localContext, num_predict: localOutput },
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: text },
        ],
      }),
    ),
  );
  const actual = result.prompt_eval_count + result.eval_count;
  request.onUsage?.({ ...usage, tokens: actual });
  if (result.done_reason === "length") throw new AgentError("output_limit");
  return { draft: parseMemoryDraft(result.message.content), tokens: actual, costUsd: 0 };
}
