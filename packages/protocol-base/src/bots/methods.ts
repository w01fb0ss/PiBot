import { z } from "zod";
import { BotCategorySchema, ImageModeSchema } from "../chat/media.ts";
import { IdSchema } from "../core/ids.ts";
import { PageSchema } from "../core/page.ts";
import { BotPermissionOverridesSchema } from "../permissions/settings.ts";
import { ModelPreferenceSchema, ThinkingLevelSchema } from "../providers/providers.ts";
import { BotSchema } from "./bot.ts";
import { MemoryProposalSchema, MemorySchema } from "./memory.ts";

const ok = z.strictObject({ ok: z.literal(true) });
const botId = z.strictObject({ botId: IdSchema });
export const BotMethods = {
  "bots.create": {
    params: z.strictObject({
      description: z.string().trim().min(1).max(4000),
      name: z.string().trim().min(1).max(200).optional(),
      avatarShape: z.string().max(32).optional(),
      avatarColor: z.string().max(32).optional(),
      systemPrompt: z.string().trim().min(1).max(100000).optional(),
      norms: z.string().trim().max(20000).optional(),
      category: BotCategorySchema.default("chat"),
      imageMode: ImageModeSchema.optional(),
      model: ModelPreferenceSchema.optional(),
      defaultVideoModel: ModelPreferenceSchema.optional(),
      thinkingLevel: ThinkingLevelSchema.optional(),
    }),
    result: BotSchema,
  },
  "bots.duplicate": { params: botId, result: BotSchema },
  "bots.archived": { params: PageSchema, result: z.array(BotSchema).max(200) },
  "bots.restore": { params: botId, result: BotSchema },
  "bots.archive": { params: botId, result: ok },
  "bots.delete": { params: botId.extend({ confirmed: z.literal(true) }), result: ok },
  "bots.profile": {
    params: botId,
    result: z.strictObject({
      bot: BotSchema,
      memories: z.array(MemorySchema).max(100),
      proposals: z.array(MemoryProposalSchema).max(200),
      undoable: z.array(MemoryProposalSchema).max(100).optional(),
      permissionOverrides: BotPermissionOverridesSchema,
    }),
  },
} as const;
export const BotEvents = {
  "bots.changed": z.strictObject({
    botId: IdSchema,
    reason: z.enum(["created", "updated", "archived", "removed"]),
  }),
} as const;
