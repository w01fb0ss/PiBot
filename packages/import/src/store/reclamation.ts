import type { DatabaseSync } from "node:sqlite";
import { ChatSearchIndex } from "@pibot/storage/chat-search-index";
import { transaction } from "@pibot/storage/transactions";
import type { CleanupRequest, CleanupResponse } from "./cleanup-messages.ts";

const DELETE_RECORDS = 128;
const DELETE_WORK_MS = 12;

export class ImportReclamation {
  private readonly db: DatabaseSync;
  private readonly index: ChatSearchIndex;
  private deleteMessage?: ReturnType<DatabaseSync["prepare"]>;
  private deleteTopic?: ReturnType<DatabaseSync["prepare"]>;
  private detachTopic?: ReturnType<DatabaseSync["prepare"]>;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.index = new ChatSearchIndex(db);
  }

  run(request: Exclude<CleanupRequest, { kind: "close" }>): CleanupResponse {
    switch (request.kind) {
      case "import":
        return { kind: "import", finish: this.page(request.id) };
      case "search":
        transaction(this.db, () => this.index.rebuildBatch());
        return { kind: "search" };
      case "attachments":
        return { kind: "attachments", ...this.attachmentFiles(request.id, request.after) };
      case "sessions": {
        const { cursor, ids } = this.sessionTopics(request.id, request.after);
        return { kind: "sessions", cursor, ids, files: this.sessionFiles(ids) };
      }
      case "clearSessions":
        this.clearSessions(request.ids);
        return { kind: "clearSessions" };
    }
  }

  /** Seek through messages even when the batch has few attachment files. */
  private attachmentFiles(id: string, after: number) {
    const rows = this.db
      .prepare(`SELECT m.rowid AS cursor,
          COALESCE(a.owner_bot_id, m.bot_id, (SELECT bot_id FROM conversations WHERE id=m.conversation_id)) AS botId,
          a.path, a.text_path
        FROM (SELECT rowid,id,bot_id,conversation_id FROM messages WHERE import_id=? AND rowid>?
          ORDER BY rowid LIMIT ?) m LEFT JOIN attachments a ON a.message_id=m.id
        ORDER BY m.rowid`)
      .all(id, after, DELETE_RECORDS);
    return {
      cursor: rows.length ? Number(rows.at(-1)?.cursor) : undefined,
      files: rows.flatMap(({ botId, path, text_path }) =>
        [path, text_path].flatMap((value) =>
          typeof value === "string" ? [{ path: value, botId: String(botId) }] : [],
        ),
      ),
    };
  }

  private sessionTopics(id: string, after: number) {
    const topics = this.db
      .prepare(
        "SELECT rowid,id FROM conversations WHERE import_id=? AND rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(id, after, DELETE_RECORDS);
    return {
      cursor: topics.length ? Number(topics.at(-1)?.rowid) : undefined,
      ids: topics.map(({ id }) => String(id)),
    };
  }

  private sessionFiles(topics: string[]) {
    if (!topics.length) return [];
    return this.db
      .prepare(`WITH topics AS (
        SELECT id,bot_id FROM conversations WHERE id IN (${topics.map(() => "?").join(",")})
      )
      SELECT topics.bot_id AS botId, c.pi_session_file AS file FROM topics JOIN conversations c USING (id)
        WHERE c.pi_session_file IS NOT NULL
      UNION SELECT t.bot_id,r.session_file FROM topics t JOIN runs r ON r.conversation_id=t.id
        WHERE r.session_file IS NOT NULL
      UNION SELECT t.bot_id,s.pi_session_file FROM topics t JOIN bot_sessions s ON s.conversation_id=t.id
      UNION SELECT t.bot_id,b.session_file FROM topics t JOIN messages m ON m.conversation_id=t.id
        JOIN conversation_retry_boundaries b ON b.message_id=m.id`)
      .all(...topics)
      .map((row) => ({ botId: String(row.botId), file: String(row.file) }));
  }

  private clearSessions(topics: string[]) {
    if (!topics.length) return;
    transaction(this.db, () => {
      const scope = topics.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE conversations SET pi_session_file=NULL WHERE id IN (${scope}) AND pi_session_file IS NOT NULL`,
        )
        .run(...topics);
      this.db
        .prepare(`DELETE FROM bot_sessions WHERE conversation_id IN (${scope})`)
        .run(...topics);
      this.db
        .prepare(
          `UPDATE runs SET session_file=NULL WHERE session_file IS NOT NULL AND conversation_id IN (${scope})`,
        )
        .run(...topics);
      this.db
        .prepare(`DELETE FROM conversation_retry_boundaries WHERE message_id IN (
        SELECT id FROM messages WHERE conversation_id IN (${scope}))`)
        .run(...topics);
    });
  }

  private page(id: string) {
    return transaction(this.db, () => {
      if (
        !this.db
          .prepare("SELECT 1 FROM import_jobs WHERE id=? AND cleanup_phase IS NOT NULL")
          .get(id)
      )
        throw new Error("import_cleanup_missing");
      if (!this.index.prepareImportCleanup(id)) return false;
      const messages = this.deleteMessages(id);
      const topics = messages === 0 ? this.removeTopics(id) : undefined;
      if (messages || topics?.processed) {
        this.db
          .prepare(`UPDATE import_jobs SET removed_messages=removed_messages+?,
          removed_topics=removed_topics+? WHERE id=?`)
          .run(messages, topics?.removed ?? 0, id);
        return false;
      }
      return true;
    });
  }

  private deleteMessages(id: string) {
    const rows = this.db
      .prepare("SELECT rowid FROM messages WHERE import_id=? ORDER BY rowid LIMIT ?")
      .all(id, DELETE_RECORDS);
    this.deleteMessage ??= this.db.prepare("DELETE FROM messages WHERE rowid=?");
    const start = performance.now();
    let removed = 0;
    for (const { rowid } of rows) {
      this.deleteMessage.run(Number(rowid));
      removed++;
      if (performance.now() - start >= DELETE_WORK_MS) break;
    }
    return removed;
  }

  private removeTopics(id: string) {
    const rows = this.db
      .prepare(`SELECT rowid,
        EXISTS(SELECT 1 FROM messages WHERE conversation_id=conversations.id) AS continued
        FROM conversations WHERE import_id=? ORDER BY rowid LIMIT ?`)
      .all(id, DELETE_RECORDS);
    this.deleteTopic ??= this.db.prepare("DELETE FROM conversations WHERE rowid=?");
    this.detachTopic ??= this.db.prepare("UPDATE conversations SET import_id=NULL WHERE rowid=?");
    const start = performance.now();
    let processed = 0;
    let removed = 0;
    for (const { rowid, continued } of rows) {
      // Live messages and the original topic identity survive undo.
      if (continued) this.detachTopic.run(Number(rowid));
      else {
        this.deleteTopic.run(Number(rowid));
        removed++;
      }
      processed++;
      if (performance.now() - start >= DELETE_WORK_MS) break;
    }
    return { processed, removed };
  }
}
