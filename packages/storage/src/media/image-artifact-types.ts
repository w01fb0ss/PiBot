import {
  AbsolutePathSchema,
  IdSchema,
  ImageModeSchema,
  WorkspaceSnapshotSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

export const ImageArtifactTargetSchema = z.strictObject({
  source: z.strictObject({
    botId: IdSchema,
    runId: IdSchema,
    messageId: IdSchema,
    conversationId: IdSchema,
    groupId: IdSchema.optional(),
    threadId: IdSchema.optional(),
    taskId: IdSchema.optional(),
    cycleId: IdSchema.optional(),
    routineRunId: IdSchema.optional(),
    routineSource: z.enum(["routine", "trial"]).optional(),
    routineWorkplace: z
      .strictObject({
        kind: z.enum(["bot", "folder"]).optional(),
        folderId: z.union([z.literal("home"), IdSchema]).optional(),
        // Migration 0027 fields of ToolRunContext.routineWorkplace; without them every
        // routine run of an image Bot with read-only folders failed here after authorization.
        readonly: z.array(IdSchema).max(256).optional(),
        cwd: z.union([z.literal("home"), IdSchema]).optional(),
        temporaryRoots: z
          .array(z.strictObject({ id: IdSchema, path: AbsolutePathSchema }))
          .max(202)
          .optional(),
      })
      .optional(),
    language: z.enum(["zh", "en"]),
  }),
  cwd: AbsolutePathSchema,
  boundary: WorkspaceSnapshotSchema,
});
export const ImageArtifactModelSchema = z.strictObject({
  provider: z.string().min(1).max(200),
  id: z.string().min(1).max(500),
  recipient: z.string().min(1).max(1000),
  mode: ImageModeSchema,
  botModel: z
    .strictObject({ provider: z.string().min(1).max(200), id: z.string().min(1).max(500) })
    .optional(),
});
export const ImageArtifactReceiptSchema = z.strictObject({
  path: AbsolutePathSchema,
  identityKey: z.string().regex(/^[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  device: z.string().min(1).max(100),
  inode: z.string().min(1).max(100),
  parentDevice: z.string().min(1).max(100),
  parentInode: z.string().min(1).max(100),
});
export type ImageArtifactTarget = z.infer<typeof ImageArtifactTargetSchema>;
export type ImageArtifactModel = z.infer<typeof ImageArtifactModelSchema>;
export type ImageArtifactReceipt = z.infer<typeof ImageArtifactReceiptSchema>;
export interface ImageArtifactRecord {
  target: ImageArtifactTarget;
  model: ImageArtifactModel;
  createdAt: string;
  generatedAt?: string;
}

export interface ImageArtifactActor {
  botId: string;
  conversationId: string;
  groupId?: string;
  threadId?: string;
  runId?: string;
}

/** Optional object keys disappear on JSON persistence; key order does not change a frozen intent. */
export function imageArtifactFingerprint(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, canonical(v)]),
      );
    return item;
  }
  return JSON.stringify(canonical(value));
}
