import { z } from "zod";
import { BotSchema } from "../bots/bot.ts";
import { ConversationSchema, MessageSchema } from "../chat/entities.ts";
import { SafeSecretSchema, WebUrlSchema } from "../core/values.ts";
import { GroupSchema } from "../groups/group.ts";
import { SearchConfigSchema } from "../providers/auth.ts";

const label = z.string().trim().min(1).max(200);
const ok = z.strictObject({ ok: z.literal(true) });
const SearchConversationSchema = ConversationSchema.pick({
  id: true,
  kind: true,
  botId: true,
  groupId: true,
  title: true,
  readOnly: true,
  importSource: true,
});
export const SearchMethods = {
  "search.query": {
    params: z.strictObject({
      query: label,
      limit: z.number().int().min(1).max(200).optional(),
      /** Continues the message matches after the previous page; chats are only on the first page. */
      cursor: z.string().min(1).max(256).optional(),
    }),
    result: z.strictObject({
      topics: z.array(SearchConversationSchema).max(200).optional(),
      /** Owners of `messages`, so a result row can name its Bot / group / topic; older brains omit it. */
      conversations: z.array(SearchConversationSchema).max(200).optional(),
      bots: z.array(BotSchema).max(200),
      groups: z.array(GroupSchema).max(200),
      messages: z.array(MessageSchema).max(200),
      /** More (older) messages may match; older brains omit it. */
      nextCursor: z.string().max(256).nullable().optional(),
    }),
  },
  "search.getConfig": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: SearchConfigSchema.nullable(),
  },
  "search.setConfig": {
    params: z.union([
      z.strictObject({ provider: z.enum(["keyless", "duckduckgo", "bing"]) }),
      z.strictObject({
        provider: z.enum(["brave", "tavily", "keenable"]),
        apiKey: SafeSecretSchema.optional(),
      }),
      z.strictObject({ provider: z.literal("searxng"), baseUrl: WebUrlSchema }),
    ]),
    result: SearchConfigSchema,
  },
  "search.disclose": {
    params: z.strictObject({
      provider: z.enum(["brave", "tavily", "keenable", "searxng", "duckduckgo", "bing"]),
      expectedEndpoint: WebUrlSchema.optional(),
    }),
    result: ok,
  },
  "search.removeConfig": { params: z.union([z.undefined(), z.strictObject({})]), result: ok },
} as const;
