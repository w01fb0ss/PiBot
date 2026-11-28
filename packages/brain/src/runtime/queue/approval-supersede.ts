import { recoverableChatRun } from "@pibot/protocol-base";
import {
  ApprovalPausesRepo,
  BotsRepo,
  ConversationsRepo,
  MessagesRepo,
  type OpenApprovalPause,
  type SupersededPause,
} from "@pibot/storage";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import { announceSuperseded, supersedePause, unreadableRow } from "./approval-pause-settle.ts";
import { eventBackedRun } from "./retry-service.ts";

/**
 * Whether a paused approval's run can never be resumed: the facts `retryDmRun` /
 * `retryGroupTaskRun` refuse on for good (a later run in the conversation; the run, its reply,
 * the conversation, the Bot, the group membership or the task gone, closed or changed; a newer
 * group cycle). A busy topic, a run still draining and a paused or changing group pass again
 * later, so they are not "moved on" and keep today's retry.
 */
export function pauseMovedOn(
  service: GroupOrchestrationPort,
  approval: Pick<OpenApprovalPause, "botId" | "runId" | "messageId">,
): boolean {
  try {
    return movedOn(service, approval);
  } catch (error) {
    if (unreadableRow(error)) return true;
    throw error;
  }
}

function movedOn(
  service: GroupOrchestrationPort,
  approval: Pick<OpenApprovalPause, "botId" | "runId" | "messageId">,
) {
  const { db } = service.deps;
  const run = service.runs.get(approval.runId);
  if (!run || run.botId !== approval.botId || run.messageId !== approval.messageId) return true;
  if (run.status === "queued" || run.status === "running" || run.status === "waiting") return false;
  if (service.runs.hasRunAfter(run.id)) return true;
  // A status flipped by hand no longer matches the run's own terminal event.
  if (!recoverableChatRun(run) || !eventBackedRun(service, run.id, run.botId, run.conversationId))
    return true;
  const bot = new BotsRepo(db).get(run.botId);
  if (!bot || bot.archivedAt) return true;
  const conversations = new ConversationsRepo(db);
  const conversation = conversations.get(run.conversationId);
  if (!conversation || conversation.archivedAt || conversations.isInternal(conversation.id))
    return true;
  const message = new MessagesRepo(db).get(run.messageId);
  if (
    !message ||
    message.runId !== run.id ||
    message.botId !== run.botId ||
    message.conversationId !== run.conversationId
  )
    return true;
  if (!run.groupId)
    return conversation.kind !== "dm" || conversation.botId !== run.botId || run.kind !== "chat";
  const group = service.groups.get(run.groupId);
  if (
    !group ||
    group.archivedAt ||
    group.topicArchivedAt ||
    conversation.groupId !== group.id ||
    !group.members.some((member) => member.botId === run.botId)
  )
    return true;
  const task = run.taskId ? service.tasks.get(run.taskId) : undefined;
  if (run.taskId && (!task || task.groupId !== group.id || task.status !== "open")) return true;
  if (
    run.kind === "group_task" &&
    (task?.threadConversationId !== run.conversationId || task.assigneeBotId !== run.botId)
  )
    return true;
  // A task whose failure still names this run is retried even across cycles.
  return (
    run.cycleId !== service.cycles.get(group.id).cycleId &&
    task?.activity?.failure?.runId !== run.id
  );
}

/**
 * Startup: pauses earlier versions left open although their run can never resume (the bug that
 * kept a card and the group's "waiting for you" forever), including rows another tool edited by
 * hand. Each one settles in its own transaction; one that cannot be read or written is counted
 * and left, so startup always goes on and the next start tries again. Logs counts only.
 */
export function settleStalePauses(service: GroupOrchestrationPort) {
  const { db, local, logger, peer } = service.deps;
  const repo = new ApprovalPausesRepo(db);
  let after = "";
  let settled = 0;
  let failed = 0;
  for (let pages = 0; pages < 1_000; pages++) {
    let page: OpenApprovalPause[];
    try {
      page = repo.open(after, 100);
    } catch {
      // The table itself cannot be read; the cards stay as they were and startup continues.
      failed++;
      break;
    }
    const closed: SupersededPause[] = [];
    for (const pause of page) {
      try {
        if (!pauseMovedOn(service, pause)) continue;
        const result = supersedePause(db, local.approvals.audit, pause.approvalId, {
          actor: "system",
          reasonCode: "approval_pause_superseded_on_start",
        });
        if (result) closed.push(result);
      } catch {
        // One damaged row must not stop the others or startup; it is retried next start.
        failed++;
      }
    }
    settled += closed.length;
    announceSuperseded(db, peer, closed);
    const last = page.at(-1);
    if (page.length < 100 || !last) break;
    after = last.approvalId;
  }
  if (settled || failed)
    logger[failed ? "warn" : "info"](
      JSON.stringify({ module: "approvals", event: "stale_pauses_settled", settled, failed }),
    );
}
