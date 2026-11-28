import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { AttachmentSchema } from "./attachments.ts";
import { MAX_GENERATED_IMAGES } from "./media.ts";

const source = { botId: IdSchema, conversationId: IdSchema, messageId: IdSchema };
export const ConversationRetryReceiptSchema = z.strictObject({
  requestId: IdSchema,
  state: z.enum(["pending", "done", "failed"]),
  botId: IdSchema,
  conversationId: IdSchema.nullable(),
});
export const ConversationRetryMethods = {
  "chat.retryPreview": {
    params: z.strictObject(source),
    result: z.strictObject({
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      fileCount: z.number().int().min(0).max(500),
      restoreFiles: z.boolean(),
    }),
  },
  "chat.retryFromMessage": {
    params: z.strictObject({
      ...source,
      requestId: IdSchema,
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      confirmed: z.literal(true),
    }),
    result: ConversationRetryReceiptSchema,
  },
  "chat.retryStatus": {
    params: z.strictObject({ ...source, requestId: IdSchema }),
    result: ConversationRetryReceiptSchema.nullable(),
  },
  "chat.retryDraft": {
    params: z.strictObject({ botId: IdSchema, conversationId: IdSchema }),
    result: z
      .strictObject({
        text: z.string().max(100000),
        attachments: z.array(AttachmentSchema).max(MAX_GENERATED_IMAGES),
      })
      .nullable(),
  },
} as const;
