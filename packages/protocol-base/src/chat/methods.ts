import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { PageSchema } from "../core/page.ts";
import { RunSchema } from "../execution/runs.ts";
import { ModelOverrideSchema } from "../providers/providers.ts";
import { ConversationSchema } from "./entities.ts";

const _botId = z.strictObject({ botId: IdSchema });
const _groupId = z.strictObject({ groupId: IdSchema });
const page = PageSchema;
export const ChatMethods = {
  "chat.topicModel.set": {
    params: z.strictObject({ conversationId: IdSchema, override: ModelOverrideSchema.nullable() }),
    result: ConversationSchema,
  },
  "chat.compact": {
    params: z.strictObject({
      botId: IdSchema,
      conversationId: IdSchema,
      requestId: IdSchema,
      fork: z.boolean(),
    }),
    result: z.strictObject({ conversationId: IdSchema, mechanical: z.boolean() }),
  },
  "chat.compact.cancel": {
    params: z.strictObject({ botId: IdSchema, conversationId: IdSchema, requestId: IdSchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  // The brain owns the token estimate; the UI only asks after a model switch and
  // reports the user's 「不用」 so the same topic and model stops asking. `modelProvider` /
  // `modelId` name the model that was on screen, so a save racing the click cannot file the
  // refusal under a model the user never saw.
  "chat.contextHint": {
    params: z.strictObject({
      botId: IdSchema,
      conversationId: IdSchema,
      dismiss: z.boolean().optional(),
      modelProvider: z.string().min(1).max(64).optional(),
      modelId: z.string().min(1).max(200).optional(),
    }),
    result: z.strictObject({ show: z.boolean() }),
  },
  "chat.runs": {
    params: page
      .extend({ botId: IdSchema.optional(), groupId: IdSchema.optional() })
      .refine((v) => !!v.botId !== !!v.groupId),
    result: z
      .array(RunSchema.omit({ sessionFile: true, triggerKey: true, ancestry: true }))
      .max(200),
  },
} as const;
export const ChatEvents = {
  "chat.activity": z.discriminatedUnion("phase", [
    z.strictObject({
      botId: IdSchema,
      conversationId: IdSchema,
      groupId: IdSchema.optional(),
      threadId: IdSchema.optional(),
      runId: IdSchema,
      messageId: IdSchema,
      phase: z.literal("waiting_model"),
      readingWindow: z.boolean().optional(),
    }),
    z.strictObject({
      botId: IdSchema,
      conversationId: IdSchema,
      groupId: IdSchema.optional(),
      threadId: IdSchema.optional(),
      runId: IdSchema,
      messageId: IdSchema,
      phase: z.literal("preparing_tool"),
      tool: z.string().min(1).max(200),
      characters: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.strictObject({
      botId: IdSchema,
      conversationId: IdSchema,
      groupId: IdSchema.optional(),
      threadId: IdSchema.optional(),
      runId: IdSchema,
      messageId: IdSchema,
      phase: z.literal("executing_tool"),
      tool: z.string().min(1).max(200),
    }),
    z.strictObject({
      botId: IdSchema,
      conversationId: IdSchema,
      groupId: IdSchema.optional(),
      threadId: IdSchema.optional(),
      runId: IdSchema,
      messageId: IdSchema,
      phase: z.literal("clear"),
    }),
  ]),
  "chat.status": z.strictObject({
    botId: IdSchema,
    conversationId: IdSchema,
    groupId: IdSchema.optional(),
    threadId: IdSchema.optional(),
    runId: IdSchema.nullable(),
    state: z.enum(["queued", "running", "idle"]),
    compacting: z.boolean().optional(),
    reconnecting: z
      .strictObject({
        attempt: z.number().int().min(1).max(100),
        // Mirrors the agent's retry setting so the UI never shows a stale ceiling.
        maxAttempts: z.number().int().min(1).max(100),
      })
      .refine((value) => value.attempt <= value.maxAttempts)
      .nullable()
      .optional(),
    messageId: IdSchema.optional(),
    queuePosition: z.number().int().positive().optional(),
  }),
} as const;
