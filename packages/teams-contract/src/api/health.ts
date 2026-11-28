import { GroupSchema, IdSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { PI_HEALTH_KINDS, PI_HEALTH_REASONS, PI_REPAIR_ACTIONS } from "../tools/pi-health.ts";

const name = z.string().min(1).max(200);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * One stuck item of the default Pi's health check, as its list card and the model see it. Ids,
 * names, states, times and fixed codes only; never message text, file contents or secrets.
 */
export const PiHealthItemSchema = z.strictObject({
  /** `<target kind>:<id>` (a plan step: `step:<workflow run>:<step>`); what pi_repair names. */
  id: z.string().min(3).max(240),
  kind: z.enum(PI_HEALTH_KINDS),
  reason: z.enum(PI_HEALTH_REASONS),
  /** A fixed sub-code, e.g. why a connection failed or which choice a plan waits for. */
  detail: code.optional(),
  where: z.strictObject({
    botId: IdSchema.optional(),
    botName: name.optional(),
    groupId: IdSchema.optional(),
    groupName: name.optional(),
    conversationId: IdSchema.optional(),
    /** The topic, task, plan, step or connection name (redacted, short). */
    title: z.string().max(200).optional(),
  }),
  since: z.iso.datetime().nullable(),
  actions: z.array(z.enum(PI_REPAIR_ACTIONS)).max(6),
  /** stop_run only: the run still has a live worker, so stopping it always asks. */
  liveWorker: z.boolean().optional(),
  /** The limit displayed to the user. The owning service must compare it again before resuming. */
  roundLimit: GroupSchema.shape.autoRoundLimit.optional(),
  /** Program fingerprint of the state the check saw; a repair refuses when it changed. */
  state: z.string().min(1).max(200),
});
export type PiHealthItem = z.infer<typeof PiHealthItemSchema>;

/** What a repair did to one listed item (the card marks it). */
export const PiHealthResolutionSchema = z.strictObject({
  itemId: z.string().min(3).max(240),
  action: z.enum(PI_REPAIR_ACTIONS),
  outcome: z.enum(["fixed", "state_changed", "failed"]),
  at: z.iso.datetime(),
});

export const PiHealthReportSchema = z.strictObject({
  id: IdSchema,
  toolCallId: z.string().min(1).max(200),
  messageId: IdSchema,
  scope: z.strictObject({
    kind: z.enum(["all", "bot", "group"]),
    name: name.optional(),
  }),
  items: z.array(PiHealthItemSchema).max(60),
  /** Items found beyond this page (`after` reads them). */
  more: z.number().int().nonnegative(),
  resolutions: z.array(PiHealthResolutionSchema).max(200),
  createdAt: z.iso.datetime(),
});
export type PiHealthReport = z.infer<typeof PiHealthReportSchema>;

/**
 * The fix the person tapped on the check card, carried by the message it sends to Pi. Set by the
 * brain only (never parsed from text), so typed words can never stand in for a tap.
 */
export const PiRepairRequestSchema = z.strictObject({
  check: IdSchema,
  item: z.string().min(3).max(240),
  action: z.enum(PI_REPAIR_ACTIONS),
});
export type PiRepairRequest = z.infer<typeof PiRepairRequestSchema>;

export function messageRepairRequest(message: { usage: unknown } | undefined) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const parsed = PiRepairRequestSchema.safeParse((usage as Record<string, unknown>).repairRequest);
  return parsed.success ? parsed.data : undefined;
}

export const PiHealthMethods = {
  /**
   * The person taps one of an item's fixes on the check card: Pi gets a plain-words message
   * ("Fix this: … — …") carrying that exact fix, and repairs it with the usual card. Refused for an
   * item or fix the check did not list, and from an editor (ACP).
   */
  "teams.healthRepair": {
    params: PiRepairRequestSchema,
    result: z.strictObject({ runId: IdSchema }),
  },
  /** The health checks under one of Pi's replies (the list card), oldest first. */
  "teams.healthReports": {
    params: z.strictObject({ messageId: IdSchema }),
    result: z.array(PiHealthReportSchema).max(10),
  },
} as const;

export const PiHealthEvents = {
  "teams.health.changed": z.strictObject({ messageId: IdSchema }),
} as const;
