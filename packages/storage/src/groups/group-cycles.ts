import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { GroupCycleSchema, HANDOFF_LIMIT } from "@pibot/protocol-base";
import { GroupsRepo } from "./groups.ts";

export class GroupCyclesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(groupId: string) {
    const row = this.db
      .prepare(
        "SELECT cycle_id AS cycleId,rounds,limited,handoffs,round_limit_id AS roundLimitId FROM group_cycles WHERE group_id=?",
      )
      .get(groupId);
    return GroupCycleSchema.parse(
      row
        ? { ...row, limited: row.limited === 1, roundLimitId: row.roundLimitId ?? undefined }
        : { cycleId: null, rounds: 0, limited: false, handoffs: 0 },
    );
  }
  reset(groupId: string) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO group_cycles(group_id,cycle_id,rounds,limited) VALUES (?,?,0,0)
        ON CONFLICT(group_id) DO UPDATE SET cycle_id=excluded.cycle_id,rounds=0,limited=0,
          handoffs=0,round_limit_id=NULL`,
      )
      .run(groupId, id);
    return id;
  }
  /**
   * One automatic step of this cycle. `free` (discussion: asks, replies, plain assignments) uses
   * the group's round limit; `handoff`
   * uses its own cap so a 3–4 stage pipeline is not cut off, while a looping one still stops.
   * A round-limit stop can be lifted while keeping this cycle's tasks and pending wakes.
   */
  consume(
    groupId: string,
    cycleId: string,
    kind: "free" | "handoff" = "free",
  ): "ok" | "stale" | "paused" | "limit" {
    const group = new GroupsRepo(this.db).get(groupId),
      cycle = this.get(groupId);
    if (!group || cycle.cycleId !== cycleId) return "stale";
    if (group.paused) return "paused";
    const exhausted =
      kind === "handoff"
        ? (cycle.handoffs ?? 0) >= HANDOFF_LIMIT
        : cycle.rounds >= group.autoRoundLimit;
    if (cycle.limited) return "limit";
    if (exhausted) {
      this.db
        .prepare("UPDATE group_cycles SET limited=1,round_limit_id=? WHERE group_id=?")
        .run(kind === "free" ? randomUUID() : null, groupId);
      return "limit";
    }
    this.db
      .prepare(
        kind === "handoff"
          ? "UPDATE group_cycles SET handoffs=handoffs+1 WHERE group_id=? AND cycle_id=?"
          : "UPDATE group_cycles SET rounds=rounds+1 WHERE group_id=? AND cycle_id=?",
      )
      .run(groupId, cycleId);
    return "ok";
  }
  continueRounds(groupId: string, roundLimitId: string) {
    return (
      this.db
        .prepare(`UPDATE group_cycles SET rounds=0,limited=0,round_limit_id=NULL
          WHERE group_id=? AND limited=1 AND round_limit_id=?`)
        .run(groupId, roundLimitId).changes > 0
    );
  }
  /** Stops the current cycle: a hand-off still unmet after its send-back waits for the user. */
  limit(groupId: string, cycleId: string) {
    return (
      this.db
        .prepare(
          "UPDATE group_cycles SET limited=1,round_limit_id=NULL WHERE group_id=? AND cycle_id=?",
        )
        .run(groupId, cycleId).changes > 0
    );
  }
  origin(taskId: string) {
    const row = this.db
      .prepare(
        "SELECT cycle_id,source_message_id,source_run_id,source_tool_call_id,finished_run_id,wake_claimed FROM group_task_origins WHERE task_id=?",
      )
      .get(taskId);
    return row
      ? {
          cycleId: String(row.cycle_id),
          sourceMessageId: String(row.source_message_id),
          sourceRunId: String(row.source_run_id),
          sourceToolCallId:
            row.source_tool_call_id === null ? null : String(row.source_tool_call_id),
          finishedRunId: row.finished_run_id === null ? null : String(row.finished_run_id),
          wakeClaimed: row.wake_claimed === 1,
        }
      : undefined;
  }
  bind(taskId: string, cycleId: string, messageId: string, runId: string, toolCallId?: string) {
    this.db
      .prepare(
        "INSERT INTO group_task_origins(task_id,cycle_id,source_message_id,source_run_id,source_tool_call_id) VALUES (?,?,?,?,?)",
      )
      .run(taskId, cycleId, messageId, runId, toolCallId ?? null);
  }
  remind(taskId: string, cycleId: string, messageId: string, runId: string, toolCallId: string) {
    const changed = this.db
      .prepare(
        `INSERT INTO group_task_origins(task_id,cycle_id,source_message_id,source_run_id,source_tool_call_id)
       SELECT ?,?,?,?,? FROM group_tasks WHERE id=? AND status='open'
       ON CONFLICT(task_id) DO UPDATE SET cycle_id=excluded.cycle_id,
       source_message_id=excluded.source_message_id,source_run_id=excluded.source_run_id,
       source_tool_call_id=excluded.source_tool_call_id,finished_run_id=NULL,wake_claimed=0`,
      )
      .run(taskId, cycleId, messageId, runId, toolCallId, taskId);
    if (!changed.changes) throw new TypeError("Task no longer open");
  }
  claimWake(taskId: string): boolean {
    return (
      this.db
        .prepare("UPDATE group_task_origins SET wake_claimed=1 WHERE task_id=? AND wake_claimed=0")
        .run(taskId).changes > 0
    );
  }
  continueTask(taskId: string, cycleId: string) {
    // Only an explicitly continued open task joins the current cycle; siblings stay untouched.
    this.db
      .prepare(`UPDATE group_task_origins SET cycle_id=? WHERE task_id=? AND wake_claimed=0
      AND EXISTS(SELECT 1 FROM group_tasks t WHERE t.id=task_id AND t.status='open')`)
      .run(cycleId, taskId);
  }
  recordFinish(taskId: string, runId: string) {
    this.db
      .prepare(
        "UPDATE group_task_origins SET finished_run_id=COALESCE(finished_run_id,?) WHERE task_id=? AND wake_claimed=0",
      )
      .run(runId, taskId);
  }
  pendingWakes(after = "", limit = 50, includePaused = false): string[] {
    return this.db
      .prepare(
        `SELECT o.task_id FROM group_task_origins o
       JOIN group_tasks t ON t.id=o.task_id
       JOIN group_cycles c ON c.group_id=t.group_id AND c.cycle_id=o.cycle_id
       JOIN groups g ON g.id=t.group_id
       WHERE o.wake_claimed=0 AND o.finished_run_id IS NOT NULL AND t.status='done'
         AND (? OR (g.paused=0 AND c.limited=0)) AND o.task_id>?
       ORDER BY o.task_id LIMIT ?`,
      )
      .all(includePaused ? 1 : 0, after, limit)
      .map((row) => String(row.task_id));
  }
}
