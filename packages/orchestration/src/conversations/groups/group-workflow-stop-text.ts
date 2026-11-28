import type { GroupWorkflowRunRecord, GroupWorkflowStepRecord } from "@pibot/storage";
import { planStepTitles } from "./group-plan-summary.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";
import { verdictFailureLines } from "./group-workflow-verdicts.ts";

/** User-facing stop text is separate from durable diagnostic codes in the audit. */
export function workflowStopText(
  record: GroupWorkflowRunRecord,
  steps: GroupWorkflowStepRecord[],
  reason: string,
  actor: "user" | "system",
  language: "zh" | "en",
) {
  const zh = language === "zh";
  const reasons: Record<string, string> = zh
    ? {
        cost: "费用上限已到",
        budget_exhausted: "预算用尽",
        model_requests: "请求次数用尽",
        active_seconds: "执行时限已到",
        round_limit: "群回合上限已到",
        no_progress: "没有新增进展",
        replan_limit: "重新规划次数用尽",
        verdict_failed: "测试或审查结论不通过",
        verdict_recheck_skipped: "复验已跳过但没有用户接受记录",
        verdict_repair_owner_missing: "无法从失败步骤的依赖找到原实现者",
      }
    : {
        cost: "cost limit reached",
        budget_exhausted: "budget exhausted",
        model_requests: "request limit reached",
        active_seconds: "execution time limit reached",
        round_limit: "group round limit reached",
        no_progress: "no new progress",
        replan_limit: "replanning limit reached",
        verdict_failed: "test or review verdict failed",
        verdict_recheck_skipped: "recheck skipped without user acceptance",
        verdict_repair_owner_missing:
          "original implementer unavailable in failed step dependencies",
      };
  const title =
    actor === "user"
      ? zh
        ? "计划已按你的要求停止：正在跑的步骤已中止，已完成的交付物保留。"
        : "Plan stopped as you asked: running steps were aborted; completed deliverables are kept."
      : zh
        ? `计划已停止：${reasons[reason] ?? "需要检查执行状态"}。请检查步骤交付与预算后决定下一步。`
        : `Plan stopped: ${reasons[reason] ?? "execution needs review"}. Review step deliveries and limits before continuing.`;
  const stepTitle = planStepTitles(workflowOf(record).contract.steps, language);
  const unfinished = steps.filter((step) => !["passed", "skipped"].includes(step.status));
  return [
    title,
    ...verdictFailureLines(progressOf(record), zh, stepTitle),
    zh ? "未完成步骤：" : "Unfinished steps:",
    ...unfinished.map((step) => `- ${stepTitle(step.stepId)}`),
  ].join("\n");
}
