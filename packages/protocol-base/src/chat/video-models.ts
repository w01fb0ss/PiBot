import { z } from "zod";

export const VideoApiSchema = z.enum([
  "openai-videos",
  "gemini-veo",
  "gemini-omni",
  "kling",
  "ark-seedance",
  "agnes",
  "openrouter-videos",
]);
export const CustomVideoApiSchema = VideoApiSchema.exclude(["gemini-omni"]);
export const CustomVideoModelSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/),
  /** Rates are configured by the operator because gateway and regional prices differ. */
  priceUsdPerSecond: z.number().nonnegative().max(100).optional(),
  priceUsdPerClip: z.number().nonnegative().max(3000).optional(),
  timeoutMinutes: z.number().int().min(15).max(120).optional(),
});
export type VideoApi = z.infer<typeof VideoApiSchema>;
export type CustomVideoModel = z.infer<typeof CustomVideoModelSchema>;

export const BuiltinVideoProviderIdSchema = z.enum(["openai", "google", "openrouter"]);
export const BuiltinVideoModelSchema = CustomVideoModelSchema.omit({ timeoutMinutes: true }).extend(
  {
    priceUsdPerSecondBySize: z
      .record(
        z.string().regex(/^(?:[0-9]{2,4}x[0-9]{2,4}|[0-9]{3,4}p|4k)$/),
        CustomVideoModelSchema.shape.priceUsdPerSecond.unwrap(),
      )
      .optional(),
  },
);
export const BuiltinVideoModelsSchema = z
  .array(BuiltinVideoModelSchema)
  .max(200)
  .refine((models) => new Set(models.map((model) => model.id)).size === models.length);
export const BuiltinVideoCatalogModelSchema = BuiltinVideoModelSchema.extend({
  cachedPricing: z.literal(true).optional(),
});
export const BuiltinVideoOptionSchema = BuiltinVideoCatalogModelSchema.extend({
  enabled: z.boolean(),
});

export function suggestedOpenRouterVideo(id: string): boolean {
  return /(?:^|\/)seedance(?:[-.]|$)/i.test(id);
}

export type BuiltinVideoProviderId = z.infer<typeof BuiltinVideoProviderIdSchema>;
export type BuiltinVideoModel = z.infer<typeof BuiltinVideoModelSchema>;
export type BuiltinVideoCatalogModel = z.infer<typeof BuiltinVideoCatalogModelSchema>;

export interface VideoProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  videoApi: VideoApi;
  videoModels: (CustomVideoModel &
    Pick<BuiltinVideoCatalogModel, "priceUsdPerSecondBySize" | "cachedPricing">)[];
}
