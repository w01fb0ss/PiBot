import { z } from "zod";
import { BotCategorySchema, ImageModeSchema } from "../chat/media.ts";
import { IdSchema } from "../core/ids.ts";
import { BotPermissionOverridesSchema } from "../permissions/settings.ts";
import { ModelPreferenceSchema, ThinkingLevelSchema } from "../providers/providers.ts";
import { AvatarImageSchema } from "./app-profile.ts";

const name = z.string().min(1);
export const BOT_AVATAR_COLORS = [
  "orange",
  "amber",
  "blue",
  "violet",
  "pink",
  "teal",
  "green",
  "brown",
  "ink",
  "gray",
] as const;

export const BotSchema = z.strictObject({
  id: IdSchema,
  name,
  isMain: z.boolean(),
  category: BotCategorySchema.default("chat"),
  imageMode: ImageModeSchema.optional(),
  avatarShape: name,
  avatarColor: name,
  avatarEyes: name,
  avatarImage: AvatarImageSchema.nullable().optional(),
  modelProvider: name.nullable(),
  modelId: name.nullable(),
  defaultVideoModel: ModelPreferenceSchema.nullable().optional(),
  thinkingLevel: ThinkingLevelSchema,
  thinkingPreference: ThinkingLevelSchema.nullable().optional(),
  systemPrompt: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  permissionOverrides: BotPermissionOverridesSchema.optional(),
  description: z.string().max(4000).optional(),
  memoryMode: z.enum(["auto", "ask"]).optional(),
  /** Post-hoc extraction from finished topics is on unless the user turns it off. */
  memoryExtraction: z.boolean().optional(),
  archivedAt: z.iso.datetime().nullable().optional(),
  /** The built-in role this Bot was created from (a mark only; edits never sync back). */
  role: z
    .strictObject({
      id: z
        .string()
        .max(64)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      version: z.number().int().min(1).max(100000),
    })
    .nullable()
    .optional(),
  /** Working norms, stored and edited apart from the persona; follows it in the prompt. */
  norms: z.string().max(20000).optional(),
  /** Up to three starter prompts shown in an empty chat, in the creation language. */
  quickPrompts: z.array(z.string().trim().min(1).max(300)).max(3).optional(),
  /** The Bot that reviews this Bot's code; null / absent = recommend one. */
  reviewBotId: IdSchema.nullable().optional(),
  /** A turn that changed files asks the reviewer for a read-only review (off by default). */
  autoReview: z.boolean().optional(),
  /**
   * An external coding agent (Codex, Claude Agent, …) driven over ACP. It thinks with its own
   * account and model; absent for Pi Bot's own Bots. Set once at creation, never changed.
   */
  kind: z.literal("agent").optional(),
});
const label = z.string().trim().min(1).max(200);
export const BotPatchSchema = BotSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  isMain: true,
  category: true,
  archivedAt: true,
  role: true,
  quickPrompts: true,
  kind: true,
})
  .partial()
  .extend({
    name: label.optional(),
    avatarShape: label.optional(),
    avatarColor: label.optional(),
    avatarEyes: label.optional(),
    systemPrompt: z.string().max(100000).optional(),
  });
export type Bot = z.infer<typeof BotSchema>;
