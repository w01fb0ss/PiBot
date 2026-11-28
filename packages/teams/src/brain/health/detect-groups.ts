// Group plans and steps waiting on the person, plans that say running with nobody working, long
// idle open tasks, and failed connections. Plans are read through the same projection as the
// inbox's 「等你处理」 and the plan's own progress, so a listed item is exactly what the card shows.
import type { CapabilityContext } from "@pibot/brain/kit";
import {
  CONNECTION_HEALTH_PORT,
  type ConnectionHealthPort,
  type GroupPlanProgress,
  GroupWorkflowDecisionSchema,
  nextGroupRoundLimit,
} from "@pibot/protocol";
import {
  BotsRepo,
  ConversationsRepo,
  GroupCyclesRepo,
  GroupPlansRepo,
  GroupsRepo,
  MessagesRepo,
} from "@pibot/storage";
import {
  PI_HEALTH_GRACE_MS,
  PI_HEALTH_IDLE_TASK_MS,
  type PiRepairAction,
} from "@pibot/teams-contract";
import { PiHealthScansRepo, type PlanRow } from "../../store/pi-health.ts";
import { type DraftItem, fingerprint, type LiveState, olderThan } from "./live.ts";

function progressOf(ctx: CapabilityContext, groupId: string, workflowRunId: string) {
  try {
    return ctx.groups.plan.progress({ groupId, workflowRunId });
  } catch {
    // A plan the engine cannot read any more is not one the person can act on from here.
    return undefined;
  }
}

const live = (progress: GroupPlanProgress) =>
  progress.status === "running" || progress.status === "waiting";

export function roundItems(ctx: CapabilityContext): DraftItem[] {
  const groups = new GroupsRepo(ctx.db);
  const cycles = new GroupCyclesRepo(ctx.db);
  const bots = new BotsRepo(ctx.db);
  return new PiHealthScansRepo(ctx.db).roundLimitedGroups().flatMap((groupId): DraftItem[] => {
    const group = groups.get(groupId);
    const cycle = cycles.get(groupId);
    if (!group || group.topicArchivedAt || !cycle.limited || !cycle.roundLimitId) return [];
    const mayContinue =
      !group.paused &&
      group.members.every(({ botId }) => {
        const bot = bots.get(botId);
        return bot && !bot.archivedAt;
      });
    const actions: PiRepairAction[] = mayContinue ? ["rounds_reset"] : [];
    if (mayContinue && nextGroupRoundLimit(group.autoRoundLimit) !== undefined)
      actions.push("rounds_raise");
    return [
      {
        id: `rounds:${group.id}:${cycle.roundLimitId}`,
        kind: "plan",
        reason: "round_limit_reached",
        where: { groupId: group.id, conversationId: group.conversationId },
        since: null,
        actions,
        roundLimit: group.autoRoundLimit,
        state: fingerprint(
          "rounds",
          cycle.cycleId,
          cycle.roundLimitId,
          group.conversationId,
          group.autoRoundLimit,
          mayContinue,
        ),
      },
    ];
  });
}

/** A plan card the inbox lists: a held started plan, a budget stop, or a card to confirm. */
function waitingPlanItem(ctx: CapabilityContext, row: PlanRow): DraftItem | undefined {
  const entry = new GroupPlansRepo(ctx.db).get(row.messageId);
  if (!entry) return undefined;
  const where = {
    groupId: row.groupId,
    conversationId: entry.message.conversationId,
    title: entry.card.plan.name,
  };
  if (entry.card.status !== "started")
    return {
      id: `plancard:${row.messageId}`,
      kind: "plan",
      reason: "plan_confirmation",
      detail: entry.card.status,
      where,
      since: row.at,
      actions: [],
      state: fingerprint("plancard", row.messageId, entry.card.status),
    };
  const progress = progressOf(ctx, row.groupId, entry.card.id);
  if (!progress) return undefined;
  const choice = live(progress) ? progress.choice?.kind : undefined;
  const actions: PiRepairAction[] =
    choice === "replan_limit"
      ? ["plan_continue", "plan_stop"]
      : choice === "fix_skipped"
        ? ["plan_accept_as_is", "plan_stop"]
        : [];
  return {
    id: `plan:${progress.workflowRunId}`,
    kind: "plan",
    reason:
      choice === "replan_limit"
        ? "plan_hold_replan_limit"
        : choice === "fix_skipped"
          ? "plan_hold_fix_skipped"
          : "plan_waiting_you",
    ...(choice ? {} : { detail: progress.stoppedReason ?? progress.status }),
    where,
    since: row.at,
    actions,
    state: fingerprint("plan", progress.workflowRunId, progress.status, choice ?? null),
  };
}

/** A blocked step's card, a manual review, or a plan-attempts limit (all 「等你处理」). */
function planActionItem(ctx: CapabilityContext, row: PlanRow): DraftItem | undefined {
  const message = new MessagesRepo(ctx.db).get(row.messageId);
  const usage = (message?.usage ?? {}) as Record<string, unknown>;
  const decision = GroupWorkflowDecisionSchema.safeParse(usage.groupWorkflowDecision);
  const base = { groupId: row.groupId, conversationId: message?.conversationId };
  if (!decision.success)
    return {
      id: `plancard:${row.messageId}`,
      kind: "plan",
      reason: "plan_waiting_you",
      detail: "plan_attempt_limit",
      where: base,
      since: row.at,
      actions: [],
      state: fingerprint("planlimit", row.messageId),
    };
  const d = decision.data;
  const progress = progressOf(ctx, row.groupId, d.workflowRunId);
  const step = progress?.steps.find((value) => value.stepId === d.stepId);
  const review = !!d.reviewSteps?.length;
  return {
    id: `step:${d.workflowRunId}:${d.stepId}`,
    kind: "plan",
    reason: review ? "plan_manual_review" : "plan_step_blocked",
    ...(d.reasonCode ? { detail: d.reasonCode.replace(/[^a-z0-9_]/g, "_").slice(0, 64) } : {}),
    where: { ...base, title: d.title },
    since: row.at,
    actions: review ? ["plan_accept_as_is", "plan_stop"] : ["step_retry", "step_skip", "plan_stop"],
    state: fingerprint(
      "step",
      d.workflowRunId,
      d.stepId,
      review ? "review" : (step?.status ?? null),
      step?.attempt ?? d.attempt,
    ),
  };
}

export function planItems(ctx: CapabilityContext, live: LiveState, now: number): DraftItem[] {
  const scans = new PiHealthScansRepo(ctx.db);
  const items = [
    ...scans.waitingPlans().flatMap((row) => waitingPlanItem(ctx, row) ?? []),
    ...scans.waitingPlanActions().flatMap((row) => planActionItem(ctx, row) ?? []),
  ];
  const listed = new Set(items.map((item) => item.id));
  // Plans the engine calls running with nothing ready, nobody running and no hold: the run that
  // drove them ended (a crash or an edited record) and nothing will move them on by itself.
  for (const row of scans.runningWorkflows()) {
    if (row.held || row.stepsReady > 0 || listed.has(`plan:${row.id}`)) continue;
    if (
      live.groups.has(row.groupId) ||
      scans.groupActiveRuns(row.groupId).some((id) => live.runs.has(id))
    )
      continue;
    if (!olderThan(row.updatedAt, PI_HEALTH_GRACE_MS, now)) continue;
    items.push({
      id: `plan:${row.id}`,
      kind: "plan",
      reason: "plan_running_no_worker",
      where: { groupId: row.groupId, title: row.groupName },
      since: row.updatedAt,
      actions: ["plan_stop"],
      state: fingerprint("plan", row.id, "running", row.updatedAt, row.stepsRunning),
    });
  }
  return items;
}

/** Matches `staleTaskTarget`: task_close is offered only when the cleanup path can close it. */
function canCloseStaleTask(
  conversations: ConversationsRepo,
  task: { groupId: string; threadConversationId: string },
): boolean {
  const thread = conversations.get(task.threadConversationId);
  if (
    thread?.kind !== "thread" ||
    thread.groupId !== task.groupId ||
    thread.archivedAt ||
    !thread.threadOf
  )
    return false;
  const topic = conversations.get(thread.threadOf);
  return topic?.kind === "group" && topic.groupId === task.groupId && !topic.archivedAt;
}

export function taskItems(ctx: CapabilityContext, live: LiveState, now: number): DraftItem[] {
  const before = new Date(now - PI_HEALTH_IDLE_TASK_MS).toISOString();
  const conversations = new ConversationsRepo(ctx.db);
  return new PiHealthScansRepo(ctx.db).idleTasks(before).flatMap((task): DraftItem[] => {
    if (live.conversations.has(task.threadConversationId)) return [];
    const closeable = canCloseStaleTask(conversations, task);
    return [
      {
        id: `task:${task.id}`,
        kind: "task",
        reason: "task_idle_open",
        where: {
          botId: task.assigneeBotId,
          groupId: task.groupId,
          conversationId: task.threadConversationId,
          title: task.title,
        },
        since: task.lastActivity,
        actions: closeable ? ["task_close"] : [],
        state: fingerprint("task", task.id, "open", task.lastActivity, closeable),
      },
    ];
  });
}

export function connectionItems(ctx: CapabilityContext): DraftItem[] {
  const port = ctx.ports.get<ConnectionHealthPort>(CONNECTION_HEALTH_PORT);
  return (port?.failed(50) ?? []).map((connection) => ({
    id: `connection:${connection.id}`,
    kind: "connection",
    reason: "connection_failed",
    ...(connection.detail && /^[a-z][a-z0-9_]{0,63}$/.test(connection.detail)
      ? { detail: connection.detail }
      : {}),
    where: { title: connection.name },
    since: connection.since,
    actions: ["connection_restart"],
    state: fingerprint("connection", connection.id, connection.revision, connection.detail),
  }));
}
