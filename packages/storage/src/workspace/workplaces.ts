import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AbsolutePathSchema,
  type ExecutionLocationTarget,
  type UsedFolder,
  UsedFolderSchema,
  type WorkingFolder,
  WorkingFolderSchema,
  type Workplaces,
  WorkplacesSchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

// Session bookkeeping must not consume the user/monitor registry; both pools count hidden rows
// because their topics and routines may still reference them.
const MAX_USER_FOLDERS = 200;
const MAX_SESSION_FOLDERS = 200;
export const WORKPLACE_REGISTRY_LIMIT = MAX_USER_FOLDERS + MAX_SESSION_FOLDERS;

const folderColumns =
  "id, path, name, location, association, last_used_at AS lastUsedAt, hidden_at AS hiddenAt, display_path AS displayPath";
type FolderRow = WorkingFolder & { hiddenAt?: string | null };
function folder(row: Record<string, unknown>): FolderRow {
  const {
    lastUsedAt,
    hiddenAt,
    location,
    association,
    displayPath,
    createdAt: _createdAt,
    ...rest
  } = row;
  const remote = typeof location === "string" && location !== "local";
  if (remote) {
    const prefix = `pibot-${location}:`;
    if (typeof rest.path !== "string" || !rest.path.startsWith(prefix))
      throw new TypeError("Invalid runner folder");
    rest.path = Buffer.from(rest.path.slice(prefix.length), "base64url").toString("utf8");
  }
  return {
    ...WorkingFolderSchema.parse({
      ...rest,
      ...(remote ? { location } : {}),
      ...(association === "user" || association === "monitor" ? { association } : {}),
      ...(lastUsedAt ? { lastUsedAt } : {}),
      ...(displayPath ? { displayPath } : {}),
    }),
    hiddenAt: (hiddenAt as string | null) ?? null,
  };
}

/**
 * The Bot's folder registry. It is now the "used folders" list: topics, routines and drafts
 * select folders by these IDs; the Bot itself no longer has a current folder (`bot_workplace`
 * keeps only the legacy default for a Bot without any topic).
 */
export class WorkplacesRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
  ) {}

  home(botId: string) {
    return join(this.dataDir, "bots", botId, "home");
  }

  /** The visible registry (records the user removed are hidden) with the legacy current folder. */
  list(botId: string): Workplaces {
    if (!this.db.prepare("SELECT id FROM bots WHERE id = ?").get(botId))
      throw new TypeError("Unknown Bot");
    const folders = this.db
      .prepare(`SELECT ${folderColumns} FROM working_folders
      WHERE bot_id = ? AND hidden_at IS NULL AND association <> 'session' ORDER BY position, id LIMIT 200`)
      .all(botId)
      .map(folder);
    const current = this.legacyCurrent(botId);
    return WorkplacesSchema.parse({
      home: this.home(botId),
      folders: folders.map(({ hiddenAt: _hidden, ...f }) => ({
        ...f,
        role: f.id === current.currentId ? "primary" : "readonly",
      })),
      revision: current.revision,
      currentId: current.currentId,
    });
  }

  /** @deprecated Only the default for a Bot that has no topic yet. */
  legacyCurrent(botId: string): { currentId: string; revision: number } {
    const row = this.db
      .prepare("SELECT current_folder_id, revision FROM bot_workplace WHERE bot_id = ?")
      .get(botId);
    return {
      currentId: row?.current_folder_id == null ? "home" : String(row.current_folder_id),
      revision: Number(row?.revision ?? 0),
    };
  }

  /** Registered folders by ID, hidden ones included: a removed record still serves its topics. */
  folders(botId: string, ids: readonly string[]): Map<string, WorkingFolder> {
    const result = new Map<string, WorkingFolder>();
    if (!ids.length) return result;
    const rows = this.db
      .prepare(
        `SELECT ${folderColumns} FROM working_folders WHERE bot_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(botId, ...ids);
    for (const row of rows) {
      const { hiddenAt: _hidden, ...value } = folder(row);
      result.set(value.id, value);
    }
    return result;
  }

  /** Registered folder IDs for these paths, hidden records included (a routine's watched folders). */
  idsForPaths(botId: string, paths: readonly string[]): string[] {
    if (!paths.length) return [];
    return this.db
      .prepare(
        `SELECT id FROM working_folders WHERE bot_id = ? AND path IN (${paths.map(() => "?").join(",")}) ORDER BY position, id`,
      )
      .all(botId, ...paths)
      .map((row) => String(row.id));
  }

  /** Every registered path (hidden included): `files.open` may open what any topic could show. */
  allPaths(botId: string): string[] {
    return this.db
      .prepare(
        `SELECT path FROM working_folders WHERE bot_id = ? AND location = 'local' ORDER BY position, id LIMIT ${WORKPLACE_REGISTRY_LIMIT}`,
      )
      .all(botId)
      .map((row) => String(row.path));
  }
  /** Every local path a Bot registered, unfiltered and unpaged because the caller deletes
   * the Bot's rows in the next transaction and cannot read them afterwards. */
  pathsForBot(botId: string): string[] {
    return this.db
      .prepare(
        "SELECT path FROM working_folders WHERE bot_id = ? AND location = 'local' ORDER BY position, id",
      )
      .all(botId)
      .map((row) => String(row.path));
  }
  /** One record's path, read before the record is hidden or deleted. */
  path(folderId: string): string | undefined {
    const row = this.db.prepare("SELECT path FROM working_folders WHERE id = ?").get(folderId) as
      | { path?: unknown }
      | undefined;
    return typeof row?.path === "string" ? row.path : undefined;
  }
  /**
   * Whether any record still points at this path. Hidden records count as used on purpose:
   * topics and routines keep working on them after the user removes the folder, so the derived
   * index must outlive the visible row.
   */
  referencedAt(path: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS used FROM working_folders WHERE path = ? LIMIT 1").get(path),
    );
  }
  remoteFolders(botId: string): WorkingFolder[] {
    return this.db
      .prepare(
        `SELECT ${folderColumns} FROM working_folders WHERE bot_id = ? AND location <> 'local' LIMIT ${WORKPLACE_REGISTRY_LIMIT}`,
      )
      .all(botId)
      .map((row) => {
        const { hiddenAt: _hidden, ...value } = folder(row);
        return value;
      });
  }

  /** Registers a folder, or brings back a removed record of the same path; returns its row. */
  register(
    botId: string,
    path: string,
    name = basename(path) || path,
    association: "user" | "monitor" | "session" = "user",
    location: ExecutionLocationTarget = "local",
    displayPath?: string | null,
  ): WorkingFolder {
    AbsolutePathSchema.parse(path);
    if (displayPath != null) AbsolutePathSchema.parse(displayPath);
    const storagePath =
      location === "local" ? path : `pibot-${location}:${Buffer.from(path).toString("base64url")}`;
    return transaction(this.db, () => {
      if (!this.db.prepare("SELECT id FROM bots WHERE id = ?").get(botId))
        throw new TypeError("Unknown Bot");
      const existing = this.db
        .prepare(`SELECT ${folderColumns} FROM working_folders WHERE bot_id = ? AND path = ?`)
        .get(botId, storagePath);
      if (existing) {
        const row = folder(existing);
        const { hiddenAt: _hidden, ...value } = row;
        if (
          association !== "session" &&
          location === "local" &&
          displayPath !== undefined &&
          (value.displayPath ?? null) !== displayPath
        ) {
          this.db
            .prepare("UPDATE working_folders SET display_path=? WHERE bot_id=? AND id=?")
            .run(displayPath, botId, row.id);
          delete value.displayPath;
          if (displayPath) value.displayPath = displayPath;
        }
        const existingAssociation = String(existing.association ?? "user");
        if (existingAssociation === "session" && association !== "session") {
          this.requireRegistrationRoom(botId, association);
          this.db
            .prepare(
              "UPDATE working_folders SET association=?, hidden_at=NULL WHERE bot_id=? AND id=?",
            )
            .run(association, botId, row.id);
          this.bump(botId);
          return { ...value, association };
        }
        // Picking the folder again is the user asking for it, so its record reappears.
        if (row.hiddenAt && association === "user") {
          this.db
            .prepare("UPDATE working_folders SET hidden_at = NULL WHERE bot_id = ? AND id = ?")
            .run(botId, row.id);
          this.bump(botId);
        }
        return association === "session" ? value : { ...value, association };
      }
      this.requireRegistrationRoom(botId, association);
      const value = WorkingFolderSchema.parse({
        id: randomUUID(),
        path,
        name,
        ...(displayPath ? { displayPath } : {}),
        ...(location !== "local" ? { location } : {}),
      });
      this.db
        .prepare(`INSERT INTO working_folders(id, bot_id, path, name, position, created_at, association, last_used_at, location, display_path)
        SELECT ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1, ?, ?, NULL, ?, ? FROM working_folders WHERE bot_id = ?`)
        .run(
          value.id,
          botId,
          storagePath,
          name,
          new Date().toISOString(),
          association,
          location,
          displayPath ?? null,
          botId,
        );
      this.bump(botId);
      return association === "session" ? value : { ...value, association };
    });
  }

  private requireRegistrationRoom(botId: string, association: "user" | "monitor" | "session") {
    const session = association === "session";
    const count = Number(
      this.db
        .prepare(
          session
            ? "SELECT COUNT(*) AS n FROM working_folders WHERE bot_id=? AND association='session'"
            : "SELECT COUNT(*) AS n FROM working_folders WHERE bot_id=? AND association IN ('user','monitor')",
        )
        .get(botId)?.n ?? 0,
    );
    if (count >= (session ? MAX_SESSION_FOLDERS : MAX_USER_FOLDERS))
      throw new TypeError(
        session ? "Too many session working folders" : "Too many working folders",
      );
  }

  add(
    botId: string,
    path: string,
    name = basename(path) || path,
    association: "user" | "monitor" = "user",
  ): Workplaces {
    this.register(botId, path, name, association);
    return this.list(botId);
  }

  /** Hard delete, only for a record that nothing uses (rolling back a failed registration). */
  remove(botId: string, folderId: string): Workplaces {
    return transaction(this.db, () => {
      if (folderId === "home") throw new TypeError("Cannot remove Bot home");
      if (this.inUse(botId, folderId) || this.legacyCurrent(botId).currentId === folderId)
        this.hide(botId, folderId);
      else if (
        this.db
          .prepare("DELETE FROM working_folders WHERE bot_id = ? AND id = ?")
          .run(botId, folderId).changes
      )
        this.bump(botId);
      return this.list(botId);
    });
  }

  /** "Remove record": hides the row; the topics and routines using it keep working. */
  hide(botId: string, folderId: string): number {
    return transaction(this.db, () => {
      if (
        !this.db
          .prepare("SELECT 1 FROM working_folders WHERE bot_id = ? AND id = ?")
          .get(botId, folderId)
      )
        throw new TypeError("Unknown working folder");
      if (
        this.db
          .prepare(
            "UPDATE working_folders SET hidden_at = ? WHERE bot_id = ? AND id = ? AND hidden_at IS NULL",
          )
          .run(new Date().toISOString(), botId, folderId).changes
      )
        this.bump(botId);
      return this.inUse(botId, folderId);
    });
  }

  /** Topics plus routines that still select the folder. */
  inUse(botId: string, folderId: string): number {
    const row = this.db.prepare(usageSql).get(...usageParams(botId, folderId));
    return Number(row?.topics ?? 0) + Number(row?.routines ?? 0);
  }

  touch(botId: string, ids: readonly string[], at = new Date().toISOString()) {
    const real = ids.filter((id) => id !== "home");
    if (!real.length) return;
    this.db
      .prepare(
        `UPDATE working_folders SET last_used_at = ? WHERE bot_id = ? AND id IN (${real.map(() => "?").join(",")})`,
      )
      .run(at, botId, ...real);
  }

  /** Bot details: the visible records, most recently used first, with where they are used. */
  used(botId: string): UsedFolder[] {
    const rows = this.db
      .prepare(`SELECT ${folderColumns}, created_at AS createdAt FROM working_folders
      WHERE bot_id = ? AND hidden_at IS NULL AND association <> 'session'
      ORDER BY COALESCE(last_used_at, created_at) DESC, id LIMIT 200`)
      .all(botId);
    const titles = this.db.prepare(`SELECT c.id, c.title FROM conversations c
      WHERE c.kind='dm' AND c.bot_id=? AND c.archived_at IS NULL AND c.routine_id IS NULL AND c.internal_task_id IS NULL
        AND (c.workplace_folder_id=? OR EXISTS(SELECT 1 FROM topic_folders t WHERE t.conversation_id=c.id AND t.folder_id=?))
      ORDER BY c.updated_at DESC, c.id DESC LIMIT 3`);
    const usage = this.db.prepare(usageSql);
    return rows.map((row) => {
      const counts = usage.get(...usageParams(botId, String(row.id)));
      return UsedFolderSchema.parse({
        id: row.id,
        name: row.name,
        path: row.displayPath ?? folder(row).path,
        association: row.association,
        lastUsedAt: row.lastUsedAt ?? row.createdAt ?? null,
        topics: titles
          .all(botId, String(row.id), String(row.id))
          .map((topic) => ({ id: topic.id, title: String(topic.title ?? "").slice(0, 200) })),
        topicCount: Number(counts?.topics ?? 0),
        routineCount: Number(counts?.routines ?? 0),
      });
    });
  }

  addReadOnly(botId: string, path: string, name = basename(path) || path): Workplaces {
    return this.add(botId, path, name, "monitor");
  }
  private bump(botId: string) {
    this.db
      .prepare(
        "INSERT INTO bot_workplace(bot_id,current_folder_id,revision) VALUES (?,NULL,1) ON CONFLICT(bot_id) DO UPDATE SET revision=revision+1",
      )
      .run(botId);
  }
  /** @deprecated The legacy default for a Bot without topics; no UI sets it any more. */
  setCurrent(botId: string, folderId: string): Workplaces {
    const current = this.list(botId);
    if (folderId !== "home" && !current.folders.some((folder) => folder.id === folderId)) {
      throw new TypeError("Unknown working folder");
    }
    if (current.currentId === folderId) return current;
    this.db
      .prepare(`INSERT INTO bot_workplace(bot_id, current_folder_id) VALUES (?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET current_folder_id = excluded.current_folder_id, revision=revision+1`)
      .run(botId, folderId === "home" ? null : folderId);
    return this.list(botId);
  }
}

// Topics count where the folder is primary or a reference; unattended definitions (routines) where
// it is their folder, a reference, or a watched folder of one of their triggers, read
// through the unattended_definition_folders view.
const usageSql = `SELECT
  (SELECT COUNT(*) FROM conversations c WHERE c.kind='dm' AND c.bot_id=? AND c.archived_at IS NULL AND c.routine_id IS NULL AND c.internal_task_id IS NULL
    AND (c.workplace_folder_id=? OR EXISTS(SELECT 1 FROM topic_folders t WHERE t.conversation_id=c.id AND t.folder_id=?))) AS topics,
  (SELECT COUNT(DISTINCT d.definition_id) FROM unattended_definition_folders d WHERE d.bot_id=?
    AND ((d.role='primary' AND d.folder_id=?) OR (d.role='readonly' AND d.folder_id=?)
      OR (d.role='watched' AND d.folder_id=?))) AS routines
FROM (SELECT 1) AS anchor`;
const usageParams = (botId: string, folderId: string) =>
  [botId, folderId, folderId, botId, folderId, folderId, folderId] as const;
