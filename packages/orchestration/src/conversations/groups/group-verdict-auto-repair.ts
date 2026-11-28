// Repairs and same-verifier rechecks are admitted atomically under the original plan's limits.
import { redactValue } from "@pibot/brain/orchestration-kit";
import { GroupPlanSchema, RpcError } from "@pibot/protocol-base";
import { GroupExecutionLimitsRepo, type GroupWorkflowRunRecord, transaction } from "@pibot/storage";
import { validateGroupPlan } from "./group-plan-validation.ts";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import { verdictRepairPlan } from "./group-verdict-repair-plan.ts";
import { implementationAuthors, verificationMembers } from "./group-verification-facts.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";
import { verdictRepairPairs, verdictRepairReady } from "./group-workflow-verdicts.ts";

function prepareRepair(service: GroupService, record: GroupWorkflowRunRecord) {
  const states = service.workflows.repo.steps(record.id),
    progress = progressOf(record);
  if (!verdictRepairReady(states, progress)) return;
  const original = GroupPlanSchema.parse(
    (record.workflow as { dynamicPlan?: unknown }).dynamicPlan,
  );
  const generated = verdictRepairPlan(
    original,
    states,
    progress,
    service.deps.chat.currentLanguage(),
  );
  if (!generated) return;
  const group = service.active(record.groupId);
  const entry = service.plans.repo.forCycle(group.conversationId, record.cycleId);
  if (entry?.card.id !== record.id) throw new RpcError(-32602, "group_plan_replacement_stale");
  const checked = validateGroupPlan(
    redactValue(generated, service.deps.redactor),
    verificationMembers(service, group),
    service.deps.local.externalAgentProvider?.stepReadiness,
    implementationAuthors(progress.implementation),
  );
  if (!checked.ok) throw new RpcError(-32602, "group_plan_verdict_repair_invalid");
  // Mac acceptance 2026-11-20: the card kept a `disposition` from an earlier replan, which a
  // verdict repair must not carry, so every repair was refused and the group stalled.
  const { disposition: _disposition, ...current } = entry.card;
  const card = { ...current, plan: checked.plan, owners: checked.owners };
  const pairs = verdictRepairPairs(original, card, states, progress);
  const added = checked.plan.steps.filter(
    (step) => !original.steps.some((old) => old.id === step.id),
  );
  return { card, pairs, added, entry, expectedReplans: progress.replans };
}

type Repair = NonNullable<ReturnType<typeof prepareRepair>>;

function createSteps(service: GroupService, record: GroupWorkflowRunRecord, repair: Repair) {
  for (const step of repair.added) {
    const owner = repair.card.owners.find((item) => item.stepId === step.id)?.botId;
    if (!owner) throw new RpcError(-32602, "verdict_owner_invalid");
    service.workflows.repo.createStep({
      workflowRunId: record.id,
      stepId: step.id,
      status: "waiting",
      attempt: 0,
      taskId: null,
      executionRunId: null,
      deliverables: [],
      ownerBotId: owner,
      decisionMessageId: null,
    });
  }
}

function commitRepair(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  repair: Repair,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  assertPlanWorkplace(service, record.id);
  const latest = service.workflows.repo.get(record.id),
    group = service.active(record.groupId);
  const current = latest ? progressOf(latest) : undefined;
  if (
    !latest ||
    !current ||
    !["running", "waiting"].includes(latest.status) ||
    current.replanRunId ||
    current.replans !== repair.expectedReplans
  )
    throw new RpcError(-32602, "group_plan_replacement_stale");
  if (new GroupExecutionLimitsRepo(service.deps.db).get(group.id).mode !== "execute")
    throw new RpcError(-32602, "group_plan_execute_required");
  // Each refusal names its real cause, so the plan stops with the reason the user can act on.
  const limit = service.workflows.progress.hardLimit(latest, true);
  const stop = (reason: string) => new RpcError(-32602, reason, { planLimit: true });
  if (limit) throw stop(limit);
  if (current.replans >= 2) throw stop("replan_limit");
  // A pause is not an end: replan() waits on it, so this race reports it the same way.
  if (group.paused) throw new RpcError(-32602, "group_paused", { paused: true });
  // Keep the refusal's stop ID when no repair can be admitted. Other errors still roll back.
  if (!service.auto(group.id, record.cycleId, () => true).value) return false;
  const workflow = workflowOf(latest);
  const contractSteps = repair.added.map(({ method: _method, ...step }) => ({
    ...step,
    task: step.task.replace(/[\r\n\t]/g, " "),
  }));
  service.workflows.repo.updateWorkflow(record.id, {
    ...(latest.workflow as object),
    dynamicPlan: repair.card.plan,
    contract: {
      ...workflow.contract,
      steps: [...(workflow.contract.steps ?? []), ...contractSteps],
    },
    progress: {
      ...current,
      requested: false,
      replans: current.replans + 1,
      verdictRepairs: { ...current.verdictRepairs, ...repair.pairs.rechecks },
      verdictFixes: { ...current.verdictFixes, ...repair.pairs.fixes },
    },
  });
  createSteps(service, record, repair);
  service.workflows.repo.updateRun(record.id, "running");
  service.plans.repo.update(repair.entry.message.id, repair.card);
  service.workflows.audit(
    record,
    "group.workflow.disposition",
    "Repair and recheck scheduled / 已排修复与复验",
    { actor: "system", reasonCode: "verdict_auto_repair" },
  );
  return true;
}

export function appendVerdictRepairs(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  signal: AbortSignal,
): boolean {
  const repair = prepareRepair(service, record);
  if (!repair) return false;
  const applied = transaction(service.deps.db, () => commitRepair(service, record, repair, signal));
  if (!applied) throw new RpcError(-32602, "round_limit", { planLimit: true });
  service.plans.changed(repair.entry.message.id, repair.card);
  service.workflows.schedule(record.id);
  return true;
}
