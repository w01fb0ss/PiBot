import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type GroupTask,
  GroupTaskSchema,
  type KernelMethodParams,
  type ModelOverride,
  ModelOverrideSchema,
  type Page,
  PageSchema,
} from "@pibot/protocol-base";
import { ConversationsRepo } from "../conversations/conversations.ts";
import { transaction } from "../database/database.ts";
import { readPage } from "../database/paging.ts";
import { GroupTaskSourcesRepo } from "./group-task-sources.ts";
import { GroupsRepo } from "./groups.ts";

const taskColumns =
  "execution_mode AS executionMode,id,group_id AS groupId,thread_conversation_id AS threadConversationId,assignee_bot_id AS assigneeBotId,title,instructions,status,summary,created_by_bot_id AS createdByBotId,created_at AS createdAt,finished_at AS finishedAt,quiet_at AS quietAt,model_override AS modelOverride";
export class GroupTasksRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly redact: (text: string) => string,
  ) {}
  get(id: string): GroupTask | undefined {
    const row = this.db.prepare(`SELECT ${taskColumns} FROM group_tasks WHERE id=?`).get(id);
    return row ? new GroupTaskSourcesRepo(this.db).decorate(row) : undefined;
  }
  setTaskModel(id: string, override: ModelOverride | null) {
    this.db
      .prepare("UPDATE group_tasks SET model_override=? WHERE id=?")
      .run(override ? JSON.stringify(ModelOverrideSchema.parse(override)) : null, id);
  }
  forThread(threadId: string): GroupTask | undefined {
    const row = this.db
      .prepare(`SELECT ${taskColumns} FROM group_tasks WHERE thread_conversation_id=?`)
      .get(threadId);
    return row ? new GroupTaskSourcesRepo(this.db).decorate(row) : undefined;
  }
  openForBot(groupId: string, botId: string, page: Page = {}) {
    return readPage(
      this.db,
      "group_tasks",
      taskColumns,
      "created_at",
      page,
      [
        ["group_id", groupId],
        ["assignee_bot_id", botId],
        [
          "(SELECT thread_of FROM conversations WHERE id=thread_conversation_id)",
          new ConversationsRepo(this.db).forGroup(groupId)?.id ?? "",
        ],
        ["status", "open"],
      ],
      [
        ["group_id", groupId],
        ["assignee_bot_id", botId],
        [
          "(SELECT thread_of FROM conversations WHERE id=thread_conversation_id)",
          new ConversationsRepo(this.db).forGroup(groupId)?.id ?? "",
        ],
        ["status", "open"],
      ],
    ).map((row) => new GroupTaskSourcesRepo(this.db).decorate(row));
  }
  findOpenTitle(groupId: string, botId: string, title: string) {
    const normalized = (value: string) => value.replace(/[\s\p{P}]/gu, "");
    const key = normalized(this.redact(title));
    let before: string | undefined;
    for (;;) {
      const page = this.openForBot(groupId, botId, { before, limit: 200 });
      const match = page.find((task) => normalized(task.title) === key);
      if (match || page.length < 200) return match;
      before = page.at(-1)?.id;
    }
  }
  cancelOpen(groupId: string, botId?: string): GroupTask[] {
    const result: GroupTask[] = [];
    // Cursor ownership is stable even after each page's task status changes.
    let before: string | undefined;
    for (;;) {
      const page = this.list(groupId, { before, limit: 200 }, "open");
      for (const task of page)
        if (!botId || task.assigneeBotId === botId)
          result.push(this.finish(task.id, task.assigneeBotId, "cancelled"));
      if (page.length < 200) break;
      before = page.at(-1)?.id;
    }
    return result;
  }
  bindSource(taskId: string, runId: string) {
    new GroupTaskSourcesRepo(this.db).bind(taskId, runId);
    return this.get(taskId) as GroupTask;
  }
  bindUserSource(taskId: string, messageId: string) {
    new GroupTaskSourcesRepo(this.db).bindUser(taskId, messageId);
    return this.get(taskId) as GroupTask;
  }
  serialFallback(taskId: string) {
    this.db
      .prepare(
        "UPDATE group_tasks SET execution_mode='serial' WHERE id=? AND status='open' AND execution_mode='parallel'",
      )
      .run(taskId);
    return this.get(taskId);
  }
  hasPendingChildren(taskId: string) {
    return new GroupTaskSourcesRepo(this.db).hasPendingChildren(taskId);
  }
  summary(params: KernelMethodParams["groups.tasks.summary"]) {
    return new GroupTaskSourcesRepo(this.db).summary(params);
  }
  list(
    groupId: string,
    page: Page = {},
    status?: GroupTask["status"],
    filter: Pick<KernelMethodParams["groups.tasks"], "origin" | "section"> = {},
  ): GroupTask[] {
    if (filter.origin || filter.section) {
      const { before, limit = 50 } = PageSchema.parse(page);
      const cursor = before
        ? this.db
            .prepare("SELECT created_at FROM group_tasks WHERE id=? AND group_id=?")
            .get(before, groupId)
        : undefined;
      if (before && !cursor) return [];
      return this.db
        .prepare(`SELECT ${taskColumns} FROM group_tasks WHERE group_id=?
        AND thread_conversation_id IN (SELECT id FROM conversations WHERE thread_of=?)
        AND quiet_at IS NULL
        AND (? IS NULL OR status=?) AND (? IS NULL OR (status='open')=(?='open'))
        AND (? IS NULL OR id IN (SELECT task_id FROM group_task_sources WHERE kind=?))
        AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(
          groupId,
          new ConversationsRepo(this.db).forGroup(groupId)?.id ?? "",
          status ?? null,
          status ?? null,
          filter.section ?? null,
          filter.section ?? null,
          filter.origin ?? null,
          filter.origin ?? null,
          before ?? null,
          cursor?.created_at ?? "",
          cursor?.created_at ?? "",
          before ?? "",
          limit,
        )
        .map((row) => new GroupTaskSourcesRepo(this.db).decorate(row));
    }
    // A quiet task is bookkeeping for a plain chat reply, so the task panel never lists one.
    const filters: [string, string | null][] = [
      ["group_id", groupId],
      [
        "(SELECT thread_of FROM conversations WHERE id=thread_conversation_id)",
        new ConversationsRepo(this.db).forGroup(groupId)?.id ?? "",
      ],
      ["quiet_at", null],
    ];
    if (status !== undefined) filters.push(["status", GroupTaskSchema.shape.status.parse(status)]);
    return readPage(this.db, "group_tasks", taskColumns, "created_at", page, filters, [
      ["group_id", groupId],
    ]).map((r) => new GroupTaskSourcesRepo(this.db).decorate(r));
  }
  /** Whole-group lifecycle operations must include tasks in inactive and archived topics. */
  listForGroup(groupId: string, page: Page = {}, status?: GroupTask["status"]): GroupTask[] {
    const filters: [string, string][] = [["group_id", groupId]];
    if (status !== undefined) filters.push(["status", GroupTaskSchema.shape.status.parse(status)]);
    return readPage(this.db, "group_tasks", taskColumns, "created_at", page, filters, [
      ["group_id", groupId],
    ]).map((row) => new GroupTaskSourcesRepo(this.db).decorate(row));
  }
  create(
    input: Pick<
      GroupTask,
      "groupId" | "assigneeBotId" | "title" | "instructions" | "createdByBotId" | "executionMode"
    >,
  ): GroupTask {
    return transaction(this.db, () => {
      const group = new GroupsRepo(this.db).get(input.groupId);
      if (!group) throw new TypeError("Unknown group");
      if (group.coordinatorBotId !== input.createdByBotId)
        throw new TypeError("Only coordinator assigns tasks");
      if (!group.members.some((m) => m.botId === input.assigneeBotId))
        throw new TypeError("Assignee must be an active member");
      const thread = new ConversationsRepo(this.db).createGroup(
          input.groupId,
          group.conversationId,
        ),
        now = new Date().toISOString();
      const v = GroupTaskSchema.parse({
        ...input,
        executionMode: input.executionMode ?? "serial",
        title: this.redact(input.title),
        instructions: this.redact(input.instructions),
        id: randomUUID(),
        threadConversationId: thread.id,
        status: "open",
        summary: null,
        createdAt: now,
        finishedAt: null,
      });
      this.db
        .prepare(
          "INSERT INTO group_tasks(execution_mode,id,group_id,thread_conversation_id,assignee_bot_id,title,instructions,status,summary,created_by_bot_id,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          v.executionMode ?? "serial",
          v.id,
          v.groupId,
          v.threadConversationId,
          v.assigneeBotId,
          v.title,
          v.instructions,
          v.status,
          v.summary,
          v.createdByBotId,
          now,
          null,
        );
      return v;
    });
  }
  /**
   * A member whose whole reply was plain chat ends its direct task without a result. Only a
   * task bound to the user's own request can be quiet; an assignment, plan step or thread
   * supplement is real work and keeps its normal completion.
   */
  closeQuiet(id: string, botId: string): GroupTask | undefined {
    return transaction(this.db, () => {
      const task = this.get(id);
      if (!task || task.assigneeBotId !== botId) throw new TypeError("Wrong task owner");
      if (task.status !== "open" || task.source?.kind !== "user") return undefined;
      const now = new Date().toISOString();
      const { changes } = this.db
        .prepare(
          `UPDATE group_tasks SET status='done',finished_at=?,quiet_at=? WHERE id=? AND status='open'
          AND id IN (SELECT task_id FROM group_task_sources WHERE kind='user')`,
        )
        .run(now, now, id);
      return changes ? this.get(id) : undefined;
    });
  }
  finish(
    id: string,
    botId: string,
    status: "done" | "cancelled",
    summary: string | null = null,
  ): GroupTask {
    return transaction(this.db, () => {
      const task = this.get(id);
      if (!task || task.assigneeBotId !== botId) throw new TypeError("Wrong task owner");
      if (task.status !== "open") return task;
      const v = GroupTaskSchema.parse({
        ...task,
        status,
        summary:
          summary === null
            ? null
            : this.redact(summary)
                .slice(0, 16000)
                .replace(/[\uD800-\uDBFF]$/, ""),
        finishedAt: new Date().toISOString(),
      });
      this.db
        .prepare(
          "UPDATE group_tasks SET status=?,summary=?,finished_at=? WHERE id=? AND status='open'",
        )
        .run(v.status, v.summary, v.finishedAt, id);
      return v;
    });
  }
}
