import { z } from "zod";

const count = z.number().int().nonnegative().safe();

export const RunRetentionResultSchema = z.strictObject({
  runs: count,
  events: count,
  executions: count,
  sessionFiles: count,
  resultFiles: count,
  freedBytes: count.optional(),
});
export type RunRetentionResult = z.infer<typeof RunRetentionResultSchema>;

export const RunRetentionEstimateSchema = z.strictObject({
  runs: count,
  files: count,
  bytes: count,
  incomplete: z.boolean(),
});
export type RunRetentionEstimate = z.infer<typeof RunRetentionEstimateSchema>;

export const RunRetentionMethods = {
  "runs.cleanupEstimate": {
    params: z.strictObject({
      olderThanDays: z.number().int().min(1).max(36_500),
    }),
    result: RunRetentionEstimateSchema,
  },
  "runs.cleanup": {
    params: z.strictObject({
      olderThanDays: z.number().int().min(1).max(36_500),
      confirmed: z.literal(true),
    }),
    result: RunRetentionResultSchema,
  },
} as const;
