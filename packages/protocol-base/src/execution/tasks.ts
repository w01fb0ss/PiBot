import { z } from "zod";
import { MessageSchema } from "../chat/entities.ts";
import { IdSchema } from "../core/ids.ts";
import { optionalPageBefore } from "../tools/pagination.ts";
import { ExecutionLimitsSchema, ExecutionScopeSchema } from "./modes.ts";

/** Raises of a workflow's cost cap per budget root, and the share of the cap each adds. */
export const BUDGET_RAISES_MAX = 3;
export const BUDGET_RAISE_SHARE = 0.5;

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "stopping",
  "done",
  "error",
  "aborted",
  "interrupted",
]);
export const TaskSummarySchema = ExecutionScopeSchema.extend({
  id: IdSchema,
  parentTaskId: IdSchema.nullable(),
  rootRunId: IdSchema,
  parentRunId: IdSchema,
  /** Match against this parent run's actual message tool records; never guess a latest reply. */
  sourceToolCallId: z.string().min(1).nullable().optional(),
  runId: IdSchema.nullable(),
  title: z.string().min(1).max(200),
  status: TaskStatusSchema,
  version: z.number().int().nonnegative().safe(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  result: z.string().max(16_000).nullable(),
  resultTruncated: z.boolean(),
  needsVerification: z.boolean(),
  archivedAt: z.iso.datetime().nullable().optional(),
  deletedAt: z.iso.datetime().nullable().optional(),
});
export const TaskPageSchema = z.strictObject({
  items: z.array(TaskSummarySchema).max(50),
  nextBefore: IdSchema.nullable(),
});
export const BudgetSnapshotSchema = z.strictObject({
  rootRunId: IdSchema,
  limits: ExecutionLimitsSchema,
  activeMillis: z.number().nonnegative().finite(),
  tools: z.number().int().nonnegative().safe(),
  requests: z.number().int().nonnegative().safe(),
  childTasks: z.number().int().nonnegative().safe(),
  activeChildren: z.number().int().nonnegative().safe(),
  maxDepth: z.number().int().nonnegative().safe(),
  observedTokens: z.number().nonnegative().finite(),
  knownCostUsd: z.number().nonnegative().finite(),
  unknownUsageRequests: z.number().int().nonnegative().safe(),
  unknownCostRequests: z.number().int().nonnegative().safe(),
  exhaustedReason: z.string().max(100).nullable(),
  version: z.number().int().nonnegative().safe(),
  /**
   * The user's 「加预算继续」 on a workflow run stopped at its cost cap. `baseUsd` is the cap
   * the root started with (each raise adds half of it); `count` is how many raises it has had.
   */
  costRaises: z
    .strictObject({
      count: z.number().int().min(1).max(BUDGET_RAISES_MAX),
      baseUsd: z.number().positive().max(10_000),
    })
    .optional(),
});
export const ExecutionCheckpointSchema = z.strictObject({
  runId: IdSchema,
  toolCallId: z.string().max(300).nullable(),
  tool: z.string().max(100).nullable(),
  phase: z.enum(["idle", "dispatch", "settled", "interrupted"]),
  outcome: z.enum(["done", "error", "unknown"]).nullable(),
  sideEffectsPossible: z.boolean(),
  summary: z.string().max(8_000),
  updatedAt: z.iso.datetime(),
});
export const TaskDetailSchema = z.strictObject({
  task: TaskSummarySchema,
  budget: BudgetSnapshotSchema,
  checkpoint: ExecutionCheckpointSchema.nullable(),
});
export const TaskSpawnSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(16_000),
  mode: z.literal("plan").optional(),
  /**
   * `cheap` runs the child on the auxiliary model, on the same budget root. Only honoured
   * in a workflow run; elsewhere it is ignored and the result says so.
   */
  model: z.enum(["cheap", "main"]).optional(),
});
export const TaskStatusInputSchema = z.strictObject({
  taskId: IdSchema.optional(),
  before: optionalPageBefore,
  limit: z.number().int().min(1).max(50).optional(),
});
export const TaskMessageSchema = z.strictObject({
  taskId: IdSchema,
  message: z.string().trim().min(1).max(8_000),
});
export const TaskCancelSchema = z.strictObject({ taskId: IdSchema });
export const TaskReceiptSchema = z.strictObject({
  task: TaskSummarySchema,
  delivery: z.enum(["queued", "delivered", "deferred", "stopping"]),
});
const scopedTask = ExecutionScopeSchema.extend({ taskId: IdSchema });
export const TaskExecutionMethods = {
  "execution.budget.get": {
    params: ExecutionScopeSchema.extend({ runId: IdSchema.optional() }),
    result: BudgetSnapshotSchema.nullable(),
  },
  "execution.tasks.list": {
    params: ExecutionScopeSchema.extend({
      archived: z.boolean().optional(),
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    result: TaskPageSchema,
  },
  "execution.tasks.get": { params: scopedTask, result: TaskDetailSchema },
  "execution.tasks.history": {
    params: scopedTask.extend({
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    result: z.strictObject({
      messages: z.array(MessageSchema).max(50),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "execution.tasks.message": {
    params: scopedTask.extend({ requestId: IdSchema, message: TaskMessageSchema.shape.message }),
    result: TaskReceiptSchema,
  },
  "execution.tasks.cancel": { params: scopedTask, result: TaskReceiptSchema },
} as const;
export const TaskExecutionEvents = {
  "execution.task.changed": TaskSummarySchema,
  "execution.budget.changed": BudgetSnapshotSchema,
} as const;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskPage = z.infer<typeof TaskPageSchema>;
export type BudgetSnapshot = z.infer<typeof BudgetSnapshotSchema>;
export type ExecutionCheckpoint = z.infer<typeof ExecutionCheckpointSchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type TaskSpawn = z.infer<typeof TaskSpawnSchema>;
