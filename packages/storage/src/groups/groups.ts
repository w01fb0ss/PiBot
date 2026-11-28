import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Group,
  GroupPatchSchema,
  GroupSchema,
  type KernelMethodParams,
  KernelMethods,
  type Page,
  PageSchema,
} from "@pibot/protocol-base";
import { ConversationsRepo } from "../conversations/conversations.ts";
import { type CleanupManifest, deleteConversations } from "../database/cleanup.ts";
import { transaction } from "../database/database.ts";
import { defined } from "../database/paging.ts";
import { ManagedWorktreesRepo } from "../workspace/managed-worktrees.ts";
import { GroupFoldersRepo } from "./group-folders.ts";
import { GroupMemberWorkspacesRepo } from "./group-member-workspaces.ts";

const columns =
  "archived_at AS archivedAt,id,name,coordinator_bot_id AS coordinatorBotId,announcement,auto_round_limit AS autoRoundLimit,external_agent_step_context AS externalAgentStepContext,paused,workplace,created_at AS createdAt,updated_at AS updatedAt";
export class GroupsRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): Group | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM groups WHERE id=?`).get(id);
    if (!row) return undefined;
    const conversation = new ConversationsRepo(this.db).forGroup(id);
    if (!conversation) throw new TypeError("Missing group conversation");
    return GroupSchema.parse({
      ...row,
      paused: row.paused === 1,
      externalAgentStepContext: row.externalAgentStepContext === 1,
      workplace: JSON.parse(String(row.workplace)),
      conversationId: conversation.id,
      topicTitle: conversation.title,
      topicModelOverride: conversation.modelOverride,
      topicArchivedAt: conversation.archivedAt,
      folders: new GroupFoldersRepo(this.db).list(id),
      primaryFolderId: new GroupFoldersRepo(this.db).identity(id).primaryFolderId,
      workspaceRevision: new GroupFoldersRepo(this.db).identity(id).revision,
      memberWorkspaces: new GroupMemberWorkspacesRepo(this.db)
        .list(id, conversation.id)
        .flatMap((value) => {
          const tree = new ManagedWorktreesRepo(this.db).get(value.worktreeId);
          return tree
            ? [
                {
                  taskId: value.taskId,
                  sourceConversationId: value.sourceConversationId,
                  botId: value.botId,
                  path: tree.path,
                  branch: tree.branch,
                  state: value.state,
                  errorCode: value.errorCode,
                },
              ]
            : [];
        }),
      members: this.db
        .prepare(
          "SELECT bot_id AS botId,position,joined_at AS joinedAt FROM group_members WHERE group_id=? AND left_at IS NULL ORDER BY position",
        )
        .all(id),
    });
  }
  /**
   * The groups a Bot is still in. The built-in update asks which template each of them
   * came from, because a group's template decides which of the role's skills the Bot gets.
   */
  idsForBot(botId: string): string[] {
    return this.db
      .prepare(
        "SELECT group_id AS id FROM group_members WHERE bot_id=? AND left_at IS NULL ORDER BY group_id",
      )
      .all(botId)
      .map((row) => String(row.id));
  }
  list(page: KernelMethodParams["groups.list"] = {}): Group[] {
    const {
      before,
      limit = 50,
      query = "",
      archived = false,
    } = KernelMethods["groups.list"].params.parse(page);
    // Match the sidebar's conversation activity; editing a group's settings is not a chat turn.
    const base = `WITH activity AS (
      SELECT g.id,g.name,COALESCE(c.updated_at,g.updated_at) AS activityAt
      FROM groups g LEFT JOIN conversations c ON c.group_id=g.id AND c.kind='group' AND c.id=(SELECT id FROM conversations WHERE group_id=g.id AND kind='group' ORDER BY id=(SELECT conversation_id FROM group_current_topics WHERE group_id=g.id) DESC,archived_at IS NULL DESC,updated_at DESC,id DESC LIMIT 1)
      WHERE ${archived ? "g.archived_at IS NOT NULL" : "g.archived_at IS NULL"}
    )`;
    const cursor = before
      ? this.db.prepare(`${base} SELECT * FROM activity WHERE id=?`).get(before)
      : undefined;
    if (before && !cursor) return [];
    return this.db
      .prepare(`${base} SELECT id FROM activity
        WHERE instr(lower(name),lower(?))>0
        AND (? IS NULL OR activityAt<? OR (activityAt=? AND id<?))
        ORDER BY activityAt DESC,id DESC LIMIT ?`)
      .all(
        query,
        before ?? null,
        cursor?.activityAt ?? "",
        cursor?.activityAt ?? "",
        before ?? "",
        limit,
      )
      .map((row) => this.get(String(row.id)) as Group);
  }
  forBot(botId: string, page: Page = {}): Group[] {
    const { before, limit = 50 } = PageSchema.parse(page);
    return this.db
      .prepare(
        "SELECT group_id FROM group_members WHERE bot_id=? AND left_at IS NULL AND group_id>? ORDER BY group_id LIMIT ?",
      )
      .all(botId, before ?? "", limit)
      .flatMap((row) => {
        const group = this.get(String(row.group_id));
        return group ? [group] : [];
      });
  }
  conversationIds(groupId: string, after = ""): string[] {
    return this.db
      .prepare("SELECT id FROM conversations WHERE group_id=? AND id>? ORDER BY id LIMIT 50")
      .all(groupId, after)
      .map((row) => String(row.id));
  }
  setArchived(id: string, archived: boolean): Group {
    if (!this.get(id)) throw new TypeError("Unknown group");
    this.db
      .prepare("UPDATE groups SET archived_at=?,paused=1,updated_at=? WHERE id=?")
      .run(archived ? new Date().toISOString() : null, new Date().toISOString(), id);
    return this.get(id) as Group;
  }
  create(input: KernelMethodParams["groups.create"]): Group {
    const p = KernelMethods["groups.create"].params.parse(input);
    return transaction(this.db, () => {
      for (const id of p.botIds) this.activeBot(id);
      const coordinator =
        p.coordinatorBotId ??
        p.botIds.find((id) =>
          this.db.prepare("SELECT 1 FROM bots WHERE id=? AND is_main=1").get(id),
        ) ??
        p.botIds.find((id) =>
          this.db
            .prepare("SELECT 1 FROM bots WHERE id=? AND category='chat' AND kind IS NULL")
            .get(id),
        );
      if (!coordinator || !p.botIds.includes(coordinator))
        throw new TypeError("Coordinator must be a member");
      if (this.db.prepare("SELECT 1 FROM bots WHERE id=? AND kind='agent'").get(coordinator))
        throw new TypeError("agent_coordinator_unsupported");
      if (this.db.prepare("SELECT 1 FROM bots WHERE id=? AND category='image'").get(coordinator))
        throw new TypeError("image_coordinator_unsupported");
      const id = randomUUID(),
        now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO groups(id,name,coordinator_bot_id,announcement,auto_round_limit,external_agent_step_context,workplace,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          p.name,
          coordinator,
          p.announcement ?? "",
          p.autoRoundLimit,
          Number(p.externalAgentStepContext ?? true),
          JSON.stringify(p.workplace ?? { kind: "coordinator" }),
          now,
          now,
        );
      p.botIds.forEach((botId, position) => {
        this.db
          .prepare(
            "INSERT INTO group_members(group_id,bot_id,position,joined_at) VALUES (?,?,?,?) ON CONFLICT(group_id,bot_id) DO UPDATE SET position=excluded.position,joined_at=excluded.joined_at,left_at=NULL",
          )
          .run(id, botId, position, now);
      });
      new ConversationsRepo(this.db).createGroup(id);
      this.db
        .prepare("INSERT INTO sidebar_entries(conversation_key,chat_group_id) VALUES (?,?)")
        .run(`group:${id}`, id);
      const value = this.get(id) as Group;
      this.workplace(value);
      return value;
    });
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        Group,
        | "name"
        | "coordinatorBotId"
        | "announcement"
        | "autoRoundLimit"
        | "externalAgentStepContext"
        | "paused"
        | "workplace"
      >
    >,
  ): Group | undefined {
    const p = defined(GroupPatchSchema.parse(patch));
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return undefined;
      const value = GroupSchema.parse({ ...current, ...p, updatedAt: new Date().toISOString() });
      if (!value.members.some((m) => m.botId === value.coordinatorBotId))
        throw new TypeError("Coordinator must be a member");
      this.activeBot(value.coordinatorBotId);
      if (
        value.coordinatorBotId !== current.coordinatorBotId &&
        this.db
          .prepare("SELECT 1 FROM bots WHERE id=? AND kind='agent'")
          .get(value.coordinatorBotId)
      )
        throw new TypeError("agent_coordinator_unsupported");
      if (
        this.db
          .prepare("SELECT 1 FROM bots WHERE id=? AND category='image'")
          .get(value.coordinatorBotId)
      )
        throw new TypeError("image_coordinator_unsupported");
      this.workplace(value);
      this.db
        .prepare(
          "UPDATE groups SET name=?,coordinator_bot_id=?,announcement=?,auto_round_limit=?,external_agent_step_context=?,paused=?,workplace=?,updated_at=? WHERE id=?",
        )
        .run(
          value.name,
          value.coordinatorBotId,
          value.announcement,
          value.autoRoundLimit,
          Number(value.externalAgentStepContext),
          Number(value.paused),
          JSON.stringify(value.workplace),
          value.updatedAt,
          id,
        );
      return value;
    });
  }
  addMember(groupId: string, botId: string): Group {
    return transaction(this.db, () => {
      const g = this.required(groupId);
      this.activeBot(botId);
      if (g.members.some((m) => m.botId === botId)) return g;
      if (g.members.length >= 6) throw new TypeError("Group is full");
      const used = new Set(g.members.map((m) => m.position));
      const position = [0, 1, 2, 3, 4, 5].find((n) => !used.has(n)) as number;
      this.db
        .prepare(
          "INSERT INTO group_members(group_id,bot_id,position,joined_at) VALUES (?,?,?,?) ON CONFLICT(group_id,bot_id) DO UPDATE SET position=excluded.position,joined_at=excluded.joined_at,left_at=NULL",
        )
        .run(groupId, botId, position, new Date().toISOString());
      this.touch(groupId);
      return this.required(groupId);
    });
  }
  removeMember(groupId: string, botId: string): Group {
    return transaction(this.db, () => {
      const g = this.required(groupId);
      if (!g.members.some((m) => m.botId === botId)) return g;
      if (
        g.members.length <= 2 ||
        g.coordinatorBotId === botId ||
        (g.workplace.kind === "folder" && g.workplace.botId === botId)
      )
        throw new TypeError("Cannot remove required member");
      // Keep historical memberships so completed tasks and per-Bot sessions retain their ownership.
      if (
        this.db
          .prepare(
            "SELECT 1 FROM group_tasks WHERE group_id=? AND assignee_bot_id=? AND status='open' LIMIT 1",
          )
          .get(groupId, botId)
      )
        throw new TypeError("Cancel member tasks first");
      this.db
        .prepare(
          "UPDATE group_members SET left_at=? WHERE group_id=? AND bot_id=? AND left_at IS NULL",
        )
        .run(new Date().toISOString(), groupId, botId);
      this.touch(groupId);
      return this.required(groupId);
    });
  }
  remove(groupId: string): CleanupManifest {
    return transaction(this.db, () => {
      this.required(groupId);
      // Workflow source messages are required references; remove the owning DAG before messages.
      this.db.prepare("DELETE FROM group_workflow_runs WHERE group_id=?").run(groupId);
      const cleanup = deleteConversations(this.db, "group_id", groupId);
      this.db.prepare("DELETE FROM sidebar_entries WHERE chat_group_id=?").run(groupId);
      this.db.prepare("DELETE FROM settings WHERE key=? OR key=? OR key=? OR key LIKE ?").run(
        `group-plan-attempts:${groupId}`,
        `group-verification:${groupId}`,
        `group-verification-assignment:${groupId}`,
        // One dedupe row per cycle/run/cause for "verification could not start".
        `group-verification-unstarted:${groupId}:%`,
      );
      this.db.prepare("DELETE FROM groups WHERE id=?").run(groupId);
      return cleanup;
    });
  }
  private activeBot(id: string): void {
    if (!this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(id))
      throw new TypeError("Unknown active Bot");
  }
  private required(id: string): Group {
    const g = this.get(id);
    if (!g) throw new TypeError("Unknown group");
    return g;
  }
  private touch(id: string): void {
    this.db.prepare("UPDATE groups SET updated_at=? WHERE id=?").run(new Date().toISOString(), id);
  }
  private workplace(g: Group): void {
    const w = g.workplace;
    if (
      w.kind === "folder" &&
      (!g.members.some((m) => m.botId === w.botId) ||
        (w.folderId !== "home" &&
          !this.db
            .prepare("SELECT 1 FROM working_folders WHERE id=? AND bot_id=?")
            .get(w.folderId, w.botId)))
    )
      throw new TypeError("Invalid group workplace");
  }
}
