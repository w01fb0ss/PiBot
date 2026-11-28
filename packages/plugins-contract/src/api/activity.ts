import { ConnectorNetworkSiteSchema, IdSchema } from "@pibot/protocol-base";
import { z } from "zod";

// What a connection was used for and where its data goes, read from records the app
// already writes (audit log, send drafts, the connection's own configuration). Facts only: tool
// names, Bot / group names, outcome codes, domains and data categories; never arguments, results,
// content or credentials.
const time = z.iso.datetime();
const code = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
/** Keyset position `<at>~<id>` of the last row of the previous page (newest first). */
export const ConnectionUseCursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z~[0-9a-f-]{36}$/);
export const ConnectionUseSchema = z.strictObject({
  /** Audit row id for reads and refusals, the approval id for a write draft. */
  id: IdSchema,
  at: time,
  botId: IdSchema,
  /** Null once the Bot or group is gone; the row stays because the audit survives deletion. */
  botName: z.string().max(200).nullable(),
  groupId: IdSchema.nullable(),
  groupName: z.string().max(200).nullable(),
  /** The run that made the call: its work receipt opens from here. */
  runId: IdSchema.nullable(),
  tool: z.string().min(1).max(200).nullable(),
  kind: z.enum(["read", "write"]),
  /**
   * done: succeeded; failed: did not complete (`reasonCode`); denied: policy or the person
   * refused it; pending: a write waiting for confirmation; running: started, no outcome yet.
   */
  outcome: z.enum(["done", "failed", "denied", "pending", "running"]),
  reasonCode: code.nullable(),
});
export type ConnectionUse = z.output<typeof ConnectionUseSchema>;
export const ConnectionDataCategorySchema = z.enum([
  /** What the Bot filled in to read: queries, ids, ranges. */
  "requests",
  /** Content of writes the person (or a remembered rule) let through. */
  "written_content",
  /** The account token, sent only to authenticate. */
  "credential",
]);
export const ConnectionDestinationSchema = z.strictObject({
  destination: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("domain"), domain: ConnectorNetworkSiteSchema }),
    z.strictObject({ kind: z.literal("this_computer") }),
  ]),
  categories: z.array(ConnectionDataCategorySchema).max(3),
  /** Last recorded use of this connection that reached this destination; null if never used. */
  lastAt: time.nullable(),
});
export type ConnectionDestination = z.output<typeof ConnectionDestinationSchema>;

export const ConnectorActivityMethods = {
  "connectors.recentUse": {
    params: z.strictObject({
      id: IdSchema,
      before: ConnectionUseCursorSchema.optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    result: z.strictObject({
      items: z.array(ConnectionUseSchema).max(50),
      nextCursor: ConnectionUseCursorSchema.nullable(),
    }),
  },
  "connectors.dataDestinations": {
    params: z.strictObject({ id: IdSchema }),
    result: z.strictObject({ items: z.array(ConnectionDestinationSchema).max(192) }),
  },
} as const;
