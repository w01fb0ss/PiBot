import type { WorkflowStep } from "@pibot/protocol-base";
import { BotsRepo, type GroupWorkflowStepRecord } from "@pibot/storage";
import { groupPlanText, localizedPlanStepTitle } from "@pibot/teams-contract/i18n";
import type { GroupService } from "./group-service.ts";
import type { WorkflowProgress } from "./group-workflow-progress.ts";
import type { StoredWorkflow } from "./group-workflow-snapshot.ts";
import { verdictStepStatus } from "./group-workflow-verdicts.ts";

type Language = "zh" | "en";

/** Keep saved titles and names on one line without interpreting them as Markdown. */
export function planMarkdownText(text: string) {
  return text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\\\x60*_{}[\]<>!&|~]/gu, "\\$&");
}

export function planStepTitles(steps: readonly WorkflowStep[] | undefined, language: Language) {
  const titles = new Map(steps?.map((step) => [step.id, step.title]));
  return (id: string) => localizedPlanStepTitle(titles.get(id), language);
}

export function planStepNames(service: GroupService, steps: readonly GroupWorkflowStepRecord[]) {
  const bots = new BotsRepo(service.deps.db);
  return new Map(
    [...new Set(steps.map((step) => step.ownerBotId))].map((id) => [id, bots.get(id)?.name ?? ""]),
  );
}

/** A recheck can also be skipped by the scheduler when its prerequisite repair was skipped. */
export function automaticallySkippedSteps(
  steps: readonly GroupWorkflowStepRecord[],
  progress: WorkflowProgress,
) {
  const skipped = new Set(
    steps.filter((step) => step.status === "skipped").map((step) => step.stepId),
  );
  const automatic = new Set<string>();
  for (const [failed, fix] of Object.entries(progress.verdictFixes)) {
    const recheck = progress.verdictRepairs[failed];
    if (skipped.has(fix) && recheck && skipped.has(recheck) && !progress.verdictSkips[recheck])
      automatic.add(recheck);
  }
  return automatic;
}

export function planStepLines(
  definitions: readonly WorkflowStep[] | undefined,
  steps: readonly GroupWorkflowStepRecord[],
  names: ReadonlyMap<string, string>,
  progress: WorkflowProgress,
  language: Language,
  workspaces: ReadonlyMap<string, string | undefined> = new Map(),
) {
  const title = planStepTitles(definitions, language);
  const automaticallySkipped = automaticallySkippedSteps(steps, progress);
  const t = (key: Parameters<typeof groupPlanText>[1], vars?: Record<string, string | number>) =>
    groupPlanText(language, key, vars);
  const status = (
    step: GroupWorkflowStepRecord,
    workspace: string | undefined,
  ): readonly [string, string] => {
    if (step.status === "skipped")
      return automaticallySkipped.has(step.stepId)
        ? ["⏭", t("group.plan.stepLine.autoSkipped")]
        : ["⏭", t("group.plan.stepLine.skipped")];
    if (workspace === "conflict") return ["⏸", t("group.plan.stepLine.mergeConflict")];
    const verdict = verdictStepStatus(progress, step.stepId, language, title);
    if (verdict) return verdict;
    if (step.status === "passed") return ["✅", t("group.plan.stepLine.passed")];
    const count = progress.steps[step.stepId]?.unmet ?? 0;
    if (step.status === "failed" || (step.status === "blocked" && count > 0))
      return [
        "❌",
        count ? t("group.plan.stepLine.failedCount", { count }) : t("group.plan.stepLine.failed"),
      ];
    if (step.status === "blocked")
      return [
        "⏸",
        t(step.decisionMessageId ? "group.plan.stepLine.needsYou" : "group.plan.stepLine.blocked"),
      ];
    if (step.status === "ready" && progress.paused?.[step.stepId])
      return ["⏸", t("group.plan.stepLine.paused")];
    if (step.status === "running") return ["⏳", t("group.plan.stepLine.running")];
    return ["⏳", t("group.plan.stepLine.waiting")];
  };
  return steps.map((step) => {
    const workspace = workspaces.get(step.stepId);
    const [icon, label] = status(step, workspace);
    const details = [title(step.stepId), names.get(step.ownerBotId) ?? "", label];
    if (icon === "❌" && step.status === "blocked" && step.decisionMessageId)
      details.push(t("group.plan.stepLine.needsYou"));
    if (step.status === "passed" && workspace === "merged")
      details.push(t("group.plan.stepLine.merged"));
    if (step.status === "passed" && workspace === "merging")
      details.push(t("group.plan.stepLine.merging"));
    return `- ${icon} ${details.map(planMarkdownText).filter(Boolean).join(" · ")}`;
  });
}

export function planSummaryText(
  workflow: StoredWorkflow,
  steps: readonly GroupWorkflowStepRecord[],
  names: ReadonlyMap<string, string>,
  progress: WorkflowProgress,
  language: Language,
  {
    coverage,
    supplement,
    files,
    unavailable,
  }: {
    coverage: string;
    supplement?: string;
    files: number;
    unavailable: readonly string[];
  },
) {
  const automatic = automaticallySkippedSteps(steps, progress).size;
  const passed = steps.filter((step) => step.status === "passed").length;
  const skipped = steps.length - passed - automatic;
  const counts = [
    groupPlanText(language, "group.plan.summary.completed", { count: passed }),
    skipped && groupPlanText(language, "group.plan.summary.skipped", { count: skipped }),
    automatic && groupPlanText(language, "group.plan.summary.autoSkipped", { count: automatic }),
  ]
    .filter(Boolean)
    .join(language === "zh" ? "，" : ", ");
  const heading = groupPlanText(language, "group.plan.summary.ended", {
    name: planMarkdownText(workflow.name),
    count: steps.length,
    counts,
  });
  const stepHeading = groupPlanText(language, "group.plan.summary.steps");
  const outputHeading = groupPlanText(language, "group.plan.summary.outputs");
  return [
    `${heading}  \n${coverage}`,
    supplement,
    [
      `**${stepHeading}**`,
      "",
      ...planStepLines(workflow.contract.steps, steps, names, progress, language),
    ].join("\n"),
    ...(unavailable.length
      ? [
          `**${groupPlanText(language, "group.plan.summary.outputUnavailable")}**\n\n` +
            unavailable.map((name) => `- ${planMarkdownText(name)}`).join("\n"),
        ]
      : []),
    files
      ? `**${outputHeading}**${groupPlanText(language, "group.plan.summary.files", { count: files })}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}
