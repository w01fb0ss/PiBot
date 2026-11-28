import { readProviderError } from "./provider-response-error.ts";
import type { AgentErrorCode } from "./types.ts";

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    readonly httpStatus?: number,
    readonly providerDetail?: string,
    readonly retryAfterMs?: number,
  ) {
    // Never expose raw SDK diagnostics: they can contain keys, headers or response bodies.
    super(code);
    this.name = "AgentError";
  }
}

export class MemoryDraftBudgetError extends AgentError {
  constructor(readonly required: { tokens: number; costUsd: number }) {
    super("budget_exhausted");
  }
}

/** Only a transport/server failure with no output can be treated as an unbilled attempt. */
export function transientRequestError(
  error: unknown,
): "network" | "provider_error" | "rate_limited" | undefined {
  const code = mapAgentError(error);
  if (code === "network") return code;
  const status = agentHttpStatus(error);
  if (code === "rate_limited" && status === 429) return code;
  if (
    code === "provider_overloaded" ||
    (code === "provider_error" && status !== undefined && status >= 500)
  )
    return "provider_error";
  return undefined;
}

export function agentHttpStatus(err: unknown): number | undefined {
  if (err instanceof AgentError) return err.httpStatus;
  const seen = new Set<unknown>();
  function extract(value: unknown): number | undefined {
    if (typeof value === "string") {
      const parsed = readProviderError(value);
      if (parsed.status !== undefined) return parsed.status;
      // Fixed Pi Bot errors also carry trailing "HTTP 503"; numbers in arbitrary prose are not statuses.
      const match = /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s*[:=]?\s*([45]\d\d)\b/i.exec(
        parsed.message?.split("\n", 1)[0] ?? "",
      );
      return match ? Number(match[1]) : undefined;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    const item = value as {
      httpStatus?: unknown;
      status?: unknown;
      statusCode?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const status = item.httpStatus ?? item.status ?? item.statusCode;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599)
      return status;
    return extract(item.cause) ?? extract(item.message);
  }
  return extract(err);
}

/**
 * The output limit a provider states when it rejects max_tokens (custom endpoints outside pi's
 * catalog). Only output-limit errors: a context overflow belongs to pi's compaction
 * recovery, and halving or persisting max_tokens for a long conversation would cripple the model
 * for every later run. The limit is the largest stated number below what was requested; without
 * one the request is halved.
 */
export function providerModelLimit(
  err: unknown,
  current: number,
): { maxTokens: number } | undefined {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  if (
    !/max[_ -]?(?:completion[_ -]|output[_ -]|new[_ -])?tokens?/i.test(text) ||
    !/too large|exceed|limit|maximum|at most|less than|<=|must be/i.test(text)
  )
    return undefined;
  const below = [...text.matchAll(/\b\d{3,7}\b/g)]
    .map((match) => Number(match[0]))
    .filter((value) => value >= 256 && value < current);
  const maxTokens = below.length ? Math.max(...below) : Math.floor(current / 2);
  return maxTokens >= 256 && maxTokens < current ? { maxTokens } : undefined;
}

export function mapAgentError(err: unknown, responseStatus?: number): AgentErrorCode {
  if (err instanceof AgentError) return err.code;
  const seen = new Set<unknown>();
  function classify(value: unknown): AgentErrorCode {
    if (value instanceof AgentError) return value.code;
    if (!value || typeof value !== "object" || seen.has(value)) return "internal";
    seen.add(value);
    const item = value as {
      status?: number;
      statusCode?: number;
      code?: string;
      name?: string;
      message?: string;
      cause?: unknown;
    };
    const status = responseStatus ?? agentHttpStatus(item);
    const message = typeof item.message === "string" ? item.message : "";
    if (message === "subscription_unsupported") return "subscription_unsupported";
    if (message.includes("claude_subscription_unsupported"))
      return "claude_subscription_unsupported";
    if (
      message === "chatgpt_reconnect_required" ||
      message === "openai_approval_required" ||
      message === "chatgpt_plan_denied" ||
      message === "chatgpt_plan_not_eligible"
    )
      return message;
    if (
      item.code === "proxy_credentials_unavailable" ||
      message.includes("proxy_credentials_unavailable")
    )
      return "proxy_credentials_unavailable";
    if (item.code === "proxy_unavailable" || message.includes("proxy_unavailable"))
      return "proxy_unavailable";
    // network.ts reports a 407 as this code; without it a wrong proxy password read as a provider fault.
    if (item.code === "proxy_auth_failed" || message.includes("proxy_auth_failed"))
      return "proxy_auth_failed";
    if (message.includes("proxy_unsupported")) return "proxy_unsupported";
    if (
      item.name === "AbortError" ||
      item.code === "ABORT_ERR" ||
      /\babort(?:ed)?\b/i.test(message)
    )
      return "aborted";
    if (status === 402) return "billing";
    if (
      status === 401 ||
      status === 403 ||
      /\b(?:unauthorized|forbidden)\b|invalid.{0,10}(?:api.?key|authentication)|no api key|authentication failed/i.test(
        message,
      )
    )
      return "auth_failed";
    // Account quotas need a different recovery action from short-lived request throttling.
    const quotaCode =
      /\b(?:insufficient_quota|usage_limit_reached|quota_exceeded|quota_exhausted|billing_hard_limit_reached|credits_exhausted|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded|GoUsageLimitError|FreeUsageLimitError)\b/i;
    const quotaMessage =
      /\b(?:usage limit|quota|credits?) (?:has been |is )?(?:reached|exceeded|exhausted|used up)\b|\b(?:you(?: have|'ve)|account has) (?:reached|exceeded|exhausted) (?:your |the )?(?:usage limit|quota|credits?)\b/i;
    if (quotaCode.test(item.code ?? "") || quotaCode.test(message) || quotaMessage.test(message))
      return "quota_exhausted";
    const caused = item.cause ? classify(item.cause) : "internal";
    if (caused === "quota_exhausted") return caused;
    if (status === 429 || /rate.?limit|too many requests/i.test(message)) return "rate_limited";
    if (/context.*(?:length|window|exceed|overflow)|maximum.*tokens/i.test(message))
      return "context_overflow";
    if (
      item.code === "model_not_found" ||
      /\bmodel_not_found\b/i.test(message) ||
      (status === 404 && /\bmodel\b[^\n]{0,200}\b(?:not found|does not exist)\b/i.test(message)) ||
      caused === "no_model"
    )
      return "no_model";
    // A rejected field can be named "network" or contain "service unavailable".
    if (status === 400 || status === 404 || status === 422) return "provider_rejected";
    if (
      /^(?:E(?:CONNREFUSED|CONNRESET|NETUNREACH|HOSTUNREACH|NOTFOUND|AI_AGAIN|TIMEDOUT)|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET))$/.test(
        item.code ?? "",
      ) ||
      item.name === "TimeoutError" ||
      /fetch failed|network|connection|socket|timed? ?out|TransferEncodingError|premature close|other side closed|\bterminated\b|\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b/i.test(
        message,
      )
    )
      return "network";
    // Split what the user can act on: wait / switch model (overloaded) vs. fix the request
    // (rejected); everything else from the provider stays provider_error.
    if (
      status === 529 ||
      status === 503 ||
      /overloaded|over capacity|temporarily unavailable|service unavailable/i.test(message)
    )
      return "provider_overloaded";
    if (/invalid.request|model.*not found|unsupported (?:parameter|model)/i.test(message))
      return "provider_rejected";
    if (
      (status !== undefined && status >= 400) ||
      /provider error|context.*(?:length|window|exceed)/i.test(message)
    )
      return "provider_error";
    return caused;
  }
  return typeof err === "string" ? classify({ message: err }) : classify(err);
}
