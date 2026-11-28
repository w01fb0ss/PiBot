import type { DatabaseSync } from "node:sqlite";
import {
  BingError,
  bingSearch,
  DuckDuckGoError,
  duckduckgoSearch,
  isProxyFailure,
  type NetworkProxy,
  searchJson,
} from "@pibot/execution";
import type { PolicyRequest } from "@pibot/policy";
import { type KernelMethodParams, RpcError, type SearchConfig } from "@pibot/protocol-base";
import type { Redactor, SecretCipher } from "@pibot/secrets";
import { SearchSettingsRepo, SecretStore, transaction } from "@pibot/storage";
import { z } from "zod";
import { abortable } from "../../core/abort.ts";
import { endpoint } from "../../core/endpoint.ts";
import { SearchCircuit } from "./search-circuit.ts";

const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
// Providers that take an API key (stored like the Brave and Tavily keys).
const keyedProviders = ["brave", "tavily", "keenable"] as const;
const row = z.object({
  title: z.string().max(8192),
  url: z.string().max(32768),
  description: z.string().max(65536).optional(),
  content: z.string().max(65536).optional(),
  // Keenable returns the page text in `snippet`; its `description` is always empty.
  snippet: z.string().max(65536).optional(),
});
export type SearchRecipient = Exclude<SearchConfig["provider"], "keyless">;
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
/** Ephemeral permission from the tool gate; it never updates the global disclosure setting. */
export interface TransientSearchAuthorization {
  recipient: SearchRecipient;
  snapshot: string;
  allowUndisclosed: boolean;
  current(): boolean;
}
export class SearchService {
  readonly circuit: SearchCircuit;
  readonly repo: SearchSettingsRepo;
  readonly secrets: SecretStore;
  readonly shutdown = new AbortController();
  private readonly unavailable = new Set<SearchRecipient>();
  private routingGeneration = 0;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private consentTail: Promise<void> = Promise.resolve();
  constructor(
    readonly db: DatabaseSync,
    cipher: SecretCipher,
    redactor: Redactor,
    readonly changed: () => void,
    private readonly http: typeof searchJson = searchJson,
    private readonly duck: typeof duckduckgoSearch = duckduckgoSearch,
    private readonly bing: typeof bingSearch = bingSearch,
    now: () => number = Date.now,
    private readonly proxy: () => NetworkProxy | undefined = () => undefined,
  ) {
    this.circuit = new SearchCircuit(now);
    this.repo = new SearchSettingsRepo(db);
    this.secrets = new SecretStore(db, cipher, redactor);
  }
  get(): SearchConfig | null {
    const value = this.repo.get();
    const config = value
      ? {
          ...value,
          configured:
            value.provider === "searxng" ||
            ["keyless", "duckduckgo", "bing"].includes(value.provider) ||
            this.secrets.has(`search:${value.provider}`, "apiKey"),
        }
      : null;
    return config?.configured ? config : this.repo.keyless();
  }
  snapshot() {
    return JSON.stringify([this.generation, this.get()]);
  }
  async confirmation<T>(
    parent: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
    timing?: import("@pibot/protocol-base").ToolTiming,
  ): Promise<T> {
    const signal = AbortSignal.any([parent, this.shutdown.signal]);
    const previous = this.consentTail;
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.consentTail = previous.then(() => next);
    try {
      if (timing) await timing.measure("queue", () => abortable(previous, signal));
      else await abortable(previous, signal);
      signal.throwIfAborted();
      return await action(signal);
    } finally {
      // A cancelled waiter cannot unlock a still-active confirmation in another Bot.
      release();
    }
  }
  async set(input: KernelMethodParams["search.setConfig"]): Promise<SearchConfig> {
    const work = this.tail.then(async () => {
      this.shutdown.signal.throwIfAborted();
      const config: SearchConfig =
        input.provider === "duckduckgo" || input.provider === "bing" || input.provider === "keyless"
          ? this.repo.keyless(input.provider)
          : input.provider === "searxng"
            ? {
                provider: input.provider,
                baseUrl: endpoint(input.baseUrl),
                configured: true,
                disclosed: false,
              }
            : {
                provider: input.provider,
                configured:
                  ("apiKey" in input && !!input.apiKey) ||
                  this.secrets.has(`search:${input.provider}`, "apiKey"),
                disclosed: false,
              };
      if (
        (keyedProviders as readonly string[]).includes(input.provider) &&
        "apiKey" in input &&
        input.apiKey
      )
        await this.secrets.set(`search:${input.provider}`, "apiKey", input.apiKey);
      const result = this.repo.set(config);
      this.generation++;
      this.resetCooldown();
      this.changed();
      return this.get() ?? result;
    });
    this.tail = work.catch(() => {
      /* Keep later settings writes usable after an encryption failure. */
    });
    return work;
  }
  disclose(provider: SearchRecipient, expectedEndpoint?: string, keylessGroup = false) {
    const config = this.get();
    if (
      config?.provider !== provider &&
      !(config?.provider === "keyless" && (provider === "duckduckgo" || provider === "bing"))
    )
      throw new RpcError(-32602, "search_service_changed");
    if (config?.provider === "searxng" && expectedEndpoint !== config.baseUrl)
      throw new RpcError(-32602, "search_service_changed");

    transaction(this.db, () => {
      if (keylessGroup && (provider === "duckduckgo" || provider === "bing")) {
        this.repo.disclose("duckduckgo");
        this.repo.disclose("bing");
      } else this.repo.disclose(provider);
    });
    this.generation++;
    const expected = this.snapshot();
    this.changed();
    return expected;
  }
  remove() {
    transaction(this.db, () => {
      for (const p of keyedProviders) this.secrets.remove(`search:${p}`, "apiKey");
      this.repo.remove();
    });
    this.generation++;
    this.resetCooldown();
    this.changed();
  }
  resetCooldown() {
    this.routingGeneration++;
    this.circuit.reset();
    this.unavailable.clear();
  }
  recipient(): SearchRecipient {
    const provider = this.get()?.provider ?? "keyless";
    return provider === "keyless"
      ? this.unavailable.has("duckduckgo") || this.circuit.cooling()
        ? "bing"
        : "duckduckgo"
      : provider;
  }
  assertReady(recipient: SearchRecipient) {
    if (this.unavailable.has(recipient))
      throw recipient === "duckduckgo"
        ? new DuckDuckGoError("unavailable")
        : new BingError("unavailable");
    if (recipient === "duckduckgo" && this.get()?.provider === "keyless")
      this.circuit.assertReady();
  }
  canFallback(error: unknown, recipient: SearchRecipient) {
    return (
      this.get()?.provider === "keyless" &&
      recipient === "duckduckgo" &&
      error instanceof DuckDuckGoError &&
      error.reason !== "structure"
    );
  }
  rememberedDuckFailure() {
    return this.unavailable.has("duckduckgo") ? "unavailable" : this.circuit.failure();
  }
  disclosed(recipient: SearchRecipient) {
    return recipient === "duckduckgo" || recipient === "bing"
      ? this.repo.recipientDisclosed(recipient)
      : (this.get()?.disclosed ?? false);
  }
  target(recipient = this.recipient()) {
    const config = this.get();
    if (!config?.configured) throw new RpcError(-32602, "search_not_configured");
    return config.provider === "searxng"
      ? `${config.baseUrl.replace(/\/$/, "")}/search`
      : recipient === "bing"
        ? "https://cn.bing.com/search"
        : recipient === "duckduckgo"
          ? "https://html.duckduckgo.com/html/"
          : config.provider === "brave"
            ? "https://api.search.brave.com/res/v1/web/search"
            : config.provider === "keenable"
              ? KEENABLE_SEARCH_URL
              : "https://api.tavily.com/search";
  }
  policyRequest(recipient = this.recipient()): PolicyRequest {
    const config = this.get();
    return {
      category: "web",
      url: this.target(recipient),
      search: {
        disclosed: this.disclosed(recipient),
        ...(["duckduckgo", "bing"].includes(recipient) ? { confirmBeforeUse: true } : {}),
        ...(config?.provider === "searxng" ? { configuredEndpoint: this.target() } : {}),
      },
    };
  }
  async query(
    query: string,
    count: number,
    signal: AbortSignal,
    recipient = this.recipient(),
    authorization?: TransientSearchAuthorization,
  ): Promise<SearchResult[]> {
    const config = this.get();
    if (!config?.configured) throw new RpcError(-32602, "search_not_configured");
    const assertAuthorized = () => {
      signal.throwIfAborted();
      if (
        authorization &&
        (authorization.recipient !== recipient ||
          authorization.snapshot !== this.snapshot() ||
          !authorization.current())
      )
        throw new RpcError(-32602, "search_service_changed");
      if (!this.disclosed(recipient) && !authorization?.allowUndisclosed)
        throw new RpcError(-32602, "search_disclosure_required");
    };
    assertAuthorized();
    const expected = this.snapshot();
    if (
      recipient !== this.recipient() &&
      !(config.provider === "keyless" && (recipient === "duckduckgo" || recipient === "bing"))
    )
      throw new RpcError(-32602, "search_service_changed");
    if (recipient === "duckduckgo" || recipient === "bing") {
      const current = AbortSignal.any([signal, this.shutdown.signal]);
      const send = () =>
        (recipient === "duckduckgo" ? this.duck : this.bing)(
          query,
          count,
          current,
          undefined,
          this.proxy(),
        );
      this.assertReady(recipient);
      const routing = this.routingGeneration;
      try {
        return await (recipient === "duckduckgo" && config.provider === "keyless"
          ? this.circuit.run(current, send)
          : send());
      } catch (error) {
        // Route memory never grants consent; cancellation and proxy failures do not poison it.
        if (
          !current.aborted &&
          routing === this.routingGeneration &&
          // The automatic DuckDuckGo circuit owns recovery; this legacy session skip
          // would otherwise override its half-open probe after a network timeout.
          !(recipient === "duckduckgo" && config.provider === "keyless") &&
          !isProxyFailure(error) &&
          (error instanceof DuckDuckGoError || error instanceof BingError) &&
          error.reason === "unavailable"
        )
          this.unavailable.add(recipient);
        throw error;
      }
    }
    const url = new URL(this.target());
    const key =
      config.provider === "searxng"
        ? undefined
        : await this.secrets.get(`search:${config.provider}`, "apiKey");
    if (expected !== this.snapshot()) throw new RpcError(-32602, "search_service_changed");
    // Reading a provider key can yield to a configuration or conversation-mode change.
    assertAuthorized();
    const headers: Record<string, string> = { accept: "application/json" };
    let body: string | undefined;
    if (config.provider === "brave") {
      headers["X-Subscription-Token"] = key ?? "";
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));
    } else if (config.provider === "keenable") {
      headers["X-API-Key"] = key ?? "";
      headers["Content-Type"] = "application/json";
      // Only this app name goes out; no user or device information.
      headers["X-Keenable-Title"] = "Pi Bot";
      body = JSON.stringify({ query, max_results: Math.min(count, 50), snippet_max_length: 1000 });
    } else if (config.provider === "tavily") {
      headers.authorization = `Bearer ${key}`;
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        query,
        max_results: count,
        include_answer: false,
        include_raw_content: false,
      });
    } else {
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
    }
    const data = await this.http({
      url: url.href,
      proxy: this.proxy(),
      method: body ? "POST" : "GET",
      body,
      headers,
      ...(config.provider === "searxng" ? { configuredPrivateEndpoint: config.baseUrl } : {}),
      signal: AbortSignal.any([signal, this.shutdown.signal]),
    });
    const parsed =
      config.provider === "brave"
        ? (z.object({ web: z.object({ results: z.array(row).max(100) }).optional() }).parse(data)
            .web?.results ?? [])
        : z.object({ results: z.array(row).max(1000) }).parse(data).results;
    return parsed.slice(0, count).flatMap((r) => {
      try {
        const url = new URL(r.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
        return [
          {
            title: r.title.slice(0, 500),
            url: url.href,
            proxy: this.proxy(),
            snippet: (r.snippet || r.description || r.content || "").slice(0, 2000),
          },
        ];
      } catch {
        return [];
      }
    });
  }
  cancel() {
    this.shutdown.abort();
  }
  async settingsSettled() {
    await this.tail;
  }
  async settled() {
    await this.settingsSettled();
    await this.consentTail;
  }
}
