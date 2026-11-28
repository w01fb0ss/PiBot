// Stuck approvals, runs, topics and background commands: each rule compares what the records
// say with what the owning service really holds right now (see live.ts).
import type { DatabaseSync } from "node:sqlite";
import { ConversationsRepo } from "@pibot/storage";
import { PI_HEALTH_GRACE_MS, PI_HEALTH_LONG_RUN_MS } from "@pibot/teams-contract";
import {
  type PendingApprovalRow,
  PiHealthScansRepo,
  type TopicHolderRow,
} from "../../store/pi-health.ts";
import { type DraftItem, fingerprint, type LiveState, olderThan } from "./live.ts";

/**
 * One pending approval's verdict; undefined when it is fine (live, kept, or still resumable). A
 * paused card counts only when the paused-approval fix's own check says its run can never resume.
 */
export function approvalItem(
  row: PendingApprovalRow,
  live: LiveState,
  now: number,
): DraftItem | undefined {
  if (live.approvals.has(row.id) || row.kept) return undefined;
  const reason = row.paused
    ? live.pauseMovedOn(row.id)
      ? "approval_superseded"
      : undefined
    : olderThan(row.createdAt, PI_HEALTH_GRACE_MS, now)
      ? "approval_no_waiter"
      : undefined;
  if (!reason) return undefined;
  return {
    id: `approval:${row.id}`,
    kind: "approval",
    reason,
    detail: row.category.replace(/[^a-z0-9_]/g, "_").slice(0, 64) || undefined,
    where: {
      botId: row.botId,
      ...(row.groupId ? { groupId: row.groupId } : {}),
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    },
    since: row.paused?.at ?? row.createdAt,
    actions: ["settle_approval"],
    state: fingerprint("approval", row.id, "pending", reason),
  };
}

export function approvalItems(db: DatabaseSync, live: LiveState, now: number): DraftItem[] {
  return new PiHealthScansRepo(db)
    .pendingApprovals()
    .flatMap((row) => approvalItem(row, live, now) ?? []);
}

/**
 * Runs the records call queued or running that no queue entry owns (a worker that crashed or was
 * killed, or hand-edited state), and runs with a live worker that have gone on far too long.
 */
export function runItems(db: DatabaseSync, live: LiveState, now: number): DraftItem[] {
  return new PiHealthScansRepo(db).activeRuns().flatMap((run): DraftItem[] => {
    const owned = live.runs.has(run.id);
    const since = run.startedAt ?? run.createdAt;
    if (owned && !(run.status === "running" && olderThan(since, PI_HEALTH_LONG_RUN_MS, now)))
      return [];
    if (!owned && !olderThan(run.createdAt, PI_HEALTH_GRACE_MS, now)) return [];
    const reason = owned
      ? "run_long_running"
      : run.status === "queued"
        ? "run_queued_stuck"
        : "run_no_worker";
    return [
      {
        id: `run:${run.id}`,
        kind: "run",
        reason,
        where: {
          botId: run.botId,
          conversationId: run.conversationId,
          ...(run.groupId ? { groupId: run.groupId } : {}),
        },
        since,
        actions: ["stop_run"],
        liveWorker: owned,
        state: fingerprint("run", run.id, run.status, run.startedAt, owned),
      },
    ];
  });
}

/**
 * A holder of a topic's busy state that nothing live stands behind. A paused approval that can
 * still resume, a send draft and a parked routine are waiting for the person on purpose.
 */
function deadHolder(
  holder: TopicHolderRow,
  live: LiveState,
  approvals: Map<string, PendingApprovalRow>,
): boolean {
  if (holder.kind === "run") return !live.runs.has(holder.id);
  if (holder.kind === "subtask") return !holder.runId || !live.runs.has(holder.runId);
  if (holder.kind === "background") return !live.background(holder.id);
  const approval = approvals.get(holder.id);
  if (!approval || live.approvals.has(approval.id) || approval.kept) return false;
  return !approval.paused || live.pauseMovedOn(approval.id);
}

/** Topics that refuse new messages from their records while nothing live holds them. */
export function topicItems(db: DatabaseSync, live: LiveState, now: number): DraftItem[] {
  const scans = new PiHealthScansRepo(db);
  const approvals = new Map(scans.pendingApprovals().map((row) => [row.id, row]));
  const byTopic = new Map<string, TopicHolderRow[]>();
  for (const holder of scans.topicHolders()) {
    const list = byTopic.get(holder.conversationId) ?? [];
    list.push(holder);
    byTopic.set(holder.conversationId, list);
  }
  const conversations = new ConversationsRepo(db);
  return [...byTopic].flatMap(([conversationId, holders]): DraftItem[] => {
    const topic = conversations.get(conversationId);
    if (!topic || topic.archivedAt || conversations.isInternal(conversationId)) return [];
    if (live.conversations.has(conversationId) || (topic.groupId && live.groups.has(topic.groupId)))
      return [];
    if (!holders.every((holder) => deadHolder(holder, live, approvals))) return [];
    // A dead run, approval or background command is listed as its own item; the topic is its own
    // item when a sub-task keeps it busy (what makes a private chat refuse new messages), since
    // nothing else names that one.
    if (!holders.some((holder) => holder.kind === "subtask")) return [];
    const newest = holders
      .map((holder) => holder.at)
      .sort()
      .at(-1);
    if (!olderThan(newest, PI_HEALTH_GRACE_MS, now)) return [];
    const ids = holders.map((holder) => `${holder.kind}:${holder.id}`).sort();
    return [
      {
        id: `topic:${conversationId}`,
        kind: "topic",
        reason: "topic_busy_no_run",
        detail: `holders_${Math.min(holders.length, 99)}`,
        where: {
          ...(topic.botId ? { botId: topic.botId } : {}),
          ...(topic.groupId ? { groupId: topic.groupId } : {}),
          conversationId,
          ...(topic.title ? { title: topic.title } : {}),
        },
        since: holders.map((holder) => holder.at).sort()[0] ?? null,
        actions: ["release_topic"],
        state: fingerprint("topic", conversationId, ids),
      },
    ];
  });
}

/** Background commands still listed as running whose job this process does not own. */
export function backgroundItems(db: DatabaseSync, live: LiveState, now: number): DraftItem[] {
  return new PiHealthScansRepo(db).runningBackground().flatMap((row): DraftItem[] =>
    live.background(row.id) || !olderThan(row.startedAt, PI_HEALTH_GRACE_MS, now)
      ? []
      : [
          {
            id: `background:${row.id}`,
            kind: "background",
            reason: "background_process_gone",
            where: {
              botId: row.botId,
              ...(row.groupId ? { groupId: row.groupId } : {}),
              ...(row.conversationId ? { conversationId: row.conversationId } : {}),
            },
            since: row.startedAt,
            actions: ["background_forget"],
            state: fingerprint("background", row.id, row.status, row.startedAt),
          },
        ],
  );
}
