// Owns bounded discovery requests to the Magpie loopback gateway.
import {
  type CustomProvider,
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
// Magpie reports each route's limits and thinking support; dropping them made every model look
// like a non-reasoning 32k model, so the thinking-level control never appeared.
const limit = z.number().int().positive().max(100_000_000).optional().catch(undefined);
const modelList = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(512),
        context_window: limit,
        context_length: limit,
        max_output_tokens: limit,
        reasoning: z.boolean().optional().catch(undefined),
        modalities: z
          .object({ input: z.array(z.string().max(40)).max(20).optional() })
          .optional()
          .catch(undefined),
      }),
    )
    .max(10000),
});

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

export async function fetchMagpieModels(
  port: number,
  signal: AbortSignal,
): Promise<CustomProvider["models"]> {
  try {
    const response = await fetch(`${magpieBaseUrl(port)}/models`, {
      signal,
      redirect: "error",
      headers: { Authorization: `Bearer ${MAGPIE_PROVIDER.attribution}` },
    });
    const { data } = modelList.parse(await readCatalogJson(response, 2 * 1024 * 1024));
    const models = new Map(data.map((model) => [model.id, model]));
    if (models.size === 0) throw new Error("Magpie model list empty");
    signal.throwIfAborted();
    return [...models.values()].map<CustomProvider["models"][number]>((model) => {
      const contextWindow = model.context_window ?? model.context_length;
      return {
        id: model.id,
        ...(contextWindow ? { contextWindow } : {}),
        ...(model.max_output_tokens ? { maxTokens: model.max_output_tokens } : {}),
        ...(model.modalities?.input
          ? {
              input: model.modalities.input.includes("image") ? ["text", "image"] : ["text"],
            }
          : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      };
    });
  } catch {
    throw new RpcError(-32602, "magpie_models_unavailable");
  }
}
