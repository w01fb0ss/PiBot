import {
  IdSchema,
  SkillImportDetailsSchema,
  SkillImportSourceSchema,
  TeamPreviewSchema,
  TeamSkillReimportSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const ok = z.strictObject({ ok: z.literal(true) });
export const TeamMethods = {
  "teams.export": {
    params: z
      .strictObject({
        botIds: z.array(IdSchema).min(1).max(100).optional(),
        groupId: IdSchema.optional(),
      })
      .refine((v) => !!v.botIds !== !!v.groupId),
    result: z.strictObject({
      saved: z.boolean(),
      omitted: z.array(TeamSkillReimportSchema).max(10000).optional(),
    }),
  },
  "teams.previewSkillSource": {
    timeoutMs: 125 * 60_000,
    params: z.strictObject({
      botId: IdSchema,
      source: SkillImportSourceSchema,
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    result: SkillImportDetailsSchema,
  },
  "teams.preview": {
    params: z.strictObject({ file: z.string().min(1).max(32768) }),
    result: TeamPreviewSchema,
  },
  "teams.pickFile": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: TeamPreviewSchema.nullable(),
  },
  "teams.cancel": { params: z.strictObject({ previewId: IdSchema.optional() }), result: ok },
  // One text file of a pending version-3 preview exactly as it would be saved; null = binary.
  "teams.previewFile": {
    params: z.strictObject({
      previewId: IdSchema,
      ref: z.string().min(1).max(200),
      skill: z.string().min(1).max(80),
      path: z.string().min(1).max(512),
    }),
    result: z.strictObject({
      text: z
        .string()
        .max(5 * 1024 * 1024)
        .nullable(),
    }),
  },
  "teams.import": {
    params: z.strictObject({ previewId: IdSchema }),
    result: z.strictObject({
      botIds: z.array(IdSchema),
      groupIds: z.array(IdSchema),
      sidebarGroupId: IdSchema,
      /** Skills that could not be written (the Bots are already committed); absent when none. */
      skippedSkills: z
        .array(z.strictObject({ botId: IdSchema, name: z.string().min(1).max(200) }))
        .max(1000)
        .optional(),
    }),
  },
} as const;
