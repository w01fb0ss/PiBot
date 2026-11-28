import { z } from "zod";

export const MAX_HISTORY_PARTS = 4096;

export const HistoryPartsSchema = z
  .array(
    z.object({
      kind: z.enum(["call", "result", "attachment"]),
      name: z.string().min(1).max(200),
      summary: z.string().max(200).optional(),
    }),
  )
  .max(MAX_HISTORY_PARTS);
type HistoryPart = z.infer<typeof HistoryPartsSchema>[number];

const block = z.object({
  type: z.string(),
  id: z.string().max(256).optional(),
  tool_use_id: z.string().max(256).optional(),
  name: z.string().optional(),
  file_name: z.string().optional(),
  filename: z.string().optional(),
  is_error: z.boolean().optional(),
});
const nameOnly = (text: string) =>
  text
    .split(/[\\/]/u)
    .at(-1)
    ?.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .slice(0, 200);

export function attachmentParts(raw: unknown[]): HistoryPart[] {
  const schema = z.object({
    file_name: z.string().optional(),
    filename: z.string().optional(),
    name: z.string().optional(),
  });
  return raw.slice(0, MAX_HISTORY_PARTS).flatMap((item) => {
    const value = schema.safeParse(item).data;
    const name = value && nameOnly(value.file_name ?? value.filename ?? value.name ?? "");
    return name ? [{ kind: "attachment", name }] : [];
  });
}

/** IDs link a result to its name. Arguments and result bodies stay out of these records. */
export class ImportedToolParts {
  private readonly names = new Map<string, string>();

  call(name: string | undefined, id?: string): HistoryPart {
    const safeName =
      name
        ?.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
        .trim()
        .slice(0, 200) || "tool";
    if (id) {
      if (this.names.size >= 4096) this.names.delete(this.names.keys().next().value ?? "");
      this.names.set(id, safeName);
    }
    return { kind: "call", name: safeName, summary: "Call recorded" };
  }

  result(id?: string, name?: string, failed?: boolean): HistoryPart {
    const tool =
      (id ? this.names.get(id) : undefined) ??
      name
        ?.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
        .trim()
        .slice(0, 200);
    if (id) this.names.delete(id);
    return {
      kind: "result",
      name: tool || "tool",
      summary: failed ? "Reported an error" : "Result recorded",
    };
  }

  blocks(raw: unknown): HistoryPart[] {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_HISTORY_PARTS).flatMap((item) => {
      const parsed = block.safeParse(item).data;
      if (!parsed) return [];
      if (parsed.type === "tool_use") return [this.call(parsed.name, parsed.id)];
      if (parsed.type === "tool_result")
        return [this.result(parsed.tool_use_id, parsed.name, parsed.is_error)];
      if (!["file", "document", "attachment", "image"].includes(parsed.type)) return [];
      const name = nameOnly(parsed.file_name ?? parsed.filename ?? parsed.name ?? "");
      return name ? [{ kind: "attachment" as const, name }] : [];
    });
  }
}
