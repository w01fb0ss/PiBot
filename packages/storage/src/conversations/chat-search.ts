import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { ReadMessagesSearchInput } from "@pibot/protocol-base";
import { readTransaction } from "../database/database.ts";
import { ChatSearchIndex } from "./chat-search-index.ts";
import { visibleImportedRows } from "./conversations.ts";
import { readableTaskResult } from "./read-messages.ts";

export type ChatSearchScope = { botId: string } | { botId: string; groupId: string };

const SHORT_QUERY_BATCH = 64;
const FTS_DIRECT_LIMIT = 400;
const scopeFilter = `
  EXISTS(SELECT 1 FROM bots b WHERE b.id=$bot AND b.archived_at IS NULL)
  AND c.internal_task_id IS NULL AND ${visibleImportedRows("c.import_id")}
  AND (($group IS NULL AND c.kind='dm' AND c.bot_id=$bot AND (m.role='user' OR m.bot_id=$bot))
    OR ($group IS NOT NULL AND c.kind='group' AND c.group_id=$group
      AND EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=$group
        AND gm.bot_id=$bot AND gm.left_at IS NULL)))
  AND m.status='done' AND m.role IN ('user','assistant')
  AND ${readableTaskResult}
`;
const messageJoin = `JOIN messages m ON m.id=d.message_id
  JOIN conversations c ON c.id=m.conversation_id`;
const from = `chat_search_documents d ${messageJoin}`;
type SearchValues = { $key: string; $bot: string; $group: string | null };
const literal = (text: string) => `"${text.replaceAll('"', '""')}"`;

/** A caller provides the trusted origin; indexed scope is an optimization, never authorization. */
export class ChatSearchRepo {
  constructor(private readonly db: DatabaseSync) {}

  async search(
    scope: ChatSearchScope,
    { query, limit = 10 }: ReadMessagesSearchInput,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const group = "groupId" in scope ? scope.groupId : null;
    const key = group ? `group:${group}` : `dm:${scope.botId}`;
    const values = { $key: key, $bot: scope.botId, $group: group };
    const indexed =
      Array.from(query).length < 3
        ? undefined
        : readTransaction(this.db, () => this.indexedMatches(values, query, limit));
    const ids = indexed ?? (await this.shortMatches(values, query, limit, signal));
    signal.throwIfAborted();
    if (!ids.length) return [];
    // Read the whole bounded, already sanitized projection so the caller can redact newly known
    // credentials before clipping. Recheck live visibility after the short query may have yielded.
    const rows = this.db
      .prepare(`SELECT m.id AS messageId,c.id AS conversationId,
        CASE WHEN length(CAST(c.title AS BLOB))>2000 THEN '' ELSE c.title END AS title,
        m.created_at AS createdAt,d.body,
        CASE WHEN m.import_id IS NOT NULL THEN c.import_source END AS importSource FROM ${from}
        WHERE d.scope=$key AND ${scopeFilter} AND d.rowid IN (${ids.map((_, i) => `$row${i}`).join(",")})
        ORDER BY m.created_at DESC,m.id DESC`)
      .all({
        ...values,
        ...Object.fromEntries(ids.map((row, i) => [`$row${i}`, row])),
      });
    signal.throwIfAborted();
    return indexed === undefined
      ? rows.filter(
          ({ body }) =>
            typeof body === "string" && body.toLowerCase().includes(query.toLowerCase()),
        )
      : rows;
  }

  private indexedMatches(values: SearchValues, query: string, limit: number) {
    if (new ChatSearchIndex(this.db).rebuilding()) return;
    const cap = Math.max(FTS_DIRECT_LIMIT, limit);
    const matched = this.db
      .prepare("SELECT rowid FROM chat_search_fts WHERE chat_search_fts MATCH $match LIMIT $cap")
      .all({
        $match: `scope:${literal(values.$key)} AND body:${literal(query)}`,
        $cap: cap + 1,
      }) as { rowid: number }[];
    if (!matched.length) return [];
    // A high-frequency term is cheaper to find via the scope's time-ordered index.
    if (matched.length > cap) return;
    const placeholders = matched.map((_, index) => `$r${index}`).join(",");
    return this.db
      .prepare(`SELECT d.rowid AS row FROM chat_search_documents d ${messageJoin}
        WHERE d.rowid IN (${placeholders}) AND d.scope=$key AND ${scopeFilter}
        ORDER BY m.created_at DESC,m.id DESC LIMIT $limit`)
      .all({
        ...values,
        ...Object.fromEntries(matched.map(({ rowid }, index) => [`$r${index}`, Number(rowid)])),
        $limit: limit,
      })
      .map(({ row }) => Number(row));
  }

  private async shortMatches(
    values: SearchValues,
    query: string,
    limit: number,
    signal: AbortSignal,
  ) {
    // Trigrams cannot match one or two code points. Walk the sanitized projection in small
    // scope-indexed pages, releasing the event loop between pages so cancellation can be delivered.
    const page = (seek: boolean) =>
      this.db.prepare(
        `SELECT d.rowid AS row,d.body,d.created_at AS at,d.message_id AS id FROM ${from}
       WHERE d.scope=$key AND d.body IS NOT NULL AND d.body<>'' AND ${scopeFilter}
       ${seek ? "AND (d.created_at,d.message_id)<($at,$id)" : ""}
       ORDER BY d.created_at DESC,d.message_id DESC LIMIT ${SHORT_QUERY_BATCH}`,
      );
    const needle = query.toLowerCase();
    const next = page(true);
    let cursor: { $at: string; $id: string } | undefined;
    const ids: number[] = [];
    while (ids.length < limit) {
      signal.throwIfAborted();
      const rows = cursor ? next.all({ ...values, ...cursor }) : page(false).all(values);
      for (const { row, body } of rows) {
        if (typeof body === "string" && body.toLowerCase().includes(needle)) ids.push(Number(row));
        if (ids.length === limit) break;
      }
      if (rows.length < SHORT_QUERY_BATCH || ids.length === limit) break;
      const last = rows.at(-1);
      cursor = { $at: String(last?.at), $id: String(last?.id) };
      await yieldToLoop(undefined, { signal });
    }
    return ids;
  }
}
