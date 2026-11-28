import { z } from "zod";

const placeholders = new Set([
  "",
  "all",
  "any",
  "none",
  "null",
  "undefined",
  "*",
  "全部",
  "所有",
  "无",
  "空",
]);

/** Keep placeholders valid in the SDK's input schema, then validate actual references. */
export function optionalToolRef(schema: z.ZodType<string, string>) {
  return z
    .string()
    .nullish()
    .transform((value) =>
      value == null || placeholders.has(value.trim().toLowerCase()) ? undefined : value,
    )
    .pipe(schema.optional());
}
