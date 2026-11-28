import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

export const RunStopCauseSchema = z.strictObject({
  code: z.enum([
    "user_stopped",
    "timeout",
    "budget_exhausted",
    "repeated_operation",
    "restart",
    "shutdown",
    "superseded",
    "approval_expired",
    "approval_paused",
    "remote_disconnected",
    "checkpoint_failed",
    "compaction_no_progress",
    "park",
    "detached",
    "cancelled",
    "completed",
    "error",
    "aborted",
    "workspace_changed",
    "bot_retired",
    "workflow_stopped",
  ]),
});
export type RunStopCause = z.infer<typeof RunStopCauseSchema>;

export const RunSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  conversationId: IdSchema,
  groupId: IdSchema.nullable(),
  kind: z.enum(["chat", "group_task", "wake", "routine"]),
  status: z.enum(["queued", "running", "waiting", "done", "error", "aborted"]),
  messageId: IdSchema,
  userMessageId: IdSchema.nullable(),
  taskId: IdSchema.nullable(),
  cycleId: IdSchema.nullable(),
  automatic: z.boolean(),
  parentRunId: IdSchema.nullable(),
  afterRunId: IdSchema.nullable(),
  ancestry: z.array(IdSchema).max(12),
  triggerKey: z.string().max(1024).nullable(),
  sessionFile: z.string().nullable(),
  stopReason: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type Run = z.infer<typeof RunSchema>;
export const GroupCycleSchema = z.strictObject({
  cycleId: IdSchema.nullable(),
  rounds: z.number().int().nonnegative(),
  limited: z.boolean(),
  /** Identifies one automatic round-limit stop, even if the same cycle later hits it again. */
  roundLimitId: IdSchema.optional(),
  /** Structured hand-offs this cycle (their own cap, not the automatic rounds). */
  handoffs: z.number().int().nonnegative().optional(),
});
