import type { CustomImageModel, ImageContent } from "@pibot/protocol-base";
import { AgentError } from "../core/errors.ts";
import { dataUrl, type ImageTransport } from "./provider-transport.ts";

export function seedreamImages(
  transport: ImageTransport,
  model: string,
  prompt: string,
  images: ImageContent[],
  settings?: CustomImageModel,
) {
  // Ark sends reference images in the generation JSON, as a string or an array.
  // Resolution tiers use a natural-language ratio; explicit dimensions set the exact size.
  // https://docs.volcengine.com/docs/ark/image-generation-api
  const references = images.map(dataUrl);
  const legacy = /^doubao-seedream-3-/i.test(model);
  const supportsGroupedOutput = /^doubao-seedream-(?:4-|5-0-lite)/i.test(model);
  if (legacy && images.length) throw new AgentError("image_mode_mismatch");
  const size = settings?.size ?? (legacy ? "1024x1024" : "2K");
  const ratio = settings?.aspectRatio;
  const requestedPrompt =
    ratio && !size.includes("x") ? `${prompt}\nUse aspect ratio ${ratio} (width:height).` : prompt;
  return transport
    .json(
      "images/generations",
      JSON.stringify({
        model,
        prompt: requestedPrompt,
        size,
        response_format: "b64_json",
        ...(supportsGroupedOutput ? { sequential_image_generation: "disabled" } : {}),
        ...(references.length
          ? { image: references.length === 1 ? references[0] : references }
          : {}),
      }),
    )
    .then((value) => transport.standard(value));
}
