import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

/**
 * Commands a Bot started with `run_command` background mode. They keep running in the
 * command sandbox after the tool returns, belong to the chat (topic / group) they were started
 * in, and are stopped by the Bot, the user, deleting that chat, archiving the Bot or quitting.
 */
export const MAX_BACKGROUND_COMMANDS_PER_TOPIC = 3;

/**
 * The Bot-wide ceiling, summed over all its topics. Parallel topics each need their own check
 * (e.g. a long `check:changed`), but the machine still needs one bound so one Bot's runaway
 * topics cannot exhaust it.
 */
export const MAX_BACKGROUND_COMMANDS_PER_BOT = 8;

export const LocalPortSchema = z.number().int().min(1).max(65535);
export const BackgroundCommandStatusSchema = z.enum(["running", "exited", "stopped", "failed"]);
export const BackgroundStopReasonSchema = z.enum([
  "user",
  "bot",
  "chat_deleted",
  "bot_archived",
  "left_group",
  "app_quit",
  /** It listened on a non-loopback address. */
  "exposed",
  /** Found still running after the brain restarted. */
  "restart",
  "restart_unverified",
  "time_limit",
  /** Its process was gone; the person removed it through Pi's repair. */
  "orphaned",
]);
export const BackgroundCommandSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  /** DM topic or group conversation / task thread the command was started from. */
  conversationId: IdSchema.nullable(),
  groupId: IdSchema.nullable(),
  runId: IdSchema,
  toolCallId: z.string().min(1).max(200),
  /** Redacted, shortened command text for display. */
  command: z.string().max(500),
  status: BackgroundCommandStatusSchema,
  promoted: z.boolean().optional(),
  continuation: z.enum(["waiting", "automatic", "manual", "resumed", "none"]).optional(),
  continuationRunId: IdSchema.optional(),
  continuationFailed: z.boolean().optional(),
  continuationPending: z.boolean().optional(),
  /** Live redacted-output count; absent after restart or on older execution targets. */
  outputLines: z.number().int().min(0).max(1_000_000_000).optional(),
  stopReason: BackgroundStopReasonSchema.nullable(),
  exitCode: z.number().int().safe().nullable(),
  /** Loopback TCP ports the command's processes listen on right now. */
  ports: z.array(LocalPortSchema).max(16),
  /** false where ports cannot be seen from this machine (Linux sandbox network namespace). */
  portsVisible: z.boolean(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});
export type BackgroundCommand = z.infer<typeof BackgroundCommandSchema>;
export type BackgroundStopReason = z.infer<typeof BackgroundStopReasonSchema>;

/**
 * Where a command was started, for the Records page. `topic` is a DM topic, `group` a
 * group's main chat and `thread` a group task thread (`groupName` set for both group kinds).
 * The record's place is null when that chat no longer exists.
 */
export const BackgroundPlaceSchema = z.strictObject({
  kind: z.enum(["topic", "group", "thread"]),
  title: z.string().max(200),
  groupName: z.string().max(200).nullable(),
});
export const BackgroundCommandRecordSchema = BackgroundCommandSchema.extend({
  place: BackgroundPlaceSchema.nullable(),
});
export type BackgroundPlace = z.infer<typeof BackgroundPlaceSchema>;
export type BackgroundCommandRecord = z.infer<typeof BackgroundCommandRecordSchema>;

export const ForegroundCommandKeySchema = z.strictObject({
  botId: IdSchema,
  runId: IdSchema,
  toolCallId: z.string().min(1).max(200),
});
export const ForegroundCommandStateSchema = ForegroundCommandKeySchema.extend({
  active: z.boolean(),
  available: z.boolean(),
  reason: z.enum(["limit"]).optional(),
});
export type ForegroundCommandState = z.infer<typeof ForegroundCommandStateSchema>;

const job = z.strictObject({ botId: IdSchema, id: IdSchema });
export const BackgroundCommandMethods = {
  "foregroundCommands.get": {
    params: ForegroundCommandKeySchema,
    result: ForegroundCommandStateSchema.nullable(),
  },
  "foregroundCommands.promote": {
    params: ForegroundCommandKeySchema,
    result: z.strictObject({ ok: z.literal(true) }),
  },
  /** Newest first: running ones plus recently ended ones of this Bot. */
  "backgroundCommands.list": {
    params: z.strictObject({
      botId: IdSchema,
      conversationId: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    result: z.array(BackgroundCommandSchema).max(50),
  },
  /**
   * Records page: all Bots (or one). Running ones newest start first, ended ones newest end
   * first; `before` is the last row's id of the previous page.
   */
  "backgroundCommands.page": {
    params: z.strictObject({
      /** Bounded exact lookup for older completion batches; all scope filters still apply. */
      ids: z.array(IdSchema).min(1).max(32).optional(),
      from: z.iso.datetime().optional(),
      state: z.enum(["running", "ended"]),
      groupId: IdSchema.optional(),
      botId: IdSchema.optional(),
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    result: z.array(BackgroundCommandRecordSchema).max(100),
  },
  "backgroundCommands.stop": { params: job, result: BackgroundCommandSchema },
  "backgroundCommands.continue": { params: job, result: BackgroundCommandSchema },
  "backgroundCommands.output": {
    params: job,
    result: z.strictObject({ text: z.string().max(20_000).nullable() }),
  },
  /**
   * Opens http://localhost:<port>/ in a new tab of this Bot's own browser (it used to open
   * the system browser). Brain builds the address from the command: `port` only picks one
   * of the ports the job listens on right now (several listening ports get one button each);
   * without it, the first one. The UI can never pass an address.
   */
  "backgroundCommands.open": {
    params: job.extend({ port: LocalPortSchema.optional() }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
};
export const BackgroundCommandEvents = {
  "foregroundCommands.changed": ForegroundCommandStateSchema,
  "backgroundCommands.changed": BackgroundCommandSchema,
};

/**
 * A URL that targets a service on this machine — http(s)/ws(s), host 127.0.0.1, localhost
 * or [::1], no credentials. Policy, the Bot browser host and brain all use this one definition so
 * their rules cannot drift; callers then require the port to be one of the Bot's own listeners.
 */
export function localServiceTarget(value: string): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return undefined;
  if (url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return undefined;
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:" || url.protocol === "wss:"
      ? 443
      : 80;
  return { host, port };
}
