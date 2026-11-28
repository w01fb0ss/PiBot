import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../database/database.ts";
import { RunEventsRepo } from "../runs/run-events.ts";

export interface ApprovalPause {
  approvalId: string;
  callHash: string;
  factsHash: string;
  pausedAt: string;
  resumedRunId: string | null;
  choice: unknown;
  /** Settled as out of date: closed without a resume, so no run will ever take its answer. */
  superseded: boolean;
}
/** A pause still waiting for its answer, with what decides whether its run can resume. */
export interface OpenApprovalPause {
  approvalId: string;
  botId: string;
  runId: string;
  messageId: string;
}
/** What a settled out-of-date pause touched, for the caller's audit entry and change events. */
export interface SupersededPause extends OpenApprovalPause {
  status: "expired" | "denied";
  conversationId: string | null;
  groupId: string | null;
  taskId: string | null;
}
// Draft (send-out) and routine cards keep their own recovery and are never settled here.
const OPEN = `p.resumed_run_id IS NULL AND p.consumed=0 AND a.status='pending'
  AND a.routine_run_id IS NULL AND NOT EXISTS(SELECT 1 FROM send_drafts d WHERE d.approval_id=a.id)`;

/** Digests bind a human answer to one re-evaluated operation, never to arbitrary session calls. */
export class ApprovalPausesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): ApprovalPause | undefined {
    const row = this.db
      .prepare(`SELECT approval_id AS approvalId,call_hash AS callHash,
      facts_hash AS factsHash,paused_at AS pausedAt,resumed_run_id AS resumedRunId,choice_json AS choice,
      consumed FROM chat_approval_pauses WHERE approval_id=?`)
      .get(id) as unknown as (Omit<ApprovalPause, "superseded"> & { consumed: number }) | undefined;
    if (!row) return undefined;
    const { consumed, ...pause } = row;
    return {
      ...pause,
      choice: typeof row.choice === "string" ? JSON.parse(row.choice) : undefined,
      superseded: consumed === 1 && row.resumedRunId === null,
    };
  }
  /** Open pauses after `after` in approval-id order: the page the startup cleanup re-checks. */
  open(after: string, limit: number): OpenApprovalPause[] {
    return this.db
      .prepare(`SELECT p.approval_id AS approvalId,a.bot_id AS botId,a.run_id AS runId,
      a.message_id AS messageId FROM chat_approval_pauses p JOIN approvals a ON a.id=p.approval_id
      WHERE p.approval_id>? AND ${OPEN} ORDER BY p.approval_id LIMIT ?`)
      .all(after, Math.min(Math.max(limit, 1), 200))
      .map((row) => ({
        approvalId: String(row.approvalId),
        botId: String(row.botId),
        runId: String(row.runId),
        messageId: String(row.messageId),
      }));
  }
  /**
   * Open pauses of runs before `runId` in its Bot and conversation: once a later run exists the
   * resume path refuses them for good (`hasRunAfter`). `resumedFrom` is the run a resume
   * continues; that resume answers its own pause. Starts from pending approvals (indexed).
   */
  earlier(runId: string, resumedFrom?: string): string[] {
    return this.db
      .prepare(`SELECT a.id FROM approvals a JOIN chat_approval_pauses p ON p.approval_id=a.id
      JOIN runs src ON src.id=a.run_id JOIN runs nxt ON nxt.id=?
      WHERE ${OPEN} AND src.bot_id=nxt.bot_id AND src.conversation_id=nxt.conversation_id
      AND src.rowid<nxt.rowid AND src.id<>? LIMIT 50`)
      .all(runId, resumedFrom ?? "")
      .map((row) => String(row.id));
  }
  /**
   * Closes a pause whose run can never resume because the conversation moved on: the approval
   * ends `expired` (`denied` when that was the answer) marked out of date, the pause can no longer
   * be resumed, and the reply's pause band says so. Plain JSON updates instead of the parsing
   * repositories, because rows another tool edited by hand may no longer parse. Undefined when
   * the approval was answered or settled meanwhile.
   */
  supersede(id: string, status: "expired" | "denied"): SupersededPause | undefined {
    return transaction(this.db, () => {
      const row = this.db
        .prepare(`SELECT a.bot_id AS botId,a.run_id AS runId,a.message_id AS messageId,
        a.conversation_id AS conversationId,r.group_id AS groupId,r.task_id AS taskId
        FROM chat_approval_pauses p JOIN approvals a ON a.id=p.approval_id
        LEFT JOIN runs r ON r.id=a.run_id WHERE p.approval_id=? AND ${OPEN}`)
        .get(id);
      if (!row) return undefined;
      const at = new Date().toISOString();
      this.db
        .prepare(`UPDATE approvals SET status=?,remembered=0,resolved_at=?,
        request=CASE WHEN json_valid(request) THEN json_set(request,'$.superseded',json('true')) ELSE request END
        WHERE id=? AND status='pending'`)
        .run(status, at, id);
      this.db
        .prepare("UPDATE chat_approval_pauses SET consumed=1,choice_json=NULL WHERE approval_id=?")
        .run(id);
      this.db
        .prepare(`UPDATE messages SET updated_at=?,usage=json_set(CASE WHEN json_valid(usage)
        AND json_type(usage)='object' THEN usage ELSE '{}' END,'$.executionPause',json(?)) WHERE id=?`)
        .run(
          at,
          JSON.stringify({ reason: "approval", summary: "", superseded: true }),
          String(row.messageId),
        );
      const conversationId = row.conversationId == null ? null : String(row.conversationId);
      if (conversationId)
        new RunEventsRepo(this.db).append({
          runId: String(row.runId),
          conversationId,
          kind: "approval.resolved",
          at,
          payload: { approvalId: id, status, remembered: false },
        });
      return {
        approvalId: id,
        botId: String(row.botId),
        runId: String(row.runId),
        messageId: String(row.messageId),
        conversationId,
        groupId: row.groupId == null ? null : String(row.groupId),
        taskId: row.taskId == null ? null : String(row.taskId),
        status,
      };
    });
  }
  pause(id: string, callHash: string, factsHash: string) {
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO chat_approval_pauses
        (approval_id,call_hash,facts_hash,paused_at) VALUES (?,?,?,?)`)
        .run(id, callHash, factsHash, new Date().toISOString());
      this.db.prepare("UPDATE approvals SET timeout_paused=1 WHERE id=?").run(id);
    });
  }

  choice(id: string, value: unknown) {
    const json = JSON.stringify(value);
    if (json.length > 16_384) throw new TypeError("approval_choice_too_large");
    this.db
      .prepare(`UPDATE chat_approval_pauses SET choice_json=? WHERE approval_id=?
      AND resumed_run_id IS NULL AND EXISTS(SELECT 1 FROM approvals a WHERE a.id=approval_id AND a.status='pending')`)
      .run(json, id);
  }
  clearChoice(id: string, value: unknown) {
    this.db
      .prepare(`UPDATE chat_approval_pauses SET choice_json=NULL
      WHERE approval_id=? AND choice_json=? AND resumed_run_id IS NULL`)
      .run(id, JSON.stringify(value));
  }
  takeChoice(runId: string, callId: string): unknown {
    const row = this.db
      .prepare(`SELECT approval_id AS id,choice_json AS choice FROM chat_approval_pauses
      WHERE resumed_run_id=? AND resumed_call_id=? AND consumed=1 AND choice_json IS NOT NULL`)
      .get(runId, callId);
    if (!row) return;
    this.db
      .prepare("UPDATE chat_approval_pauses SET choice_json=NULL WHERE approval_id=?")
      .run(String(row.id));
    return JSON.parse(String(row.choice));
  }
  resumed(id: string, runId: string) {
    const changed = this.db
      .prepare(`UPDATE chat_approval_pauses SET resumed_run_id=?
      WHERE approval_id=? AND resumed_run_id IS NULL`)
      .run(runId, id).changes;
    if (!changed) throw new Error("approval_resume_changed");
  }
  consume(
    runId: string,
    callHash: string,
    factsHash?: string,
    callId?: string,
  ): "allowed" | "denied" | undefined {
    const row = this.db
      .prepare(`SELECT p.approval_id AS id,a.status FROM chat_approval_pauses p
      JOIN approvals a ON a.id=p.approval_id WHERE p.resumed_run_id=? AND p.consumed=0
      AND a.status IN ('allowed','denied') AND p.call_hash=?
      AND (a.status='denied' OR p.facts_hash=?) LIMIT 1`)
      .get(runId, callHash, factsHash ?? "");
    if (!row) return;
    this.db
      .prepare(
        "UPDATE chat_approval_pauses SET consumed=1,resumed_call_id=? WHERE approval_id=? AND consumed=0",
      )
      .run(callId ?? null, String(row.id));
    return row.status === "allowed" ? "allowed" : "denied";
  }
}
