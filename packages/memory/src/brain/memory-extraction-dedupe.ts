// Keeps background extraction from repeating a write or proposal the topic already handled.
import type { DatabaseSync } from "node:sqlite";
import { normalizeMemory } from "@pibot/storage";

const OVERLAP = 0.6;
const RECENT = 50;

function bigrams(text: string) {
  const chars = Array.from(normalizeMemory(text).replace(/[\s\p{P}\p{S}]+/gu, ""));
  return new Set(chars.slice(0, -1).map((char, i) => char + chars[i + 1]));
}

/**
 * Overlap of the shorter text: extraction rephrases the Bot's own note ("报表输出到 out/…" vs
 * "report-tool 项目约定：月度报表输出到…"), so the strict duplicate check used for saved notes
 * misses it. A lower bar is safe here because it only drops a second card for the same topic.
 */
export function overlapping(a: string, b: string) {
  const left = bigrams(a);
  const right = bigrams(b);
  const smaller = Math.min(left.size, right.size);
  if (smaller < 4) return normalizeMemory(a) === normalizeMemory(b);
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / smaller >= OVERLAP;
}

/**
 * Check accepted writes on this reply and pending or rejected proposals in the topic.
 * Rejected proposals include undone writes, which extraction must not recreate.
 */
export function extractionRepeats(
  db: DatabaseSync,
  botId: string,
  conversationId: string,
  text: string,
  memoryId?: string,
  replyId?: string,
): "pending" | "applied" | "undone" | undefined {
  const rows = db
    .prepare(
      `SELECT p.status, p.text, p.memory_id AS memoryId, p.resolved_memory_id AS resolvedId, p.action
      FROM scoped_memory_proposals p JOIN messages m ON m.id=p.message_id
      WHERE m.conversation_id=? AND p.bot_id=?
        AND (p.status IN ('pending','rejected') OR (p.status='accepted' AND m.id=?))
        AND p.action IN ('add','update')
      ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`,
    )
    .all(conversationId, botId, replyId ?? null, RECENT);
  for (const row of rows) {
    // A waiting change or a write in this turn already handles that target.
    const sameTarget =
      !!memoryId &&
      ((row.status === "pending" && row.action === "update" && row.memoryId === memoryId) ||
        (row.status === "accepted" && row.resolvedId === memoryId));
    if (!sameTarget && !overlapping(String(row.text), text)) continue;
    return row.status === "accepted" ? "applied" : row.status === "pending" ? "pending" : "undone";
  }
  return undefined;
}
