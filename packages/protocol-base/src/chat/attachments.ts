// Keep stored attachment metadata separate from the formats accepted by image decoders.
import { z } from "zod";

export const IMAGE_LIMIT = 10 * 1024 * 1024;
export const FILE_LIMIT = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
/** Limit for files attached by a Bot's reply tools. Image generation has its own output limit. */
export const MAX_REPLY_ATTACHMENTS = 10;
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "log",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "css",
  "scss",
  "less",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "swift",
  "rb",
  "php",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "sql",
  "toml",
  "ini",
  "conf",
  "cfg",
  "vue",
  "svelte",
  "r",
  "lua",
  "dart",
  "ex",
  "exs",
  "erl",
  "hs",
]);
const MEDIA_MIMES = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
} as const;
export function mediaMime(name: string) {
  const ext = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() : undefined;
  return ext && Object.hasOwn(MEDIA_MIMES, ext)
    ? MEDIA_MIMES[ext as keyof typeof MEDIA_MIMES]
    : undefined;
}
export const FILE_MIMES = [
  ...Object.values(MEDIA_MIMES),
  "image/svg+xml",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/yaml",
  "application/xml",
  "text/html",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;
export function fileMime(name: string): (typeof FILE_MIMES)[number] | undefined {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  const media = mediaMime(name);
  if (media) return media;
  if (ext === "svg") return "image/svg+xml";
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === "pptx")
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (!TEXT_EXTENSIONS.has(ext)) return undefined;
  const types: Record<string, (typeof FILE_MIMES)[number]> = {
    md: "text/markdown",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    yaml: "application/yaml",
    yml: "application/yaml",
    xml: "application/xml",
    html: "text/html",
    htm: "text/html",
  };
  return types[ext] ?? "text/plain";
}

export function base64Bytes(data: string): number {
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
export function base64Schema(limit: number, allowEmpty = false) {
  return (
    z
      .string()
      .min(allowEmpty ? 0 : 4)
      .max(Math.ceil(limit / 3) * 4)
      // A repeated capture per four bytes exhausts RegExp stacks on 20 MB inputs.
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((data) => data.length % 4 === 0, "Invalid base64 length")
      .refine((data) => base64Bytes(data) <= limit, "Attachment too large")
  );
}
const attachmentName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => !/[\\/\p{Cc}\p{Cf}]/u.test(value) && value !== "." && value !== "..",
    "Invalid attachment name",
  );
/** Cached preview size; base64 of this stays inside the renderer's per-preview budget. */
export const THUMBNAIL_BYTES = 64 * 1024;
export const ThumbnailContentSchema = z.strictObject({
  type: z.literal("image"),
  data: base64Schema(THUMBNAIL_BYTES),
  mimeType: z.enum(["image/jpeg", "image/png"]),
});
export const ImageContentSchema = z.strictObject({
  type: z.literal("image"),
  data: base64Schema(IMAGE_LIMIT),
  mimeType: z.enum(IMAGE_MIMES),
});
export const AttachmentInputSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("image"),
      name: attachmentName,
      mimeType: z.enum(IMAGE_MIMES),
      data: base64Schema(IMAGE_LIMIT),
    }),
    z.strictObject({
      kind: z.literal("file"),
      name: attachmentName,
      mimeType: z.enum(FILE_MIMES),
      data: base64Schema(FILE_LIMIT, true),
    }),
  ])
  .refine(
    (item) => item.kind === "image" || fileMime(item.name) === item.mimeType,
    "Unsupported file",
  );
export const AttachmentSchema = z.strictObject({
  id: z.uuidv4(),
  kind: z.enum(["image", "file"]),
  name: attachmentName,
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative().max(FILE_LIMIT),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  truncated: z.boolean().optional(),
  sentPercent: z.number().min(0).max(100).optional(),
});
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type ImageContent = z.infer<typeof ImageContentSchema>;
