import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

/** Navigation metadata issued by the brain, separate from the text shown to the model. */
export const OpenTopicActionSchema = z.strictObject({
  kind: z.enum(["bot", "group"]),
  id: IdSchema,
  conversationId: IdSchema,
  name: z.string().min(1).max(200),
  title: z.string().min(1).max(80),
  folderName: z.string().min(1).max(255).optional(),
});
export type OpenTopicAction = z.infer<typeof OpenTopicActionSchema>;
