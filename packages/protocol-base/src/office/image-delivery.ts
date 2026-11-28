import { z } from "zod";
import { MAX_GENERATED_IMAGES } from "../chat/media.ts";
import { AbsolutePathSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";

export const ImageWorkspaceDeliverySchema = z
  .strictObject({
    attachmentId: IdSchema,
    status: z.enum(["saved", "failed", "denied", "cancelled", "needs_verification"]),
    fileName: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9._-]+$/),
    // These describe an actual workspace destination, never an attachment cache path.
    targetPath: AbsolutePathSchema.optional(),
    savedPath: AbsolutePathSchema.optional(),
    errorCode: z
      .enum([
        "permission_denied",
        "cancelled",
        "workspace_changed",
        "file_conflict",
        "file_failed",
        "attachment_invalid",
        "receipt_failed",
        "internal",
      ])
      .optional(),
  })
  .superRefine((value, context) => {
    if ((value.status === "saved") !== !!value.savedPath)
      context.addIssue({ code: "custom", message: "Only a verified save has a saved path" });
  });
export const ImageDeliverySchema = z.strictObject({
  attachments: z.literal("delivered"),
  workspace: z.array(ImageWorkspaceDeliverySchema).min(1).max(MAX_GENERATED_IMAGES),
});
export type ImageWorkspaceDelivery = z.infer<typeof ImageWorkspaceDeliverySchema>;
export type ImageDelivery = z.infer<typeof ImageDeliverySchema>;

// Identity-only commands: destinations and receipts always come from private brain storage.
export const ImageOperationSchema = z.strictObject({
  action: z.enum(["inspect", "resend", "save"]),
  sourceRunId: IdSchema,
  attachmentIds: z.array(IdSchema).min(1).max(MAX_GENERATED_IMAGES).optional(),
});
export type ImageOperation = z.infer<typeof ImageOperationSchema>;
