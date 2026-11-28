import { setTimeout as delay } from "node:timers/promises";
import { type Approval, RpcError, type Run } from "@pibot/protocol-base";
import {
  type ApprovalPause,
  ApprovalPausesRepo,
  MessagesRepo,
  RunRecoveryRepo,
} from "@pibot/storage";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import { RESUME_NOTE_CALLS, resumeNote } from "../continuation/resume-note.ts";
import { restoreWorkflow } from "../workflows/workflow-recovery.ts";
import { announceSuperseded, supersedePause } from "./approval-pause-settle.ts";
import { pauseMovedOn } from "./approval-supersede.ts";
import { retryDmRun } from "./retry-service.ts";

type ResumeAnswer = { ok: true; superseded?: true };
const SUPERSEDED: ResumeAnswer = { ok: true, superseded: true };

/**
 * The answer came after the conversation moved on, so no run can take it: the card closes as out
 * of date (a deny stays a deny) instead of failing on every click and keeping the inbox busy.
 */
function settleOutOfDate(
  service: GroupOrchestrationPort,
  id: string,
  decision: "allow" | "deny",
): ResumeAnswer {
  const { db, local, peer } = service.deps;
  const settled = supersedePause(db, local.approvals.audit, id, {
    actor: "user",
    decision,
    reasonCode: "approval_pause_superseded",
  });
  if (settled) {
    announceSuperseded(db, peer, [settled]);
    return SUPERSEDED;
  }
  // Another window or a newer run closed it first; that is the same outcome for this click.
  if (new ApprovalPausesRepo(db).get(id)?.superseded) return SUPERSEDED;
  throw new RpcError(-32602, "Approval already answered");
}

/** The decision and queue receipt commit together; failed preflight leaves the card actionable. */
export async function resumeApproval(
  service: GroupOrchestrationPort,
  id: string,
  decision: "allow" | "deny",
): Promise<ResumeAnswer> {
  const local = service.deps.local;
  const pauses = new ApprovalPausesRepo(service.deps.db);
  const approval = local.approvals.repo.get(id);
  const paused = pauses.get(id);
  if (!approval || !paused || approval.routineRunId)
    throw new RpcError(-32602, "Paused approval unavailable");
  if (paused.resumedRunId) {
    if (approval.status !== (decision === "allow" ? "allowed" : "denied"))
      throw new RpcError(-32602, "Approval already answered differently");
    return { ok: true as const };
  }
  // A card still on screen after a newer run or the startup cleanup closed it.
  if (paused.superseded) return SUPERSEDED;
  if (approval.status !== "pending") throw new RpcError(-32602, "Approval no longer pending");
  // Before waiting on the topic: a newer turn keeps it busy and would only time this click out.
  if (pauseMovedOn(service, approval)) return settleOutOfDate(service, id, decision);
  const signal = AbortSignal.any([service.signal, AbortSignal.timeout(25_000)]);
  while (service.deps.chat.topicBusy(approval.botId, String(approval.conversationId))) {
    await delay(100, undefined, { signal });
  }
  if (pauseMovedOn(service, approval)) return settleOutOfDate(service, id, decision);
  const run = service.runs.get(approval.runId);
  if (!run || run.status === "running" || run.status === "queued")
    throw new RpcError(-32011, "Approval pause is still draining");
  const persisted = new RunRecoveryRepo(service.deps.db).get(run.id)?.workflow;
  const workflow = persisted
    ? await restoreWorkflow(local.skills, run.botId, run.groupId ?? undefined, persisted)
    : undefined;
  // The workflow the run followed is gone or changed; resuming it is no longer possible.
  if (persisted && !workflow) return settleOutOfDate(service, id, decision);
  const durationMs = Math.max(0, Date.now() - Date.parse(paused.pausedAt));
  try {
    await resume(service, id, decision, { approval, paused, run, workflow, durationMs });
  } catch (error) {
    // The conversation can move on while the model is resolved; that answer is out of date.
    if (pauses.get(id)?.superseded) return SUPERSEDED;
    if (
      local.approvals.repo.get(id)?.status === "pending" &&
      !pauses.get(id)?.resumedRunId &&
      pauseMovedOn(service, approval)
    )
      return settleOutOfDate(service, id, decision);
    throw error;
  }
  if (local.approvals.repo.get(id)?.status !== (decision === "allow" ? "allowed" : "denied"))
    throw new RpcError(-32602, "Approval already answered differently");
  service.deps.peer.emit("approval.resolved", {
    id,
    status: decision === "allow" ? "allowed" : "denied",
    remembered: false,
  });
  service.deps.peer.emit("inbox.changed", {});
  return { ok: true as const };
}

/** Starts the resume run; the approval's answer commits in the same transaction as its insert. */
async function resume(
  service: GroupOrchestrationPort,
  id: string,
  decision: "allow" | "deny",
  source: {
    approval: Approval;
    paused: ApprovalPause;
    run: Run;
    workflow: Awaited<ReturnType<typeof restoreWorkflow>>;
    durationMs: number;
  },
) {
  const { approval, paused, run, workflow, durationMs } = source;
  const local = service.deps.local;
  const pauses = new ApprovalPausesRepo(service.deps.db);
  await retryDmRun(
    service,
    {
      botId: run.botId,
      conversationId: run.conversationId,
      failedRunId: run.id,
    },
    {
      root: local.tasks.budgetRoot(run),
      note:
        "The previous turn stopped before dispatch while waiting for an approval, not because the user denied it.\n" +
        resumeNote(
          local.toolJournal.repo.uncertain(run.id, RESUME_NOTE_CALLS),
          local.toolJournal.repo.uncertainCount(run.id),
          "approval",
        ),
      text: `继续暂停的审批步骤。用户现在${decision === "allow" ? "允许" : "拒绝"}了该操作；暂停了 ${Math.floor(durationMs / 1000)} 秒。重新请求该步骤，由程序重新核对权限。不要重复已完成或结果不明的操作。 / Resume the paused approval step. The user has now ${decision === "allow" ? "allowed" : "denied"} it after ${Math.floor(durationMs / 1000)} seconds. Request that operation again for current authorization; never replay completed or uncertain effects.`,
      ...(workflow ? { workflow } : {}),
      inserted: (runId) => {
        if (local.approvals.repo.get(id)?.status !== "pending")
          throw new RpcError(-32602, "Approval already answered");
        if (JSON.stringify(pauses.get(id)?.choice) !== JSON.stringify(paused.choice))
          throw new RpcError(-32602, "Approval choice changed");
        pauses.resumed(id, runId);
        if (!local.approvals.repo.resolve(id, decision === "allow" ? "allowed" : "denied"))
          throw new RpcError(-32602, "Approval already answered");
        local.approvals.audit.append({
          botId: run.botId,
          runId: run.id,
          kind: "approval.resolved",
          summary: "Paused approval answered / 暂停审批收到用户决定",
          detail: {
            approvalId: id,
            actor: "user",
            decision,
            durationMs,
            status: decision === "allow" ? "allowed" : "denied",
            reasonCode: "approval_pause_resumed",
            target: runId,
            ...(approval.videoModel
              ? { providerId: approval.videoModel.provider, modelId: approval.videoModel.id }
              : {}),
          },
        });
        const messages = new MessagesRepo(service.deps.db);
        const message = messages.get(approval.messageId);
        const usage = message?.usage;
        messages.update(approval.messageId, {
          usage: {
            ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {}),
            executionPause: { reason: "approval", summary: "", durationMs, resumedRunId: runId },
          },
        });
      },
    },
  );
}
