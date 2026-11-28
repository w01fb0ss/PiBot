// Owns bounded discovery requests to the Magpie loopback gateway.
import {
  type CustomImageModel,
  CustomImageModelSchema,
  type CustomProvider,
  type CustomVideoModel,
  CustomVideoModelSchema,
  type ImageMode,
  MAGPIE_PROVIDER,
  magpieBaseUrl,
  RpcError,
} from "@pibot/models-contract/full";
import { z } from "zod";
import { readCatalogJson } from "./read-catalog-json.ts";

const hello = z.object({
  name: z.literal(MAGPIE_PROVIDER.id),
  version: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9.+_-]+$/),
});
// Magpie reports each route's limits, thinking support, and modality kind; dropping them made
// every model look like a non-reasoning 32k text model and hid image/video routes.
const limit = z.number().int().positive().max(100_000_000).optional().catch(undefined);
const entrySchema = z.object({
  id: z.string().min(1).max(512),
  display_name: z.string().trim().min(1).max(200).optional().catch(undefined),
  kind: z.string().max(40).optional().catch(undefined),
  context_window: limit,
  context_length: limit,
  max_output_tokens: limit,
  reasoning: z.boolean().optional().catch(undefined),
  supported_endpoint_types: z.array(z.string().max(40)).max(20).optional().catch(undefined),
  modalities: z
    .object({
      input: z.array(z.string().max(40)).max(20).optional(),
      output: z.array(z.string().max(40)).max(20).optional(),
    })
    .optional()
    .catch(undefined),
});
const modelList = z.object({
  data: z.array(entrySchema).max(10000),
});

export interface MagpieCatalog {
  models: CustomProvider["models"];
  imageModels: CustomImageModel[];
  videoModels: CustomVideoModel[];
}

function imageModes(entry: z.infer<typeof entrySchema>): ImageMode[] {
  const endpoints = entry.supported_endpoint_types;
  if (endpoints?.length) {
    const modes: ImageMode[] = [];
    if (endpoints.includes("image-generation")) modes.push("text-to-image");
    if (endpoints.includes("image-edit")) modes.push("image-to-image");
    return modes.length ? modes : ["text-to-image"];
  }
  return entry.modalities?.input?.includes("image")
    ? ["text-to-image", "image-to-image"]
    : ["text-to-image"];
}

export async function detectMagpie(port: number, parent: AbortSignal) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(1500)]);
  try {
    const response = await fetch(new URL("/api/hello", magpieBaseUrl(port)), {
      signal,
      redirect: "error",
    });
    const result = hello.parse(await readCatalogJson(response, 4096));
    signal.throwIfAborted();
    return { running: true, port, version: result.version } as const;
  } catch {
    parent.throwIfAborted();
    // Connection, timeout and identity failures all leave the port editable.
    return { running: false } as const;
  }
}

async function fetchRawMagpieList(port: number, signal: AbortSignal) {
  const headers = { Authorization: `Bearer ${MAGPIE_PROVIDER.attribution}` };
  // Newer Magpie builds filter `/v1/models` to chat routes unless `?kind=all` is passed;
  // older builds may reject unknown query params with 400, so fall back to the default route.
  let response = await fetch(`${magpieBaseUrl(port)}/models?kind=all`, {
    signal,
    redirect: "error",
    headers,
  });
  if (response.status === 400) {
    await response.body?.cancel();
    response = await fetch(`${magpieBaseUrl(port)}/models`, {
      signal,
      redirect: "error",
      headers,
    });
  }
  return modelList.parse(await readCatalogJson(response, 4 * 1024 * 1024)).data;
}

export async function fetchMagpieCatalog(
  port: number,
  signal: AbortSignal,
): Promise<MagpieCatalog> {
  try {
    const data = await fetchRawMagpieList(port, signal);
    signal.throwIfAborted();
    const chat = new Map<string, CustomProvider["models"][number]>();
    const images = new Map<string, CustomImageModel>();
    const videos = new Map<string, CustomVideoModel>();
    for (const model of data) {
      if (model.kind === "image") {
        if (images.size >= 200 || images.has(model.id)) continue;
        const parsed = CustomImageModelSchema.safeParse({
          id: model.id,
          ...(model.display_name ? { name: model.display_name } : {}),
          modes: imageModes(model),
        });
        if (parsed.success) images.set(parsed.data.id, parsed.data);
        continue;
      }
      if (model.kind === "video") {
        if (videos.size >= 200 || videos.has(model.id)) continue;
        const parsed = CustomVideoModelSchema.safeParse({ id: model.id });
        if (parsed.success) videos.set(parsed.data.id, parsed.data);
        continue;
      }
      if (model.kind && model.kind !== "chat") continue;
      if (chat.has(model.id)) continue;
      const contextWindow = model.context_window ?? model.context_length;
      chat.set(model.id, {
        id: model.id,
        ...(contextWindow ? { contextWindow } : {}),
        ...(model.max_output_tokens ? { maxTokens: model.max_output_tokens } : {}),
        ...(model.modalities?.input
          ? {
              input: model.modalities.input.includes("image") ? ["text", "image"] : ["text"],
            }
          : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      });
    }
    // A custom provider cannot list the same model id in multiple capability arrays.
    for (const id of images.keys()) {
      chat.delete(id);
      videos.delete(id);
    }
    for (const id of videos.keys()) chat.delete(id);
    const catalog: MagpieCatalog = {
      models: [...chat.values()],
      imageModels: [...images.values()],
      videoModels: [...videos.values()],
    };
    if (!catalog.models.length && !catalog.imageModels.length && !catalog.videoModels.length)
      throw new Error("Magpie model list empty");
    return catalog;
  } catch {
    throw new RpcError(-32602, "magpie_models_unavailable");
  }
}

export async function fetchMagpieModels(
  port: number,
  signal: AbortSignal,
): Promise<CustomProvider["models"]> {
  const { models } = await fetchMagpieCatalog(port, signal);
  if (!models.length) throw new RpcError(-32602, "magpie_models_unavailable");
  return models;
}
