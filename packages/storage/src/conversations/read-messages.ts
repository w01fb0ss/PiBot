import type { DatabaseSync } from "node:sqlite";
import {
  type Attachment,
  AttachmentSchema,
  IdSchema,
  type ReadMessagesInput,
  ReadMessagesInputSchema,
} from "@pibot/protocol-base";
import { visibleImportedRows } from "./conversations.ts";

// Scope is applied in SQL, never by loading another Bot's history and filtering it afterwards.
const readable = `c.archived_at IS NULL AND c.internal_task_id IS NULL AND ${visibleImportedRows("c.import_id")} AND EXISTS(SELECT 1 FROM bots b WHERE b.id=$bot AND b.archived_at IS NULL)
  AND ((c.kind='dm' AND c.bot_id=$bot) OR (c.kind IN ('group','thread') AND
    EXISTS(SELECT 1 FROM groups g JOIN group_members gm ON gm.group_id=g.id
      WHERE g.id=c.group_id AND gm.bot_id=$bot AND gm.left_at IS NULL) AND
    (c.kind='group' OR EXISTS(SELECT 1 FROM conversations p JOIN group_tasks t
      ON t.group_id=p.group_id AND t.thread_conversation_id=c.id
      WHERE p.id=c.thread_of AND p.kind='group' AND p.group_id=c.group_id AND p.archived_at IS NULL))))`;

// Search and full history must agree even if the task's publication state changes after indexing.
export const readableTaskResult = `(m.task_result_id IS NULL OR EXISTS(
  SELECT 1 FROM group_tasks t JOIN group_task_results r ON r.task_id=t.id
  WHERE t.id=m.task_result_id AND r.message_id=m.id AND t.group_id=c.group_id
    AND t.assignee_bot_id=m.bot_id AND t.status='done'))`;

export class ReadMessagesRepo {
  constructor(private readonly db: DatabaseSync) {}

  caller(
    botId: string,
    runId: string,
    messageId: string,
    conversationId: string,
    groupId?: string,
    threadId?: string,
    parkedRoutineId?: string,
  ): boolean {
    const row = this.db
      .prepare(`SELECT c.kind,c.group_id,c.id FROM runs r JOIN messages m ON m.id=r.message_id
      JOIN conversations c ON c.id=r.conversation_id WHERE r.id=? AND r.bot_id=?
      AND (r.status='running' OR (r.status='waiting' AND r.kind='routine' AND EXISTS(
        SELECT 1 FROM unattended_runs rr WHERE rr.id=? AND rr.run_id=r.id AND rr.bot_id=r.bot_id
        AND rr.status IN ('waiting','scheduled') AND rr.owner_token IS NULL
        AND rr.decision_consumed_at IS NULL AND json_type(rr.wait_checkpoint,'$.drain')='object'
        AND json_extract(rr.wait_checkpoint,'$.messageId')=m.id
        AND json_extract(rr.wait_checkpoint,'$.conversationId')=c.id)))
      AND r.message_id=? AND c.id=? AND c.internal_task_id IS NULL AND ${visibleImportedRows("c.import_id")} AND m.role='assistant' AND m.status='streaming'
      AND m.bot_id=r.bot_id AND m.run_id=r.id AND m.conversation_id=c.id
      AND r.group_id IS c.group_id`)
      .get(runId, botId, parkedRoutineId ?? null, messageId, conversationId);
    return (
      !!row &&
      (row.kind === "dm"
        ? !groupId && !threadId
        : row.group_id === groupId && (row.kind === "thread" ? threadId === row.id : !threadId))
    );
  }

  scope(botId: string, conversationId: string): string | undefined {
    IdSchema.parse(botId);
    IdSchema.parse(conversationId);
    const row = this.db
      .prepare(`SELECT c.id,c.kind,c.bot_id,c.group_id,c.thread_of,
      (SELECT joined_at FROM group_members WHERE group_id=c.group_id AND bot_id=$bot AND left_at IS NULL) AS joined_at,
      (SELECT id||':'||assignee_bot_id FROM group_tasks WHERE thread_conversation_id=c.id AND group_id=c.group_id) AS task
      FROM conversations c WHERE c.id=$id AND ${readable}`)
      .get({ $bot: botId, $id: conversationId });
    return row ? JSON.stringify(row) : undefined;
  }

  conversations(
    botId: string,
    page: Pick<Extract<ReadMessagesInput, { mode: "list" }>, "before" | "limit">,
    signal: AbortSignal,
  ) {
    ReadMessagesInputSchema.parse({ ...page, mode: "list" });
    signal.throwIfAborted();
    if (page.before && !this.scope(botId, page.before))
      throw new TypeError("message_scope_unavailable");
    const rows = this.db
      .prepare(`SELECT c.id,c.kind,CASE WHEN length(CAST(c.title AS BLOB))>2000 THEN '' ELSE c.title END AS title,
      c.group_id AS groupId,c.thread_of AS threadOf,c.created_at AS createdAt,
      CASE WHEN c.import_id IS NOT NULL THEN c.import_source END AS importSource
      FROM conversations c WHERE c.id>$before AND ${readable} ORDER BY c.id LIMIT $limit`)
      .all({ $bot: botId, $before: page.before ?? "", $limit: (page.limit ?? 20) + 1 });
    signal.throwIfAborted();
    return rows;
  }

  messages(
    botId: string,
    conversationId: string,
    page: Pick<Extract<ReadMessagesInput, { mode: "list" }>, "before" | "limit">,
    signal: AbortSignal,
  ) {
    ReadMessagesInputSchema.parse({ ...page, mode: "messages", conversationId });
    signal.throwIfAborted();
    if (!this.scope(botId, conversationId)) throw new TypeError("message_scope_unavailable");
    const cursor = page.before
      ? this.db
          .prepare("SELECT created_at,rowid FROM messages WHERE id=? AND conversation_id=?")
          .get(page.before, conversationId)
      : undefined;
    if (page.before && !cursor) throw new TypeError("message_scope_unavailable");
    // Oversize bodies are omitted entirely, not sliced before secret redaction.
    const rows = this.db
      .prepare(`SELECT m.id,m.role,m.bot_id AS botId,m.created_at AS createdAt,
      CASE WHEN m.import_id IS NOT NULL THEN c.import_source END AS importSource,
      CASE WHEN length(CAST(m.content AS BLOB))>16000 THEN '' ELSE m.content END AS content,
      length(CAST(m.content AS BLOB))>16000 AS truncated FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.id=$id AND ${readable} AND m.status='done' AND m.role IN ('user','assistant')
      AND (c.kind<>'dm' OR m.role='user' OR m.bot_id=$bot)
      AND ${readableTaskResult}
      ${cursor ? "AND (m.created_at,m.rowid)<($at,$row)" : ""}
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT $limit`)
      .all({
        $bot: botId,
        $id: conversationId,
        ...(cursor ? { $at: cursor.created_at, $row: cursor.rowid } : {}),
        $limit: (page.limit ?? 50) + 1,
      });
    signal.throwIfAborted();
    return rows;
  }

  attachments(botId: string, conversationId: string, ids: string[]): Map<string, Attachment[]> {
    if (!ids.length) return new Map();
    if (ids.length > 50 || !this.scope(botId, conversationId))
      throw new TypeError("message_scope_unavailable");
    const slots = ids.map(() => "?").join(",");
    // Linked published group results expose metadata only from the same group and same author.
    const rows = this.db
      .prepare(`WITH refs AS (
      SELECT message_id, id AS attachment_id FROM attachments WHERE message_id IN (${slots})
      UNION SELECT message_id,attachment_id FROM message_attachment_links WHERE message_id IN (${slots})
    ) SELECT r.message_id,a.id,a.kind,a.name,
      CASE WHEN length(CAST(a.mime_type AS BLOB))>512 THEN 'application/octet-stream' ELSE a.mime_type END AS mimeType,a.size,a.width,a.height,
      a.truncated,a.sent_percent AS sentPercent FROM refs r JOIN messages target ON target.id=r.message_id
      JOIN conversations tc ON tc.id=target.conversation_id JOIN attachments a ON a.id=r.attachment_id
      JOIN messages source ON source.id=a.message_id JOIN conversations sc ON sc.id=source.conversation_id
      WHERE target.conversation_id=? AND target.import_id IS NULL AND (source.id=target.id OR (tc.group_id IS NOT NULL
        AND sc.group_id=tc.group_id AND source.bot_id=target.bot_id AND source.role='assistant'
        AND source.status='done' AND (sc.kind='group' OR (sc.kind='thread' AND EXISTS(
          SELECT 1 FROM conversations p JOIN group_tasks t ON t.thread_conversation_id=sc.id
          WHERE p.id=sc.thread_of AND p.kind='group' AND p.group_id=tc.group_id
            AND t.group_id=tc.group_id AND t.assignee_bot_id=source.bot_id)))))
      ORDER BY r.message_id,a.id LIMIT 250`)
      .all(...ids, ...ids, conversationId);
    const result = new Map<string, Attachment[]>();
    for (const row of rows) {
      const key = String(row.message_id),
        items = result.get(key) ?? [];
      if (items.length === 5) continue;
      items.push(
        AttachmentSchema.parse({
          id: row.id,
          kind: row.kind,
          name: row.name,
          mimeType: row.mimeType,
          size: row.size,
          ...(row.width == null ? {} : { width: row.width }),
          ...(row.height == null ? {} : { height: row.height }),
          truncated: row.truncated === 1,
          ...(row.sentPercent == null ? {} : { sentPercent: row.sentPercent }),
        }),
      );
      result.set(key, items);
    }
    return result;
  }
}
