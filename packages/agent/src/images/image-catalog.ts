import type { ImageApi, ImageModel, Provider } from "@earendil-works/pi-ai";
import {
  comfyUsesImage,
  type ImageMode,
  type ImageModelInfo,
  imageApiRequiresKey,
  parseComfyWorkflow,
} from "@pibot/protocol-base";
import {
  CHATGPT_CODEX_PROVIDER,
  CHATGPT_PLAN_PROVIDER,
} from "@pibot/protocol-base/provider-catalog";
import type { CustomProviderConfig, ImageUrlFetch } from "../core/types.ts";
import { dashscopeModel } from "./dashscope.ts";
import { type ImageWire, imageAdapter } from "./image-adapters.ts";
import { imagePrice } from "./image-pricing.ts";
import { imagineReferenceLimit, isImagine2 } from "./xai.ts";

const openRouterTextRouters = new Set([
  "openrouter/auto",
  "openrouter/auto-beta",
  "openrouter/auto-code",
]);

function supportedModes(wire: ImageWire, id: string, workflow?: string): ImageMode[] {
  if (wire === "comfyui-images") {
    const graph = workflow && parseComfyWorkflow(workflow);
    if (!graph) return [];
    return [comfyUsesImage(graph) ? "image-to-image" : "text-to-image"];
  }
  if (wire === "dashscope-images") {
    const family = dashscopeModel(id);
    if (family === "sync-only" || family === "unsupported") return [];
    if (family === "wanx-edit") return ["image-to-image"];
    if (family === "wan-legacy" || /-t2i(?:-|$)/.test(id)) return ["text-to-image"];
  }
  if (
    (wire === "xai-images" && !imagineReferenceLimit(id)) ||
    (wire === "seedream-images" && /^doubao-seedream-3-/i.test(id))
  )
    return ["text-to-image"];
  return ["text-to-image", "image-to-image"];
}

function customModes(
  wire: ImageWire,
  entry: NonNullable<CustomProviderConfig["imageModels"]>[number],
) {
  const supported = supportedModes(wire, entry.id, entry.workflow);
  return entry.modes.filter((mode) => supported.includes(mode));
}

function models(
  provider: string,
  baseUrl: string,
  api: ImageWire,
  ids: string[],
): ImageModel<ImageApi>[] {
  return ids.map((id) => ({
    type: "image",
    provider,
    id,
    name: id,
    baseUrl,
    api,
    input: ["text", "image"],
    output: [
      "image",
      ...(api === "google-images" || api === "vertex-images" ? ["text" as const] : []),
    ],
    cost: { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 },
  }));
}
export function imageProvider(
  provider: Provider,
  config?: CustomProviderConfig,
  ports: { fetchImageUrl?: ImageUrlFetch } = {},
): Provider {
  let extra: ImageModel<ImageApi>[] = [];
  let wire: ImageWire | undefined;
  if (config?.imageApi && config.imageModels?.length) {
    wire = config.imageApi;
    const api = wire;
    extra = config.imageModels.flatMap((entry) => {
      const modes = customModes(api, entry);
      return !modes.length
        ? []
        : models(config.id, config.baseUrl, api, [entry.id]).map((model) => ({
            ...model,
            name: entry.name ?? entry.id,
            input: modes.includes("image-to-image")
              ? ["text" as const, "image" as const]
              : ["text" as const],
          }));
    });
  } else if (provider.id === "openai") {
    wire = "openai-images";
    extra = models(provider.id, "https://api.openai.com/v1", wire, [
      "gpt-image-2",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-1-mini",
      "gpt-image-1.5",
      "gpt-image-2-2026-04-21",
      "gpt-image-2.5-sunburst-2026-09-08",
      "gpt-image-2.5-flare-2026-09-08",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
      "chatgpt-image-latest",
    ]);
  } else if (provider.id === "google") {
    wire = "google-images";
    extra = models(provider.id, "https://generativelanguage.googleapis.com/v1beta", wire, [
      "gemini-nano-banana-2.1",
      "gemini-2.5-flash-image",
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
    ]);
  } else if (provider.id === "google-vertex") {
    // Vertex's Cloud credential is exchanged for a short-lived bearer token by memoryVertex;
    // the static catalog cannot use the generic API-key image adapter.
    wire = "vertex-images";
    extra = models(provider.id, "https://aiplatform.googleapis.com/v1", wire, [
      "gemini-nano-banana-2.1",
      "gemini-3.1-flash-lite-image",
      "gemini-3.1-flash-image",
      "gemini-3-pro-image",
      "gemini-2.5-flash-image",
    ]);
  } else if (provider.id === CHATGPT_PLAN_PROVIDER) {
    // ChatGPT plan OAuth is a Responses credential, not a Codex account token.
    // Keep this on the official image_generation tool route; the Codex backend
    // requires a chatgpt_account_id claim that plan tokens do not provide.
    wire = "openai-chatgpt-images";
    extra = models(provider.id, "https://api.openai.com/v1", wire, [
      "gpt-image-2",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
      "gpt-image-1-mini",
      "gpt-image-1.5",
    ]);
  } else if (provider.id === "openai-codex" || provider.id === CHATGPT_CODEX_PROVIDER) {
    wire = "codex-images";
    // Built-in role installs take the first available image model, so gpt-image-2 stays first.
    extra = models(provider.id, "https://chatgpt.com/backend-api/codex", wire, [
      "gpt-image-2",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5-flare",
      "gpt-image-2.6-sunburst",
      "gpt-image-2.6-flare",
    ]);
  } else if (provider.id === "openrouter") wire = "openrouter-images";
  if (!wire || (wire === "vertex-images" && !provider.generateImages)) return provider;
  const all = provider.getAllModels?.() ?? provider.getModels();
  const supported =
    !config && provider.id === "openrouter" && wire === "openrouter-images"
      ? all
          .filter((entry) => entry.type === "image" && !openRouterTextRouters.has(entry.id))
          .map((entry) => ({
            ...entry,
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openrouter-images",
          }))
      : extra;
  return {
    ...provider,
    getAllModels: () => [...all.filter((entry) => entry.type !== "image"), ...supported],
    generateImages:
      wire === "vertex-images"
        ? provider.generateImages
        : imageAdapter(wire, ports, config?.imageModels),
  };
}
export function imageInfo(
  model: ImageModel<ImageApi>,
  configured: boolean,
  config?: CustomProviderConfig,
): ImageModelInfo {
  const declared = config?.imageModels?.find((entry) => entry.id === model.id);
  const wire = config?.imageApi;
  const base = new URL(model.baseUrl);
  const generationPrice = wire && imagePrice(wire, model.id, model.baseUrl);
  const editPrice = wire && imagePrice(wire, model.id, model.baseUrl, true);
  const size =
    wire === "seedream-images"
      ? (declared?.size ?? (/^doubao-seedream-3-/i.test(model.id) ? "1024x1024" : "2K"))
      : wire === "comfyui-images"
        ? declared?.size
        : wire === "xai-images" && isImagine2(model.id)
          ? "1K"
          : undefined;
  const maxReferences =
    wire === "comfyui-images" ||
    (wire === "dashscope-images" && dashscopeModel(model.id) === "wanx-edit")
      ? 1
      : wire === "xai-images"
        ? imagineReferenceLimit(model.id)
        : wire === "dashscope-images" && /^qwen-image-3\.0(?:-|$)/.test(model.id)
          ? 3
          : undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    modes: (declared && wire ? customModes(wire, declared) : undefined) ?? [
      "text-to-image",
      ...(model.input.includes("image") ? ["image-to-image" as const] : []),
    ],
    output: [...model.output],
    configured,
    recipient: base.hostname,
    ...(wire === "comfyui-images" || imageApiRequiresKey(wire) ? { origin: base.origin } : {}),
    source: config ? "custom" : model.provider === "openrouter" ? "sdk" : "official",
    ...(generationPrice ? { generationPrice } : {}),
    ...(editPrice ? { editPrice } : {}),
    ...(size ? { size } : {}),
    ...(wire === "seedream-images" && declared?.aspectRatio
      ? { aspectRatio: declared.aspectRatio }
      : {}),
    ...(maxReferences ? { maxReferences } : {}),
    ...(wire === "comfyui-images" ? { workflowOutput: true as const } : {}),
    ...(model.provider === "openai-codex" ||
    model.provider === CHATGPT_CODEX_PROVIDER ||
    model.provider === CHATGPT_PLAN_PROVIDER
      ? { experimental: true }
      : {}),
  };
}
