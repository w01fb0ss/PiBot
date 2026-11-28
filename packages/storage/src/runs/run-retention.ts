import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../database/database.ts";

export interface RunCleanupManifest {
  sessionFiles: string[];
  resultFiles: string[];
}

export interface RunRetentionBatch {
  runs: number;
  events: number;
  executions: number;
  cleanupKey: string | null;
}

export interface RunRetentionCandidates {
  runs: number;
  sessionFiles: string[];
  resultFiles: string[];
}

const TERMINAL = "'done','error','aborted'";
const BASE_CANDIDATE_WHERE = `r.status IN (${TERMINAL}) AND r.finished_at IS NOT NULL AND r.finished_at<?
  AND NOT EXISTS (SELECT 1 FROM routine_runs rr
    WHERE rr.run_id=r.id AND rr.status IN ('scheduled','running','waiting'))
  AND NOT EXISTS (SELECT 1 FROM continuation_intents ci WHERE ci.root_run_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM file_checkpoints checkpoint
    JOIN file_restore_operations restore ON restore.checkpoint_id=checkpoint.id
    WHERE checkpoint.run_id=r.id)`;

function values(rows: Record<string, unknown>[], key: string): string[] {
  return [...new Set(rows.map((row) => String(row[key])).filter(Boolean))];
}

/** Database half of explicit run retention. File deletion is owned by the brain after commit. */
export class RunRetentionRepo {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Read-only fixed-point preview of runs and unreferenced files eligible for cleanup before
   * `cutoff`, matching the multi-pass cleanup loop where removing child runs unlocks their parents.
   */
  estimateBefore(cutoff: string): RunRetentionCandidates {
    const parsed = new Date(cutoff);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== cutoff)
      throw new TypeError("Invalid cleanup cutoff");
    const baseIds = values(
      this.db.prepare(`SELECT r.id FROM runs r WHERE ${BASE_CANDIDATE_WHERE}`).all(cutoff),
      "id",
    );
    if (baseIds.length === 0) return { runs: 0, sessionFiles: [], resultFiles: [] };
    const baseSet = new Set(baseIds);
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of baseIds) inDegree.set(id, 0);
    const edges = this.db
      .prepare(
        `WITH base AS (SELECT r.id FROM runs r WHERE ${BASE_CANDIDATE_WHERE})
         SELECT DISTINCT blocked, blocker FROM (
           SELECT child.parent_run_id AS blocked, child.id AS blocker
             FROM runs child WHERE child.parent_run_id IN (SELECT id FROM base)
           UNION ALL
           SELECT child.after_run_id AS blocked, child.id AS blocker
             FROM runs child WHERE child.after_run_id IN (SELECT id FROM base)
           UNION ALL
           SELECT recovery.root_run_id AS blocked, recovery.run_id AS blocker
             FROM run_recovery recovery JOIN runs consumer ON consumer.id=recovery.run_id
             WHERE recovery.root_run_id IN (SELECT id FROM base) AND recovery.run_id<>recovery.root_run_id
           UNION ALL
           SELECT task.root_run_id AS blocked, task.run_id AS blocker
             FROM task_instances task JOIN runs consumer ON consumer.id=task.run_id
             WHERE task.root_run_id IN (SELECT id FROM base) AND task.run_id<>task.root_run_id
           UNION ALL
           SELECT te.root_run_id AS blocked, te.run_id AS blocker
             FROM tool_executions te JOIN runs consumer ON consumer.id=te.run_id
             WHERE te.root_run_id IN (SELECT id FROM base) AND te.run_id<>te.root_run_id
         )`,
      )
      .all(cutoff);
    for (const row of edges) {
      const blocked = String(row.blocked);
      const blocker = String(row.blocker);
      if (!baseSet.has(blocked)) continue;
      inDegree.set(blocked, (inDegree.get(blocked) ?? 0) + 1);
      if (baseSet.has(blocker)) {
        const list = dependents.get(blocker);
        if (list) list.push(blocked);
        else dependents.set(blocker, [blocked]);
      }
    }
    const queue: string[] = [];
    for (const id of baseIds) {
      if (inDegree.get(id) === 0) queue.push(id);
    }
    const eligible: string[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor] as string;
      eligible.push(current);
      const waiting = dependents.get(current);
      if (!waiting) continue;
      for (const next of waiting) {
        const remaining = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, remaining);
        if (remaining === 0) queue.push(next);
      }
    }
    if (eligible.length === 0) return { runs: 0, sessionFiles: [], resultFiles: [] };
    const eligibleJson = JSON.stringify(eligible);
    const sessionFiles = values(
      this.db
        .prepare(
          `WITH eligible(id) AS (SELECT value FROM json_each(?))
           SELECT file FROM (
             SELECT session_file AS file FROM runs WHERE id IN (SELECT id FROM eligible) AND session_file IS NOT NULL
             UNION SELECT rr.session_file AS file FROM routine_runs rr
               WHERE rr.run_id IN (SELECT id FROM eligible) AND rr.session_file IS NOT NULL
             UNION SELECT b.session_file AS file FROM conversation_retry_boundaries b
               JOIN messages m ON m.id=b.message_id WHERE m.run_id IN (SELECT id FROM eligible)
           )
           EXCEPT SELECT pi_session_file FROM conversations WHERE pi_session_file IS NOT NULL
           EXCEPT SELECT pi_session_file FROM bot_sessions WHERE pi_session_file IS NOT NULL
           EXCEPT SELECT session_file FROM runs
             WHERE session_file IS NOT NULL AND id NOT IN (SELECT id FROM eligible)
           EXCEPT SELECT session_file FROM routine_runs
             WHERE session_file IS NOT NULL AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM eligible))
           EXCEPT SELECT b.session_file FROM conversation_retry_boundaries b
             JOIN messages m ON m.id=b.message_id
             WHERE m.run_id IS NULL OR m.run_id NOT IN (SELECT id FROM eligible)`,
        )
        .all(eligibleJson),
      "file",
    );
    const resultFiles = values(
      this.db
        .prepare(
          `WITH eligible(id) AS (SELECT value FROM json_each(?))
           SELECT json_extract(payload,'$.result.path') AS file
           FROM run_events
           WHERE json_type(payload,'$.result.path')='text'
           GROUP BY json_extract(payload,'$.result.path')
           HAVING COUNT(*)=SUM(CASE WHEN run_id IN (SELECT id FROM eligible) THEN 1 ELSE 0 END)`,
        )
        .all(eligibleJson),
      "file",
    );
    return { runs: eligible.length, sessionFiles, resultFiles };
  }

  cleanupBefore(cutoff: string, limit = 200): RunRetentionBatch {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new TypeError("Invalid cleanup limit");
    const parsed = new Date(cutoff);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== cutoff)
      throw new TypeError("Invalid cleanup cutoff");
    return transaction(this.db, () => {
      const ids = values(
        this.db
          .prepare(
            `SELECT r.id FROM runs r
             WHERE ${BASE_CANDIDATE_WHERE}
             AND NOT EXISTS (SELECT 1 FROM runs child
               WHERE child.parent_run_id=r.id OR child.after_run_id=r.id)
             AND NOT EXISTS (SELECT 1 FROM run_recovery recovery JOIN runs consumer ON consumer.id=recovery.run_id
               WHERE recovery.root_run_id=r.id AND recovery.run_id<>r.id)
             AND NOT EXISTS (SELECT 1 FROM task_instances task JOIN runs consumer ON consumer.id=task.run_id
               WHERE task.root_run_id=r.id AND task.run_id<>r.id)
             AND NOT EXISTS (SELECT 1 FROM tool_executions te JOIN runs consumer ON consumer.id=te.run_id
               WHERE te.root_run_id=r.id AND te.run_id<>r.id)
             ORDER BY r.finished_at,r.id LIMIT ?`,
          )
          .all(cutoff, limit),
        "id",
      );
      if (ids.length === 0) return { runs: 0, events: 0, executions: 0, cleanupKey: null };
      const slots = ids.map(() => "?").join(",");
      const sessionFiles = values(
        this.db
          .prepare(
            `SELECT session_file AS file FROM runs WHERE id IN (${slots}) AND session_file IS NOT NULL
             UNION SELECT rr.session_file AS file FROM routine_runs rr
               WHERE rr.run_id IN (${slots}) AND rr.session_file IS NOT NULL
             UNION SELECT b.session_file AS file FROM conversation_retry_boundaries b
               JOIN messages m ON m.id=b.message_id WHERE m.run_id IN (${slots})`,
          )
          .all(...ids, ...ids, ...ids),
        "file",
      );
      const resultFiles = values(
        this.db
          .prepare(
            `SELECT json_extract(payload,'$.result.path') AS file FROM run_events
             WHERE run_id IN (${slots}) AND json_type(payload,'$.result.path')='text'`,
          )
          .all(...ids),
        "file",
      );

      this.db
        .prepare(
          `DELETE FROM conversation_retry_boundaries WHERE message_id IN
             (SELECT id FROM messages WHERE run_id IN (${slots}))`,
        )
        .run(...ids);
      this.db.prepare(`UPDATE messages SET run_id=NULL WHERE run_id IN (${slots})`).run(...ids);
      this.db
        .prepare(
          `UPDATE routine_runs SET run_id=NULL,session_file=NULL,wait_checkpoint=NULL
           WHERE run_id IN (${slots})`,
        )
        .run(...ids);
      this.db
        .prepare(
          `DELETE FROM run_recovery WHERE run_id IN (${slots}) OR root_run_id IN (${slots})
           OR resumed_from IN (${slots})`,
        )
        .run(...ids, ...ids, ...ids);
      this.db
        .prepare(`DELETE FROM continuation_ledgers WHERE root_run_id IN (${slots})`)
        .run(...ids);
      for (const table of ["run_file_changes", "review_findings", "review_runs"])
        this.db.prepare(`DELETE FROM ${table} WHERE run_id IN (${slots})`).run(...ids);
      const executions = Number(
        this.db
          .prepare(
            `DELETE FROM tool_executions WHERE run_id IN (${slots}) OR root_run_id IN (${slots})`,
          )
          .run(...ids, ...ids).changes,
      );
      const events = Number(
        this.db.prepare(`DELETE FROM run_events WHERE run_id IN (${slots})`).run(...ids).changes,
      );
      const runs = Number(
        this.db.prepare(`DELETE FROM runs WHERE id IN (${slots})`).run(...ids).changes,
      );

      const manifest: RunCleanupManifest = {
        sessionFiles: sessionFiles.filter((file) => !this.sessionReferenced(file)),
        resultFiles: resultFiles.filter((file) => !this.resultReferenced(file)),
      };
      let cleanupKey: string | null = null;
      if (manifest.sessionFiles.length > 0 || manifest.resultFiles.length > 0) {
        cleanupKey = `run-cleanup:${randomUUID()}`;
        this.db
          .prepare("INSERT INTO settings(key,value) VALUES (?,?)")
          .run(cleanupKey, JSON.stringify(manifest));
      }
      return { runs, events, executions, cleanupKey };
    });
  }

  sessionReferenced(file: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM (
           SELECT pi_session_file AS file FROM conversations WHERE pi_session_file=?
           UNION ALL SELECT pi_session_file FROM bot_sessions WHERE pi_session_file=?
           UNION ALL SELECT session_file FROM runs WHERE session_file=?
           UNION ALL SELECT session_file FROM routine_runs WHERE session_file=?
           UNION ALL SELECT session_file FROM conversation_retry_boundaries WHERE session_file=?
         ) LIMIT 1`,
      )
      .get(file, file, file, file, file);
  }

  resultReferenced(file: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM run_events WHERE json_type(payload,'$.result.path')='text'
         AND json_extract(payload,'$.result.path')=? LIMIT 1`,
      )
      .get(file);
  }
}
