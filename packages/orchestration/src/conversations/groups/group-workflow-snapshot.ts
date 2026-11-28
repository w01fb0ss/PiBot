import type { WorkflowRun } from "@pibot/brain/orchestration-kit";
import {
  type GroupExecutionPlan,
  GroupExecutionPlanSchema,
  type GroupWorkflowDecision,
  type PlanDelivery,
  PlanDeliverySchema,
  type PlanRelaxation,
  PlanRelaxationHistorySchema,
  RpcError,
  RpcErrorCodes,
  type WorkflowStep,
} from "@pibot/protocol-base";
import type {
  GroupWorkflowRunRecord,
  GroupWorkflowStepRecord,
  GroupWorkflowsRepo,
} from "@pibot/storage";
import { PlanWorkplaceSchema } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import type { GroupWorkflowProgress } from "./group-workflow-progress.ts";

export type StoredWorkflow = GroupExecutionPlan & {
  folder: string;
  piDispatchId?: string;
  workplaceRevoked?: boolean;
  acceptanceRelaxed?: boolean;
  manualReviewMessageId?: string;
  relaxationDetails?: PlanRelaxation[];
  delivery?: PlanDelivery;
  workplace?: import("zod").z.infer<typeof PlanWorkplaceSchema>;
  previous?: WorkflowRun["previous"];
};

export type WorkflowAuditKind =
  | "group.workflow.started"
  | "group.workflow.recovered"
  | "group.workflow.step_dispatched"
  | "group.workflow.step_passed"
  | "group.workflow.step_failed"
  | "group.workflow.step_blocked"
  | "group.workflow.step_merged"
  | "group.workflow.disposition"
  | "group.workflow.completed";

/** What the scheduler's parts share; the scheduler owns lifecycle (closed / shutdown). */
export interface WorkflowEngine {
  readonly service: GroupService;
  readonly repo: GroupWorkflowsRepo;
  readonly progress: GroupWorkflowProgress;
  readonly closed: boolean;
  readonly shutdownSignal: AbortSignal;
  schedule(id: string): void;
  block(
    record: GroupWorkflowRunRecord,
    definition: WorkflowStep,
    state: GroupWorkflowStepRecord,
    reason: string,
  ): void;
  createDecision(
    record: GroupWorkflowRunRecord,
    definition: WorkflowStep,
    attempt: number,
    reasonCode?: string,
    note?: string,
  ): void;
  /** One program-written progress line per burst of step transitions. */
  announce(record: GroupWorkflowRunRecord): void;
  /** After the user's decision: the progress line below that card shows the current state. */
  refreshStatus(record: GroupWorkflowRunRecord, decisionMessageId: string): void;
  /** Maintainers 2026-11-14: merge a passed step's own workspace into the group folder (queued). */
  requestMerge(workflowRunId: string, stepId: string): void;
  audit(
    record: GroupWorkflowRunRecord,
    kind: WorkflowAuditKind,
    summary: string,
    detail: Record<string, unknown>,
  ): void;
}

export function workflowOf(record: GroupWorkflowRunRecord): StoredWorkflow {
  const value = record.workflow as Partial<StoredWorkflow>;
  const plan = GroupExecutionPlanSchema.safeParse({
    source: value.source ?? {
      kind: "contract",
      skillId: record.skillId,
      version: record.contractVersion,
    },
    name: value.name,
    contract: value.contract,
    inputs: value.inputs,
  });
  if (!plan.success || typeof value.folder !== "string" || !value.folder)
    throw new RpcError(RpcErrorCodes.internal, "group_workflow_snapshot_invalid");
  return {
    ...plan.data,
    folder: value.folder,
    ...(typeof value.piDispatchId === "string" ? { piDispatchId: value.piDispatchId } : {}),
    ...(typeof value.manualReviewMessageId === "string"
      ? { manualReviewMessageId: value.manualReviewMessageId }
      : {}),
    ...(value.relaxationDetails
      ? { relaxationDetails: PlanRelaxationHistorySchema.parse(value.relaxationDetails) }
      : {}),
    ...(value.acceptanceRelaxed === true ? { acceptanceRelaxed: true } : {}),
    ...(value.workplaceRevoked ? { workplaceRevoked: true } : {}),
    ...(value.workplace ? { workplace: PlanWorkplaceSchema.parse(value.workplace) } : {}),
    ...(value.delivery ? { delivery: PlanDeliverySchema.parse(value.delivery) } : {}),
    ...(value.previous ? { previous: value.previous } : {}),
  };
}

export const decisionOf = (usage: unknown): GroupWorkflowDecision | undefined => {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const value = (usage as Record<string, unknown>).groupWorkflowDecision;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const decision = value as Partial<GroupWorkflowDecision>;
  return decision.workflowRunId && decision.stepId && decision.title && decision.state
    ? (decision as GroupWorkflowDecision)
    : undefined;
};

/** The program's settled deliverable record of a step: summary plus declared and observed paths. */
export function stepDeliverables(
  definition: WorkflowStep,
  summary: string,
  artifacts: readonly string[],
) {
  return [
    { summary },
    ...[...new Set([...definition.deliverables.map((item) => item.path), ...artifacts])].map(
      (path) => ({ path }),
    ),
  ];
}
