import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../database/transactions.ts";

export const CHAT_SEARCH_BATCH_SIZE = 128;
const BATCH_WORK_MS = 12;
const MAX_BODY_BYTES = 256 * 1024;
const MIN_BULK_CLEANUP_MESSAGES = 512;

/** A NULL body queues only the identity until the writer's credential redactor is ready. */
export function configureChatSearchRedactor(
  db: DatabaseSync,
  redact: (text: string) => string | null = () => null,
) {
  db.function("pibot_chat_search_redact", (value) => {
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_BODY_BYTES) return "";
    const body = redact(value);
    if (body === null) return null;
    // Never slice raw input before redaction; a cut credential might no longer be recognizable.
    return Buffer.byteLength(body) <= MAX_BODY_BYTES ? body.replaceAll("\0", " ") : "";
  });
}

export class ChatSearchIndex {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** One step of clearing the shared index before an already-hidden batch is deleted. */
  prepareImportCleanup(importId: string): boolean {
    const state = this.rebuildState();
    if (state?.phase === "clearing") {
      this.clearBatch();
      return false;
    }
    if (state?.phase === "deleting") return true;
    const covered = this.db
      .prepare("SELECT 1 FROM chat_search_pruned_imports WHERE import_id=?")
      .get(importId);
    if (covered) return true;
    if (state?.phase === "replaying") {
      this.replay(Number(state.after_id), Number(state.through_id));
      return false;
    }
    const large = this.db
      .prepare("SELECT 1 FROM messages WHERE import_id=? LIMIT 1 OFFSET ?")
      .get(importId, MIN_BULK_CLEANUP_MESSAGES - 1);
    if (!large) return true;

    this.db.exec("INSERT INTO chat_search_rebuild(id,phase) VALUES(1,'clearing')");
    return false;
  }

  /** Runs after all runnable cleanup, including when one of the imports is blocked. */
  rebuildBatch() {
    const state = this.rebuildState();
    if (!state) return;
    if (state.phase === "clearing") this.clearBatch();
    else if (state.phase === "deleting") {
      this.db.exec(`INSERT OR IGNORE INTO chat_search_pruned_imports(import_id)
        SELECT id FROM import_jobs WHERE cleanup_phase IS NOT NULL;
        UPDATE chat_search_rebuild SET phase='replaying',
          through_id=COALESCE((SELECT MAX(id) FROM chat_search_documents),0) WHERE id=1`);
    } else {
      this.replay(Number(state.after_id), Number(state.through_id));
    }
  }

  private rebuildState() {
    return this.db
      .prepare("SELECT phase,after_id,through_id FROM chat_search_rebuild WHERE id=1")
      .get();
  }

  private clearBatch() {
    // FTS5's delete-all clears these three shadow tables in one go. Drain their rows
    // while all FTS readers and writers are gated, then let FTS5 reset its metadata
    // (the averages and structure records at ids 1 and 10) on the same commit.
    // Keep the tables and configuration intact, including FTS5 secure-delete.
    // Older Node versions allow these writes by default.
    this.db.enableDefensive?.(false);
    try {
      for (const sql of [
        "DELETE FROM chat_search_fts_data WHERE id IN (SELECT id FROM chat_search_fts_data WHERE id>10 ORDER BY id LIMIT 64)",
        "DELETE FROM chat_search_fts_idx WHERE (segid,term) IN (SELECT segid,term FROM chat_search_fts_idx ORDER BY segid,term LIMIT 128)",
        "DELETE FROM chat_search_fts_docsize WHERE id IN (SELECT id FROM chat_search_fts_docsize ORDER BY id LIMIT 256)",
      ]) {
        if (this.db.prepare(sql).run().changes) return;
      }
    } finally {
      this.db.enableDefensive?.(true);
    }
    this.db.exec(`INSERT INTO chat_search_fts(chat_search_fts) VALUES('delete-all');
      UPDATE chat_search_rebuild SET phase='deleting' WHERE id=1`);
  }

  private replay(after: number, through: number) {
    const rows = this.db
      .prepare(
        `SELECT d.id AS cursor, d.body<>'' AND j.cleanup_phase IS NULL
          AND NOT EXISTS (SELECT 1 FROM chat_search_fts_docsize WHERE id=d.id) AS include
        FROM chat_search_documents d JOIN messages m ON m.id=d.message_id
        LEFT JOIN import_jobs j ON j.id=m.import_id
        WHERE d.id>? AND d.id<=? ORDER BY d.id LIMIT ?`,
      )
      .all(after, through, CHAT_SEARCH_BATCH_SIZE);
    const insert = this.db.prepare(`INSERT INTO chat_search_fts(rowid,scope,body)
      SELECT id,scope,body FROM chat_search_documents WHERE id=?`);
    const start = performance.now();
    let replayed = 0;
    for (const row of rows) {
      after = Number(row.cursor);
      if (row.include) insert.run(after);
      replayed++;
      if (performance.now() - start >= BATCH_WORK_MS) break;
    }
    if (replayed === rows.length && rows.length < CHAT_SEARCH_BATCH_SIZE)
      this.db.exec("DELETE FROM chat_search_rebuild WHERE id=1");
    else this.db.prepare("UPDATE chat_search_rebuild SET after_id=? WHERE id=1").run(after);
  }

  rebuilding(): boolean {
    return !!this.db.prepare("SELECT 1 FROM chat_search_rebuild").get();
  }

  backfillBatch(signal: AbortSignal): { done: boolean; scanned: number } {
    signal.throwIfAborted();
    return transaction(this.db, () => {
      const state = this.db
        .prepare("SELECT after_id,through_id FROM chat_search_backfill WHERE id=1")
        .get();
      if (!state) return this.drainPending(signal);
      const rows = this.db
        .prepare("SELECT id FROM messages WHERE id>? AND id<=? ORDER BY id LIMIT ?")
        .all(String(state.after_id), String(state.through_id), CHAT_SEARCH_BATCH_SIZE);
      const insert =
        this.db.prepare(`INSERT INTO chat_search_documents(message_id,scope,body,created_at)
        SELECT id,scope,pibot_chat_search_redact(content),created_at FROM chat_search_source
        WHERE id=? AND NOT EXISTS(SELECT 1 FROM chat_search_documents WHERE message_id=?)`);
      const start = performance.now();
      let scanned = 0;
      for (const { id } of rows) {
        signal.throwIfAborted();
        insert.run(String(id), String(id));
        scanned++;
        if (performance.now() - start >= BATCH_WORK_MS) break;
      }
      signal.throwIfAborted();
      if (scanned === rows.length && rows.length < CHAT_SEARCH_BATCH_SIZE)
        this.db.exec("DELETE FROM chat_search_backfill WHERE id=1");
      else
        this.db
          .prepare("UPDATE chat_search_backfill SET after_id=? WHERE id=1")
          .run(String(rows[scanned - 1]?.id ?? state.after_id));
      return { done: false, scanned };
    });
  }

  private drainPending(signal: AbortSignal) {
    const rows = this.db
      .prepare(
        "SELECT message_id FROM chat_search_documents WHERE body IS NULL ORDER BY message_id LIMIT ?",
      )
      .all(CHAT_SEARCH_BATCH_SIZE);
    const update = this.db.prepare(`UPDATE chat_search_documents
      SET body=CASE WHEN EXISTS(SELECT 1 FROM chat_search_source WHERE id=?)
        THEN (SELECT pibot_chat_search_redact(content) FROM chat_search_source WHERE id=?) ELSE '' END
      WHERE message_id=? AND body IS NULL`);
    const start = performance.now();
    let scanned = 0;
    for (const { message_id } of rows) {
      signal.throwIfAborted();
      const id = String(message_id);
      update.run(id, id, id);
      scanned++;
      if (performance.now() - start >= BATCH_WORK_MS) break;
    }
    signal.throwIfAborted();
    return { done: scanned === rows.length && rows.length < CHAT_SEARCH_BATCH_SIZE, scanned };
  }

  pending(): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM chat_search_backfill
      UNION ALL SELECT 1 FROM chat_search_rebuild
      UNION ALL SELECT 1 FROM chat_search_documents WHERE body IS NULL LIMIT 1`)
      .get();
  }
}
