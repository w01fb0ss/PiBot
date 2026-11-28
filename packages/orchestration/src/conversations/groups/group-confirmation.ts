import type { ChatConfirmation, QueueInput } from "@pibot/brain/orchestration-kit";
import { type UserMessageDisplay, userMessageUsage } from "@pibot/brain/orchestration-kit";
import { RpcError } from "@pibot/protocol-base";
import { BotsRepo, MessagesRepo, transaction } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/** Acceptance is a notice, not a new instruction that starts or replaces group collaboration. */
export async function confirmGroupNotice(
  service: GroupService,
  preparing: Map<string, AbortController>,
  target: {
    groupId: string;
    conversationId: string;
    botId: string;
    text: string;
    display?: UserMessageDisplay;
  },
  confirmation: ChatConfirmation,
  controller: AbortController,
): Promise<void> {
  const { groupId, conversationId, botId } = target;
  const { signal } = confirmation;
  signal.throwIfAborted();
  if (service.changing(groupId) || preparing.has(groupId))
    throw new RpcError(-32011, "Group message preparing");
  const group = service.active(groupId, botId, conversationId);
  if (group.conversationId !== conversationId)
    throw new RpcError(-32602, "routine_proposal_group_thread_unsupported");
  const membership = JSON.stringify(group.members);
  preparing.set(groupId, controller);
  try {
    const queue = service.deps.chat.queue;
    queue.capacity([botId]);
    queue.assertTopicAdmission(conversationId);
    const { bot } = await service.model(botId, signal, undefined, { groupId, conversationId });
    await confirmation.beforeCommit();
    signal.throwIfAborted();
    const result = transaction(service.deps.db, () => {
      const current = service.active(groupId, botId, conversationId);
      const latest = new BotsRepo(service.deps.db).get(botId);
      if (
        service.changing(groupId) ||
        current.coordinatorBotId !== group.coordinatorBotId ||
        JSON.stringify(current.members) !== membership ||
        !latest ||
        latest.archivedAt ||
        latest.modelProvider !== bot.modelProvider ||
        latest.modelId !== bot.modelId ||
        latest.category !== bot.category ||
        latest.thinkingLevel !== bot.thinkingLevel
      )
        throw new RpcError(-32602, "routine_proposal_unavailable");
      // No capacity re-check here: a folder-trigger confirmation pauses the Bot in beforeCommit and
      // only commit() (via the routine proposal's release) lifts the pause; queue.insert re-checks
      // capacity right after commit, same as the private-chat path.
      queue.assertTopicAdmission(conversationId);
      confirmation.commit();
      const text = service.deps.redactor.redact(target.text);
      const user = new MessagesRepo(service.deps.db).create({
        conversationId,
        role: "user",
        content: text,
        status: "done",
        mentions: [botId],
        markUnread: false,
        ...userMessageUsage(undefined, target.display),
      });
      const input: QueueInput = {
        userInitiated: true,
        bot,
        conversationId,
        groupId,
        userMessageId: user.id,
        text,
      };
      return { input, record: queue.insert(input) };
    });
    queue.publish(result.record, result.input);
    service.deps.chat.openConversation(conversationId);
    service.changed(groupId, "updated");
  } finally {
    if (preparing.get(groupId) === controller) preparing.delete(groupId);
  }
}
