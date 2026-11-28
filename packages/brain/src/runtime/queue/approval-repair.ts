// The default Pi's repair of approvals nobody can answer, through the two paths that already
// settle them: the paused-approval fix (a pause whose run can never resume) and startup recovery
// (a card no live run waits on). Nothing here decides or writes approval state on its own.
import { ApprovalPausesRepo, ApprovalsRepo } from "@pibot/storage";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import { announceSuperseded, supersedePause } from "./approval-pause-settle.ts";
import { pauseMovedOn } from "./approval-supersede.ts";

export interface ApprovalRepairPort {
  /** An open paused card whose run can never resume (`pauseMovedOn`); false for anything else. */
  pauseMovedOn(approvalId: string): boolean;
  /** Settles such a pause as out of date (actor user, via Pi); false when it is no longer one. */
  settlePause(approvalId: string): boolean;
  /** Expires a pending card no live run waits on, like startup recovery; false otherwise. */
  expireOrphan(approvalId: string): boolean;
}

function openPause(groups: GroupOrchestrationPort, approvalId: string) {
  const { db } = groups.deps;
  const pause = new ApprovalPausesRepo(db).get(approvalId);
  const approval = new ApprovalsRepo(db).get(approvalId);
  if (!pause || pause.resumedRunId || pause.superseded || approval?.status !== "pending")
    return undefined;
  if (approval.routineRunId || approval.draft) return undefined;
  return { botId: approval.botId, runId: approval.runId, messageId: approval.messageId };
}

export function approvalRepair(groups: GroupOrchestrationPort): ApprovalRepairPort {
  const { db, local, peer } = groups.deps;
  return {
    pauseMovedOn(approvalId) {
      const pause = openPause(groups, approvalId);
      return !!pause && pauseMovedOn(groups, pause);
    },
    settlePause(approvalId) {
      // Checked again right here: a pause that can resume again is the person's to answer.
      const pause = openPause(groups, approvalId);
      if (!pause || !pauseMovedOn(groups, pause)) return false;
      const settled = supersedePause(db, local.approvals.audit, approvalId, {
        actor: "user",
        reasonCode: "approval_settled_by_pi",
      });
      if (!settled) return false;
      announceSuperseded(db, peer as Parameters<typeof announceSuperseded>[1], [settled]);
      return true;
    },
    expireOrphan: (approvalId) => local.approvals.expireOrphan(approvalId),
  };
}
