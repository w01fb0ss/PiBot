import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { optionalPageBefore } from "../tools/pagination.ts";
import { AttachmentSchema } from "./attachments.ts";
import {
  ReadHistoryImportSchema,
  ReadMessagesSearchInputSchema,
  ReadMessagesSearchResultSchema,
} from "./chat-search.ts";
import { MAX_GENERATED_IMAGES } from "./media.ts";

const page = {
  before: optionalPageBefore,
  limit: z.number().int().min(1).max(50).optional(),
};
export const ReadMessagesInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("list"), ...page }),
  z.strictObject({ mode: z.literal("messages"), conversationId: IdSchema, ...page }),
  ReadMessagesSearchInputSchema,
]);
export const ReadConversationSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(["dm", "group", "thread"]),
  title: z.string().max(200),
  importedFrom: ReadHistoryImportSchema.optional(),
  groupId: IdSchema.nullable(),
  threadOf: IdSchema.nullable(),
});
export const ReadMessageSchema = z.strictObject({
  id: IdSchema,
  role: z.enum(["user", "assistant"]),
  botId: IdSchema.nullable(),
  content: z.string().max(4000),
  createdAt: z.iso.datetime(),
  importedFrom: ReadHistoryImportSchema.optional(),
  truncated: z.boolean(),
  attachments: z.array(AttachmentSchema).max(MAX_GENERATED_IMAGES),
});
export const ReadMessagesResultSchema = z.discriminatedUnion("mode", [
  ReadMessagesSearchResultSchema,
  z.strictObject({
    mode: z.literal("list"),
    conversations: z.array(ReadConversationSchema).max(50),
    nextBefore: IdSchema.nullable(),
  }),
  z.strictObject({
    mode: z.literal("messages"),
    conversationId: IdSchema,
    messages: z.array(ReadMessageSchema).max(50),
    nextBefore: IdSchema.nullable(),
  }),
]);
export type ReadMessagesInput = z.infer<typeof ReadMessagesInputSchema>;
export type ReadMessagesResult = z.infer<typeof ReadMessagesResultSchema>;
