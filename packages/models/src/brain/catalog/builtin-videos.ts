import {
  type BuiltinVideoModel,
  BuiltinVideoModelSchema,
  type BuiltinVideoProviderId,
  suggestedOpenRouterVideo,
  type VideoProviderConfig,
} from "@pibot/models-contract/full";
import { z } from "zod";
import { readCatalogJson } from "./read-catalog-json.ts";

export type TestVideoBaseUrls = Partial<Record<BuiltinVideoProviderId, string>>;

const providers = {
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", videoApi: "openai-videos" },
  google: {
    name: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    videoApi: "gemini-omni",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    videoApi: "openrouter-videos",
  },
} as const satisfies Record<
  BuiltinVideoProviderId,
  Omit<VideoProviderConfig, "id" | "videoModels">
>;

export function builtinVideoProvider(id: BuiltinVideoProviderId, testBases: TestVideoBaseUrls) {
  const provider = providers[id];
  const testOrigin = testBases[id];
  if (testOrigin === undefined) return { id, ...provider };
  // Only a trusted acceptance fixture can inject a base, and only at a local random port.
  const url = new URL(testOrigin);
  if (url.href !== `http://127.0.0.1:${url.port}/` || !url.port)
    throw new Error("Invalid built-in video test origin");
  return { id, ...provider, baseUrl: url.origin + new URL(provider.baseUrl).pathname };
}

const omniModels = ["gemini-omni-1.2-flash", "gemini-omni-1.1-flash"];
const openRouterSuggestedModels = [
  "bytedance/seedance-2.0-mini",
  "bytedance/seedance-2.0-fast",
] as const;

// Estimated USD per second of output:
// https://ai.google.dev/gemini-api/docs/pricing#gemini-omni-1.2-flash
// https://ai.google.dev/gemini-api/docs/pricing#gemini-omni-1.1-flash
const omniRates = { "360p": 0.023, "720p": 0.07, "1080p": 0.104, "4k": 0.209 };
const omniAliasSwitch = Date.UTC(2026, 11, 3);

export function builtinVideoModels(id: BuiltinVideoProviderId, models: BuiltinVideoModel[]) {
  if (id !== "google") return models;
  return models
    .filter((model) => omniModels.includes(model.id))
    .map((model) => {
      if (
        model.priceUsdPerClip !== undefined ||
        model.priceUsdPerSecond !== undefined ||
        model.priceUsdPerSecondBySize !== undefined
      )
        return model;
      const rates =
        model.id === "gemini-omni-1.1-flash" && Date.now() < omniAliasSwitch
          ? { "720p": 0.1 }
          : omniRates;
      return { ...model, priceUsdPerSecondBySize: rates };
    });
}

const catalogPrice = {
  priceUsdPerSecond: BuiltinVideoModelSchema.shape.priceUsdPerSecond.catch(undefined),
  priceUsdPerClip: BuiltinVideoModelSchema.shape.priceUsdPerClip.catch(undefined),
  priceUsdPerSecondBySize: BuiltinVideoModelSchema.shape.priceUsdPerSecondBySize.catch(undefined),
};
const openRouterPriceValue = z.union([z.string().max(64), z.number().finite().nonnegative()]);
const openRouterModels = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        pricing_skus: z.record(z.string().max(128), openRouterPriceValue).optional(),
        supported_resolutions: z.array(z.string().max(16)).max(20).nullish().catch(undefined),
        pricing: z
          .object({
            per_second: openRouterPriceValue.optional(),
            second: openRouterPriceValue.optional(),
            video: openRouterPriceValue.optional(),
            generate: openRouterPriceValue.optional(),
          })
          .optional(),
        ...catalogPrice,
      }),
    )
    .max(2000),
});
const openaiModels = z.object({
  data: z.array(z.object({ id: z.string(), ...catalogPrice })).max(10_000),
});
const googleModels = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        ...catalogPrice,
      }),
    )
    .max(1000)
    .default([]),
  nextPageToken: z.string().max(4096).optional(),
});

function parseUsd(value: string | number | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= max ? amount : undefined;
}

function openRouterModelEntry(
  raw: z.infer<typeof openRouterModels>["data"][number],
): BuiltinVideoModel {
  if (
    raw.priceUsdPerSecond !== undefined ||
    raw.priceUsdPerClip !== undefined ||
    raw.priceUsdPerSecondBySize !== undefined
  )
    return {
      id: raw.id,
      ...(raw.priceUsdPerSecond !== undefined ? { priceUsdPerSecond: raw.priceUsdPerSecond } : {}),
      ...(raw.priceUsdPerClip !== undefined ? { priceUsdPerClip: raw.priceUsdPerClip } : {}),
      ...(raw.priceUsdPerSecondBySize !== undefined
        ? { priceUsdPerSecondBySize: raw.priceUsdPerSecondBySize }
        : {}),
    };
  let basePerSecond: number | undefined;
  let audioPerSecond: number | undefined;
  const bySize: Record<string, number> = {};
  const audioBySize: Record<string, number> = {};
  let perClip: number | undefined;
  // Seedance-style models price per video token: tokens = width × height × fps × seconds / 1024
  // (checked 11-26 against a real 4 s 480p seedance-2.0-mini job: estimate $0.1406, charged $0.142).
  // Converted to a per-second price at each resolution's 16:9 frame size and 24 fps.
  const tokensPerSecond: Record<string, number> = {
    "480p": (864 * 496 * 24) / 1024,
    "720p": (1280 * 720 * 24) / 1024,
    "1080p": (1920 * 1080 * 24) / 1024,
    "4k": (3840 * 2160 * 24) / 1024,
  };
  const tokenRates: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.pricing_skus ?? {})) {
    const match = /^video_tokens(?:_(480p|720p|1080p|4k))?$/.exec(key.toLowerCase());
    const rate = match ? parseUsd(value, 1) : undefined;
    if (match && rate !== undefined) tokenRates[match[1] ?? "base"] = rate;
  }
  if (tokenRates.base !== undefined || Object.keys(tokenRates).length) {
    const sizes = (raw.supported_resolutions ?? Object.keys(tokensPerSecond)).filter(
      (size) => size in tokensPerSecond,
    );
    const priced: Record<string, number> = {};
    for (const size of sizes) {
      const rate = tokenRates[size] ?? tokenRates.base;
      if (rate !== undefined) priced[size] = rate * (tokensPerSecond[size] ?? 0);
    }
    if (Object.keys(priced).length) return { id: raw.id, priceUsdPerSecondBySize: priced };
  }
  for (const [key, value] of Object.entries(raw.pricing_skus ?? {})) {
    const lower = key.toLowerCase();
    const isPerSecond =
      /(?:^|_)duration_seconds?(?:_|$)/.test(lower) ||
      lower.includes("per_second") ||
      lower === "second";
    if (isPerSecond) {
      const rate = parseUsd(value, 100);
      if (rate === undefined) continue;
      const resolution = /(?:^|_)(360p|480p|720p|1080p|4k)(?:_|$)/.exec(lower)?.[1];
      const withAudio = lower.includes("with_audio") && !lower.includes("without_audio");
      if (resolution) {
        if (withAudio) audioBySize[resolution] ??= rate;
        else bySize[resolution] ??= rate;
      } else if (withAudio) {
        audioPerSecond ??= rate;
      } else {
        basePerSecond ??= rate;
      }
      continue;
    }
    if (
      lower === "generate" ||
      lower === "video" ||
      lower === "per_video" ||
      lower === "per_clip"
    ) {
      perClip ??= parseUsd(value, 3000);
    }
  }
  const mergedBySize = { ...audioBySize, ...bySize };
  const mergedPerSecond = basePerSecond ?? audioPerSecond;
  if (Object.keys(mergedBySize).length > 0) {
    if (mergedPerSecond !== undefined) {
      mergedBySize["720p"] ??= mergedPerSecond;
      if (mergedBySize["4k"] !== undefined) mergedBySize["1080p"] ??= mergedPerSecond;
    }
    return { id: raw.id, priceUsdPerSecondBySize: mergedBySize };
  }
  const perSecond =
    mergedPerSecond ?? parseUsd(raw.pricing?.per_second ?? raw.pricing?.second, 100);
  if (perSecond !== undefined) return { id: raw.id, priceUsdPerSecond: perSecond };
  const clip = perClip ?? parseUsd(raw.pricing?.video ?? raw.pricing?.generate, 3000);
  if (clip !== undefined) return { id: raw.id, priceUsdPerClip: clip };
  return { id: raw.id };
}

export async function discoverBuiltinVideos(
  provider: ReturnType<typeof builtinVideoProvider>,
  key: string,
  signal: AbortSignal,
  fetchCatalog: typeof fetch = fetch,
) {
  const url = new URL(
    provider.id === "openrouter"
      ? `${provider.baseUrl}/videos/models`
      : `${provider.baseUrl}/models`,
  );
  const headers = new Headers();
  if (provider.id === "google") headers.set("x-goog-api-key", key);
  else headers.set("Authorization", `Bearer ${key}`);
  if (provider.id === "openrouter") {
    headers.set("HTTP-Referer", "https://pibot.space");
    headers.set("X-Title", "Pi Bot");
  }
  const read = async () =>
    readCatalogJson(
      await fetchCatalog(url, { headers, signal, redirect: "error", credentials: "omit" }),
      2 * 1024 * 1024,
    );
  const found = new Map<string, BuiltinVideoModel>();
  const add = (entry: BuiltinVideoModel) => {
    const model = BuiltinVideoModelSchema.safeParse(entry);
    if (model.success && (provider.id === "openrouter" || found.size < 200))
      found.set(model.data.id, model.data);
  };
  if (provider.id === "openai") {
    for (const model of openaiModels.parse(await read()).data)
      if (/^sora(?:-[a-z0-9]+)+$/.test(model.id)) add(model);
    return { models: [...found.values()], fallback: false };
  }
  if (provider.id === "openrouter") {
    for (const model of openRouterModels.parse(await read()).data) add(openRouterModelEntry(model));
    if (!found.size)
      return { models: openRouterSuggestedModels.map((id) => ({ id })), fallback: true };
    const suggested = openRouterSuggestedModels.flatMap((id) => {
      const listed = found.get(id);
      return listed ? [listed] : [];
    });
    const suggestedSet = new Set<string>(openRouterSuggestedModels);
    const rest = [...found.values()].filter((model) => !suggestedSet.has(model.id));
    return {
      models: [
        ...suggested,
        ...rest.filter(({ id }) => suggestedOpenRouterVideo(id)),
        ...rest.filter(({ id }) => !suggestedOpenRouterVideo(id)),
      ].slice(0, 200),
      fallback: false,
    };
  }
  url.searchParams.set("pageSize", "100");
  for (let page = 0; page < 20; page++) {
    const { models, nextPageToken } = googleModels.parse(await read());
    for (const { name, ...price } of models) {
      const model = name.replace(/^models\//, "");
      if (omniModels.includes(model)) add({ ...price, id: model });
    }
    if (!nextPageToken || found.size === omniModels.length) break;
    if (url.searchParams.get("pageToken") === nextPageToken) throw new Error("Repeated model page");
    url.searchParams.set("pageToken", nextPageToken);
  }
  const fallback = !found.size;
  const models = omniModels.flatMap((id) => {
    const listed = found.get(id);
    return listed ? [listed] : fallback ? [{ id }] : [];
  });
  return { models, fallback };
}
