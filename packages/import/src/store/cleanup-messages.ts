import { z } from "zod";

const id = z.string();
const offset = z.number().int().nonnegative();
export const CleanupRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("import"), id }),
  z.strictObject({ kind: z.literal("search") }),
  z.strictObject({ kind: z.literal("attachments"), id, after: offset }),
  z.strictObject({ kind: z.literal("sessions"), id, after: offset }),
  z.strictObject({ kind: z.literal("clearSessions"), ids: z.array(id) }),
  z.strictObject({ kind: z.literal("close") }),
]);
export type CleanupRequest = z.infer<typeof CleanupRequest>;

const response = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("import"), finish: z.boolean() }),
  z.strictObject({ kind: z.literal("search") }),
  z.strictObject({
    kind: z.literal("attachments"),
    cursor: offset.optional(),
    files: z.array(z.strictObject({ path: z.string(), botId: id })),
  }),
  z.strictObject({
    kind: z.literal("sessions"),
    cursor: offset.optional(),
    ids: z.array(id),
    files: z.array(z.strictObject({ file: z.string(), botId: id })),
  }),
  z.strictObject({ kind: z.literal("clearSessions") }),
]);
export type CleanupResponse = z.infer<typeof response>;
export const CleanupResult = z.union([
  response,
  z.strictObject({ kind: z.literal("busy") }),
  z.strictObject({ kind: z.literal("failed") }),
]);
export type CleanupResult = z.infer<typeof CleanupResult>;
