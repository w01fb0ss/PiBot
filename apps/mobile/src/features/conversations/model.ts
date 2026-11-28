import type { Bot, Group, Message } from "@pibot/protocol";
import { z } from "zod";
import type { AvatarLook } from "../../ui/avatar.tsx";

/** Image avatars kept in the list cache: an agent's logo is ~10 KB; larger uploads draw the shape. */
const CACHED_IMAGE_MAX = 64 * 1024;
const LookSchema = z.object({
  name: z.string().max(200),
  shape: z.string().max(200),
  color: z.string().max(200),
  eyes: z.string().max(200),
  image: z.string().max(CACHED_IMAGE_MAX).optional(),
});
const PreviewSchema = z.object({
  text: z.string().max(400),
  role: z.enum(["user", "assistant", "error"]),
  status: z.enum(["streaming", "done", "error", "aborted"]),
  at: z.string().max(40),
});
export const ConversationSchema = z.object({
  key: z.string().max(80),
  kind: z.enum(["bot", "group"]),
  id: z.uuid(),
  name: z.string().max(200),
  looks: z.array(LookSchema).max(6),
  /** Group: member Bot IDs in group order, for the composer's @ list. */
  memberIds: z.array(z.uuid()).max(6).optional(),
  /** Group: the current topic's conversation; a DM topic comes from topics.list. */
  topicId: z.uuid().optional(),
  modelId: z.string().max(200).nullable().optional(),
  /** The main Bot, marked with the violet star as in the desktop sidebar. */
  main: z.boolean().optional(),
  /** Pinned in the desktop sidebar (`sidebar.list` pinnedAt). */
  pinned: z.boolean().optional(),
  /** Position in the desktop sidebar response. Older caches only have the pin flag. */
  pinOrder: z.number().int().nonnegative().optional(),
  /** Unread on the computer (`sidebar.list`), stored so a cold start shows the marks too. */
  unread: z.boolean().optional(),
  /** An external agent Bot; it runs only on the computer (never on the phone's own model). */
  agent: z.boolean().optional(),
  updatedAt: z.string().max(40),
  preview: PreviewSchema.optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
export type Preview = z.infer<typeof PreviewSchema>;
export const CachedConversationsSchema = z.array(ConversationSchema).max(400);

export const conversationKey = (kind: "bot" | "group", id: string) =>
  `${kind === "bot" ? "dm" : "group"}:${id}`;
export function botLook(
  bot: Pick<Bot, "name" | "avatarShape" | "avatarColor" | "avatarEyes" | "avatarImage">,
): AvatarLook {
  return {
    name: bot.name,
    shape: bot.avatarShape,
    color: bot.avatarColor,
    eyes: bot.avatarEyes,
    ...(bot.avatarImage && bot.avatarImage.length <= CACHED_IMAGE_MAX
      ? { image: bot.avatarImage }
      : {}),
  };
}
export function botRow(bot: Bot): Conversation {
  return {
    key: conversationKey("bot", bot.id),
    kind: "bot",
    id: bot.id,
    name: bot.name,
    looks: [botLook(bot)],
    modelId: bot.modelId,
    main: bot.isMain,
    ...(bot.kind === "agent" ? { agent: true } : {}),
    updatedAt: bot.updatedAt,
  };
}
export function groupRow(group: Group, bots: Map<string, Bot>): Conversation {
  const members = [...group.members]
    .sort((a, b) => a.position - b.position)
    .flatMap((member) => {
      const bot = bots.get(member.botId);
      return bot ? [bot] : [];
    });
  const looks = members.map(botLook);
  return {
    key: conversationKey("group", group.id),
    kind: "group",
    id: group.id,
    name: group.name,
    looks,
    memberIds: members.map((bot) => bot.id),
    topicId: group.conversationId,
    updatedAt: group.updatedAt,
  };
}
/**
 * B16 (phone 2026-11-14): previews showed raw Markdown (`**name**`). One line of plain text:
 * block marks at line starts go first (before lines are joined), then inline marks. Copies stored
 * by older builds are already one line, so this runs again when a row is drawn.
 */
export function plainPreview(text: string) {
  return text
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/^\s*(?:```|~~~).*$/gm, "")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/(^|\W)__(?=\S)([^\n]*?\S)__(?!\w)/g, "$1$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
    .replace(/`+([^`\n]+)`+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
export function preview(message: Message): Preview {
  return {
    // Previews are one line; never keep a long reply in the list cache.
    text: plainPreview(message.content).slice(0, 400),
    role: message.role,
    status: message.status,
    at: message.updatedAt,
  };
}
export function lastActivity(row: Conversation) {
  return Math.max(Date.parse(row.updatedAt) || 0, Date.parse(row.preview?.at ?? "") || 0);
}
