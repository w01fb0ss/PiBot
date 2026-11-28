// The brain-side sentences of Pi's health check (what the model reads, what the cards say). The
// list card in the app reads the same reasons from i18n (`piHealth.reason.*`).

import { nextGroupRoundLimit } from "@pibot/protocol";
import type { PiHealthReason, PiRepairAction } from "@pibot/teams-contract";
import { piHealthEn, piHealthZh } from "@pibot/teams-contract/i18n";
import type { Language } from "../manager/lookup.ts";

export function reasonText(reason: PiHealthReason, language: Language): string {
  const key = `piHealth.reason.${reason}` as const;
  return language === "zh" ? piHealthZh[key] : piHealthEn[key];
}

export function actionText(
  action: PiRepairAction,
  language: Language,
  roundLimit?: number,
): string {
  const strings = language === "zh" ? piHealthZh : piHealthEn;
  const raiseTo = roundLimit === undefined ? undefined : nextGroupRoundLimit(roundLimit);
  if (action === "rounds_raise" && raiseTo !== undefined)
    return strings["piHealth.roundsRaiseTo"].replace("{limit}", String(raiseTo));
  const key = `piHealth.action.${action}` as const;
  return strings[key];
}

/** What happens after "allow", and what cannot be taken back, for each fix. */
export const effects: Record<
  PiRepairAction,
  { zh: string; en: string; undo: { zh: string; en: string } }
> = {
  settle_approval: {
    zh: "把这张接不上的审批卡收起来（记为已过期），它后面的运行不会再继续这一步",
    en: "Settle this approval that can no longer continue (marked expired); its run will not continue that step",
    undo: {
      zh: "收起的卡不能再点允许；需要的话让 Bot 重新做",
      en: "A settled card cannot be allowed later; ask the Bot to redo it if needed",
    },
  },
  stop_run: {
    zh: "把这次运行记为「已停止」，它的审批卡一并收起",
    en: "Mark this run as stopped and settle its approvals",
    undo: {
      zh: "停止后不能接着这次运行继续，只能重新发消息或重试",
      en: "A stopped run cannot continue; send again or retry instead",
    },
  },
  release_topic: {
    zh: "停止这个话题里已经没有进程的运行、清掉没人等的审批和不在了的后台命令，让话题重新接消息",
    en: "Stop runs with no process, settle approvals nobody waits on and drop gone background commands, so the topic takes messages again",
    undo: {
      zh: "这些运行和审批不能再继续",
      en: "Those runs and approvals cannot continue afterwards",
    },
  },
  rounds_reset: {
    zh: "从零重新计数，继续本轮原来的任务和计划。",
    en: "Reset the counter to zero and continue this cycle's existing tasks and plans.",
    undo: { zh: "已执行的步骤会保留。", en: "Steps already performed are kept." },
  },
  rounds_raise: {
    zh: "保存新的回合上限，从零重新计数并继续本轮原来的任务和计划。",
    en: "Save the higher limit, reset the counter to zero and continue this cycle's existing tasks and plans.",
    undo: {
      zh: "已执行的步骤会保留，之后可在设置里改回上限。",
      en: "Steps already performed are kept. You can change the limit back in settings.",
    },
  },
  plan_continue: {
    zh: "按剩下的步骤继续，不再重新规划；还没通过的结论按现状保留",
    en: "Continue with the remaining steps without another replan; verdicts still failing stay as they are",
    undo: { zh: "继续后不能退回到这次选择之前", en: "Cannot go back to before this choice" },
  },
  plan_accept_as_is: {
    zh: "按现状接受，计划接着往下走",
    en: "Accept as is; the plan goes on",
    undo: { zh: "接受后这一项不会再修", en: "Once accepted it is not repaired again" },
  },
  plan_stop: {
    zh: "结束这个计划：停下还在跑的步骤，已经完成的步骤和产物都保留",
    en: "End this plan: stop the steps still running; finished steps and outputs are kept",
    undo: {
      zh: "结束的计划不能再继续，只能新开计划",
      en: "An ended plan cannot continue; start a new plan instead",
    },
  },
  step_retry: {
    zh: "让这一步的成员重新做一次",
    en: "Have the step's member do it again",
    undo: { zh: "重试会再花一次运行的费用", en: "A retry costs another run" },
  },
  step_skip: {
    zh: "跳过这一步，计划接着做后面的步骤",
    en: "Skip this step; the plan goes on with the next ones",
    undo: {
      zh: "跳过的步骤不会再做，依赖它的步骤可能拿不到产物",
      en: "A skipped step is not done; steps that depend on it may miss its output",
    },
  },
  task_close: {
    zh: "把这个任务关闭为「已取消」",
    en: "Close this task as cancelled",
    undo: {
      zh: "关闭后不能重新打开，只能再派一个新任务",
      en: "A closed task cannot be reopened; assign a new one instead",
    },
  },
  connection_restart: {
    zh: "重新启动这个连接，和「测试连接」一样",
    en: "Restart this connection, the same as Test connection",
    undo: { zh: "可以随时再试一次", en: "You can try again any time" },
  },
  background_forget: {
    zh: "确认进程已经不在后，把它从后台命令列表里去掉",
    en: "Once its process is confirmed gone, remove it from the background command list",
    undo: {
      zh: "去掉的是一条已经没有进程的记录",
      en: "Only a record with no process left is removed",
    },
  },
};
