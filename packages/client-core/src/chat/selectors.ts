import type { TranslationKey, TranslationVars } from "@pibot/i18n";
import {
  type ConversationYolo,
  canonicalImageModelId,
  chatReplyTo,
  imageApprovalDeclined,
  imageGenerationUsage,
  imageReplacementDeclined,
  type Message,
} from "@pibot/protocol";

import type { ChatState } from "./types.ts";
export function activeRun(state: ChatState) {
  // Queued replies are also persisted as streaming. The first outstanding run owns this
  // topic; later tool segments share its run id and must not make Stop pick a queued turn.
  const message = state.messages.find((message) => message.status === "streaming");
  return message?.runId;
}

export function currentImageModel(state: Pick<ChatState, "bot" | "imageModels">) {
  const bot = state.bot;
  if (bot?.category !== "image" || !bot.modelProvider || !bot.modelId) return undefined;
  const id = canonicalImageModelId(bot.modelProvider, bot.modelId);
  return state.imageModels.find((model) => model.provider === bot.modelProvider && model.id === id);
}

// Both sides come from the same RPC schema, so serialization is a faithful equality check; a
// differing key order only costs one extra re-render.
export function sameMessage(a: Message, b: Message) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function retryText(messages: Message[], messageId: string) {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return undefined;
  const reply = messages[index];
  const inputId = reply && chatReplyTo(reply);
  if (reply && inputId)
    return messages.find(
      (message) =>
        message.id === inputId &&
        message.role === "user" &&
        message.conversationId === reply.conversationId &&
        message.runId === reply.runId,
    )?.content;
  return messages.slice(0, index).findLast((message) => message.role === "user")?.content;
}

export function chatPermissionFailureText(
  usage: Message["usage"],
  externalAgent: boolean,
  translate: (key: TranslationKey, vars?: TranslationVars) => string,
) {
  if (externalAgent) return translate("externalAgents.errors.launchDenied");
  const replacement = imageReplacementDeclined(usage);
  if (replacement) return translate("media.error.replacementApprovalDetails", replacement);
  if (imageApprovalDeclined(usage)) return translate("media.error.approvalDeclined");
  if (imageGenerationUsage(usage)) return translate("media.error.permission_denied");
  // Older image refusals share this code with other denials and have no image marker.
  return translate("chat.requestNotAllowed");
}

export function yoloScopeUnavailable({ isolation }: ConversationYolo): boolean {
  return (
    !isolation.available &&
    (!isolation.reason ||
      isolation.reason === "runner_offline" ||
      isolation.reason === "isolation_unknown" ||
      isolation.reason === "isolation_check_unfinished" ||
      isolation.reason === "exec_closed")
  );
}

export function sameYoloScope(current: ConversationYolo, shown: ConversationYolo): boolean {
  return (
    current.isolation.available === shown.isolation.available &&
    current.isolation.reason === shown.isolation.reason &&
    current.windowsDirectRun === shown.windowsDirectRun
  );
}
