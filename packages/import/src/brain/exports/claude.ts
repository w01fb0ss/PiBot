// Map Claude text and retain names and status from structured history.
import { z } from "zod";
import { ImportFailure } from "../adapter.ts";
import { attachmentParts, ImportedToolParts, MAX_HISTORY_PARTS } from "../history-parts.ts";
import { type ConversationItem, readableText } from "./text.ts";

const stamp = z.iso.datetime({ offset: true });
const conversation = z.object({
  sensitive: z.literal(true).optional().catch(undefined),
  excluded: z.literal(true).optional().catch(undefined),
  memory_excluded: z.literal(true).optional().catch(undefined),
  is_do_not_remember: z.literal(true).optional().catch(undefined),
  name: z.string().nullish(),
  created_at: stamp,
  updated_at: stamp.nullish(),
  chat_messages: z.array(z.unknown()),
  version: z.undefined().optional(),
  // Exports that link a chat to its project use either field; neither is required.
  project_uuid: z.string().max(120).nullish(),
  project: z.object({ uuid: z.string().max(120), name: z.string().nullish() }).nullish(),
});

export function claudeProjectKey(uuid: string) {
  return `claude:${uuid}`;
}
const message = z.object({
  sender: z.string(),
  text: z.string().nullish(),
  created_at: stamp.nullish(),
  content: z.array(z.unknown()).nullish(),
  attachments: z.array(z.unknown()).nullish(),
  files: z.array(z.unknown()).nullish(),
});
const block = z.object({ type: z.string(), text: z.string().optional() });

const mediaKinds = new Set(["image", "document", "audio", "video", "file", "attachment"]);

function* messageItems(
  raw: unknown,
  date: string,
  tools: ImportedToolParts,
): Generator<ConversationItem> {
  const parsed = message.safeParse(raw);
  if (!parsed.success) throw new ImportFailure("format");
  const item = parsed.data;
  if (item.sender !== "human" && item.sender !== "assistant") return;
  const parts: string[] = [];
  let media = 0;
  for (const rawBlock of item.content ?? []) {
    const content = block.safeParse(rawBlock);
    if (!content.success) continue;
    if (content.data.type === "text" && content.data.text) parts.push(content.data.text);
    if (mediaKinds.has(content.data.type)) media++;
  }
  const attachments = Math.max(media, (item.attachments?.length ?? 0) + (item.files?.length ?? 0));
  if (attachments) yield { kind: "attachments", count: attachments };
  const text = readableText(parts) || readableText([item.text ?? ""]);
  const historyParts = [
    ...tools.blocks(item.content),
    ...attachmentParts([...(item.attachments ?? []), ...(item.files ?? [])]),
  ].slice(0, MAX_HISTORY_PARTS);
  if (text || historyParts.length)
    yield {
      kind: "message",
      role: item.sender === "human" ? "user" : "assistant",
      text,
      ...(historyParts.length ? { historyParts } : {}),
      createdAt: item.created_at ?? date,
    };
}

export function* claudeConversation(
  raw: unknown,
  signal: AbortSignal,
): Generator<ConversationItem> {
  const parsed = conversation.safeParse(raw);
  if (!parsed.success) throw new ImportFailure("format");
  const { name, created_at, updated_at, chat_messages, project_uuid, project } = parsed.data;
  const uuid = project?.uuid || project_uuid;
  yield {
    kind: "topic",
    ...(parsed.data.sensitive ||
    parsed.data.excluded ||
    parsed.data.memory_excluded ||
    parsed.data.is_do_not_remember
      ? { memoryExcluded: true as const }
      : {}),
    title: (name ?? "").slice(0, 200),
    createdAt: created_at,
    updatedAt: updated_at ?? created_at,
    ...(uuid
      ? { project: { key: claudeProjectKey(uuid), name: (project?.name ?? "").slice(0, 200) } }
      : {}),
  };
  const tools = new ImportedToolParts();
  for (const chat of chat_messages) {
    signal.throwIfAborted();
    yield* messageItems(chat, created_at, tools);
  }
}
