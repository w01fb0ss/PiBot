import {
  BOT_AVATAR_COLORS,
  type CapabilityToolSpec,
  DispatchModelNeedsSchema,
  GROUP_PLAN_MAX_STEPS,
  GroupPlanStepSchema,
  IMAGE_GENERATION_GUIDANCE,
  ImageGenerationOptionsSchema,
  ModelOverrideSchema,
} from "@pibot/protocol-base";
import { z } from "zod";
import { optionalToolRef } from "./optional-ref.ts";
import { piManagerPrompts } from "./prompts/pi-manager.ts";

/** A Bot or group named by its id or its exact display name. */
const target = z.string().trim().min(1).max(200);
const optionalTarget = optionalToolRef(target);
const name = z.string().trim().min(1).max(60);
// Older dispatch calls can still be resumed with their original arguments.
const dispatchFolder = z
  .string()
  .min(1)
  .max(1024)
  .optional()
  .describe("Omit to inherit the recipient's workplace. Supply only a path the person gave you.");
const dispatchReason = z.string().trim().min(1).max(200).optional();
const modelChoice = {
  model: ModelOverrideSchema.optional(),
  needs: DispatchModelNeedsSchema.optional(),
  modelReason: dispatchReason,
};
const dispatchStep = z.strictObject({
  stepId: GroupPlanStepSchema.shape.id,
  bot: target,
  ...modelChoice,
  model: ModelOverrideSchema,
});

/**
 * The default Pi manages the person's Bots and groups and hands work to them (owner decision
 * 2026-11-24). `mainBotOnly`: the kernel offers these only in Pi's own direct chat typed by the
 * person on this computer, and policy refuses them anywhere else. Offered directly (no load group),
 * so no other Bot's tool catalog or prompt changes at all.
 */
export const piManagerTools = {
  team_list: {
    mainBotOnly: true,
    schema: z.strictObject({
      includeArchived: z.boolean().optional(),
      includeImageModels: z.boolean().optional(),
    }),
    description:
      "List the person's Bots and groups: id, name, role (one line), busy or idle, archived, and each group's members and coordinator. Set includeImageModels to list configured image model names and {provider,id} for a batch model override or comparison. Metadata only; no messages, memories, permissions or keys. No confirmation.",
    policy: { category: "bot_management", operation: "list" },
    attributes: { readOnly: true },
  },
  team_directory: {
    mainBotOnly: true,
    rule: piManagerPrompts.rule,
    schema: z.strictObject({ includeArchived: z.boolean().optional() }),
    description:
      "Read the routing directory: up to 60 Bots with role, model, thinkingLevel, modelAvailability {available, reason}, defaultVideoModel {provider, id, available} when set, abilities and state; 30 groups with purpose, members, coordinator and state; and 80 local or cached catalog roles/templates with their IDs and install status. Catalog installed means the pack is usable locally. Includes configured models with price per million tokens, tier, abilities and current availability. Metadata only, with local gateway reachability checks. No messages, memories, keys or confirmation.",
    policy: { category: "bot_management", operation: "list" },
    attributes: { readOnly: true },
  },
  bot_manage: {
    mainBotOnly: true,
    schema: z.strictObject({
      action: z.enum(["create", "update", "archive", "restore"]),
      /** The Bot to change (id or exact name); required except for create. */
      bot: optionalTarget,
      name: name.optional(),
      /** One-line role and duties; on create it also seeds the Bot's persona. */
      role: z.string().trim().min(1).max(2000).optional(),
      /** Full persona text, when the person dictated one. */
      persona: z.string().trim().min(1).max(20_000).optional(),
      /** "provider/model-id" from the available models, or "default". */
      model: z.string().trim().min(1).max(300).optional(),
      color: z.enum(BOT_AVATAR_COLORS).optional(),
    }),
    description:
      'Create, edit, archive or restore one of the person\'s Bots; the person confirms each call on a card. create: name and role (required), optional persona, model ("provider/id" or "default") and color. update: bot plus any of name, role, persona, model. archive / restore: bot. Permissions, keys and the default Pi itself cannot be changed; nothing can be deleted.',
    policy: { category: "bot_management", operation: "change" },
    attributes: { readOnly: false },
  },
  group_manage: {
    mainBotOnly: true,
    schema: z.strictObject({
      action: z.enum(["create", "add_members", "remove_members", "archive", "restore"]),
      /** The group to change (id or exact name); required except for create. */
      group: optionalTarget,
      name: name.optional(),
      /** Bot ids or exact names. create: 2–6 members; add/remove: the Bots to add or remove. */
      members: z.array(target).min(1).max(6).optional(),
      /** create only: the member who plans and hands out the group's work. */
      coordinator: optionalTarget,
      /** create only: the group's standing rules, shown to every member. */
      rules: z.string().trim().min(1).max(4000).optional(),
    }),
    description:
      "Create a group, add or remove members, archive or restore a group; the person confirms each call on a card. create: name and 2–6 members (plus optional coordinator and rules). add_members / remove_members: group and members. archive / restore: group. Nothing can be deleted.",
    policy: { category: "bot_management", operation: "change" },
    attributes: { readOnly: false },
  },
  catalog_install: {
    mainBotOnly: true,
    schema: z.strictObject({
      kind: z.enum(["role", "group"]),
      id: z
        .string()
        .max(64)
        .regex(/^[a-z0-9][a-z0-9-]*$/),
    }),
    description:
      "Install a role or group template selected from team_directory under the person's Bot management approval rules. A role creates a Bot; a template creates a group, reusing existing matching members. If needed, download its verified pack after approval. When installing for the current task, dispatch this turn using the returned botId or groupId.",
    policy: { category: "bot_management", operation: "change" },
    attributes: { readOnly: false },
  },
  send_to_bot: {
    mainBotOnly: true,
    schema: z.strictObject({
      bot: target,
      folder: dispatchFolder,
      imageGeneration: ImageGenerationOptionsSchema.optional(),
      ...modelChoice,
      reason: dispatchReason,
      title: z.string().trim().min(1).max(80),
      task: z.string().trim().min(1).max(8000),
    }),
    description:
      "Send a message or task to another Bot (id or exact name) after the person confirms. It opens a new topic in that Bot marked as from you, works under its own permissions, and this call returns the latest receipt status shortly after work is queued. The receipt card tracks the outcome. folder = optional absolute or ~ directory explicitly supplied by the person in this chat; it requires confirmation. title = a short name (up to 40 characters); task = everything it needs (it cannot see this chat); reason = one line explaining why this Bot fits. Optional model {provider,id,thinkingLevel?}, needs and modelReason select a model for this topic and explain the task difficulty on the approval card. Use imageGeneration for explicit image batches or comparisons, or model for the topic model." +
      IMAGE_GENERATION_GUIDANCE,
    policy: { category: "work_dispatch" },
    attributes: { output: "message" },
  },
  send_to_group: {
    mainBotOnly: true,
    schema: z.strictObject({
      group: target,
      steps: z
        .array(dispatchStep)
        .max(GROUP_PLAN_MAX_STEPS)
        .refine((steps) => new Set(steps.map(({ stepId }) => stepId)).size === steps.length)
        .optional(),
      folder: dispatchFolder,
      reason: dispatchReason,
      title: z.string().trim().min(1).max(80),
      task: z.string().trim().min(1).max(8000),
    }),
    description:
      "Send a task to a group (id or exact name) after the person confirms. It opens a new group topic marked as from you; the group's coordinator plans and the members work under their own permissions, and this call returns the latest receipt status shortly after work is queued. The receipt card tracks the outcome. Optional folder and short title work as in send_to_bot. Give a standalone task and a one-line reason why the group fits. Optional steps list one model choice per planned step with a unique stepId, exact member bot, model {provider,id,thinkingLevel?}, needs and modelReason. Describe those steps in the task so the coordinator can use the same step IDs and owners.",
    policy: { category: "work_dispatch" },
    attributes: { output: "message" },
  },
} as const satisfies Record<string, CapabilityToolSpec>;

/** The tools that hand out work; each call writes one dispatch record (receipt). */
export const PI_DISPATCH_TOOLS = ["send_to_bot", "send_to_group"] as const;
/** A turn may hand out this many pieces of work; the next one is refused (loop guard). */
export const PI_DISPATCHES_PER_TURN = 3;
