import {
  AbsolutePathSchema,
  ExecutionModeSchema,
  IdSchema,
  PermissionsSettingsSchema,
  ReviewProfileSchema,
  TopicWorkplaceSnapshotSchema,
  WorkplacesSchema,
  WorkspaceSnapshotSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

/** Private persisted authority. Never serialized as a TaskSummary or sent to a renderer. */
export const TaskAuthoritySchema = z.strictObject({
  source: z.strictObject({
    botId: IdSchema,
    conversationId: IdSchema,
    runId: IdSchema,
    messageId: IdSchema,
    groupId: IdSchema.optional(),
    threadId: IdSchema.optional(),
    taskId: IdSchema.optional(),
    cycleId: IdSchema.optional(),
    groupAuthorization: z.string().max(200_000).optional(),
    groupMemberWorktreeId: IdSchema.optional(),
    topicWorkplace: TopicWorkplaceSnapshotSchema.optional(),
  }),
  permissions: PermissionsSettingsSchema,
  mode: ExecutionModeSchema,
  /** Server-created and persisted before queue publication; never accepted by task_spawn. */
  reviewProfile: ReviewProfileSchema.optional(),
  /** A workflow run's `task_spawn model: "cheap"`; the child runs on the auxiliary model. */
  modelTier: z.literal("cheap").optional(),
  workplace: z.strictObject({
    value: WorkplacesSchema,
    displayFolders: z
      .array(
        z.strictObject({ path: AbsolutePathSchema, displayPath: AbsolutePathSchema.optional() }),
      )
      .max(32)
      .readonly()
      .optional(),
    cwd: z.string().min(1).max(32_768),
    roots: z.array(z.string().min(1).max(32_768)).max(202),
    home: z.string().min(1).max(32_768),
    boundary: WorkspaceSnapshotSchema,
  }),
});
export type TaskAuthority = z.infer<typeof TaskAuthoritySchema>;
