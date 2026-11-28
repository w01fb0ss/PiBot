// Share YOLO requests, results, and events between the brain and its clients.
import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { RiskSchema } from "./approvals.ts";
import { IsolationSchema } from "./settings.ts";

/**
 * YOLO: a switch on one conversation (a DM topic, or a group conversation together with its
 * task threads). While on, a policy decision that would ask is allowed without a card. It is
 * stored on that conversation only: a new topic starts off, nothing is inherited or Bot-wide, and
 * a routine's own topic cannot be switched on.
 */
export const ConversationYoloStateSchema = z.strictObject({
  conversationId: IdSchema,
  enabled: z.boolean(),
  /** When it was turned on; null while off. */
  enabledAt: z.iso.datetime().nullable(),
});
export const ConversationYoloSchema = ConversationYoloStateSchema.extend({
  /** Command isolation on this computer: the confirm text warns when commands run unisolated. */
  isolation: IsolationSchema,
  /** Whether the brain can save consent for eligible commands on a Windows execution target. */
  windowsDirectRun: z.enum(["consented", "needs_consent", "unavailable"]).optional(),
});
/** A tool step that was allowed by YOLO instead of a card (risk "danger" shows in warning color). */
export const YoloStepSchema = z.strictObject({ risk: RiskSchema });
const conversationId = z.strictObject({ conversationId: IdSchema });
export const YoloMethods = {
  "conversations.yolo.get": { params: conversationId, result: ConversationYoloSchema },
  // This desktop-only confirmation can persist the device-wide Windows consent.
  "conversations.yolo.enableOnWindows": {
    params: conversationId.extend({ acknowledged: z.literal(true).optional() }),
    result: ConversationYoloSchema,
  },
  /** Turning it on also lets eligible pending cards of that conversation through. */
  "conversations.yolo.set": {
    params: conversationId.extend({ enabled: z.boolean() }),
    result: ConversationYoloSchema,
  },
} as const;
export const YoloEvents = {
  "conversations.yolo.changed": ConversationYoloStateSchema,
} as const;
export type ConversationYolo = z.infer<typeof ConversationYoloSchema>;
export type ConversationYoloState = z.infer<typeof ConversationYoloStateSchema>;
export type YoloStep = z.infer<typeof YoloStepSchema>;
