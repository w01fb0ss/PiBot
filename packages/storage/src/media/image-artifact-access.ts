import type { DatabaseSync } from "node:sqlite";
import { MAX_GENERATED_IMAGES } from "@pibot/protocol-base";
import { BotsRepo } from "../bots/bots.ts";
import { AttachmentsRepo } from "../conversations/attachments.ts";
import { ConversationsRepo } from "../conversations/conversations.ts";
import { GroupTasksRepo } from "../groups/group-tasks.ts";
import { GroupsRepo } from "../groups/groups.ts";
import { RunsRepo } from "../runs/runs.ts";
import { MessagesRepo } from "../workspace/repositories.ts";
import type { ImageArtifactActor, ImageArtifactRecord } from "./image-artifact-types.ts";

/** Access is checked against live storage, never inferred from a remembered group/model context. */
export function resolveArtifactSource(
  db: DatabaseSync,
  artifact: ImageArtifactRecord,
  actor: ImageArtifactActor,
  ids?: string[],
) {
  const source = artifact.target.source,
    message = new MessagesRepo(db).get(source.messageId),
    run = new RunsRepo(db).get(source.runId),
    bots = new BotsRepo(db);
  const owner = bots.get(source.botId),
    current = bots.get(actor.botId),
    conversation = new ConversationsRepo(db).get(actor.conversationId),
    sourceConversation = new ConversationsRepo(db).get(source.conversationId);
  const usage = message?.usage;
  if (
    !owner ||
    !artifact.generatedAt ||
    owner.archivedAt ||
    owner.category !== "image" ||
    !current ||
    current.archivedAt ||
    !message ||
    message.botId !== source.botId ||
    message.runId !== source.runId ||
    message.conversationId !== source.conversationId ||
    message.role !== "assistant" ||
    !run ||
    run.botId !== source.botId ||
    run.messageId !== source.messageId ||
    run.conversationId !== source.conversationId ||
    run.groupId !== (source.groupId ?? null) ||
    run.taskId !== (source.taskId ?? null) ||
    run.cycleId !== (source.cycleId ?? null) ||
    !usage ||
    typeof usage !== "object" ||
    Array.isArray(usage) ||
    usage.imageGeneration !== true ||
    !conversation ||
    conversation.archivedAt ||
    !sourceConversation ||
    sourceConversation.archivedAt
  )
    throw new TypeError("image_artifact_source_invalid");
  const initial =
    actor.runId === source.runId &&
    actor.botId === source.botId &&
    actor.conversationId === source.conversationId &&
    run.status === "running" &&
    message.status === "streaming";
  const recovered =
    ["error", "aborted"].includes(run.status) &&
    ["done", "error", "aborted"].includes(message.status);
  if (
    !initial &&
    !recovered &&
    (message.status !== "done" || run.status !== "done" || run.stopReason !== "stop")
  )
    throw new TypeError("image_artifact_not_published");
  let sourceTaskId = source.taskId;
  if (source.groupId) {
    const group = new GroupsRepo(db).get(source.groupId),
      tasks = new GroupTasksRepo(db, (value) => value);
    if (
      !group ||
      sourceConversation.groupId !== group.id ||
      !["group", "thread"].includes(sourceConversation.kind) ||
      (sourceConversation.kind === "group" && sourceConversation.id !== group.conversationId) ||
      (sourceConversation.kind === "thread" ? sourceConversation.id : undefined) !==
        source.threadId ||
      (sourceConversation.kind === "thread" &&
        sourceConversation.threadOf !== group.conversationId) ||
      actor.groupId !== source.groupId ||
      conversation.groupId !== source.groupId ||
      !["group", "thread"].includes(conversation.kind) ||
      (conversation.kind === "group" && conversation.id !== group.conversationId) ||
      (conversation.kind === "thread" ? conversation.id : undefined) !== actor.threadId ||
      (conversation.kind === "thread" && conversation.threadOf !== group.conversationId)
    )
      throw new TypeError("image_artifact_not_visible");
    const sourceTask = source.threadId ? tasks.forThread(source.threadId) : undefined;
    sourceTaskId ??= sourceTask?.id;
    if (
      (source.taskId && sourceTask?.id !== source.taskId) ||
      (source.threadId &&
        (!sourceTask ||
          sourceTask.groupId !== group.id ||
          sourceTask.assigneeBotId !== source.botId ||
          sourceTask.status === "cancelled" ||
          sourceTask.threadConversationId !== source.conversationId))
    )
      throw new TypeError("image_artifact_not_visible");
    if (actor.threadId) {
      const task = tasks.forThread(actor.threadId);
      if (
        !task ||
        task.groupId !== group.id ||
        task.status === "cancelled" ||
        (task.assigneeBotId !== actor.botId && group.coordinatorBotId !== actor.botId)
      )
        throw new TypeError("image_artifact_not_visible");
    }
    for (const botId of [source.botId, actor.botId])
      if (
        !db
          .prepare("SELECT 1 FROM group_members WHERE group_id=? AND bot_id=? AND left_at IS NULL")
          .get(source.groupId, botId)
      )
        throw new TypeError("image_artifact_not_visible");
  } else if (
    actor.groupId ||
    sourceConversation.kind !== "dm" ||
    sourceConversation.botId !== source.botId ||
    source.threadId ||
    source.taskId ||
    actor.botId !== source.botId ||
    conversation.kind !== "dm" ||
    conversation.botId !== source.botId
  )
    throw new TypeError("image_artifact_not_visible");
  const metadata = message.attachments?.filter((item) => item.kind === "image") ?? [];
  const requested = ids ?? metadata.map((item) => item.id);
  if (
    !requested.length ||
    requested.length > MAX_GENERATED_IMAGES ||
    new Set(requested).size !== requested.length
  )
    throw new TypeError("image_artifact_attachments_invalid");
  const attachments = requested.map((id) => {
    const attachment = new AttachmentsRepo(db).get(id);
    if (
      !attachment ||
      attachment.botId !== source.botId ||
      attachment.messageId !== source.messageId ||
      attachment.metadata.kind !== "image" ||
      !metadata.some((item) => item.id === id)
    )
      throw new TypeError("image_artifact_attachments_invalid");
    if (
      !initial &&
      source.groupId &&
      source.threadId &&
      !db
        .prepare(
          `SELECT 1 FROM message_attachment_links l JOIN messages m ON m.id=l.message_id JOIN conversations c ON c.id=m.conversation_id JOIN group_task_results r ON r.message_id=m.id JOIN group_tasks t ON t.id=r.task_id WHERE l.attachment_id=? AND c.kind='group' AND c.group_id=? AND m.role='assistant' AND m.status='done' AND m.bot_id=? AND t.id=? AND t.thread_conversation_id=? AND t.assignee_bot_id=? AND t.group_id=c.group_id AND t.status!='cancelled'`,
        )
        .get(id, source.groupId, source.botId, sourceTaskId ?? "", source.threadId, source.botId)
    )
      throw new TypeError("image_artifact_not_published");
    return attachment;
  });
  return { artifact, message, attachments };
}
