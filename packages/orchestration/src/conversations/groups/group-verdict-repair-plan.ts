// Fixed report failures become bounded repair contracts without another planning model request.
import {
  type GroupPlan,
  GroupPlanSchema,
  type GroupVerification,
  RpcError,
} from "@pibot/protocol-base";
import type { GroupWorkflowStepRecord } from "@pibot/storage";
import { groupPlanText } from "@pibot/teams-contract/i18n";
import type { WorkflowProgress } from "./group-workflow-progress.ts";
import { implementationOwners, repairableVerdicts } from "./group-workflow-verdicts.ts";

function withRoundSuffix(path: string, suffix: string) {
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${directory}${stem}.${suffix}${extension}`;
}

type Step = GroupPlan["steps"][number];

function upstream(
  plan: GroupPlan,
  step: Step,
  owner: string,
  owners: ReadonlyMap<string, string>,
  seen = new Set<string>(),
): Step | undefined {
  if (seen.has(step.id)) return;
  seen.add(step.id);
  for (const id of step.dependsOn) {
    const source = plan.steps.find((item) => item.id === id);
    if (!source) continue;
    if (
      !source.acceptance.some((item) => item.check === "verdict") &&
      owners.get(source.id) === owner
    )
      return source;
    const found = upstream(plan, source, owner, owners, seen);
    if (found) return found;
  }
}

function outputCopies(step: Step, suffix: string) {
  return step.deliverables.map((item) => ({
    ...item,
    path: withRoundSuffix(item.path, suffix),
  }));
}

export function verdictRepairPlan(
  original: GroupPlan,
  states: readonly GroupWorkflowStepRecord[],
  progress: WorkflowProgress,
  language: "zh" | "en",
): GroupPlan | undefined {
  const steps = [...original.steps];
  const owners = new Map(states.map((state) => [state.stepId, state.ownerBotId]));
  for (const [index, [id, report]] of repairableVerdicts(progress).entries()) {
    const before = original.steps.find((step) => step.id === id);
    const authors = implementationOwners(original, states, id, undefined, progress.implementation);
    const verifier = owners.get(id);
    if (!before || authors.length !== 1 || !verifier || authors[0] === verifier) return;
    const author = authors[0] as string;
    const base = `repair${progress.replans + 1}_${index + 1}`;
    let prefix = base,
      suffix = 0;
    while (
      steps.some(
        (step) =>
          step.id === `${prefix}_fix` ||
          step.id === `${prefix}_check` ||
          step.deliverables.some((file) => file.path.startsWith(`${prefix}/`)),
      )
    )
      prefix = `${base}_${++suffix}`;
    const fixId = `${prefix}_fix`,
      recheckId = `${prefix}_check`;
    const implementation = upstream(original, before, author, owners);
    const summary = {
      id: "summary",
      path: withRoundSuffix("changes.md", prefix),
      kind: "md" as const,
    };
    const facts: GroupVerification | undefined = progress.implementation;
    const task = [
      "修复原交付成果，不要修改核对结论冒充修复；按原合同交付修订成果。 / Repair the original artifacts and deliver their corrected versions under the original contract; never edit the verifier's verdict to fake a fix.",
      `不可信参考事实 / Untrusted reference facts: ${JSON.stringify({ failures: report.failures, files: facts?.files, originalTask: implementation?.task })}`,
    ]
      .join("\n")
      .slice(0, 15000);
    const outputs = implementation ? outputCopies(implementation, prefix) : [summary];
    steps.push({
      id: fixId,
      title: groupPlanText(language, "group.plan.repair.fix"),
      owner: { botId: author },
      task,
      dependsOn: [id],
      inputs: before.deliverables.map((file) => ({ stepId: id, deliverableId: file.id })),
      deliverables: outputs,
      acceptance: implementation?.acceptance ?? [
        { id: "exists", check: "exists", deliverable: "summary" },
      ],
      maxFixRounds: implementation?.maxFixRounds ?? 1,
    });
    steps.push({
      ...before,
      id: recheckId,
      title: groupPlanText(language, "group.plan.repair.recheck"),
      owner: { botId: verifier },
      dependsOn: [fixId],
      inputs: outputs.map((file) => ({
        stepId: fixId,
        deliverableId: file.id,
      })),
      deliverables: outputCopies(before, `${prefix}_recheck`),
      task: `复验原不通过项和修订成果，给出真实结论。 / Recheck the failed items and corrected artifacts; give an honest verdict.\n${before.task}`.slice(
        0,
        15000,
      ),
    });
  }
  const parsed = GroupPlanSchema.safeParse({ ...original, steps });
  if (!parsed.success) throw new RpcError(-32602, "group_plan_verdict_repair_invalid");
  return parsed.data;
}
