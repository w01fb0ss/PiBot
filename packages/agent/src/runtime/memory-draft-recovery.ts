import { setTimeout as wait } from "node:timers/promises";
import {
  AgentError,
  agentHttpStatus,
  MemoryDraftBudgetError,
  mapAgentError,
} from "../core/errors.ts";
import type { MemoryDraftRequest, MemoryDraftResult, MemoryDraftUsage } from "../core/types.ts";
import { retryAfterMillis } from "./request-recovery.ts";

const recoveryMs = 60_000;
const attemptMs = 20_000;
const maxAttempts = 3;

function errorRetryAfter(error: unknown) {
  if (error instanceof AgentError) return error.retryAfterMs;
  if (!error || typeof error !== "object") return undefined;
  // Some native SDKs only expose the header on the thrown response.
  const value = error as { headers?: unknown; response?: { headers?: unknown } };
  const headers = value.headers ?? value.response?.headers;
  if (headers instanceof Headers) return retryAfterMillis(headers.get("retry-after") ?? undefined);
  if (!headers || typeof headers !== "object") return undefined;
  const header = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  return typeof header === "string" ? retryAfterMillis(header) : undefined;
}

export function memoryRequestError(error: unknown, status?: number, retryAfterMs?: number) {
  if (error instanceof MemoryDraftBudgetError) return error;
  const httpStatus = status ?? agentHttpStatus(error);
  let code = mapAgentError(error, httpStatus);
  if (
    httpStatus !== undefined &&
    httpStatus >= 500 &&
    ["provider_error", "provider_overloaded", "network", "internal"].includes(code)
  ) {
    // These server responses describe request or proxy incompatibility, not short-lived overload.
    code = [501, 505, 511].includes(httpStatus) ? "provider_rejected" : "provider_overloaded";
  }
  if (code === "proxy_unavailable") code = "network";
  return new AgentError(code, httpStatus, undefined, retryAfterMs ?? errorRetryAfter(error));
}

type Fallback = (request: MemoryDraftRequest) => Promise<MemoryDraftResult | undefined>;

/** Carry usage for generated output across attempts, including partial and invalid responses. */
export async function recoverMemoryDraft(
  request: MemoryDraftRequest,
  draft: (request: MemoryDraftRequest) => Promise<MemoryDraftResult>,
  fallback?: Fallback,
): Promise<MemoryDraftResult> {
  const deadline = performance.now() + recoveryMs;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(recoveryMs)]);
  let tokens = 0;
  let costUsd = 0;
  let lastFailure: AgentError | undefined;

  async function attempt(run: Fallback, timeoutMs = attemptMs) {
    signal.throwIfAborted();
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let usage: MemoryDraftUsage | undefined;
    try {
      const result = await run({
        ...request,
        signal: attemptSignal,
        ...(request.budget && {
          budget: {
            tokens: Math.max(0, request.budget.tokens - tokens),
            costUsd: Math.max(0, request.budget.costUsd - costUsd),
          },
        }),
        onUsage(receipt) {
          usage = receipt;
          request.onUsage?.({
            ...receipt,
            tokens: tokens + receipt.tokens,
            costUsd: costUsd + (receipt.costUsd ?? 0),
          });
        },
      });
      attemptSignal.throwIfAborted();
      return (
        result && {
          ...result,
          tokens: tokens + result.tokens,
          costUsd: costUsd + (result.costUsd ?? 0),
        }
      );
    } catch (error) {
      request.signal.throwIfAborted();
      if (attemptSignal.aborted) throw new AgentError("network");
      throw error;
    } finally {
      tokens += usage?.tokens ?? 0;
      costUsd += usage?.costUsd ?? 0;
    }
  }

  for (let index = 0; index < maxAttempts && !signal.aborted; index++) {
    try {
      const result = await attempt(draft, index === 0 ? 30_000 : attemptMs);
      if (result) return result;
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      if (error.code === "budget_exhausted" && lastFailure && fallback) break;
      if (!["provider_overloaded", "rate_limited", "network"].includes(error.code)) throw error;
      lastFailure = error;
    }
    if (!lastFailure || index + 1 === maxAttempts) break;
    const delay = Math.max(1000 * 2 ** index * (1 + Math.random()), lastFailure.retryAfterMs ?? 0);
    // A long Retry-After applies to this provider. Leave time for a different provider to answer.
    if (delay >= deadline - performance.now()) break;
    try {
      await wait(delay, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
      // Preserve the last provider failure if the recovery window closes during the wait.
      break;
    }
  }
  if (fallback && lastFailure && lastFailure.code !== "network" && !signal.aborted) {
    const result = await attempt(fallback);
    if (result) return result;
  }
  request.signal.throwIfAborted();
  throw lastFailure ?? new AgentError("internal");
}
