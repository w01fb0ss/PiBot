import type { DatabaseSync } from "node:sqlite";
import type { Memory, MemoryOwner } from "@pibot/protocol-base";

export const normalizeMemory = (text: string) =>
  text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** Usage is observation, not an edit. Omitted optional prose is stored as SQL NULL. */
export function sameMemoryRevision(a: Memory | null, b: Memory | null) {
  const revision = (value: Memory | null) => {
    if (!value) return null;
    const { lastUsedAt: _last, useCount: _count, archivedAt, why, how, ...rest } = value;
    return { ...rest, archivedAt: archivedAt ?? null, why: why ?? null, how: how ?? null };
  };
  return JSON.stringify(revision(a)) === JSON.stringify(revision(b));
}

export class SimilarMemoryError extends Error {
  /** Without a memory, the match is a proposal that is still waiting for the person. */
  constructor(readonly memory?: Memory) {
    super("memory_similar");
  }
}

function grams(text: string, width: number) {
  const chars = Array.from(text);
  return new Set(
    Array.from({ length: Math.max(0, chars.length - width + 1) }, (_, i) =>
      chars.slice(i, i + width).join(""),
    ),
  );
}

function similar(a: string, b: string) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 12) return false;
  // Small differences in numbers or negation are often contradictory preferences, not duplicates.
  const qualifiers = (s: string) =>
    JSON.stringify(
      s.match(
        /\d+(?:\.\d+)?|不|没|无|别|勿|未|非|不要|\b(?:not|no|never|without|don't|dislike)\b/gu,
      ) ?? [],
    );
  if (qualifiers(a) !== qualifiers(b)) return false;
  const left = grams(a, 2),
    right = grams(b, 2);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return (2 * shared) / (left.size + right.size) >= 0.94;
}

/** Bounded lexical candidates; filtering ownership in SQL prevents cross-scope disclosure. */
export function similarMemoryId(db: DatabaseSync, owner: MemoryOwner, text: string) {
  const normalized = normalizeMemory(text);
  const exact = db
    .prepare(
      "SELECT id FROM scoped_memories WHERE scope=? AND owner_id=? AND normalized_text=? ORDER BY id LIMIT 1",
    )
    .get(owner.scope, owner.ownerId, normalized);
  if (exact) return String(exact.id);
  const tokens = [...grams(normalized, 3)].filter((t) => !/[\s\p{P}\p{S}]/u.test(t));
  if (!tokens.length) return undefined;
  // Evenly sample long notes so the MATCH expression and ranking work stay bounded.
  const sample = tokens
    .filter((_, i) => i % Math.max(1, Math.ceil(tokens.length / 32)) === 0)
    .slice(0, 32);
  const query = sample.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
  const candidates = db
    .prepare(
      "SELECT m.id,m.text FROM memory_fts JOIN scoped_memories m ON m.rowid=memory_fts.rowid WHERE memory_fts MATCH ? AND m.scope=? AND m.owner_id=? ORDER BY memory_fts.rank,m.id LIMIT 24",
    )
    .all(query, owner.scope, owner.ownerId);
  return candidates.find((row) => similar(normalized, normalizeMemory(String(row.text))))?.id as
    | string
    | undefined;
}

/**
 * Two sources (the Bot's memory_add and background extraction, say) proposing the same new note
 * left two identical cards waiting; the second adds nothing the person has not been asked yet.
 */
export function similarPendingAdd(db: DatabaseSync, owner: MemoryOwner, text: string) {
  const normalized = normalizeMemory(text);
  return db
    .prepare(
      `SELECT text FROM scoped_memory_proposals WHERE scope=? AND owner_id=? AND status='pending'
      AND action='add' ORDER BY created_at DESC LIMIT 50`,
    )
    .all(owner.scope, owner.ownerId)
    .some((row) => similar(normalized, normalizeMemory(String(row.text))));
}

export function migrateMemorySearch(db: DatabaseSync) {
  const update = db.prepare("UPDATE scoped_memories SET normalized_text=? WHERE id=?");
  let cursor = "";
  for (;;) {
    const rows = db
      .prepare("SELECT id,text FROM scoped_memories WHERE id>? ORDER BY id LIMIT 100")
      .all(cursor);
    for (const row of rows) update.run(normalizeMemory(String(row.text)), String(row.id));
    if (rows.length < 100) break;
    cursor = String(rows.at(-1)?.id);
  }
}
