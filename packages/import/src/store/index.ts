// A batch owns its imported rows, allowing atomic publication, rollback, and recovery.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  type ImportDistillationQuote,
  type ImportStatus,
  ImportStatusSchema,
  MAX_IMPORT_TOPIC_REFERENCES,
} from "@pibot/import-contract";
import type { Attachment } from "@pibot/protocol-base";
import {
  AttachmentsRepo,
  AuditRepo,
  ChatSearchIndex,
  transaction,
  type WorkplacesRepo,
} from "@pibot/storage";
import { CleanupWork } from "./cleanup-work.ts";
import { ImportFailure } from "./failure.ts";
import { ImportMemories } from "./memories.ts";
import { ImportPersonas } from "./personas.ts";
import { ImportProjects } from "./projects.ts";

type ImportedTopic = {
  title: string;
  createdAt: string;
  updatedAt: string;
  memoryExcluded?: boolean;
};
type ImportedMessage = {
  role: "user" | "assistant";
  text: string;
  historyParts?: { kind: "call" | "result" | "attachment"; name: string; summary?: string }[];
  createdAt: string;
};

type Terminal = Exclude<ImportStatus["state"], "running" | "undoing">;
type CleanupTarget = "failed" | "cancelled";

export class ImportStore {
  private readonly audit: AuditRepo;
  private statusStatement?: ReturnType<DatabaseSync["prepare"]>;
  readonly memories: ImportMemories;
  readonly personas: ImportPersonas;
  readonly projects: ImportProjects;

  constructor(
    private readonly db: DatabaseSync,
    redactor: ConstructorParameters<typeof AuditRepo>[1],
    private readonly workplaces?: Pick<WorkplacesRepo, "hide" | "inUse">,
  ) {
    this.audit = new AuditRepo(db, redactor);
    this.memories = new ImportMemories(db, (text) => redactor.redact(text));
    this.personas = new ImportPersonas(db, (text) => redactor.redact(text));
    this.projects = new ImportProjects(db);
  }

  availableBot(botId: string) {
    return !!this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(botId);
  }

  /** Bots a memory can be kept for (the same set the destination menu lists). */
  chatBots(): string[] {
    return this.db
      .prepare(`SELECT id FROM bots WHERE archived_at IS NULL AND category='chat'
        ORDER BY is_main DESC, created_at, id LIMIT 200`)
      .all()
      .map((row) => String(row.id));
  }

  /** Local work folders the user chose for any active Bot, most recently used first, one per path. */
  workFolders() {
    const rows = this.db
      .prepare(`SELECT f.id, f.bot_id AS botId, f.name, f.path FROM working_folders f
        JOIN bots b ON b.id=f.bot_id
        WHERE b.archived_at IS NULL AND f.hidden_at IS NULL AND f.association='user'
          AND f.path NOT LIKE 'pibot-%'
        ORDER BY COALESCE(f.last_used_at, f.created_at) DESC, f.id LIMIT 300`)
      .all();
    const seen = new Set<string>();
    const folders: { id: string; botId: string; name: string; path: string }[] = [];
    for (const row of rows) {
      const path = String(row.path);
      if (seen.has(path) || folders.length >= 100) continue;
      seen.add(path);
      folders.push({ id: String(row.id), botId: String(row.botId), name: String(row.name), path });
    }
    return folders;
  }

  get(id: string) {
    this.statusStatement ??= this.db.prepare(`SELECT id AS importId, source,
        CASE cleanup_phase WHEN 'undoing' THEN 'undoing' WHEN 'discarding' THEN 'running'
          ELSE state END AS state, topics, messages, reason, cleanup_phase,
        removed_topics, removed_messages, removed_memories, added_memories, distillation_result,
        skipped_too_long,
        EXISTS(SELECT 1 FROM import_personas WHERE import_id=import_jobs.id) AS applied_persona,
        (SELECT COUNT(*) FROM import_project_notes
          WHERE import_id=import_jobs.id AND state='pending') AS project_files,
        (SELECT COUNT(*) FROM import_project_notes
          WHERE import_id=import_jobs.id AND removed=1) AS removed_project_files,
        (SELECT COUNT(*) FROM import_project_notes
          WHERE import_id=import_jobs.id AND state='kept') AS kept_files,
        (SELECT COUNT(*) FROM import_folders
          WHERE import_id=import_jobs.id AND state='pending') AS folders,
        (SELECT COUNT(*) FROM import_folders
          WHERE import_id=import_jobs.id AND state='kept') AS kept_folders
        FROM import_jobs WHERE id=?`);
    const row = this.statusStatement.get(id);
    if (!row) return undefined;
    const {
      removed_topics,
      removed_messages,
      removed_memories,
      removed_project_files,
      added_memories,
      applied_persona,
      project_files,
      kept_files,
      folders,
      kept_folders,
      cleanup_phase,
      distillation_result,
      skipped_too_long,
      ...status
    } = row;
    const completed = status.state === "completed";
    const importedTopics =
      completed && status.topics
        ? this.db
            .prepare(`SELECT c.id AS topicId, c.bot_id AS botId FROM conversations c
              JOIN bots b ON b.id=c.bot_id
              WHERE c.import_id=? AND c.archived_at IS NULL AND b.archived_at IS NULL
              ORDER BY c.updated_at DESC,c.id DESC LIMIT ?`)
            .all(id, MAX_IMPORT_TOPIC_REFERENCES)
        : undefined;
    return ImportStatusSchema.parse({
      ...status,
      ...(importedTopics?.length ? { importedTopics } : {}),
      ...(cleanup_phase ? { cleanup: cleanup_phase } : {}),
      ...(added_memories ? { memories: added_memories } : {}),
      ...(typeof distillation_result === "string"
        ? { distillation: JSON.parse(distillation_result) }
        : {}),
      ...(applied_persona ? { persona: true } : {}),
      ...(project_files && completed ? { projectFiles: project_files } : {}),
      ...(folders && completed ? { folders } : {}),
      ...(kept_files ? { keptProjectFiles: kept_files } : {}),
      ...(kept_folders ? { keptFolders: kept_folders } : {}),
      ...(skipped_too_long ? { skippedTooLong: skipped_too_long } : {}),
      ...(cleanup_phase || status.state === "undone"
        ? {
            removed: {
              topics: removed_topics,
              messages: removed_messages,
              ...(removed_memories ? { memories: removed_memories } : {}),
              ...(removed_project_files ? { projectFiles: removed_project_files } : {}),
            },
          }
        : {}),
    });
  }

  create(
    id: string,
    source: ImportStatus["source"],
    botId: string,
    quote?: ImportDistillationQuote,
    skippedTooLong = 0,
  ) {
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO import_jobs(id,source,bot_id,state,created_at,distillation_consent,skipped_too_long)
          VALUES(?,?,?,'running',?,?,?)`)
        .run(
          id,
          source,
          botId,
          new Date().toISOString(),
          quote ? JSON.stringify(quote) : null,
          skippedTooLong,
        );
      if (quote && !quote.local)
        this.audit.append({
          botId,
          kind: "import.changed",
          summary: "Import distillation consent / 导入记忆提炼已授权",
          detail: {
            actor: "user",
            importDistillationConsent: {
              importId: id,
              provider: quote.provider,
              model: quote.modelId,
              conversations: quote.conversationCount,
              estimatedTokens: quote.inputTokens + quote.outputTokens,
            },
          },
        });
    });
  }

  recordDistillation(id: string, result: NonNullable<ImportStatus["distillation"]>) {
    this.db
      .prepare("UPDATE import_jobs SET distillation_result=? WHERE id=?")
      .run(JSON.stringify(result), id);
  }

  /** Past batches newest first; the cursor is the row order, so a new batch never shifts a page. */
  history(before: number | undefined, limit: number) {
    const rows = this.db
      .prepare(`SELECT id, rowid AS cursor, created_at AS createdAt FROM import_jobs
        WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`)
      .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const page = rows.slice(0, limit);
    return {
      rows: page.map((row) => ({
        id: String(row.id),
        createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
      })),
      next: rows.length > limit ? Number(page.at(-1)?.cursor) : null,
    };
  }

  jobState(id: string) {
    return this.db.prepare("SELECT state,cleanup_phase FROM import_jobs WHERE id=?").get(id);
  }

  target(id: string) {
    return this.db.prepare("SELECT bot_id FROM import_jobs WHERE id=?").get(id)?.bot_id;
  }

  unfinished() {
    return this.db
      .prepare("SELECT id FROM import_jobs WHERE state='running' AND cleanup_phase IS NULL LIMIT 1")
      .get()?.id;
  }

  /** A project's topics start in that project's work folder (registered for the same Bot). */
  addTopic(
    batchId: string,
    botId: string,
    source: ImportStatus["source"],
    topic: ImportedTopic,
    folderId?: string,
  ) {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO conversations
      (id, kind, bot_id, title, created_at, updated_at, import_id, import_source, workplace_folder_id, import_memory_excluded)
      VALUES (?, 'dm', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        botId,
        topic.title,
        topic.createdAt,
        topic.updatedAt,
        batchId,
        source,
        folderId ?? null,
        Number(!!topic.memoryExcluded),
      );
    return id;
  }

  /** Bots that own the batch's topics, for sidebar refreshes. */
  topicBots(id: string): string[] {
    return this.db
      .prepare("SELECT DISTINCT bot_id FROM conversations WHERE import_id=? LIMIT 200")
      .all(id)
      .map((row) => String(row.bot_id));
  }

  distillationTopics(id: string) {
    return this.db
      .prepare(`SELECT id FROM conversations WHERE import_id=?
      AND import_memory_excluded=0 ORDER BY rowid`)
      .all(id)
      .map((row) => String(row.id));
  }

  async *distillationMessages(id: string, topicId: string, signal: AbortSignal) {
    const pageSize = 16;
    const page = this.db.prepare(`SELECT rowid AS cursor, role, content FROM messages
      WHERE conversation_id=? AND import_id=? AND rowid>?
      AND role IN ('user','assistant') AND content<>''
      ORDER BY rowid LIMIT ?`);
    let cursor = 0;
    while (true) {
      signal.throwIfAborted();
      const rows = page.all(topicId, id, cursor, pageSize);
      for (const row of rows) {
        signal.throwIfAborted();
        yield { role: String(row.role), text: String(row.content) };
        cursor = Number(row.cursor);
      }
      if (rows.length < pageSize) break;
      await yieldToLoop(undefined, { signal });
    }
  }

  addDistilledMemories(
    id: string,
    botId: string,
    selected: Parameters<ImportMemories["add"]>[2]["selected"],
  ) {
    return transaction(this.db, () =>
      this.memories.add(id, botId, { scope: "bot", selected, bestEffort: true }),
    );
  }

  /** The full text of a long imported message, kept like any other topic file. */
  addAttachment(messageId: string, botId: string, saved: { metadata: Attachment; stored: string }) {
    new AttachmentsRepo(this.db).create(messageId, saved.metadata, saved.stored, null, botId);
  }

  addMessage(batchId: string, botId: string, conversationId: string, msg: ImportedMessage) {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO messages
      (id, conversation_id, role, content, status, bot_id, created_at, updated_at, import_id, import_history_parts)
      VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?)`)
      .run(
        id,
        conversationId,
        msg.role,
        msg.text,
        msg.role === "user" ? null : botId,
        msg.createdAt,
        msg.createdAt,
        batchId,
        msg.historyParts?.length ? JSON.stringify(msg.historyParts) : null,
      );
    return id;
  }

  page<T>(id: string, add: () => T, counts: Pick<ImportStatus, "topics" | "messages">) {
    return transaction(this.db, () => {
      const result = add();
      this.db
        .prepare("UPDATE import_jobs SET topics=?, messages=? WHERE id=?")
        .run(counts.topics, counts.messages, id);
      return result;
    });
  }

  complete<T>(id: string, apply: () => T) {
    return transaction(this.db, () => {
      const change = apply();
      return { change, status: this.finish(id, "completed", null) };
    });
  }

  ownsTopic(importId: string, topicId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM conversations WHERE id=? AND import_id=?")
      .get(topicId, importId);
  }

  beginUndo(id: string) {
    return transaction(this.db, () => {
      if (this.projects.hasDependents(id)) throw new ImportFailure("project");
      const changed = this.db
        .prepare(`UPDATE import_jobs SET cleanup_phase='undoing'
        WHERE id=? AND state='completed' AND cleanup_phase IS NULL`)
        .run(id);
      if (!changed.changes)
        return { change: [], persona: undefined, status: this.requiredStatus(id) };
      const botId = this.target(id);
      if (typeof botId !== "string") throw new Error("import_job_missing");
      const { owners: change, removed } = this.memories.remove(id, botId);
      this.db.prepare("UPDATE import_jobs SET removed_memories=? WHERE id=?").run(removed, id);
      const persona = this.personas.undo(id, botId);
      return { change, persona, status: this.requiredStatus(id) };
    });
  }

  discard(id: string, state: CleanupTarget, reason: ImportStatus["reason"]) {
    this.db
      .prepare(`UPDATE import_jobs SET state=?,reason=?,cleanup_phase='discarding'
      WHERE id=? AND state='running'`)
      .run(state, reason, id);
  }

  recover() {
    this.db
      .prepare(`UPDATE import_jobs SET state='failed',reason='interrupted',
      cleanup_phase='discarding' WHERE state='running'`)
      .run();
  }

  nextCleanup(after = 0) {
    const row = this.db
      .prepare(`SELECT id,rowid AS cursor FROM import_jobs
      WHERE cleanup_phase IS NOT NULL AND rowid>? ORDER BY rowid LIMIT 1`)
      .get(after);
    return typeof row?.id === "string" && typeof row.cursor === "number"
      ? { id: row.id, cursor: row.cursor }
      : undefined;
  }

  cleanupWork() {
    return new CleanupWork(this.db);
  }

  searchRebuilding() {
    return new ChatSearchIndex(this.db).rebuilding();
  }

  finishCleanup(id: string): ImportStatus {
    return transaction(this.db, () => {
      const job = this.db
        .prepare(
          `SELECT state,reason,cleanup_phase FROM import_jobs WHERE id=? AND cleanup_phase IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM messages WHERE import_id=import_jobs.id)
            AND NOT EXISTS (SELECT 1 FROM conversations WHERE import_id=import_jobs.id)`,
        )
        .get(id);
      if (!job) throw new Error("import_cleanup_missing");
      this.releaseFolderRecords(id);
      const state =
        job.cleanup_phase === "undoing"
          ? "undone"
          : job.state === "cancelled"
            ? "cancelled"
            : "failed";
      const reason = ImportStatusSchema.shape.reason.parse(job.reason);
      this.db.prepare("DELETE FROM chat_search_pruned_imports WHERE import_id=?").run(id);
      return this.finish(id, state, reason);
    });
  }

  /** Remembers a work-folder record the batch registered, so undo can forget it again. */
  rememberFolderRecord(id: string, botId: string, folderId: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO import_folder_records(import_id,bot_id,folder_id) VALUES(?,?,?)",
      )
      .run(id, botId, folderId);
  }

  /**
   * After the batch's topics are gone, its folder records are hidden like "remove record": a
   * topic or routine the user pointed at the folder since keeps it listed.
   */
  private releaseFolderRecords(id: string) {
    const rows = this.db
      .prepare("SELECT bot_id,folder_id FROM import_folder_records WHERE import_id=?")
      .all(id);
    for (const row of rows) {
      const botId = String(row.bot_id);
      const folderId = String(row.folder_id);
      if (this.workplaces && this.workplaces.inUse(botId, folderId) === 0)
        this.workplaces.hide(botId, folderId);
    }
    this.db.prepare("DELETE FROM import_folder_records WHERE import_id=?").run(id);
  }

  private requiredStatus(id: string) {
    const status = this.get(id);
    if (!status) throw new Error("import_job_missing");
    return status;
  }

  private finish(id: string, state: Terminal, reason: ImportStatus["reason"]) {
    this.db
      .prepare(`UPDATE import_jobs SET state=?,reason=?,cleanup_phase=NULL WHERE id=?`)
      .run(state, reason, id);
    const botId = this.target(id);
    if (typeof botId !== "string") throw new Error("import_job_missing");
    const status = this.requiredStatus(id);
    const { source, topics, messages, memories, persona } = status;
    const { projectFiles, folders, keptProjectFiles, keptFolders } = status;
    this.audit.append({
      botId,
      kind: "import.changed",
      summary: "Conversation import / 对话导入",
      detail: {
        actor: reason === "interrupted" ? "automatic" : "user",
        conversationImport: {
          importId: id,
          source,
          state,
          topics,
          messages,
          ...(memories === undefined ? {} : { memories }),
          ...(persona ? { persona } : {}),
          ...(projectFiles ? { projectFiles } : {}),
          ...(folders ? { folders } : {}),
          ...(keptProjectFiles ? { keptProjectFiles } : {}),
          ...(keptFolders ? { keptFolders } : {}),
        },
      },
    });
    return status;
  }
}
