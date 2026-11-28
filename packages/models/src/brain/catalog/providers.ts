// Keeps saved provider configuration and credentials consistent.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSupportedCredential,
  assertSupportedHeaders,
  type CustomProviderConfig,
  listProviderCatalog,
} from "@pibot/agent";
import {
  ADDED_MODELS_LIMIT,
  AddedModelIdSchema,
  type BuiltinVideoCatalogModel,
  type BuiltinVideoModel,
  BuiltinVideoModelsSchema,
  type BuiltinVideoProviderId,
  BuiltinVideoProviderIdSchema,
  CHATGPT_PLAN_PROVIDERS,
  type CustomProvider,
  type CustomProviderInfo,
  CustomProviderSchema,
  configuredVideoProviders,
  imageApiRequiresKey,
  MAGPIE_PROVIDER,
  magpiePort,
  RpcError,
  RpcErrorCodes,
  type VideoProviderConfig,
  validImageModelOptions,
} from "@pibot/models-contract/full";
import { assertSafeSecretValue, keyHint, type Redactor, type SecretCipher } from "@pibot/secrets";
import { type SecretStore, transaction } from "@pibot/storage";
import { z } from "zod";
import { ProvidersRepo } from "../../store/index.ts";
import {
  builtinVideoModels,
  builtinVideoProvider,
  discoverBuiltinVideos,
  type TestVideoBaseUrls,
} from "./builtin-videos.ts";

export const providerScope = (id: string) => `provider:${id}`;
const VideoCatalogSchema = z.strictObject({
  models: BuiltinVideoModelsSchema,
  fallback: z.boolean(),
  cached: z.literal(true).optional(),
});
type VideoCatalog = z.infer<typeof VideoCatalogSchema>;
const DisabledVideosSchema = z.array(BuiltinVideoModelsSchema.element.shape.id).max(2000);
const AddedModelsSchema = z.array(AddedModelIdSchema).max(ADDED_MODELS_LIMIT);

function withCachedPricing(model: BuiltinVideoModel, cached: boolean): BuiltinVideoCatalogModel {
  return cached ? { ...model, cachedPricing: true as const } : model;
}

function validMagpieConfig(config: Omit<CustomProvider, "apiKey">): boolean {
  return (
    magpiePort(config.baseUrl) !== undefined &&
    config.api === "openai-completions" &&
    !config.headers &&
    (!config.videoApi || config.videoApi === "openai-videos") &&
    (!config.videoModels?.length || config.videoApi === "openai-videos") &&
    (!config.imageApi || config.imageApi === "openai-images") &&
    (!config.imageModels?.length || config.imageApi === "openai-images")
  );
}

// Async cipher work finishes before a synchronous SQLite transaction. RPCs never hold a
// database transaction over an await, and failed encryption cannot partially replace a provider.
export class ProviderStore {
  readonly catalog = listProviderCatalog();
  readonly repo: ProvidersRepo;
  readonly secrets: SecretStore;
  private readonly custom = new Map<string, CustomProviderConfig>();
  private readonly lockedHeaders = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: SecretCipher,
    private readonly redactor: Redactor,
    secrets: SecretStore,
    private readonly testVideoBases: TestVideoBaseUrls = {},
    private readonly fetchCatalog?: typeof fetch,
  ) {
    this.repo = new ProvidersRepo(db);
    this.secrets = secrets;
  }

  configs = (): CustomProviderConfig[] => structuredClone([...this.custom.values()]);

  private usesBuiltinVideoKey(id: BuiltinVideoProviderId) {
    const row = this.repo.get(id);
    const selected = row?.config.selectedAuth;
    return (
      row?.kind !== "custom" &&
      (selected === undefined || selected === "apiKey") &&
      this.secrets.has(providerScope(id), "apiKey")
    );
  }

  private savedVideoModels(id: BuiltinVideoProviderId) {
    const parsed = BuiltinVideoModelsSchema.safeParse(this.repo.get(id)?.config.videoModels);
    return parsed.success ? parsed.data : [];
  }

  private enabledVideoModels(id: BuiltinVideoProviderId, catalog = this.savedVideoCatalog(id)) {
    return builtinVideoModels(id, this.savedVideoModels(id)).map((model) =>
      withCachedPricing(model, !catalog || catalog.fallback || !!catalog.cached),
    );
  }

  videoProviders = (): VideoProviderConfig[] => {
    const custom = configuredVideoProviders([...this.custom.values()], (id) =>
      this.secrets.has(providerScope(id), "apiKey"),
    ).map(({ id, name, baseUrl, videoApi, videoModels }) => ({
      id,
      name,
      baseUrl,
      videoApi,
      videoModels: structuredClone(videoModels),
    }));
    const builtin = BuiltinVideoProviderIdSchema.options.flatMap((id) => {
      if (!this.usesBuiltinVideoKey(id)) return [];
      const videoModels = this.enabledVideoModels(id);
      return videoModels.length
        ? [{ ...builtinVideoProvider(id, this.testVideoBases), videoModels }]
        : [];
    });
    return [...custom, ...builtin];
  };

  private async discoverVideoModels(id: BuiltinVideoProviderId, signal: AbortSignal) {
    if (!this.usesBuiltinVideoKey(id))
      throw new RpcError(RpcErrorCodes.invalidParams, "video_model_unavailable");
    const key = await this.secrets.get(providerScope(id), "apiKey");
    if (!key || !this.usesBuiltinVideoKey(id))
      throw new RpcError(RpcErrorCodes.invalidParams, "video_model_unavailable");
    const provider = builtinVideoProvider(id, this.testVideoBases);
    try {
      const { models, fallback } = await discoverBuiltinVideos(
        provider,
        key,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        this.fetchCatalog,
      );
      return { models: models.filter(({ id }) => this.redactor.redact(id) === id), fallback };
    } catch {
      signal.throwIfAborted();
      throw new RpcError(RpcErrorCodes.invalidParams, "provider_error");
    }
  }

  private savedVideoCatalog(id: BuiltinVideoProviderId) {
    const parsed = VideoCatalogSchema.safeParse(this.repo.get(id)?.config.videoCatalog);
    return parsed.success ? parsed.data : undefined;
  }

  videoOptions(id: BuiltinVideoProviderId) {
    if (!this.usesBuiltinVideoKey(id)) return [];
    const catalog = this.savedVideoCatalog(id);
    const entries = new Map(
      builtinVideoModels(id, catalog?.models ?? []).map((model) => [
        model.id,
        { ...withCachedPricing(model, !!catalog?.cached), enabled: false },
      ]),
    );
    for (const model of this.enabledVideoModels(id, catalog))
      entries.set(model.id, { ...model, enabled: true });
    return [...entries.values()];
  }

  videoModelsToEnable = () =>
    BuiltinVideoProviderIdSchema.options.flatMap((providerId) =>
      this.videoOptions(providerId).flatMap(({ enabled, ...model }) =>
        enabled ? [] : [{ kind: "enable_video_model" as const, providerId, model }],
      ),
    );

  private async refreshVideoCatalog(id: BuiltinVideoProviderId, signal: AbortSignal) {
    signal.throwIfAborted();
    let catalog: VideoCatalog | undefined;
    try {
      catalog = await this.discoverVideoModels(id, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RpcError)) throw error;
    }
    signal.throwIfAborted();
    const previous = this.savedVideoCatalog(id);
    // An outage or fallback does not confirm which models are still offered or what they cost.
    if ((!catalog || catalog.fallback) && previous && !previous.fallback)
      catalog = { ...previous, cached: true };
    if (!catalog) return false;
    const config = { ...this.repo.get(id)?.config };
    const saved = this.savedVideoModels(id);
    const disabled = new Set(DisabledVideosSchema.safeParse(config.disabledVideoModels).data ?? []);
    const next =
      catalog.fallback || catalog.cached
        ? saved
        : catalog.models.filter(({ id }) => !disabled.has(id));
    if (
      JSON.stringify(catalog) !== JSON.stringify(config.videoCatalog) ||
      JSON.stringify(next) !== JSON.stringify(saved)
    ) {
      this.repo.upsert({
        id,
        kind: "builtin",
        config: { ...config, videoCatalog: catalog, videoModels: next },
      });
    }
    return true;
  }

  refreshVideoCatalogs(signal: AbortSignal) {
    return this.serialize(async () => {
      const results = await Promise.allSettled(
        BuiltinVideoProviderIdSchema.options
          .filter((id) => this.usesBuiltinVideoKey(id))
          .map((id) => this.refreshVideoCatalog(id, signal)),
      );
      signal.throwIfAborted();
      for (const result of results) if (result.status === "rejected") throw result.reason;
    });
  }

  async listVideoModels(id: BuiltinVideoProviderId, refresh: boolean, signal: AbortSignal) {
    return this.serialize(async () => {
      if (!this.usesBuiltinVideoKey(id))
        throw new RpcError(RpcErrorCodes.invalidParams, "video_model_unavailable");
      const refreshed = refresh ? await this.refreshVideoCatalog(id, signal) : undefined;
      signal.throwIfAborted();
      const catalog = this.savedVideoCatalog(id);
      return {
        models: this.videoOptions(id),
        fallback: catalog?.fallback ?? false,
        unavailable: refreshed === false || !catalog || !!catalog.cached,
      };
    });
  }

  async setVideoModel(
    id: BuiltinVideoProviderId,
    modelId: string,
    enabled: boolean,
    signal: AbortSignal,
    recordChange?: () => void,
  ) {
    signal.throwIfAborted();
    if (!this.usesBuiltinVideoKey(id))
      throw new RpcError(RpcErrorCodes.invalidParams, "video_model_unavailable");
    const saved = this.savedVideoModels(id);
    if (saved.some((model) => model.id === modelId) === enabled) return false;
    const next = saved.filter((model) => model.id !== modelId);
    let cachedCatalog: VideoCatalog | undefined;
    if (enabled) {
      const discovered = await this.discoverVideoModels(id, signal);
      const previous = this.savedVideoCatalog(id);
      if (discovered.fallback && previous && !previous.fallback)
        cachedCatalog = { ...previous, cached: true };
      const candidate = (cachedCatalog ?? discovered).models.find((model) => model.id === modelId);
      if (!candidate) throw new RpcError(RpcErrorCodes.invalidParams, "video_model_unavailable");
      next.push(candidate);
    }
    signal.throwIfAborted();
    const config = { ...this.repo.get(id)?.config };
    const disabled = new Set(DisabledVideosSchema.safeParse(config.disabledVideoModels).data ?? []);
    if (enabled) disabled.delete(modelId);
    else disabled.add(modelId);
    const parsed = BuiltinVideoModelsSchema.safeParse(next);
    const disabledModels = DisabledVideosSchema.safeParse([...disabled]);
    if (!parsed.success || !disabledModels.success)
      throw new RpcError(RpcErrorCodes.invalidParams, "video_model_unavailable");
    transaction(this.db, () => {
      this.repo.upsert({
        id,
        kind: "builtin",
        config: {
          ...config,
          ...(cachedCatalog && { videoCatalog: cachedCatalog }),
          videoModels: parsed.data,
          disabledVideoModels: disabledModels.data,
        },
      });
      recordChange?.();
    });
    return true;
  }

  updateModelLimits(
    id: string,
    modelId: string,
    limits: { maxTokens?: number; contextWindow?: number },
  ) {
    const current = this.custom.get(id);
    if (!current) return;
    const models = current.models.map((model) => {
      if (model.id !== modelId) return model;
      const next = {
        ...model,
        ...(model.maxTokens === undefined && limits.maxTokens
          ? { maxTokens: limits.maxTokens }
          : {}),
        ...(model.contextWindow === undefined && limits.contextWindow
          ? { contextWindow: limits.contextWindow }
          : {}),
      };
      return next.maxTokens !== model.maxTokens || next.contextWindow !== model.contextWindow
        ? { ...next, limitsSource: "provider" as const }
        : model;
    });
    if (models.every((model, index) => model === current.models[index])) return;
    const next = { ...current, models };
    this.custom.set(id, next);
    this.repo.upsert({ id, kind: "custom", config: next });
  }

  async requireCredentials(id: string): Promise<void> {
    if (id === MAGPIE_PROVIDER.id) return;
    await this.secrets.get(providerScope(id), "apiKey");
    if (this.lockedHeaders.has(id)) {
      const headers = await this.readHeaders(id);
      this.custom.set(id, { ...this.get(id), headers });
      this.lockedHeaders.delete(id);
    }
  }

  private async readHeaders(id: string) {
    const encoded = await this.secrets.get(providerScope(id), "headers");
    const headers = encoded
      ? CustomProviderSchema.shape.headers.parse(JSON.parse(encoded))
      : undefined;
    this.registerHeaders(headers);
    return headers;
  }

  get = (id: string): CustomProviderConfig => {
    const config = this.custom.get(id);
    if (!config) throw new RpcError(-32602, "Unknown custom provider");
    return structuredClone(config);
  };

  /** Non-secret fields only; built field by field so new secret fields cannot leak by default. */
  info(id: string): CustomProviderInfo {
    const {
      name,
      baseUrl,
      api,
      compat,
      models,
      headers,
      imageApi,
      imageModels,
      videoApi,
      videoModels,
    } = this.get(id);
    return {
      id,
      name,
      baseUrl,
      api,
      ...(compat ? { compat } : {}),
      models,
      ...(videoApi ? { videoApi } : {}),
      ...(videoModels ? { videoModels } : {}),
      ...(imageApi ? { imageApi } : {}),
      ...(imageModels ? { imageModels } : {}),
      hasApiKey: this.secrets.has(providerScope(id), "apiKey"),
      hasHeaders: this.secrets.has(providerScope(id), "headers"),
      headerNames: Object.keys(headers ?? {}),
    };
  }

  async initialize(): Promise<void> {
    for (const row of this.repo.list()) {
      if (row.kind !== "custom") continue;
      const cfg = CustomProviderSchema.omit({ apiKey: true }).parse(row.config);
      if (row.id === MAGPIE_PROVIDER.id && !validMagpieConfig(cfg)) continue;
      if (row.id !== MAGPIE_PROVIDER.id && this.secrets.has(providerScope(row.id), "headers"))
        this.lockedHeaders.add(row.id);
      this.custom.set(row.id, { ...cfg, id: row.id });
    }
    // No plaintext enters memory at startup. Reads register keys and individual header
    // values with the redactor before exposing them to request code or diagnostics.
  }

  private registerHeaders(headers?: Record<string, string>) {
    for (const value of Object.values(headers ?? {})) {
      if (value.trim()) this.redactor.add(value.trim());
    }
  }

  serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  async settled() {
    await this.tail;
  }

  /** Hand-added model ids per built-in provider; a malformed stored list is ignored, not trusted. */
  addedModels = (): Record<string, string[]> => {
    const result: Record<string, string[]> = {};
    for (const row of this.repo.list()) {
      if (row.kind !== "builtin") continue;
      const parsed = AddedModelsSchema.safeParse(row.config.addedModels);
      if (parsed.success && parsed.data.length) result[row.id] = parsed.data;
    }
    return result;
  };

  /** Only built-in API-key providers: their key and endpoint stay pi's catalog entry. */
  changeAddedModel(id: string, modelId: string, add: boolean): boolean {
    if (this.custom.has(id) || !this.catalog.some((p) => p.id === id && p.auth === "apiKey"))
      throw new RpcError(-32602, "added_model_unsupported");
    const config = { ...this.repo.get(id)?.config };
    const current = AddedModelsSchema.safeParse(config.addedModels);
    const list = current.success ? current.data : [];
    const next = add
      ? list.includes(modelId)
        ? list
        : [...list, modelId]
      : list.filter((entry) => entry !== modelId);
    if (next.length > ADDED_MODELS_LIMIT) throw new RpcError(-32602, "added_models_limit");
    if (next === list || next.length === list.length) return false;
    if (next.length) config.addedModels = next;
    else delete config.addedModels;
    this.repo.upsert({ id, kind: "builtin", config });
    return true;
  }

  assertWritable(id: string) {
    if (!this.custom.has(id) && !this.catalog.some((p) => p.id === id && p.auth === "apiKey"))
      throw new RpcError(-32602, "Provider is unavailable");
  }

  async setKey(id: string, value: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (id === MAGPIE_PROVIDER.id) throw new RpcError(-32602, "magpie_requires_local_setup");
    this.assertWritable(id);
    assertSupportedCredential(value);
    await this.secrets.set(providerScope(id), "apiKey", value);
    if (!this.custom.has(id))
      this.repo.upsert({
        id,
        kind: "builtin",
        config: { ...this.repo.get(id)?.config, selectedAuth: "apiKey" },
      });
  }

  refreshVideoCatalogForKey(id: string, signal: AbortSignal) {
    const builtin = BuiltinVideoProviderIdSchema.safeParse(id);
    if (builtin.success && this.usesBuiltinVideoKey(builtin.data))
      return this.refreshVideoCatalog(builtin.data, signal);
  }

  async upsert(input: CustomProvider, afterWrite?: (providerId: string) => void): Promise<string> {
    if (
      (!input.models.length && !input.imageModels?.length && !input.videoModels?.length) ||
      (!!input.imageModels?.length && !input.imageApi) ||
      input.imageModels?.some((model) => !validImageModelOptions(input.imageApi, model))
    )
      throw new RpcError(-32602, "image_model_unavailable");
    const imageIds = new Set(input.imageModels?.map((model) => model.id));
    if (
      imageIds.size !== (input.imageModels?.length ?? 0) ||
      input.models.some((model) => imageIds.has(model.id))
    )
      throw new RpcError(-32602, "image_mode_mismatch");
    const videos = new Set(input.videoModels?.map((model) => model.id));
    if (
      (videos.size > 0 && !input.videoApi) ||
      videos.size !== (input.videoModels?.length ?? 0) ||
      input.models.some((model) => videos.has(model.id)) ||
      [...videos].some((id) => imageIds.has(id))
    )
      throw new RpcError(-32602, "video_model_invalid");
    const id = input.id ?? randomUUID();
    if (["openai-codex", "github-copilot", ...CHATGPT_PLAN_PROVIDERS].includes(id))
      throw new RpcError(-32602, "subscription_unsupported");
    if (this.catalog.some((p) => p.id === id && p.auth !== "custom"))
      throw new RpcError(-32602, "Cannot replace a builtin provider");
    if (id === MAGPIE_PROVIDER.id && (!validMagpieConfig(input) || input.apiKey !== undefined))
      throw new RpcError(-32602, "magpie_requires_local_setup");
    const { apiKey, headers, ...publicConfig } = input;
    assertSupportedCredential(apiKey);
    assertSupportedHeaders(headers);
    const config = {
      ...publicConfig,
      id,
      ...(id === "ollama"
        ? {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions" as const,
            compat: { ...input.compat, supportsDeveloperRole: false },
          }
        : {}),
    };
    CustomProviderSchema.omit({ apiKey: true }).parse(config);
    const url = new URL(config.baseUrl);
    if (
      url.username ||
      url.password ||
      ((config.videoApi || config.imageApi) && (url.search || url.hash)) ||
      [...url.searchParams.keys()].some((name) => /key|token|secret|password|auth/i.test(name))
    )
      throw new RpcError(-32602, "Put credentials in API Key or headers");
    const previous = this.custom.get(id);
    if (
      previous &&
      (imageApiRequiresKey(previous.imageApi) || imageApiRequiresKey(config.imageApi)) &&
      new URL(previous.baseUrl).origin !== url.origin &&
      ((!apiKey && this.secrets.has(providerScope(id), "apiKey")) ||
        (headers === undefined && this.secrets.has(providerScope(id), "headers")))
    )
      throw new RpcError(-32602, "Replace saved credentials when changing the service origin");
    if (
      config.imageApi === "comfyui-images" &&
      !config.models.length &&
      !config.videoModels?.length &&
      (apiKey || Object.keys(headers ?? {}).length)
    )
      throw new RpcError(-32602, "ComfyUI requires no credentials");
    if (apiKey) this.redactor.add(apiKey);
    this.registerHeaders(headers);
    if (this.redactor.redact(JSON.stringify(config)) !== JSON.stringify(config))
      throw new RpcError(-32602, "Provider metadata must not contain secrets");
    const clearHeaders = headers !== undefined && Object.keys(headers).length === 0;
    const pending: Array<{ name: string; value: string; cipher: Uint8Array }> = [];
    for (const [name, value] of [
      ["apiKey", apiKey],
      ["headers", headers === undefined || clearHeaders ? undefined : JSON.stringify(headers)],
    ] as const) {
      if (value === undefined) continue;
      assertSafeSecretValue(value);
      if (!(await this.cipher.isAvailable()))
        throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
      pending.push({ name, value, cipher: await this.cipher.encrypt(value) });
    }
    transaction(this.db, () => {
      this.repo.upsert({ id, kind: "custom", config });
      // Clearing headers needs only a database delete, not an encrypted empty credential.
      if (clearHeaders) this.secrets.remove(providerScope(id), "headers");
      for (const entry of pending) {
        this.db
          .prepare(`INSERT INTO secrets (id, scope, name, ciphertext, hint, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope, name) DO UPDATE
          SET ciphertext = excluded.ciphertext, hint = excluded.hint, last_used_at = NULL`)
          .run(
            randomUUID(),
            providerScope(id),
            entry.name,
            entry.cipher,
            keyHint(entry.value) ?? null,
            new Date().toISOString(),
          );
      }
      // Model metadata and affected Bot thinking levels must commit together.
      afterWrite?.(id);
    });
    for (const entry of pending) this.redactor.add(entry.value);
    this.registerHeaders(headers);
    this.custom.set(id, { ...config, headers: headers ?? previous?.headers });
    if (headers !== undefined) this.lockedHeaders.delete(id);
    return id;
  }

  remove(id: string): void {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM secrets WHERE scope = ?").run(providerScope(id));
      this.repo.remove(id);
    });
    this.custom.delete(id);
    this.lockedHeaders.delete(id);
  }
}
