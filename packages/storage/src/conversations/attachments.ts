import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Attachment, AttachmentSchema, MAX_GENERATED_IMAGES } from "@pibot/protocol-base";
import { isStoredAttachmentPath, resolveAttachmentPath } from "./attachment-paths.ts";

export interface StoredAttachment {
  metadata: Attachment;
  messageId: string;
  botId: string;
  /** Stored form (`bots/<botId>/attachments/<file>`, or a legacy absolute path); resolve with `resolveAttachmentPath`. */
  path: string;
  textPath: string | null;
}
const columns = `a.id, a.kind, a.name, a.mime_type AS mimeType, a.size, a.width, a.height,
  a.truncated, a.sent_percent AS sentPercent, a.message_id AS messageId, a.path,
  a.text_path AS textPath, COALESCE(a.owner_bot_id,m.bot_id,c.bot_id) AS botId`;
function parse(row: Record<string, unknown>): StoredAttachment {
  return {
    metadata: AttachmentSchema.parse({
      id: row.id,
      kind: row.kind,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
      ...(row.width === null ? {} : { width: row.width }),
      ...(row.height === null ? {} : { height: row.height }),
      truncated: row.truncated === 1,
      ...(row.sentPercent === null ? {} : { sentPercent: row.sentPercent }),
    }),
    messageId: String(row.messageId),
    botId: String(row.botId),
    path: String(row.path),
    textPath: row.textPath === null ? null : String(row.textPath),
  };
}
export class AttachmentsRepo {
  constructor(private readonly db: DatabaseSync) {}
  /** `path` / `textPath` must already be in the stored relative form for the owning Bot. */
  create(
    messageId: string,
    metadata: Attachment,
    path: string,
    textPath: string | null,
    ownerBotId?: string,
    sourceAttachmentId?: string,
  ) {
    const c = this.db
      .prepare(
        "SELECT c.bot_id,c.group_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",
      )
      .get(messageId);
    const owner = ownerBotId ?? c?.bot_id;
    if (
      !owner ||
      (c?.bot_id
        ? owner !== c.bot_id
        : !this.db
            .prepare(
              "SELECT 1 FROM group_members WHERE group_id=? AND bot_id=? AND left_at IS NULL",
            )
            .get(String(c?.group_id), String(owner)))
    )
      throw new TypeError("Invalid attachment owner");
    // New rows never record where the data directory happens to be today.
    if (
      !isStoredAttachmentPath(path, String(owner)) ||
      (textPath !== null && !isStoredAttachmentPath(textPath, String(owner)))
    )
      throw new TypeError("Invalid attachment path");
    this.db
      .prepare(`INSERT INTO attachments
      (id, message_id, kind, name, mime_type, size, width, height, path, text_path, truncated, sent_percent, created_at, owner_bot_id, source_attachment_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        metadata.id,
        messageId,
        metadata.kind,
        metadata.name,
        metadata.mimeType,
        metadata.size,
        metadata.width ?? null,
        metadata.height ?? null,
        path,
        textPath,
        Number(metadata.truncated ?? false),
        metadata.sentPercent ?? null,
        new Date().toISOString(),
        String(owner),
        sourceAttachmentId ?? null,
      );
  }
  groupId(id: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT c.group_id FROM attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id WHERE a.id=?",
      )
      .get(id);
    return row?.group_id ? String(row.group_id) : undefined;
  }
  get(id: string): StoredAttachment | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM attachments a
      JOIN messages m ON m.id = a.message_id JOIN conversations c ON c.id = m.conversation_id
      WHERE a.id = ?`)
      .get(id);
    return row ? parse(row) : undefined;
  }
  link(fromMessageId: string, toMessageId: string) {
    const identity = this.db
      .prepare(
        `SELECT s.bot_id AS sourceBot, t.bot_id AS targetBot, sc.group_id AS sourceGroup, tc.group_id AS targetGroup FROM messages s JOIN conversations sc ON sc.id=s.conversation_id JOIN messages t ON t.id=? JOIN conversations tc ON tc.id=t.conversation_id WHERE s.id=? AND s.role='assistant' AND t.role='assistant'`,
      )
      .get(toMessageId, fromMessageId);
    if (
      !identity?.sourceGroup ||
      identity.sourceGroup !== identity.targetGroup ||
      identity.sourceBot !== identity.targetBot
    )
      throw new TypeError("Invalid attachment link");
    if (fromMessageId === toMessageId) return;
    const present = new Set(
      (this.forMessages([toMessageId]).get(toMessageId) ?? []).map((item) => item.id),
    );
    const ids = (this.forMessages([fromMessageId]).get(fromMessageId) ?? []).filter(
      (item) => !present.has(item.id),
    );
    if (
      ids.length > MAX_GENERATED_IMAGES ||
      (this.forMessages([toMessageId]).get(toMessageId)?.length ?? 0) + ids.length >
        MAX_GENERATED_IMAGES
    )
      throw new TypeError("Too many attachments");
    for (const item of ids)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO message_attachment_links(message_id,attachment_id) VALUES (?,?)",
        )
        .run(toMessageId, item.id);
  }
  /** Retry copies retain the same Bot's managed bytes; they never create a cross-Bot read grant. */
  linkRetry(fromMessageId: string, toMessageId: string) {
    const valid = this.db
      .prepare(`SELECT 1 FROM messages s JOIN conversations sc ON sc.id=s.conversation_id
      JOIN messages t ON t.id=? JOIN conversations tc ON tc.id=t.conversation_id
      WHERE s.id=? AND sc.kind='dm' AND tc.kind='dm' AND sc.bot_id=tc.bot_id AND s.role=t.role
      AND sc.internal_task_id IS NULL AND tc.internal_task_id IS NULL AND sc.routine_id IS NULL AND tc.routine_id IS NULL`)
      .get(toMessageId, fromMessageId);
    if (!valid) throw new TypeError("Invalid retry attachment link");
    const items = this.forMessages([fromMessageId]).get(fromMessageId) ?? [];
    if (items.length > MAX_GENERATED_IMAGES) throw new TypeError("Too many attachments");
    for (const item of items)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO message_attachment_links(message_id,attachment_id) VALUES (?,?)",
        )
        .run(toMessageId, item.id);
  }
  forMessages(ids: string[]): Map<string, Attachment[]> {
    const result = new Map<string, Attachment[]>();
    if (!ids.length) return result;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id WHERE a.message_id IN (${placeholders}) ORDER BY a.rowid`,
      )
      .all(...ids);
    rows.push(
      ...this.db
        .prepare(
          `SELECT ${columns.replace("a.message_id AS messageId", "link.message_id AS messageId")} FROM message_attachment_links link JOIN attachments a ON a.id=link.attachment_id JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id WHERE link.message_id IN (${placeholders}) ORDER BY a.rowid`,
        )
        .all(...ids),
    );
    for (const row of rows) {
      const item = parse(row);
      const group = result.get(item.messageId) ?? [];
      group.push(item.metadata);
      result.set(item.messageId, group);
    }
    return result;
  }
  removeFiles(messageId: string, dataDir?: string) {
    const rows = this.db
      .prepare(`SELECT ${columns} FROM attachments a
      JOIN messages m ON m.id = a.message_id JOIN conversations c ON c.id = m.conversation_id
      WHERE a.message_id = ?`)
      .all(messageId);
    if (rows.length && !dataDir) throw new Error("Attachment deletion requires data directory");
    for (const row of rows) {
      const item = parse(row);
      const other = this.db
        .prepare(
          "SELECT message_id FROM message_attachment_links WHERE attachment_id=? AND message_id<>? LIMIT 1",
        )
        .get(item.metadata.id, messageId);
      // Transfer the owning row before deleting a source message; shared results retain one physical copy.
      if (other) {
        this.db
          .prepare("UPDATE attachments SET message_id=? WHERE id=?")
          .run(String(other.message_id), item.metadata.id);
        this.db
          .prepare("DELETE FROM message_attachment_links WHERE attachment_id=? AND message_id=?")
          .run(item.metadata.id, String(other.message_id));
        continue;
      }
      const real = realpathSync(dataDir as string);
      const root = join(real, "bots", item.botId, "attachments");
      // Repeated removal after a crash is safe; never follow symlinks out of the owned directory.
      for (const stored of [item.path, item.textPath]) {
        if (!stored) continue;
        const file = resolveAttachmentPath(real, stored);
        if (
          resolve(dirname(file)) !== resolve(root) ||
          !basename(file).startsWith(item.metadata.id)
        )
          throw new Error("Invalid attachment path");
        try {
          const stat = lstatSync(file);
          if (!stat.isFile() || realpathSync(dirname(file)) !== resolve(root))
            throw new Error("Invalid attachment path");
          unlinkSync(file);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      // Page images and the cached preview have deterministic names owned by the same attachment.
      for (const file of [
        ...Array.from({ length: 10 }, (_, index) =>
          join(root, `${item.metadata.id}.page-${index + 1}.png`),
        ),
        join(root, `${item.metadata.id}.thumb`),
      ]) {
        try {
          if (realpathSync(root) !== resolve(root)) throw new Error("Invalid attachment path");
          unlinkSync(file);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
    }
  }
}
