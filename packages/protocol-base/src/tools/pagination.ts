import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

export const optionalPageBefore = z
  .union([z.string(), z.number(), z.null()])
  .transform((value) => IdSchema.safeParse(value).data)
  .optional()
  .describe(
    "Omit before for the first page; never pass placeholders. Use the ID from the previous page.",
  );

/** Model-facing pagination starts at the first page when an offset cannot be used. */
export const optionalPageOffset = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => {
    const offset = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
    return typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0
      ? offset
      : undefined;
  })
  .optional();
