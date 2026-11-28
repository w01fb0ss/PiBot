// pi_repair: one fixed action on one item of a check the person saw. The item is checked again
// right before acting and refused when it changed; the action itself is always the owning
// service's own path (the same one the app's buttons or startup recovery use).
import type { LocalToolResult } from "@pibot/agent";
import type { CapabilityContext, ToolRunContext } from "@pibot/brain/kit";
import {
  CONNECTION_HEALTH_PORT,
  type ConnectionHealthPort,
  nextGroupRoundLimit,
  RpcError,
} from "@pibot/protocol";
import { RunsRepo } from "@pibot/storage";
import type { PiHealthItem, PiRepairAction } from "@pibot/teams-contract";
import { PiHealthScansRepo } from "../../store/pi-health.ts";
import { say } from "../manager/lookup.ts";
import { currentItem } from "./detect.ts";
import { listedReportItem, repairRequest, requestErrorText, tappedRepair } from "./request.ts";

type Outcome = "fixed" | "state_changed" | "failed" | "unavailable";
interface Done {
  outcome: Outcome;
  code: string;
  /** Short fixed code for the item's state afterwards (audit). */
  after?: string;
}

const STALE: Done = { outcome: "state_changed", code: "state_changed" };

export function parseItemId(id: string) {
  const [type = "", first = "", second] = id.split(":");
  return { type, first, second };
}

/** Known GroupToolError / RpcError guard texts mapped to stable snake codes instead of `refused`. */
const KNOWN_REFUSALS = new Map<string, { outcome?: Outcome; code: string }>([
  ["这个群里没有该任务 / The task is not in this group.", { code: "task_not_in_group" }],
  ["Group contains archived Bot; update members first", { code: "group_has_archived_member" }],
  ["Unknown group", { outcome: "state_changed", code: "group_not_found" }],
  ["Bot is not a member", { code: "bot_not_in_group" }],
  ["Wrong group conversation", { code: "wrong_group_conversation" }],
  [
    "只能完成分派给你自己的任务 / You may only finish tasks assigned to you.",
    { code: "task_not_owned" },
  ],
  [
    "只有本群统筹可以取消任务 / Only this group's coordinator may cancel a task.",
    { code: "coordinator_required" },
  ],
  [
    "子任务仍在进行，请等待后再完成父任务 / Subtasks are still active. Wait before completing the parent task.",
    { code: "task_has_pending_children" },
  ],
  [
    "成员任务或执行子任务仍在进行，请等待成果后再完成父任务 / Member assignments or execution subtasks are still active. Wait for their results before completing the parent task.",
    { code: "task_has_pending_children" },
  ],
  [
    "请选择该成员已在本群发出的回复 / Select a reply delivered by this member in this group.",
    { code: "invalid_task_result" },
  ],
  [
    "你在这个群没有未完成的任务 / You have no open task in this group.",
    { outcome: "state_changed", code: "no_open_task" },
  ],
  ["No open task / 没有未完成任务", { outcome: "state_changed", code: "no_open_task" }],
  ["Task busy", { outcome: "state_changed", code: "task_busy" }],
  ["Group changing", { outcome: "state_changed", code: "group_changing" }],
  ["Wrong task completion identity", { code: "wrong_task_identity" }],
]);

/** A fixed code for a service refusal; never its free text (it may carry names or paths). */
function refusalCode(error: unknown): Done {
  if (error instanceof RpcError) {
    const message = error.message;
    const known = KNOWN_REFUSALS.get(message);
    if (known)
      return {
        outcome: known.outcome ?? (error.code === -32011 ? "state_changed" : "failed"),
        code: known.code,
      };
    const prefixed = message.match(/^([a-z][a-z0-9_]{0,63}):\s/)?.[1];
    if (
      /unavailable|changed|no longer|already|Recovery source|stale|not pending/i.test(message) ||
      error.code === -32011
    )
      return {
        outcome: "state_changed",
        code: /^[a-z_]{1,64}$/.test(message) ? message : (prefixed ?? "state_changed"),
      };
    return {
      outcome: "failed",
      code: /^[a-z_]{1,64}$/.test(message) ? message : (prefixed ?? "refused"),
    };
  }
  if (error instanceof Error && error.name === "AbortError")
    return { outcome: "failed", code: "aborted" };
  return { outcome: "failed", code: "internal" };
}

/**
 * One card through the kernel's own settle paths: a pause whose run can never resume closes
 * through the paused-approval fix, a card no live run waits on expires like startup recovery.
 * Each re-checks its own condition and refuses (false) a card that can be answered again.
 */
function settleApproval(ctx: CapabilityContext, id: string, paused: boolean): boolean {
  return paused ? ctx.approvalRepair.settlePause(id) : ctx.approvalRepair.expireOrphan(id);
}

/**
 * Cards of this run that nothing waits on once it stopped. A paused card is left alone unless its
 * run can never resume: the person may still answer it and resume the run.
 */
function settleLeftApprovals(ctx: CapabilityContext, runId: string) {
  for (const row of new PiHealthScansRepo(ctx.db).pendingApprovals())
    if (row.runId === runId && !row.kept)
      if (!row.paused || ctx.approvalRepair.pauseMovedOn(row.id))
        settleApproval(ctx, row.id, !!row.paused);
}

async function stopRun(ctx: CapabilityContext, runId: string, signal: AbortSignal): Promise<Done> {
  if (ctx.chat.queue.owns(runId)) await ctx.chat.userStop(runId);
  else if ((await ctx.chat.queue.stopOrphan(runId)) === "live") await ctx.chat.userStop(runId);
  signal.throwIfAborted();
  settleLeftApprovals(ctx, runId);
  const after = new RunsRepo(ctx.db).get(runId)?.status ?? "missing";
  return { outcome: "fixed", code: "stopped", after };
}

/** Every dead holder of a topic through its own owner; the topic is free once none is left. */
async function releaseTopic(
  ctx: CapabilityContext,
  conversationId: string,
  signal: AbortSignal,
): Promise<Done> {
  const scans = new PiHealthScansRepo(ctx.db);
  const holders = scans.topicHolders().filter((row) => row.conversationId === conversationId);
  const runs = new RunsRepo(ctx.db);
  const paused = new Map(scans.pendingApprovals().map((row) => [row.id, !!row.paused]));
  for (const holder of holders) {
    signal.throwIfAborted();
    if (holder.kind === "run") await ctx.chat.queue.stopOrphan(holder.id);
    else if (holder.kind === "background") await ctx.local.background.forgetGone(holder.id, signal);
    else if (holder.kind === "approval")
      settleApproval(ctx, holder.id, paused.get(holder.id) ?? false);
    else if (holder.runId) {
      const run = runs.get(holder.runId);
      // A sub-task ends with its run; a run that already ended only missed that bookkeeping.
      if (run && ["queued", "running"].includes(run.status))
        await ctx.chat.queue.stopOrphan(run.id);
      else if (run) ctx.local.tasks.settled(run);
    }
  }
  const remaining = scans.topicHolders().filter((row) => row.conversationId === conversationId);
  return remaining.length
    ? { outcome: "failed", code: "topic_still_busy", after: "busy" }
    : { outcome: "fixed", code: "released", after: "free" };
}

async function planAction(
  ctx: CapabilityContext,
  item: PiHealthItem,
  action: PiRepairAction,
): Promise<Done> {
  const { type, first, second } = parseItemId(item.id);
  const groupId = item.where.groupId;
  if (!groupId || (type !== "plan" && type !== "step")) return STALE;
  const workflowRunId = first;
  const plan = ctx.groups.plan;
  if (action === "plan_stop") {
    const progress = plan.stop({ groupId, workflowRunId, confirmed: true });
    return { outcome: "fixed", code: "plan_stopped", after: progress.status };
  }
  if (action === "plan_continue" || (action === "plan_accept_as_is" && type === "plan")) {
    const progress = plan.choose({
      groupId,
      workflowRunId,
      choice: action === "plan_continue" ? "continue" : "accept",
      confirmed: true,
    });
    return { outcome: "fixed", code: "plan_chosen", after: progress.status };
  }
  if (type !== "step" || !second) return STALE;
  await plan.resolveStep({
    groupId,
    workflowRunId,
    stepId: second,
    action: action === "step_retry" ? "retry" : action === "step_skip" ? "skip" : "accept",
    confirmed: true,
  });
  return { outcome: "fixed", code: "step_resolved", after: action.replace("step_", "") };
}

async function act(
  ctx: CapabilityContext,
  context: ToolRunContext,
  item: PiHealthItem,
  action: PiRepairAction,
  signal: AbortSignal,
): Promise<Done> {
  const { first, second } = parseItemId(item.id);
  switch (action) {
    case "settle_approval":
      return settleApproval(ctx, first, item.reason === "approval_superseded")
        ? { outcome: "fixed", code: "settled", after: "settled" }
        : STALE;
    case "stop_run":
      return stopRun(ctx, first, signal);
    case "release_topic":
      return releaseTopic(ctx, first, signal);
    case "rounds_reset":
    case "rounds_raise": {
      const groupId = item.where.groupId;
      const expectedLimit = item.roundLimit;
      if (!groupId || groupId !== first || !second || expectedLimit === undefined) return STALE;
      const autoRoundLimit =
        action === "rounds_raise" ? nextGroupRoundLimit(expectedLimit) : undefined;
      if (action === "rounds_raise" && autoRoundLimit === undefined) return STALE;
      signal.throwIfAborted();
      await ctx.groups.continueRounds({
        groupId,
        roundLimitId: second,
        expectedLimit,
        autoRoundLimit,
      });
      return { outcome: "fixed", code: "rounds_continued", after: "resumed" };
    }
    case "task_close": {
      if (!item.where.groupId) return STALE;
      await ctx.groups.plan.closeStaleTask({
        groupId: item.where.groupId,
        taskId: first,
        summary: say(
          context.language,
          "你让 Pi 关闭了这个很久没有动静的任务。",
          "Closed by Pi on your request: it had been idle for a long time.",
        ),
      });
      return { outcome: "fixed", code: "task_closed", after: "cancelled" };
    }
    case "connection_restart": {
      const port = ctx.ports.get<ConnectionHealthPort>(CONNECTION_HEALTH_PORT);
      const connection = port?.failedOne(first);
      if (!port) return { outcome: "unavailable", code: "connections_unavailable" };
      if (!connection) return STALE;
      await port.restart(first, connection.revision, signal);
      return { outcome: "fixed", code: "restarting", after: "starting" };
    }
    case "background_forget": {
      const result = await ctx.local.background.forgetGone(first, signal);
      return result === "forgotten"
        ? { outcome: "fixed", code: "forgotten", after: "stopped" }
        : { ...STALE, code: result === "live" ? "background_live" : "state_changed" };
    }
    default:
      return planAction(ctx, item, action);
  }
}

function audit(
  ctx: CapabilityContext,
  context: ToolRunContext,
  item: PiHealthItem,
  action: PiRepairAction,
  done: Done,
) {
  const { type, first, second } = parseItemId(item.id);
  try {
    ctx.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "pi.repaired",
      summary: `Pi repair ${action}: ${done.outcome} / Pi 修复卡住的状态`,
      detail: {
        // The person approved it on a card (or Pi's own level); Pi carried it out.
        actor: "user",
        reasonCode: action,
        // Names people read (already redacted); the ids sit in their own typed fields below.
        target: (
          [item.where.botName, item.where.groupName, item.where.title]
            .filter(Boolean)
            .join(" · ") || item.kind
        ).slice(0, 200),
        piRepair: {
          action,
          targetKind: type,
          before: item.reason,
          ...(done.after && /^[a-z_]{1,64}$/.test(done.after) ? { after: done.after } : {}),
          outcome: done.outcome,
        },
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(item.where.groupId ? { groupId: item.where.groupId } : {}),
        ...(type === "run" ? { childRunId: first } : {}),
        ...(type === "approval" ? { approvalId: first } : {}),
        ...(type === "task" ? { taskId: first } : {}),
        ...(type === "plan" || type === "step" ? { workflowRunId: first } : {}),
        ...(type === "step" && second ? { stepId: second } : {}),
        ...(type === "connection" ? { connectorId: first } : {}),
        ...(type === "background" ? { backgroundCommandId: first } : {}),
      },
    });
  } catch (error) {
    // The repair already happened; a failed audit write is logged and never reported as a failed
    // repair (same rule as Pi's management actions).
    ctx.logger.warn(
      JSON.stringify({
        module: "pi_health",
        event: "audit_failed",
        action,
        reason: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

export async function piRepair(
  ctx: CapabilityContext,
  context: ToolRunContext,
  input: unknown,
  signal: AbortSignal,
): Promise<LocalToolResult> {
  const language = context.language;
  const args = repairRequest(ctx, context, input);
  if ("error" in args) return { text: requestErrorText(language, args.error), isError: true };
  const found = listedReportItem(ctx, context, args.check, args.item, args.action);
  if (!found)
    return {
      text: say(
        language,
        "没有修 [health_item_unknown]：这一项不在这次体检结果里，或者没有这种修法。先重新体检。",
        "Not done [health_item_unknown]: that item is not in this check or has no such fix. Run the check again first.",
      ),
      isError: true,
    };
  const { repo, item } = found;
  const now = currentItem(ctx, item.id);
  let done: Done;
  if (!now || now.state !== item.state) done = STALE;
  else
    try {
      done = await act(ctx, context, item, args.action, signal);
    } catch (error) {
      done = refusalCode(error);
      if (done.outcome === "failed" && done.code === "internal")
        ctx.logger.error(
          JSON.stringify({
            module: "pi_health",
            event: "repair_failed",
            action: args.action,
            reason: error instanceof Error ? error.name : typeof error,
          }),
        );
    }
  audit(ctx, context, item, args.action, done);
  if (done.outcome !== "unavailable") {
    const resolution = {
      itemId: item.id,
      action: args.action,
      outcome: done.outcome,
      at: new Date().toISOString(),
    };
    const updatedMessages = new Set<string>();
    const messageId = repo.resolve(args.check, resolution);
    if (messageId) updatedMessages.add(messageId);
    // If a tapped turn re-checked before repairing, also update the original card the person tapped.
    const tapped = tappedRepair(ctx, context);
    if (tapped && tapped.check !== args.check && tapped.item === item.id) {
      const tappedMessageId = repo.resolve(tapped.check, resolution);
      if (tappedMessageId) updatedMessages.add(tappedMessageId);
    }
    for (const id of updatedMessages) ctx.peer.emit("teams.health.changed", { messageId: id });
  }
  ctx.peer.emit("inbox.changed", {});
  return resultText(language, args.action, done);
}

function resultText(language: "zh" | "en", action: PiRepairAction, done: Done): LocalToolResult {
  if (done.outcome === "fixed")
    return {
      text: say(language, `已修好 [${done.code}]`, `Fixed [${done.code}]`),
      summary: say(language, `修好了：${zhAction[action]}`, `Fixed: ${enAction[action]}`),
    };
  if (done.outcome === "state_changed")
    return {
      text: say(
        language,
        `没有修 [${done.code}]：状态已经变了，请重新体检。`,
        `Not done [${done.code}]: the state changed; run the check again.`,
      ),
      isError: true,
    };
  if (done.outcome === "unavailable")
    return {
      text: say(
        language,
        `没有修 [${done.code}]：这个版本还不能这样修这一项。请告诉用户在那个话题里直接处理，不要改数据文件。`,
        `Not done [${done.code}]: this version cannot fix this item that way yet. Tell the person to handle it in that topic; never edit data files.`,
      ),
      isError: true,
    };
  return {
    text: say(
      language,
      `没有修好 [${done.code}]。告诉用户原因代码，可以稍后重新体检再试。`,
      `Not fixed [${done.code}]. Tell the person the reason code; they can run the check again later.`,
    ),
    isError: true,
  };
}

const zhAction: Record<PiRepairAction, string> = {
  settle_approval: "收起审批卡",
  stop_run: "停止运行",
  release_topic: "放开话题",
  rounds_reset: "重新计数并继续原任务",
  rounds_raise: "调高上限并继续原任务",
  plan_continue: "按剩下的步骤继续",
  plan_accept_as_is: "按现状接受",
  plan_stop: "结束计划",
  step_retry: "重试这一步",
  step_skip: "跳过这一步",
  task_close: "关闭任务",
  connection_restart: "重新启动连接",
  background_forget: "去掉后台命令",
};
const enAction: Record<PiRepairAction, string> = {
  settle_approval: "settled the approval",
  stop_run: "stopped the run",
  release_topic: "freed the topic",
  rounds_reset: "reset the round count and continued the original work",
  rounds_raise: "raised the round limit and continued the original work",
  plan_continue: "continued the plan",
  plan_accept_as_is: "accepted as is",
  plan_stop: "ended the plan",
  step_retry: "retried the step",
  step_skip: "skipped the step",
  task_close: "closed the task",
  connection_restart: "restarted the connection",
  background_forget: "removed the background command",
};
