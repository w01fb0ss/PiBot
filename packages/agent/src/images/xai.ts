import type { ImageContent } from "@pibot/protocol-base";
import { z } from "zod";
import { AgentError } from "../core/errors.ts";
import { imagePrice } from "./image-pricing.ts";
import { dataUrl, type ImageTransport, withImageCost } from "./provider-transport.ts";

const billed = z.object({ usage: z.object({ cost_in_usd_ticks: z.number().int().nonnegative() }) });
export const isImagine2 = (model: string) => /^grok-imagine-image-2\.0(?:-|$)/.test(model);
export function imagineReferenceLimit(model: string) {
  if (isImagine2(model)) return 5;
  // https://docs.x.ai/developers/rest-api-reference/inference/images
  if (
    ["grok-imagine-image", "grok-imagine-image-quality", "grok-imagine-image-pro"].includes(model)
  )
    return 1;
  return 0;
}

export async function xaiImages(
  transport: ImageTransport,
  model: string,
  prompt: string,
  images: ImageContent[],
) {
  // Edits take typed JSON image URLs, never OpenAI multipart or a mask.
  // https://docs.x.ai/developers/model-capabilities/images/editing
  // https://docs.x.ai/developers/model-capabilities/images/multi-image-editing
  if (images.length > imagineReferenceLimit(model)) throw new AgentError("image_mode_mismatch");
  const references = images.map((image) => ({ url: dataUrl(image), type: "image_url" }));
  const value = await transport.json(
    images.length ? "images/edits" : "images/generations",
    JSON.stringify({
      model,
      prompt,
      n: 1,
      response_format: "b64_json",
      ...(isImagine2(model) ? { resolution: "1k", quality: images.length ? "medium" : "low" } : {}),
      ...(references.length === 1 ? { image: references[0] } : {}),
      ...(references.length > 1 ? { images: references } : {}),
    }),
  );
  const result = await transport.standard(value);
  const price = imagePrice("xai-images", model, transport.base, images.length > 0);
  const usage = billed.safeParse(value);
  // https://docs.x.ai/developers/cost-tracking
  return withImageCost(
    result,
    usage.success
      ? usage.data.usage.cost_in_usd_ticks / 10_000_000_000
      : price && price.perImage * result.images.length + (price.perReference ?? 0) * images.length,
  );
}
