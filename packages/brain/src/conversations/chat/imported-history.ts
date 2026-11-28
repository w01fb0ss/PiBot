import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { InitialHistoryMessage } from "@pibot/agent";
import { z } from "zod";
import type { BrainRedactor } from "../../core/privacy.ts";

const parts = z.array(
  z.object({
    kind: z.enum(["call", "result", "attachment"]),
    name: z.string(),
    summary: z.string().optional(),
  }),
);
const attachmentNames = z.array(z.string());

export async function initialImportedHistory(
  db: DatabaseSync,
  conversationId: string,
  beforeMessageId: string,
  redactor: BrainRedactor,
  signal: AbortSignal,
) {
  const oneLine = (text: string) =>
    redactor
      .redact(text)
      .replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
      .trim()
      .slice(0, 160);
  const messages: InitialHistoryMessage[] = [];
  const page = db.prepare(`SELECT m.rowid AS cursor, m.role, m.content, m.created_at AS createdAt,
    m.import_id IS NOT NULL AS imported, m.import_history_parts AS parts,
    (SELECT json_group_array(name) FROM (SELECT name FROM attachments WHERE message_id=m.id ORDER BY rowid)) AS attachments
    FROM messages m WHERE m.conversation_id=? AND m.rowid>?
      AND (m.import_id IS NOT NULL OR m.rowid<COALESCE((SELECT rowid FROM messages WHERE id=?),m.rowid))
      AND m.status='done' AND m.role IN ('user','assistant')
      AND m.routine_trigger IS NULL AND json_extract(m.usage,'$.systemEvent') IS NOT 1
    ORDER BY m.rowid LIMIT 64`);
  // Imported rows were inserted in transcript order. Replay only live messages before this turn.
  let cursor = 0;
  for (;;) {
    signal.throwIfAborted();
    const rows = page.all(conversationId, cursor, beforeMessageId);
    for (const row of rows) {
      cursor = Number(row.cursor);
      const imported = row.imported === 1;
      const lines = [redactor.redact(String(row.content))];
      if (imported) {
        const saved = row.parts ? parts.parse(JSON.parse(String(row.parts))) : [];
        for (const part of saved) {
          const name = oneLine(part.name);
          lines.push(
            part.kind === "attachment"
              ? `[Attachment: ${name}]`
              : `[Tool ${part.kind}: ${name}] ${oneLine(part.summary ?? "")}`.trimEnd(),
          );
        }
      }
      const names = attachmentNames.parse(JSON.parse(String(row.attachments)));
      lines.push(...names.map((name) => `[Attachment: ${oneLine(name)}]`));
      const text = lines.filter(Boolean).join("\n");
      if (text && (row.role === "user" || row.role === "assistant"))
        messages.push({ role: row.role, text, createdAt: String(row.createdAt), imported });
    }
    if (rows.length < 64) return messages;
    await yieldToLoop(undefined, { signal });
  }
}
