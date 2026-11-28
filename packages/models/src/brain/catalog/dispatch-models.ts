import type { CapabilityContext } from "@pibot/brain/kit";
import {
  type DispatchModel,
  type DispatchModelReason,
  importedMagpieRoute,
  isChatGPTPlanProvider,
  isRetiredModel,
  MAGPIE_PROVIDER,
  type ModelInfo,
  magpiePort,
} from "@pibot/models-contract/full";
import { BotsRepo, SettingsRepo } from "@pibot/storage";
import { recentModelOutcomes } from "../../store/providers/model-health.ts";
import type { ProviderAuth } from "../auth/provider-auth.ts";
import { detectMagpie } from "./magpie.ts";
import { detectOllama } from "./ollama.ts";
import { type ProviderStore, providerScope } from "./providers.ts";

const cooldownMs = 5 * 60_000;
const providerErrors = new Set([
  "auth_failed",
  "quota_exhausted",
  "billing",
  "local_unreachable",
  "sign_in_required",
]);
const key = (model: { provider: string; id: string }) => JSON.stringify([model.provider, model.id]);

/** Low metered prices signal the fast tier even when a model supports thinking. Wider
 * context or premium prices put reasoning models in strong. Zero/unknown prices are
 * neutral: a plan or local model can still be strong. */
export function dispatchTier({
  reasoning,
  contextWindow,
  cost,
}: Pick<ModelInfo, "reasoning" | "contextWindow" | "cost">) {
  if (
    cost.input !== null &&
    cost.output !== null &&
    (cost.input > 0 || cost.output > 0) &&
    cost.input <= 0.3 &&
    cost.output <= 2
  )
    return "fast";
  if (reasoning && (contextWindow >= 196_000 || (cost.output ?? 0) >= 12)) return "strong";
  return "balanced";
}

export async function dispatchModels(
  { db, agent }: Pick<CapabilityContext, "db" | "agent">,
  providers: ProviderStore,
  auth: ProviderAuth,
  signal: AbortSignal,
): Promise<DispatchModel[]> {
  const [text, available, images] = await Promise.all([
    agent.listModels({ includeRetired: true }),
    agent.listModels({ availableOnly: true }),
    agent.listImageModels?.({ signal }) ?? [],
  ]);
  signal.throwIfAborted();
  const availableText = new Set(available.map(key));
  const configured = new Set([
    ...available.map(({ provider }) => provider),
    ...images.filter((image) => image.configured).map(({ provider }) => provider),
  ]);
  const custom = new Map(providers.configs().map((config) => [config.id, config]));
  const catalog = new Map(providers.catalog.map((entry) => [entry.id, entry]));
  const botModels = new BotsRepo(db)
    .list()
    .flatMap((bot) =>
      !bot.kind && bot.modelProvider && bot.modelId
        ? [{ provider: bot.modelProvider, id: bot.modelId }]
        : [],
    );
  const defaultModel = new SettingsRepo(db).get().defaultModel;
  if (defaultModel) botModels.push(defaultModel);
  const configuredBots = new Set(botModels.map(({ provider }) => provider));
  const providerIds = new Set([...text, ...images].map(({ provider }) => provider));
  for (const id of custom.keys()) providerIds.add(id);
  for (const id of providerIds) {
    if (
      custom.has(id) ||
      providers.repo.get(id) ||
      configuredBots.has(id) ||
      (isChatGPTPlanProvider(id) && catalog.has(id))
    )
      configured.add(id);
  }

  const gateways = new Map(
    await Promise.all(
      providers.configs().flatMap((config) => {
        const port =
          config.id === MAGPIE_PROVIDER.id || importedMagpieRoute(config)
            ? magpiePort(config.baseUrl)
            : undefined;
        if (port !== undefined)
          return [detectMagpie(port, signal).then((state) => [config.id, state.running] as const)];
        if (config.id === "ollama")
          return [detectOllama().then((state) => [config.id, state.running] as const)];
        return [];
      }),
    ),
  );
  signal.throwIfAborted();

  const providerOutcome = new Map<string, DispatchModelReason>();
  const modelOutcome = new Map<string, DispatchModelReason>();
  const updated = new Map([...providerIds].map((id) => [id, providers.repo.get(id)?.updatedAt]));
  for (const row of recentModelOutcomes(db, new Date(Date.now() - cooldownMs).toISOString())) {
    if ((updated.get(row.provider) ?? "") > row.at) continue;
    if (!providerOutcome.has(row.provider)) {
      if (row.error === null) providerOutcome.set(row.provider, "ready");
      else if (providerErrors.has(row.error))
        providerOutcome.set(row.provider, row.error as DispatchModelReason);
    }
    const modelKey = key({ provider: row.provider, id: row.model });
    if (!modelOutcome.has(modelKey)) {
      if (row.error === null) modelOutcome.set(modelKey, "ready");
      else if (row.error === "no_model" || row.error === "model_not_found")
        modelOutcome.set(modelKey, "model_not_found");
      // Throttling and overload may affect one model's serving pool; try a healthy sibling.
      else if (row.error === "provider_overloaded" || row.error === "rate_limited")
        modelOutcome.set(modelKey, row.error);
    }
  }

  const removedSubscriptions = new Set([
    "claude-code",
    "claude-pro",
    "openai-codex",
    "github-copilot",
  ]);
  const availability = (model: { provider: string; id: string }, usable: boolean) => {
    const { provider } = model;
    if (isRetiredModel(provider, model.id)) return "retired";
    if (gateways.get(provider) === false) return "local_unreachable";
    if (isChatGPTPlanProvider(provider)) {
      const state = auth.chatgpt(provider);
      if (state.state !== "connected") return "sign_in_required";
      if (state.usageLimited) return "quota_exhausted";
    }
    if (removedSubscriptions.has(provider)) return "sign_in_required";
    if (!usable) return "credentials_missing";
    const failure = providerOutcome.get(provider);
    if (failure && failure !== "ready") return failure;
    return modelOutcome.get(key(model)) ?? "ready";
  };

  const rows = new Map<string, DispatchModel>();
  for (const model of text) {
    if (!configured.has(model.provider)) continue;
    const config = custom.get(model.provider);
    // The SDK marks custom text endpoints keyless whenever they have models. For dispatch,
    // remote endpoints must have credentials. Explicit local gateways have their own probe.
    const authenticated =
      !config ||
      providers.secrets.has(providerScope(model.provider), "apiKey") ||
      providers.secrets.has(providerScope(model.provider), "headers") ||
      gateways.has(model.provider) ||
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.baseUrl).hostname);
    const reason = availability(model, availableText.has(key(model)) && authenticated);
    const cost = { input: model.cost.input, output: model.cost.output };
    rows.set(key(model), {
      provider: model.provider,
      id: model.id,
      name: model.name,
      tier: dispatchTier(model),
      pricePerMillion: cost,
      contextWindow: model.contextWindow,
      abilities: {
        text: model.input.includes("text"),
        imageInput: model.input.includes("image"),
        imageOutput: false,
        video: false,
        reasoning: model.reasoning
          ? (model.thinkingLevels ?? ["off", "low", "medium", "high"])
          : [],
      },
      available: reason === "ready",
      reason,
    });
  }
  for (const image of images) {
    if (!configured.has(image.provider)) continue;
    const reason = availability(image, image.configured);
    const existing = rows.get(key(image));
    // The same ID may exist in the text and image catalogs and be dispatched through either path.
    if (existing) {
      existing.abilities.imageOutput = image.output.includes("image");
      existing.imageModes = image.modes;
      existing.imagePrice = image.generationPrice;
      continue;
    }
    rows.set(key(image), {
      provider: image.provider,
      id: image.id,
      name: image.name,
      imageModes: image.modes,
      imagePrice: image.generationPrice,
      tier: "balanced",
      pricePerMillion: { input: null, output: null },
      abilities: {
        text: false,
        imageInput: image.modes.includes("image-to-image"),
        imageOutput: image.output.includes("image"),
        video: false,
        reasoning: [],
      },
      available: reason === "ready",
      reason,
    });
  }
  for (const [provider, config] of custom) {
    for (const video of config.videoModels ?? []) {
      const model = { provider, id: video.id };
      const reason = availability(model, providers.secrets.has(providerScope(provider), "apiKey"));
      rows.set(key(model), {
        ...model,
        name: video.id,
        tier: "balanced",
        pricePerMillion: { input: null, output: null },
        abilities: {
          text: false,
          imageInput: false,
          imageOutput: false,
          video: true,
          reasoning: [],
        },
        available: reason === "ready",
        reason,
      });
    }
  }
  // A saved Bot can outlive a catalog entry or a sign-in implementation. Describe its
  // known identity without suggesting capabilities we can no longer verify.
  for (const model of botModels) {
    if (rows.has(key(model))) continue;
    const reason = isRetiredModel(model.provider, model.id)
      ? "retired"
      : removedSubscriptions.has(model.provider) ||
          (isChatGPTPlanProvider(model.provider) &&
            auth.getState(model.provider).state !== "connected")
        ? "sign_in_required"
        : "model_not_found";
    rows.set(key(model), {
      ...model,
      name: model.id,
      available: false,
      reason,
      tier: "balanced",
      pricePerMillion: { input: null, output: null },
      abilities: {
        text: false,
        imageInput: false,
        imageOutput: false,
        video: false,
        reasoning: [],
      },
    });
  }
  return [...rows.values()];
}
