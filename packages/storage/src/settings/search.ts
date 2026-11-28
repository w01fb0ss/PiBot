import type { DatabaseSync } from "node:sqlite";
import { type KernelMethodResults, KernelMethods } from "@pibot/protocol-base";
import { z } from "zod";
import { BotsRepo } from "../bots/bots.ts";
import { ChatSearchIndex } from "../conversations/chat-search-index.ts";
import {
  type Conversation,
  ConversationsRepo,
  visibleImport,
  visibleImportedRows,
} from "../conversations/conversations.ts";
import { readTransaction } from "../database/database.ts";
import { GroupsRepo } from "../groups/groups.ts";

// One page may scan for at most this long, so a rare word in a large history answers with what it
// found so far plus a cursor instead of holding the brain; "load more" continues from there.
const PAGE_BUDGET_MS = 120;
const SCAN_CHUNK = 400;
/** Probe at most this many FTS hits before switching to newest-first indexed scan. */
const FTS_DIRECT_LIMIT = 400;
const SNIPPET_CHARS = 200;
const SNIPPET_LEAD = 40;
const RAW_WINDOW = 600;

const visible = `c.archived_at IS NULL AND c.internal_task_id IS NULL
  AND ${visibleImportedRows("c.import_id")}
  AND (c.bot_id IS NULL OR EXISTS(SELECT 1 FROM bots b WHERE b.id=c.bot_id AND b.archived_at IS NULL))`;
const order = "ORDER BY m.created_at DESC,m.rowid DESC";
const seek = "AND (m.created_at,m.rowid)<($at,$row)";

const CursorSchema = z.strictObject({ at: z.string().max(64), row: z.number().int() });
type Cursor = z.infer<typeof CursorSchema>;
type Position = { id: unknown; at: unknown; row: unknown };
type Scanned = Position & { hit: unknown };

const encode = ({ at, row }: Position) =>
  Buffer.from(JSON.stringify({ at: String(at), row: Number(row) })).toString("base64url");
function decode(cursor: string | undefined): Cursor | undefined {
  if (cursor === undefined) return undefined;
  // Only this repository issues cursors; a malformed one is a caller bug, reported as such.
  return CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
}

function trimSurrogateEdges(text: string, start: number, end: number) {
  let s = start;
  let e = end;
  if (s > 0 && text.charCodeAt(s) >= 0xdc00 && text.charCodeAt(s) <= 0xdfff) s--;
  if (e < text.length && text.charCodeAt(e - 1) >= 0xd800 && text.charCodeAt(e - 1) <= 0xdbff) e++;
  return [s, e] as const;
}

/** Bounded excerpt around the first match so large message bodies never cross RPC. */
function buildSnippet(content: string, query: string): string {
  const folded = content.toLowerCase();
  const needle = query.toLowerCase();
  const hit = folded.length === content.length ? folded.indexOf(needle) : -1;
  const rawStart = hit >= 0 ? Math.max(0, hit - SNIPPET_LEAD * 2) : 0;
  const rawEnd = Math.min(content.length, rawStart + RAW_WINDOW);
  const [sliceStart, sliceEnd] = trimSurrogateEdges(content, rawStart, rawEnd);
  const cleaned = content
    .slice(sliceStart, sliceEnd)
    .replace(/```[^\n]*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length <= SNIPPET_CHARS) {
    return `${sliceStart > 0 ? "…" : ""}${cleaned}${sliceEnd < content.length ? "…" : ""}`;
  }
  const cFolded = cleaned.toLowerCase();
  const cHit = cFolded.length === cleaned.length ? cFolded.indexOf(needle) : -1;
  const winEnd = Math.min(
    cleaned.length,
    Math.max(0, (cHit >= 0 ? cHit : 0) - SNIPPET_LEAD) + SNIPPET_CHARS,
  );
  const winStart = Math.max(0, winEnd - SNIPPET_CHARS);
  const [s, e] = trimSurrogateEdges(cleaned, winStart, winEnd);
  const prefix = sliceStart > 0 || s > 0 ? "…" : "";
  const suffix = sliceEnd < content.length || e < cleaned.length ? "…" : "";
  return `${prefix}${cleaned.slice(s, e).trim()}${suffix}`;
}

export class SearchRepo {
  constructor(private readonly db: DatabaseSync) {}
  query(input: {
    query: string;
    limit?: number;
    cursor?: string;
  }): KernelMethodResults["search.query"] {
    const { query, limit = 50, cursor } = KernelMethods["search.query"].params.parse(input),
      pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const from = decode(cursor);
    const bots = new BotsRepo(this.db),
      groups = new GroupsRepo(this.db);
    // Chats are few and fully listed on the first page; later pages only continue the messages.
    const botRows = from
      ? []
      : this.db
          .prepare(
            "SELECT id FROM bots WHERE archived_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC,id DESC LIMIT ?",
          )
          .all(pattern, limit);
    const groupRows = from
      ? []
      : this.db
          .prepare(
            "SELECT id FROM groups WHERE name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC,id DESC LIMIT ?",
          )
          .all(pattern, limit);
    const topics = from
      ? []
      : this.db
          .prepare(
            `SELECT id FROM conversations c WHERE ${visible} AND kind IN ('dm','group') AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC,id DESC LIMIT ?`,
          )
          .all(pattern, limit);
    const page = readTransaction(this.db, () =>
      Array.from(query).length >= 3 && !new ChatSearchIndex(this.db).pending()
        ? this.indexed(query, pattern, limit, from)
        : this.scanned(pattern, limit, from),
    );
    const conversations = new ConversationsRepo(this.db),
      found = this.loadMessages(page.ids, query),
      pick = ({ id, kind, botId, groupId, title, importSource }: Conversation) => ({
        id,
        kind,
        botId,
        groupId,
        title,
        ...(importSource ? { importSource } : {}),
      });
    return {
      topics: topics
        .map((row) => conversations.get(String(row.id)))
        .filter((topic) => topic !== undefined)
        .map(pick),
      conversations: [...new Set(found.map((m) => m.conversationId))]
        .map((id) => conversations.get(id))
        .filter((conversation) => conversation !== undefined)
        .map(pick),
      bots: botRows.map((r) => bots.get(String(r.id))).filter((b) => b !== undefined),
      groups: groupRows.map((r) => groups.get(String(r.id))).filter((g) => g !== undefined),
      messages: found,
      nextCursor: page.next,
    };
  }

  private loadMessages(
    ids: string[],
    query: string,
  ): KernelMethodResults["search.query"]["messages"] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, import_id IS NOT NULL AS imported, conversation_id AS conversationId, role,
          content, status, run_id AS runId, error_code AS errorCode, bot_id AS botId,
          created_at AS createdAt, updated_at AS updatedAt
        FROM messages WHERE id IN (${placeholders}) AND ${visibleImport}`,
      )
      .all(...ids);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const schema = KernelMethods["search.query"].result.shape.messages.element;
    const found: KernelMethodResults["search.query"]["messages"] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) continue;
      const snippet = buildSnippet(String(row.content ?? ""), query);
      found.push(
        schema.parse({
          id: String(row.id),
          conversationId: String(row.conversationId),
          role: row.role,
          content: snippet,
          snippet,
          status: row.status,
          runId: row.runId,
          errorCode: row.errorCode,
          botId: row.botId,
          usage: null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          ...(row.imported === 1 ? { imported: true } : {}),
        }),
      );
    }
    return found;
  }

  /** Three or more characters: probe the trigram index with a cap before sorting by time. */
  private indexed(query: string, pattern: string, limit: number, from: Cursor | undefined) {
    const cap = Math.max(FTS_DIRECT_LIMIT, limit + 1);
    const matched = this.db
      .prepare("SELECT rowid FROM chat_search_fts WHERE chat_search_fts MATCH $match LIMIT $cap")
      .all({
        $match: `body:"${query.replaceAll('"', '""')}"`,
        $cap: cap + 1,
      }) as { rowid: number }[];
    if (!matched.length) return { ids: [], next: null };
    // High-frequency term: avoid joining and temp-sorting tens of thousands of FTS hits;
    // the newest-first scan over the created_at index finds the top page in milliseconds.
    if (matched.length > cap) return this.scanned(pattern, limit, from);
    const placeholders = matched.map((_, index) => `$r${index}`).join(",");
    const rows = this.db
      .prepare(
        `SELECT m.id,m.created_at AS at,m.rowid AS row FROM chat_search_documents d
        JOIN messages m ON m.id=d.message_id JOIN conversations c ON c.id=m.conversation_id
        WHERE d.rowid IN (${placeholders}) AND ${visible} ${from ? seek : ""} ${order} LIMIT $limit`,
      )
      .all({
        ...Object.fromEntries(matched.map(({ rowid }, index) => [`$r${index}`, Number(rowid)])),
        $limit: limit + 1,
        ...(from ? { $at: from.at, $row: from.row } : {}),
      }) as Position[];
    const hits = rows.slice(0, limit);
    const last = hits.at(-1);
    return {
      ids: hits.map((r) => String(r.id)),
      next: rows.length > limit && last ? encode(last) : null,
    };
  }

  /**
   * One or two characters (trigrams cannot match them), or the index is still being built: walk
   * messages newest first in chunks within the page budget.
   */
  private scanned(pattern: string, limit: number, from: Cursor | undefined) {
    const first = this.db.prepare(
      `SELECT m.id,m.created_at AS at,m.rowid AS row,m.content LIKE $pattern ESCAPE '\\' AS hit
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE ${visible} ${order} LIMIT ${SCAN_CHUNK}`,
    );
    const next = this.db.prepare(
      `SELECT m.id,m.created_at AS at,m.rowid AS row,m.content LIKE $pattern ESCAPE '\\' AS hit
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE ${visible} ${seek} ${order} LIMIT ${SCAN_CHUNK}`,
    );
    const start = performance.now();
    const ids: string[] = [];
    let at: Position | undefined = from && { id: "", ...from };
    for (;;) {
      const rows = (
        at
          ? next.all({ $pattern: pattern, $at: String(at.at), $row: Number(at.row) })
          : first.all({ $pattern: pattern })
      ) as Scanned[];
      for (const row of rows) {
        if (ids.length === limit) {
          // A further match in what was already read proves there is more; stop at the last shown.
          if (row.hit) return { ids, next: at ? encode(at) : null };
          continue;
        }
        at = row;
        if (row.hit) ids.push(String(row.id));
      }
      if (rows.length < SCAN_CHUNK) return { ids, next: null };
      if (ids.length === limit || performance.now() - start >= PAGE_BUDGET_MS)
        return { ids, next: at ? encode(at) : null };
    }
  }
}
