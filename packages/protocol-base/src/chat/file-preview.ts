// Define the file formats and read limits shared by the preview clients and brain.
import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { type Attachment, mediaMime } from "./attachments.ts";

export const PREVIEW_TEXT_BYTES = 2_097_152;

/** Old SVGs were stored with a generic MIME. Keep them in the file preview path. */
export function canPreviewSvg(attachment: Pick<Attachment, "kind" | "name" | "size">): boolean {
  return (
    attachment.kind === "file" &&
    previewKind(attachment.name) === "svg" &&
    attachment.size > 0 &&
    attachment.size <= PREVIEW_TEXT_BYTES
  );
}

export const PreviewKindSchema = z.enum([
  "docx",
  "xlsx",
  "pptx",
  "pdf",
  "markdown",
  "code",
  "image",
  "svg",
  "video",
  "audio",
]);
export type PreviewKind = z.infer<typeof PreviewKindSchema>;
/** A closed format registry; HTML and arbitrary binary files never become executable previews. */
export function previewKind(name: string): PreviewKind | undefined {
  const media = mediaMime(name);
  if (media) return media.startsWith("video/") ? "video" : "audio";
  const extension = name.toLowerCase().split(".").pop();
  if (
    extension === "docx" ||
    extension === "xlsx" ||
    extension === "pptx" ||
    extension === "pdf" ||
    extension === "svg"
  )
    return extension;
  if (["md", "markdown", "mdown"].includes(extension ?? "")) return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension ?? "")) return "image";
  if (
    [
      "txt",
      "log",
      "csv",
      "tsv",
      "json",
      "jsonl",
      "yaml",
      "yml",
      "toml",
      "xml",
      "html",
      "htm",
      "css",
      "scss",
      "js",
      "jsx",
      "ts",
      "tsx",
      "mjs",
      "cjs",
      "py",
      "rs",
      "go",
      "java",
      "c",
      "h",
      "cpp",
      "hpp",
      "sh",
      "bash",
      "zsh",
      "sql",
      "ini",
      "conf",
      "rb",
      "php",
      "vue",
      "svelte",
    ].includes(extension ?? "")
  )
    return "code";
  return undefined;
}
/** A settled message attachment. */
export const AttachmentPreviewSource = { attachmentId: z.uuid(), messageId: z.uuid() };
/**
 * A file one run changed. `path` is only a lookup key into that run's recorded changes; the brain
 * serves the recorded path inside the recorded workspace root, never the renderer's string.
 */
export const ChangePreviewSource = {
  runId: IdSchema,
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\0\r\n]/.test(value)),
};
/** Either source with the same extra fields; strict on both sides so the two never mix. */
export function previewSourceParams<T extends z.ZodRawShape>(shape: T) {
  return z.union([
    z.strictObject({ ...AttachmentPreviewSource, ...shape }),
    z.strictObject({ ...ChangePreviewSource, ...shape }),
  ]);
}
export const PreviewSourceSchema = previewSourceParams({});
export type PreviewSource = z.infer<typeof PreviewSourceSchema>;
export const PreviewFileSchema = z.strictObject({
  kind: PreviewKindSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  // Base64 is the original local file for visual formats; text has already been redacted.
  data: z.string().max(27_962_028),
  text: z.string().max(PREVIEW_TEXT_BYTES).optional(),
});
export const PreviewMethods = {
  "preview.read": {
    params: previewSourceParams({
      requestId: z.uuid(),
      expectedRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
    result: PreviewFileSchema,
  },
  "preview.cancel": { params: z.strictObject({ requestId: z.uuid() }), result: z.null() },
  "preview.open": { params: PreviewSourceSchema, result: z.null() },
};
export type PreviewFile = z.infer<typeof PreviewFileSchema>;
