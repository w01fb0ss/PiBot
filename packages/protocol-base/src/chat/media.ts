import { z } from "zod";
import { AgentErrorCodeSchema } from "../core/errors.ts";
import { IdSchema } from "../core/ids.ts";
import { MAX_ATTACHMENTS } from "./attachments.ts";

const MAX_IMAGE_REQUESTS = 10;
// Each workflow request can return up to the per-response attachment limit.
export const MAX_GENERATED_IMAGES = MAX_IMAGE_REQUESTS * MAX_ATTACHMENTS;
const imagePrompt = z.string().trim().min(1).max(16_000);
const imageSelection = z.strictObject({
  provider: z.string().trim().min(1).max(200),
  id: z.string().trim().min(1).max(200),
});
const imageDimensions = {
  ratio: z
    .string()
    .regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/u)
    .optional(),
  size: z
    .string()
    .regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/u)
    .optional(),
};

export const ImageGenerationOptionsSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("batch"),
      ...imageDimensions,
      model: imageSelection.optional(),
      prompts: z.array(imagePrompt).min(1).max(MAX_IMAGE_REQUESTS).optional(),
      prompt: imagePrompt.optional(),
      count: z.number().int().min(1).max(MAX_IMAGE_REQUESTS).optional(),
    })
    .refine(
      (value) =>
        value.prompts
          ? value.prompt === undefined && value.count === undefined
          : value.prompt !== undefined && value.count !== undefined,
      "Provide prompts or both prompt and count",
    ),
  z.strictObject({
    kind: z.literal("compare"),
    ...imageDimensions,
    prompt: imagePrompt,
    models: z
      .array(imageSelection)
      .min(2)
      .max(4)
      .refine(
        (models) =>
          new Set(
            models.map(({ provider, id }) =>
              JSON.stringify([provider, canonicalImageModelId(provider, id)]),
            ),
          ).size === models.length,
        "Choose distinct image models",
      ),
  }),
]);
export type ImageGenerationOptions = z.infer<typeof ImageGenerationOptionsSchema>;

export const IMAGE_GENERATION_GUIDANCE =
  ' For an image Bot, use imageGeneration {kind:"batch",prompts:[...]} for several distinct images, or {kind:"batch",prompt,count} for variations of one prompt (up to 10 requests in one call). Batch uses the Bot’s model unless you specify model:{provider,id}. When the user wants to compare models on the same prompt, use {kind:"compare",prompt,models:[{provider,id},...]} with 2–4 distinct configured image models. Optional shared ratio (e.g. "3:2") and size (e.g. "1536x1024") are prompt hints where model settings allow. Workflows determine how many images each request returns. Use one dispatch for the whole batch or comparison.';

export const ImageGenerationResultsSchema = z.strictObject({
  kind: z.enum(["batch", "compare"]),
  items: z
    .array(
      z.discriminatedUnion("status", [
        z.strictObject({
          model: z.string().min(1).max(200),
          status: z.literal("success"),
          attachmentId: IdSchema,
          additionalAttachmentIds: z
            .array(IdSchema)
            .min(1)
            .max(MAX_ATTACHMENTS - 1)
            .optional(),
        }),
        z.strictObject({
          model: z.string().min(1).max(200),
          status: z.literal("failed"),
          reasonCode: AgentErrorCodeSchema,
        }),
      ]),
    )
    .min(1)
    .max(MAX_IMAGE_REQUESTS),
});
export type ImageGenerationResults = z.infer<typeof ImageGenerationResultsSchema>;

export function imageGenerationResultCounts(results: ImageGenerationResults) {
  let success = 0;
  let images = 0;
  for (const item of results.items) {
    if (item.status === "success") {
      success++;
      images += 1 + (item.additionalAttachmentIds?.length ?? 0);
    }
  }
  return { success, images, total: results.items.length };
}

export function imageGenerationResults(usage: unknown) {
  if (!usage || typeof usage !== "object" || !("imageResults" in usage)) return undefined;
  const parsed = ImageGenerationResultsSchema.safeParse(usage.imageResults);
  return parsed.success ? parsed.data : undefined;
}

/** Image attempts stopped before delivery still record their generation mode. */
export function imageGenerationUsage(usage: unknown): boolean {
  if (!usage || typeof usage !== "object") return false;
  return (
    ("imageGeneration" in usage && usage.imageGeneration === true) ||
    ("imageMode" in usage && ImageModeSchema.safeParse(usage.imageMode).success)
  );
}

export function imageApprovalDeclined(usage: unknown): boolean {
  return (
    !!usage &&
    typeof usage === "object" &&
    "imageApprovalDeclined" in usage &&
    usage.imageApprovalDeclined === true
  );
}

const ImageReplacementDeclinedSchema = z.strictObject({
  attemptedModel: z.string().min(1).max(401),
  replacementModel: z.string().min(1).max(401),
});

export function imageReplacementDeclined(usage: unknown) {
  if (!usage || typeof usage !== "object" || !("imageReplacementDeclined" in usage)) return;
  return ImageReplacementDeclinedSchema.safeParse(usage.imageReplacementDeclined).data;
}

// One verified historical spelling of the same OpenRouter model; never normalize arbitrary slugs.
export function canonicalImageModelId(provider: string, id: string) {
  return provider === "openrouter" && id === "bytedance-seed/seedream-5.0-pro"
    ? "bytedance-seed/seedream-5-0-pro"
    : id;
}
export const BotCategorySchema = z.enum(["chat", "image"]);
export const ImageModeSchema = z.enum(["text-to-image", "image-to-image"]);
export const ImageApiSchema = z.enum([
  "openai-images",
  "google-images",
  "openrouter-images",
  "codex-images",
  "seedream-images",
  "dashscope-images",
  "xai-images",
  "comfyui-images",
]);
export const ImageAspectRatioSchema = z.enum([
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "21:9",
]);
export const ImageUnitPriceSchema = z.strictObject({
  currency: z.enum(["USD", "CNY"]),
  perImage: z.number().finite().positive(),
  perReference: z.number().finite().nonnegative().optional(),
});

export const COMFY_WORKFLOW_LIMIT = 256 * 1024;
const comfyGraph = z.record(
  z.string().regex(/^[\w:-]{1,100}$/),
  z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.json()) }).passthrough(),
);
export function parseComfyWorkflow(source: string) {
  if (
    source.length > COMFY_WORKFLOW_LIMIT ||
    new TextEncoder().encode(source).byteLength > COMFY_WORKFLOW_LIMIT
  )
    return;
  try {
    const graph = comfyGraph.safeParse(JSON.parse(source));
    if (graph.success && Object.keys(graph.data).length > 0) return graph.data;
  } catch {
    // A malformed or excessively nested export is an invalid workflow.
  }
}

// Match placeholders in node inputs only, so an export's metadata cannot advertise a mode.
export function comfyUsesImage(graph: NonNullable<ReturnType<typeof parseComfyWorkflow>>) {
  const contains = (value: z.infer<ReturnType<typeof z.json>>): boolean =>
    typeof value === "string"
      ? value.includes("{{image}}")
      : !!value && typeof value === "object" && Object.values(value).some(contains);
  return Object.values(graph).some((node) => contains(node.inputs));
}

export const CustomImageModelSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  size: z
    .string()
    .regex(/^(?:1\.5K|[1234]K|[1-9]\d{1,4}x[1-9]\d{1,4})$/)
    .optional(),
  aspectRatio: ImageAspectRatioSchema.optional(),
  workflow: z
    .string()
    .max(COMFY_WORKFLOW_LIMIT)
    .refine((source) => !!parseComfyWorkflow(source))
    .optional(),
  modes: z
    .array(ImageModeSchema)
    .min(1)
    .max(2)
    .refine((v) => new Set(v).size === v.length),
});
export const ImageModelInfoSchema = z.strictObject({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  modes: z.array(ImageModeSchema).min(1).max(2),
  output: z
    .array(z.enum(["image", "text"]))
    .min(1)
    .max(2)
    .refine((value) => value.includes("image")),
  configured: z.boolean(),
  source: z.enum(["sdk", "official", "custom"]),
  experimental: z.boolean().optional(),
  size: z.string().max(32).optional(),
  aspectRatio: ImageAspectRatioSchema.optional(),
  maxReferences: z.number().int().positive().optional(),
  generationPrice: ImageUnitPriceSchema.optional(),
  editPrice: ImageUnitPriceSchema.optional(),
  workflowOutput: z.literal(true).optional(),
  // The selected service host is public metadata, never a credential-bearing URL.
  recipient: z.string().min(1).max(253),
  origin: z.string().max(320).optional(),
});
export const ImageModelPageSchema = z.strictObject({
  selected: z
    .strictObject({ provider: z.string().min(1).max(200), id: z.string().min(1).max(200) })
    .optional(),
  availableOnly: z.boolean().optional(),
  mode: ImageModeSchema.optional(),
  before: z.string().min(1).max(1000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type BotCategory = z.infer<typeof BotCategorySchema>;
export type ImageMode = z.infer<typeof ImageModeSchema>;
export type ImageApi = z.infer<typeof ImageApiSchema>;
export function imageApiRequiresKey(api: ImageApi | undefined) {
  return api === "seedream-images" || api === "dashscope-images" || api === "xai-images";
}
export type ImageUnitPrice = z.infer<typeof ImageUnitPriceSchema>;
export type ImageAspectRatio = z.infer<typeof ImageAspectRatioSchema>;
export type CustomImageModel = z.infer<typeof CustomImageModelSchema>;
export type ImageModelInfo = z.infer<typeof ImageModelInfoSchema>;

export function validImageModelOptions(api: ImageApi | undefined, model: CustomImageModel) {
  if (api === "comfyui-images") {
    const graph = model.workflow && parseComfyWorkflow(model.workflow);
    return (
      !!graph &&
      model.modes.length === 1 &&
      model.modes[0] === (comfyUsesImage(graph) ? "image-to-image" : "text-to-image") &&
      (!model.size || model.size.includes("x")) &&
      !model.aspectRatio
    );
  }
  if (model.workflow) return false;
  if (api === "seedream-images") return !(model.aspectRatio && model.size?.includes("x"));
  return !model.size && !model.aspectRatio;
}
