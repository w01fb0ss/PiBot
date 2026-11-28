import { z } from "zod";
import { ImageModeSchema, ImageUnitPriceSchema } from "../chat/media.ts";
import { IdSchema } from "../core/ids.ts";
import { ModelOverrideSchema, ThinkingLevelSchema } from "./providers.ts";

export const DispatchModelNeedsSchema = z.strictObject({
  imageInput: z.boolean().optional(),
  imageOutput: z.boolean().optional(),
  video: z.boolean().optional(),
  reasoning: z.boolean().optional(),
});

export const DispatchModelReasonSchema = z.enum([
  "ready",
  "credentials_missing",
  "sign_in_required",
  "retired",
  "model_not_found",
  "auth_failed",
  "quota_exhausted",
  "billing",
  "provider_overloaded",
  "rate_limited",
  "local_unreachable",
  "provider_changed",
  "capability_mismatch",
]);

export const DispatchModelSchema = z.strictObject({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  tier: z.enum(["fast", "balanced", "strong"]),
  pricePerMillion: z.strictObject({
    input: z.number().nonnegative().nullable(),
    output: z.number().nonnegative().nullable(),
  }),
  abilities: z.strictObject({
    text: z.boolean(),
    imageInput: z.boolean(),
    imageOutput: z.boolean(),
    video: z.boolean(),
    reasoning: z.array(ThinkingLevelSchema),
  }),
  contextWindow: z.number().positive().optional(),
  imageModes: z.array(ImageModeSchema).optional(),
  imagePrice: ImageUnitPriceSchema.optional(),
  available: z.boolean(),
  reason: DispatchModelReasonSchema,
});

export const DispatchModelRouteSchema = z.strictObject({
  dispatchId: IdSchema,
  botId: IdSchema,
  model: ModelOverrideSchema,
  destination: z.string().optional(),
  needs: DispatchModelNeedsSchema,
});

export const DispatchModelSwitchSchema = z.strictObject({
  from: z.string().min(1).max(300),
  to: z.string().min(1).max(300),
  reason: DispatchModelReasonSchema,
});

export type DispatchModel = z.infer<typeof DispatchModelSchema>;
export type DispatchModelNeeds = z.infer<typeof DispatchModelNeedsSchema>;
export type DispatchModelReason = z.infer<typeof DispatchModelReasonSchema>;
export type DispatchModelRoute = z.infer<typeof DispatchModelRouteSchema>;
