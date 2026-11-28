import type { DatabaseSync } from "node:sqlite";
import { type Group, GroupTopicSchema, type Page, PageSchema } from "@pibot/protocol-base";
import { ConversationsRepo } from "../conversations/conversations.ts";
import { GroupFoldersRepo } from "./group-folders.ts";

/** The live folder tables hold only the current topic; inactive topics retain a frozen copy. */
export class GroupTopicsRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(groupId: string, topicId: string) {
    const topic = new ConversationsRepo(this.db).get(topicId);
    if (topic?.kind !== "group" || topic.groupId !== groupId)
      throw new TypeError("Unknown group topic");
    const current = new ConversationsRepo(this.db).forGroup(groupId)?.id === topicId;
    const saved = this.db
      .prepare(
        "SELECT folders,primary_folder_id AS primaryFolderId,revision FROM group_topic_workspaces WHERE conversation_id=?",
      )
      .get(topicId);
    const live = new GroupFoldersRepo(this.db);
    return GroupTopicSchema.parse({
      ...topic,
      folders: saved && !current ? JSON.parse(String(saved.folders)) : live.list(groupId),
      primaryFolderId:
        saved && !current ? saved.primaryFolderId : live.identity(groupId).primaryFolderId,
      workspaceRevision: saved && !current ? saved.revision : live.identity(groupId).revision,
      isCurrent: current,
      messageCount: Number(
        this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?").get(topicId)
          ?.n ?? 0,
      ),
      workplaceBusy: current && this.busy(groupId),
    });
  }
  isAcp(groupId: string, topicId: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM conversations WHERE id=? AND group_id=? AND kind='group' AND acp_session=1",
      )
      .get(topicId, groupId);
  }
  markAcp(groupId: string, topicId: string) {
    if (
      !this.db
        .prepare(
          "UPDATE conversations SET acp_session=1 WHERE id=? AND group_id=? AND kind='group' AND archived_at IS NULL",
        )
        .run(topicId, groupId).changes
    )
      throw new TypeError("Unknown active group topic");
  }
  list(groupId: string, page: Page & { archived?: boolean; query?: string } = {}) {
    const { before, limit = 50 } = PageSchema.parse({ before: page.before, limit: page.limit });
    const cursor = before
      ? this.db
          .prepare(
            "SELECT updated_at FROM conversations WHERE id=? AND group_id=? AND kind='group' AND (archived_at IS NOT NULL)=?",
          )
          .get(before, groupId, page.archived ? 1 : 0)
      : undefined;
    if (before && !cursor) return [];
    return this.db
      .prepare(
        "SELECT id FROM conversations WHERE group_id=? AND kind='group' AND (archived_at IS NOT NULL)=? AND instr(lower(title),lower(?))>0 AND (? IS NULL OR updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT ?",
      )
      .all(
        groupId,
        page.archived ? 1 : 0,
        page.query ?? "",
        before ?? null,
        cursor?.updated_at ?? "",
        cursor?.updated_at ?? "",
        before ?? "",
        limit,
      )
      .map((row) => this.get(groupId, String(row.id)));
  }
  snapshot(groupId: string, topicId: string) {
    const folders = new GroupFoldersRepo(this.db),
      identity = folders.identity(groupId);
    this.db
      .prepare(
        "INSERT INTO group_topic_workspaces(conversation_id,folders,primary_folder_id,revision) VALUES (?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET folders=excluded.folders,primary_folder_id=excluded.primary_folder_id,revision=excluded.revision",
      )
      .run(
        topicId,
        JSON.stringify(folders.list(groupId)),
        identity.primaryFolderId,
        identity.revision,
      );
  }
  activate(groupId: string, topicId: string) {
    const target = this.get(groupId, topicId);
    if (target.archivedAt) throw new TypeError("Unknown active group topic");
    this.db.prepare("DELETE FROM group_workspace WHERE group_id=?").run(groupId);
    this.db.prepare("DELETE FROM group_folders WHERE group_id=?").run(groupId);
    const insert = this.db.prepare(
      "INSERT INTO group_folders(id,group_id,path,location,created_at,position,display_path) VALUES(?,?,?,?,?,?,?)",
    );
    target.folders.forEach((folder, index) => {
      insert.run(
        folder.id,
        groupId,
        folder.path,
        folder.location ?? "local",
        new Date().toISOString(),
        index,
        folder.displayPath,
      );
    });
    this.db
      .prepare(
        "INSERT INTO group_workspace(group_id,primary_folder_id,primary_initialized,revision) VALUES(?,?,1,?)",
      )
      .run(groupId, target.primaryFolderId, target.workspaceRevision);
    this.db
      .prepare(
        "INSERT INTO group_current_topics(group_id,conversation_id) VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET conversation_id=excluded.conversation_id",
      )
      .run(groupId, topicId);
    return this.get(groupId, topicId);
  }
  restore(groupId: string, topicId: string) {
    const topic = this.get(groupId, topicId);
    if (topic.archivedAt) new ConversationsRepo(this.db).restore(topicId);
    return this.get(groupId, topicId);
  }
  rename(groupId: string, topicId: string, title: string) {
    const topic = this.get(groupId, topicId);
    if (topic.archivedAt) throw new TypeError("Unknown active group topic");
    this.db.prepare("UPDATE conversations SET title=? WHERE id=?").run(title, topicId);
    return this.get(groupId, topicId);
  }
  created(groupId: string, requestId: string) {
    const row = this.db
      .prepare(
        "SELECT conversation_id FROM group_topic_creations WHERE group_id=? AND request_id=?",
      )
      .get(groupId, requestId);
    return row ? String(row.conversation_id) : undefined;
  }
  recordCreation(groupId: string, requestId: string, conversationId: string) {
    this.db
      .prepare(
        "INSERT INTO group_topic_creations(request_id,group_id,conversation_id) VALUES(?,?,?)",
      )
      .run(requestId, groupId, conversationId);
  }
  busy(groupId: string): boolean {
    return (
      !!this.db
        .prepare(
          "SELECT 1 FROM task_instances t JOIN conversations c ON c.id=t.source_conversation_id WHERE c.group_id=? AND t.status IN ('queued','running','stopping') LIMIT 1",
        )
        .get(groupId) ||
      !!this.db
        .prepare("SELECT 1 FROM background_commands WHERE group_id=? AND status='running' LIMIT 1")
        .get(groupId) ||
      !!this.db
        .prepare(
          "SELECT 1 FROM approvals a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id WHERE c.group_id=? AND a.status='pending' LIMIT 1",
        )
        .get(groupId)
    );
  }
  setWorkspace(
    groupId: string,
    folders: (Pick<NonNullable<Group["folders"]>[number], "id" | "path" | "location"> & {
      displayPath?: string;
    })[],
    primary: string | null,
    revision = 0,
  ) {
    this.db.prepare("DELETE FROM group_workspace WHERE group_id=?").run(groupId);
    this.db.prepare("DELETE FROM group_folders WHERE group_id=?").run(groupId);
    const insert = this.db.prepare(
      "INSERT INTO group_folders(id,group_id,path,location,created_at,position,display_path) VALUES(?,?,?,?,?,?,?)",
    );
    folders.forEach((folder, index) => {
      insert.run(
        folder.id,
        groupId,
        folder.path,
        folder.location ?? "local",
        new Date().toISOString(),
        index,
        folder.displayPath ?? null,
      );
    });
    this.db
      .prepare(
        "INSERT INTO group_workspace(group_id,primary_folder_id,primary_initialized,revision) VALUES(?,?,1,?)",
      )
      .run(groupId, primary, revision);
  }
  resetWorkspace(
    groupId: string,
    folderPath?: string,
    location?: NonNullable<Group["folders"]>[number]["location"],
  ) {
    this.db.prepare("DELETE FROM group_workspace WHERE group_id=?").run(groupId);
    this.db.prepare("DELETE FROM group_folders WHERE group_id=?").run(groupId);
    if (folderPath) new GroupFoldersRepo(this.db).add(groupId, folderPath, location);
  }
}
