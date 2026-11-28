import {
  BingError,
  type BlockedPageReason,
  DuckDuckGoError,
  isProxyFailure,
  SearchStatusError,
} from "@pibot/execution";
import { auditProviderName } from "../../core/audit-fields.ts";
import type { PreparedTool } from "../../core/local-types.ts";
import { allowedByYolo, runYolo } from "../../core/yolo.ts";
import type { LocalRun } from "../../runtime/tools/local-run.ts";
import { SearchCooldownError } from "./search-circuit.ts";
import type { SearchResult } from "./search-service.ts";

export class SearchRunError extends Error {
  constructor(
    readonly zh: string,
    readonly en: string,
    readonly blocked?: {
      provider: "duckduckgo" | "bing";
      reason: BlockedPageReason;
      receipt: PreparedTool;
    },
  ) {
    super("search_failed");
  }
  text(language: "zh" | "en") {
    return language === "zh" ? this.zh : this.en;
  }
}
/** Keenable's HTTP errors, each with something the user can do; never a silent empty result. */
function keenableStatus(status: number) {
  if (status === 429)
    return new SearchRunError(
      "Keenable 搜索请求太频繁（429），请稍后再试，或在设置里换一个搜索服务",
      "Keenable is rate limiting searches (429). Try again shortly, or switch the search service in settings",
    );
  if (status === 401 || status === 403)
    return new SearchRunError(
      `Keenable 拒绝了这个 API Key（${status}），请在设置里检查或更换 Key`,
      `Keenable rejected the API key (${status}). Check or replace the key in settings`,
    );
  if (status === 402)
    return new SearchRunError(
      "Keenable 账户额度不足（402），请充值，或在设置里换一个搜索服务",
      "The Keenable account is out of credits (402). Add credits, or switch the search service in settings",
    );
  return new SearchRunError(
    `Keenable 搜索失败（HTTP ${status}），请稍后再试，或在设置里换一个搜索服务`,
    `Keenable search failed (HTTP ${status}). Try again, or switch the search service in settings`,
  );
}
export function failure(error: unknown, provider: string, receipt?: PreparedTool) {
  if (provider === "Keenable" && error instanceof SearchStatusError)
    return keenableStatus(error.status);
  const reason =
    error instanceof DuckDuckGoError || error instanceof BingError ? error.reason : "other";
  return reason === "unavailable"
    ? new SearchRunError(
        `连不上 ${provider}（网络不通或超时）`,
        `Cannot connect to ${provider} (network unavailable or timed out)`,
      )
    : reason === "dns_blocked"
      ? new SearchRunError(
          `当前网络的 DNS 把 ${provider} 解析到本机或内网地址，搜索被网络拦截（Pi Bot 不连接这类地址）`,
          `Your network's DNS resolves ${provider} to a local or private address, so the network blocks this search provider (Pi Bot does not connect to such addresses)`,
        )
      : reason === "blocked"
        ? new SearchRunError(
            `${provider} 拦截了搜索（验证页或非 200 响应）`,
            `${provider} blocked search (verification page or non-200 response)`,
            currentBlocked(error, receipt),
          )
        : reason === "structure"
          ? new SearchRunError(
              `${provider} 搜索页结构变化或响应不可用`,
              `${provider} search page changed or its response is unusable`,
            )
          : new SearchRunError(
              "搜索未能完成，请检查服务配置",
              "Search could not complete; check the service configuration",
            );
}
function currentBlocked(error: unknown, receipt?: PreparedTool) {
  if (
    receipt &&
    (error instanceof DuckDuckGoError || error instanceof BingError) &&
    error.blockedReason
  )
    return {
      provider: error instanceof BingError ? ("bing" as const) : ("duckduckgo" as const),
      reason: error.blockedReason,
      receipt,
    };
  return undefined;
}
function bothFailed(first: unknown, second: unknown, currentFirst = true, receipt?: PreparedTool) {
  const a = failure(first, "DuckDuckGo");
  const b = failure(second, "Bing");
  return new SearchRunError(
    `DuckDuckGo 和 Bing 在你的网络下都用不了：${a.zh}；${b.zh}。可以在设置里配 Tavily 或 SearXNG。`,
    `DuckDuckGo and Bing are both unavailable on your network: ${a.en}; ${b.en}. Configure Tavily or SearXNG in settings.`,
    currentBlocked(second, receipt) ?? (currentFirst ? currentBlocked(first, receipt) : undefined),
  );
}
export async function executeSearch(
  run: LocalRun,
  original: PreparedTool,
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const search = run.local.deps.search;
  const timing = run.timing(original.call.id);
  const previousFallback =
    original.searchRecipient === "bing" && search?.get()?.provider === "keyless"
      ? search.rememberedDuckFailure()
      : undefined;
  timing?.web(
    "miss",
    previousFallback === "blocked" || previousFallback === "dns_blocked"
      ? "duckduckgo_blocked"
      : previousFallback
        ? "duckduckgo_unavailable"
        : "none",
  );
  if (!search || !original.searchRecipient || !run.validSearch(original))
    throw new SearchRunError("搜索授权发生变化", "Search authorization changed");
  const send = async (prepared: PreparedTool, reasonCode?: string) => {
    signal.throwIfAborted();
    if (!run.validSearch(prepared) || !prepared.searchRecipient)
      throw new SearchRunError("搜索授权发生变化", "Search authorization changed");
    const providerId = prepared.searchRecipient;
    search.assertReady(providerId);
    run.local.approvals.audit.append({
      botId: run.context.botId,
      runId: run.context.runId,
      kind: "search.sent",
      summary: `Search via ${auditProviderName(providerId) ?? providerId}`,
      detail: {
        providerId,
        providerName: auditProviderName(providerId),
        toolName: "web_search",
        ...(reasonCode ? { reasonCode } : {}),
      },
    });
    return search.query(query, count, signal, providerId, {
      recipient: providerId,
      snapshot: search.snapshot(),
      allowUndisclosed: allowedByYolo(prepared.result),
      current: () =>
        (!allowedByYolo(prepared.result) || runYolo(run.local, run.context)) &&
        run.validSearch(prepared),
    });
  };
  try {
    return await send(
      original,
      previousFallback ? `duckduckgo_cooldown_${previousFallback}` : undefined,
    );
  } catch (first) {
    signal.throwIfAborted();
    if (isProxyFailure(first)) throw first;
    if (first instanceof SearchRunError) throw first;
    if (
      original.searchRecipient === "bing" &&
      search.get()?.provider === "keyless" &&
      search.rememberedDuckFailure()
    )
      throw bothFailed(
        new DuckDuckGoError(search.rememberedDuckFailure() ?? "unavailable"),
        first,
        false,
        original,
      );
    if (!search.canFallback(first, original.searchRecipient))
      throw failure(
        first,
        auditProviderName(original.searchRecipient) ?? original.searchRecipient,
        original,
      );
    // Fixed reason codes only (never the query): "unavailable" alone hid DNS blocks before.
    run.local.deps.logger.info(
      `DuckDuckGo ${first instanceof DuckDuckGoError ? first.reason : first instanceof SearchCooldownError ? `cooldown_${first.reason}` : "failed"}; switching to Bing`,
    );
    const next = await run.fallbackSearch(original, signal);
    if (typeof next === "string") throw new SearchRunError(next, next);
    timing?.web(
      "miss",
      first instanceof DuckDuckGoError && ["blocked", "dns_blocked"].includes(first.reason)
        ? "duckduckgo_blocked"
        : "duckduckgo_unavailable",
    );
    try {
      return await send(
        next,
        first instanceof SearchCooldownError
          ? `duckduckgo_cooldown_${first.reason}`
          : first instanceof DuckDuckGoError && first.reason === "blocked"
            ? "duckduckgo_blocked"
            : first instanceof DuckDuckGoError && first.reason === "dns_blocked"
              ? "duckduckgo_dns_blocked"
              : "duckduckgo_unavailable",
      );
    } catch (second) {
      signal.throwIfAborted();
      if (isProxyFailure(second)) throw second;
      if (second instanceof SearchRunError) throw second;
      run.local.deps.logger.info(
        `Bing ${second instanceof BingError ? second.reason : "failed"} after DuckDuckGo`,
      );
      throw bothFailed(first, second, true, next);
    }
  }
}
