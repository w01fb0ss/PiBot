import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AbsolutePathSchema, type Group, GroupFolderSchema, IdSchema } from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

export class GroupFoldersRepo {
  constructor(private readonly db: DatabaseSync) {}
  identity(groupId: string) {
    const r = this.db
      .prepare(
        "SELECT primary_folder_id AS primaryFolderId,primary_initialized AS primaryInitialized,revision FROM group_workspace WHERE group_id=?",
      )
      .get(IdSchema.parse(groupId));
    return {
      primaryFolderId: r?.primaryFolderId == null ? null : String(r.primaryFolderId),
      revision: Number(r?.revision ?? 0),
      primaryInitialized: r?.primaryInitialized === 1,
    };
  }
  list(groupId: string) {
    const identity = this.identity(groupId);
    return this.db
      .prepare(
        "SELECT id,path,location,display_path AS displayPath FROM group_folders WHERE group_id=? ORDER BY position,id LIMIT 32",
      )
      .all(groupId)
      .map((row) =>
        GroupFolderSchema.parse({
          ...row,
          location: row.location === "local" ? undefined : row.location,
          role: row.id === identity.primaryFolderId ? "primary" : "readonly",
          name:
            (row.location === "local"
              ? path
              : /^(?:[A-Za-z]:[\\/]|\\\\)/.test(String(row.path))
                ? path.win32
                : path.posix
            ).basename(String(row.path)) || String(row.path),
          displayPath: row.displayPath ?? row.path,
        }),
      );
  }
  add(
    groupId: string,
    folderPath: string,
    location?: NonNullable<Group["folders"]>[number]["location"],
    displayPath?: string,
  ) {
    AbsolutePathSchema.parse(folderPath);
    if (displayPath !== undefined) AbsolutePathSchema.parse(displayPath);
    return transaction(this.db, () => {
      const first = this.list(groupId).length === 0;
      const initialized = this.identity(groupId).primaryInitialized;
      if (!this.db.prepare("SELECT 1 FROM groups WHERE id=?").get(groupId))
        throw new TypeError("Unknown group");
      const existing = this.db
        .prepare("SELECT id FROM group_folders WHERE group_id=? AND path=? AND location=?")
        .get(groupId, folderPath, location ?? "local");
      if (existing) {
        if (displayPath !== undefined)
          this.db
            .prepare("UPDATE group_folders SET display_path=? WHERE group_id=? AND id=?")
            .run(displayPath, groupId, String(existing.id));
        return false;
      }
      if (this.list(groupId).length >= 32) throw new TypeError("Group folder limit");
      this.db
        .prepare(
          "INSERT INTO group_folders(id,group_id,path,location,created_at,display_path,position) VALUES (?,?,?,?,?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM group_folders WHERE group_id=?))",
        )
        .run(
          randomUUID(),
          groupId,
          folderPath,
          location ?? "local",
          new Date().toISOString(),
          displayPath ?? null,
          groupId,
        );
      if (first && !initialized) {
        const root = this.db
          .prepare("SELECT id FROM group_folders WHERE group_id=? AND path=? AND location=?")
          .get(groupId, folderPath, location ?? "local");
        this.setPrimary(groupId, String(root?.id));
      }
      this.touch(groupId);
      return true;
    });
  }
  remove(groupId: string, folderId: string) {
    return transaction(this.db, () => {
      if (this.identity(groupId).primaryFolderId === folderId) this.setPrimary(groupId, null);
      const changed = this.db
        .prepare("DELETE FROM group_folders WHERE group_id=? AND id=?")
        .run(groupId, folderId).changes;
      if (changed) this.touch(groupId);
      return Boolean(changed);
    });
  }
  setPrimary(groupId: string, folderId: string | null) {
    IdSchema.parse(groupId);
    if (
      folderId !== null &&
      !this.db
        .prepare("SELECT 1 FROM group_folders WHERE group_id=? AND id=?")
        .get(groupId, IdSchema.parse(folderId))
    )
      throw new TypeError("Unknown group folder");
    this.db
      .prepare(
        "INSERT INTO group_workspace(group_id,primary_folder_id,primary_initialized,revision) VALUES (?,?,1,1) ON CONFLICT(group_id) DO UPDATE SET primary_folder_id=excluded.primary_folder_id,primary_initialized=1,revision=revision+1",
      )
      .run(groupId, folderId);
  }
  private touch(groupId: string) {
    this.db
      .prepare(
        "INSERT INTO group_workspace(group_id,primary_folder_id,revision) VALUES (?,NULL,1) ON CONFLICT(group_id) DO UPDATE SET revision=revision+1",
      )
      .run(groupId);
    this.db
      .prepare("UPDATE groups SET updated_at=? WHERE id=?")
      .run(new Date().toISOString(), groupId);
  }
}
