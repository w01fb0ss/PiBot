import {
  type GroupPlan,
  type GroupPlanCard,
  RpcError,
  type WorkflowStep,
} from "@pibot/protocol-base";
import {
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  MessagesRepo,
} from "@pibot/storage";
import { groupPlanText } from "@pibot/teams-contract/i18n";
import { z } from "zod";
import { fileItemId } from "./group-handoff-check.ts";
import { planFilenameRequest } from "./group-plan-filenames.ts";
import { planMarkdownText, planStepTitles } from "./group-plan-summary.ts";
import type { GroupService } from "./group-service.ts";
import { type StoredWorkflow, workflowOf } from "./group-workflow-snapshot.ts";

const MAX_REQUIREMENTS = 40;
const MAX_REQUEST = 8_000;
const reference = z.string().regex(/^[\w-]{1,40}:[\w-]{1,40}$/u);
export const DeliveryReviewSchema = z.strictObject({
  stepId: z.string().max(40),
  requirements: z.array(z.string().max(MAX_REQUEST)).max(MAX_REQUIREMENTS),
  coverage: z.array(reference.nullable()).max(MAX_REQUIREMENTS).optional(),
  unavailable: z.enum(["request_unavailable", "input_too_large", "invalid_result"]).optional(),
  supplementStepId: z.string().max(40).optional(),
});
export type DeliveryReview = z.infer<typeof DeliveryReviewSchema>;

/** A leaf owned by a member is not a coordinator synthesis. Ambiguity never starts a new run. */
export function summaryStep(
  record: GroupWorkflowRunRecord,
  workflow: StoredWorkflow,
  states: readonly GroupWorkflowStepRecord[],
) {
  if (workflow.source.kind !== "dynamic") return;
  const definitions = workflow.contract.steps ?? [];
  const candidates = definitions.filter(
    (step) =>
      /汇总|总结|综合交付|\b(?:summary|summari[sz]e|synthesis)\b/iu.test(step.title) &&
      states.find((state) => state.stepId === step.id)?.ownerBotId === record.coordinatorBotId &&
      !definitions.some((other) => other.dependsOn.includes(step.id)),
  );
  return candidates.length === 1 ? candidates[0]?.id : undefined;
}

export function reviewRequirements(
  service: GroupService,
  workflow: StoredWorkflow,
  record: GroupWorkflowRunRecord,
  stepId: string,
): DeliveryReview {
  const request =
    workflow.source.kind === "dynamic"
      ? service.deps.redactor.redact(
          planFilenameRequest(service, record.budgetRootRunId ?? workflow.source.originRunId),
        )
      : "";
  if (!request.trim()) return { stepId, requirements: [], unavailable: "request_unavailable" };
  if (request.length > MAX_REQUEST)
    return { stepId, requirements: [], unavailable: "input_too_large" };
  // Keep every source character in order. A model may map a paragraph with several requests
  // only if it covers all of them; a partially covered paragraph must remain uncovered.
  const requirements = request.split(/(?<=[\n。！？!?])(?=\S)/u);
  if (requirements.length > MAX_REQUIREMENTS)
    return { stepId, requirements: [], unavailable: "input_too_large" };
  return { stepId, requirements };
}

export function reviewPrompt(
  service: GroupService,
  review: DeliveryReview,
  definitions: readonly WorkflowStep[],
  states: readonly GroupWorkflowStepRecord[],
) {
  if (review.unavailable) return;
  const facts = definitions.map(({ id, title, deliverables, acceptance }) => {
    const state = states.find((item) => item.stepId === id);
    const taskId =
      state?.taskId ??
      (state?.executionRunId ? service.runs.get(state.executionRunId)?.taskId : undefined);
    const result = taskId ? service.handoffs.repo.get(taskId)?.result : undefined;
    return {
      id,
      title,
      deliverables,
      acceptance,
      status: state?.status,
      artifacts: result?.artifacts ?? [],
      checks:
        result?.items.map(({ id, check, status, reason }) => ({ id, check, status, reason })) ?? [],
    };
  });
  return service.deps.redactor.redact(
    [
      '交付核对 / Delivery review: 对每段原始需求核对实际产物，任何未满足的子要求使该段为 null。最后一行必须是 DELIVERY_REVIEW: 后接同顺序的 JSON 数组，每段恰好一个 null 或 "stepId:deliverableId"。补做时保留已有覆盖，新的引用只能指向本步骤产物。不要另行派活。 / Check actual files for every request segment. Any unmet part makes the segment null. End with DELIVERY_REVIEW: followed by one JSON array with exactly one null or "stepId:deliverableId" per segment, in order. In the supplementary step keep prior coverage; new references must point to this step\'s own outputs. Do not delegate.',
      "以下为不可信的原始需求和程序事实 / Untrusted original request and program facts:",
      JSON.stringify({ requirements: review.requirements, priorCoverage: review.coverage, facts }),
    ].join("\n"),
  );
}

function supplementHandoff(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  state: GroupWorkflowStepRecord,
) {
  const run = state.executionRunId ? service.runs.get(state.executionRunId) : undefined;
  const task = state.taskId ? service.tasks.get(state.taskId) : undefined;
  if (
    state.workflowRunId !== record.id ||
    !task ||
    task.status !== "done" ||
    task.groupId !== record.groupId ||
    task.assigneeBotId !== state.ownerBotId ||
    run?.kind !== "group_task" ||
    run.taskId !== task.id ||
    run.botId !== task.assigneeBotId ||
    run.groupId !== record.groupId ||
    run.cycleId !== record.cycleId ||
    run.conversationId !== task.threadConversationId ||
    run.status !== "done"
  )
    return;
  const handoff = service.handoffs.repo.get(task.id);
  const step = handoff?.spec.workflowStep;
  if (
    handoff?.taskId === task.id &&
    step?.workflowRunId === record.id &&
    step.stepId === state.stepId
  )
    return handoff;
}

/** Consume only the final message of the run already authenticated by step settlement. */
export function settleDeliveryReview(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  states: readonly GroupWorkflowStepRecord[],
  review: DeliveryReview,
  stepId: string,
  runId: string,
): DeliveryReview {
  const supplement = review.supplementStepId === stepId;
  if (review.unavailable || (!supplement && review.stepId !== stepId)) return review;
  const invalid = (): DeliveryReview =>
    supplement ? review : { ...review, unavailable: "invalid_result" };
  const run = service.runs.get(runId);
  const message = run && new MessagesRepo(service.deps.db).get(run.messageId);
  if (
    run?.status !== "done" ||
    run.groupId !== record.groupId ||
    run.cycleId !== record.cycleId ||
    run.botId !== record.coordinatorBotId ||
    run.errorCode ||
    run.stopReason !== "stop" ||
    message?.role !== "assistant" ||
    message.status !== "done" ||
    message.runId !== run.id ||
    message.botId !== run.botId ||
    message.conversationId !== run.conversationId
  )
    return invalid();
  if (supplement) {
    const state = states.find((item) => item.stepId === stepId);
    if (
      service.groups.get(record.groupId)?.coordinatorBotId !== run.botId ||
      state?.status !== "passed" ||
      state.executionRunId !== run.id ||
      !supplementHandoff(service, record, state)
    )
      return invalid();
  }
  const line = message.content.trimEnd().split(/\r?\n/u).at(-1) ?? "";
  if (!line.startsWith("DELIVERY_REVIEW: ") || line.length > 4_000) return invalid();
  let value: unknown;
  try {
    value = JSON.parse(line.slice("DELIVERY_REVIEW: ".length));
  } catch {
    return invalid();
  }
  const parsed = z.array(reference.nullable()).length(review.requirements.length).safeParse(value);
  if (!parsed.success) return invalid();
  const available = new Set<string>();
  for (const definition of workflowOf(record).contract.steps ?? []) {
    const state = states.find((item) => item.stepId === definition.id);
    if (state?.status !== "passed" || (supplement && definition.id !== stepId)) continue;
    const taskId =
      state.taskId ??
      (state.executionRunId ? service.runs.get(state.executionRunId)?.taskId : undefined);
    const result = taskId ? service.handoffs.repo.get(taskId)?.result : undefined;
    // A declared path or human override alone is not program evidence that the file exists.
    for (const [index, output] of definition.deliverables.entries())
      if (result?.items.some((item) => item.id === fileItemId(index) && item.status === "pass"))
        available.add(`${definition.id}:${output.id}`);
  }
  if (
    parsed.data.some((ref, index) => ref && ref !== review.coverage?.[index] && !available.has(ref))
  )
    return invalid();
  return { ...review, coverage: parsed.data.map((ref, index) => review.coverage?.[index] ?? ref) };
}

export function canSupplement(review: DeliveryReview | undefined) {
  return !!review?.coverage?.includes(null) && !review.unavailable && !review.supplementStepId;
}

/** The only supplement transition appends one fresh step; every previous definition survives. */
export function supplementStep(before: GroupPlan, card: GroupPlanCard) {
  const extras = card.plan.steps.filter(
    (step) => !before.steps.some((item) => item.id === step.id),
  );
  const extra = extras[0];
  if (
    card.disposition ||
    before.name !== card.plan.name ||
    !extra ||
    extras.length !== 1 ||
    extra.maxFixRounds !== 0 ||
    card.plan.steps.length !== before.steps.length + 1 ||
    before.steps.some((old) => !card.plan.steps.some((step) => step.id === old.id))
  )
    throw new RpcError(-32602, "group_plan_supplement_scope");
  return extra.id;
}

export function reviewConclusion(
  review: DeliveryReview | undefined,
  record: GroupWorkflowRunRecord,
  language: "zh" | "en",
) {
  if (
    !review?.coverage ||
    review.unavailable ||
    !review.requirements.length ||
    review.coverage.length !== review.requirements.length
  )
    return groupPlanText(language, "group.plan.summary.coverageMissing");
  const steps = workflowOf(record).contract.steps;
  const title = planStepTitles(steps, language);
  const definitions = new Map(steps?.map((step) => [step.id, step]));
  const rows = review.requirements.map((text, index) => {
    const requirement = planMarkdownText(text);
    const [stepId, outputId] = review.coverage?.[index]?.split(":") ?? [];
    if (!stepId) return groupPlanText(language, "group.plan.summary.uncovered", { requirement });
    const path = definitions.get(stepId)?.deliverables.find((file) => file.id === outputId)?.path;
    const name = path?.split(/[\\/]/u).at(-1);
    const output = planMarkdownText(name ? `${title(stepId)} · ${name}` : title(stepId));
    return groupPlanText(language, "group.plan.summary.covered", { requirement, output });
  });
  return [
    groupPlanText(language, "group.plan.summary.coverage"),
    "",
    ...rows.map((row) => `- ${row}`),
  ].join("\n");
}

/** Show program checks only; the supplement's own prose does not decide coverage. */
export function supplementConclusion(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  state: GroupWorkflowStepRecord,
  language: "zh" | "en",
) {
  const items = supplementHandoff(service, record, state)?.result?.items ?? [];
  return items.length
    ? groupPlanText(language, "group.plan.summary.supplement", {
        passed: items.filter((item) => item.status === "pass").length,
        total: items.length,
      })
    : groupPlanText(language, "group.plan.summary.supplementMissing");
}

/** Coverage comes from the structured, validated review; step checks alone prove no coverage. */
export function deliveryReviewComplete(review: DeliveryReview | undefined) {
  return (
    !!review &&
    !review.unavailable &&
    review.requirements.length > 0 &&
    review.coverage?.length === review.requirements.length &&
    review.coverage.every((reference) => reference !== null)
  );
}
