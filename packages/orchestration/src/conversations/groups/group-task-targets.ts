import { GroupToolError } from "@pibot/brain/orchestration-kit";
import { type Group, RpcError } from "@pibot/protocol-base";
import { ConversationsRepo } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/**
 * Target check for health-repair stale-task cleanup: the task must belong to `group`, its thread
 * and that thread's parent topic must belong to `group` and not be archived, and the task must
 * still be open. Unlike `taskTarget`, older non-current topics of the group are allowed.
 */
export function staleTaskTarget(service: GroupService, group: Group, taskId: string) {
  const task = service.tasks.get(taskId);
  const conversations = new ConversationsRepo(service.deps.db);
  const thread = task ? conversations.get(task.threadConversationId) : undefined;
  const topic = thread?.threadOf ? conversations.get(thread.threadOf) : undefined;
  if (
    !task ||
    task.groupId !== group.id ||
    !thread ||
    thread.kind !== "thread" ||
    thread.groupId !== group.id ||
    thread.archivedAt ||
    !topic ||
    topic.kind !== "group" ||
    topic.groupId !== group.id ||
    topic.archivedAt
  )
    throw new GroupToolError("这个群里没有该任务 / The task is not in this group.");
  if (task.status !== "open") throw new RpcError(-32011, "task_not_open");
  return task;
}

export function taskTarget(service: GroupService, group: Group, botId: string, taskId?: string) {
  if (taskId) {
    const task = service.tasks.get(taskId);
    const thread = task
      ? new ConversationsRepo(service.deps.db).get(task.threadConversationId)
      : undefined;
    if (
      !task ||
      task.groupId !== group.id ||
      thread?.threadOf !== group.conversationId ||
      thread.archivedAt
    )
      throw new GroupToolError("这个群里没有该任务 / The task is not in this group.");
    if (task.assigneeBotId !== botId && botId !== group.coordinatorBotId)
      throw new GroupToolError(
        "只能完成分派给你自己的任务 / You may only finish tasks assigned to you.",
      );
    return task;
  }
  const tasks = service.tasks.openForBot(group.id, botId, { limit: 50 });
  if (!tasks.length)
    throw new GroupToolError("你在这个群没有未完成的任务 / You have no open task in this group.");
  if (tasks.length > 1)
    throw new GroupToolError(
      `请指定任务；可选标题 / Specify taskId; available titles: ${JSON.stringify(tasks.map((t) => ({ title: t.title, taskId: t.id })))}。ID仅供调用，不要展示给用户 / IDs are internal; never show them to the user.`,
    );
  const task = tasks[0];
  if (!task) throw new GroupToolError("No open task / 没有未完成任务");
  return task;
}

export function reminderTarget(
  service: GroupService,
  group: Group,
  botId: string,
  taskId?: string,
) {
  const open = service.tasks.openForBot(group.id, botId, { limit: 2 });
  if (!taskId && !open.length) return undefined;
  const task = taskTarget(service, group, botId, taskId);
  if (task.assigneeBotId !== botId || task.status !== "open")
    throw new GroupToolError("请选择这个成员未完成的任务 / Select this member's open task.");
  return task;
}
