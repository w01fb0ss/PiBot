import {
  type CapabilityToolGroup,
  type CapabilityToolSpec,
  IdSchema,
  ModelPreferenceSchema,
  WebUrlSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

export const AgnesVideoSizeSchema = z.enum(["720P", "1080P", "1K", "2K"]);

const framePlaceholders = new Set([
  "",
  "none",
  "null",
  "undefined",
  "n/a",
  "placeholder",
  "无",
  "空",
]);
const exampleHosts = new Set(["example.com", "example.net", "example.org"]);
function framePlaceholder(value: string | null | undefined, key: string) {
  const text = value?.trim().toLowerCase() ?? "";
  if (framePlaceholders.has(text) || /^<[^<>]+>$/.test(text)) return true;
  // A documentation example can pass URL validation and still become an unreadable first frame.
  return key === "url" && URL.canParse(text) && exampleHosts.has(new URL(text).hostname);
}

const frameReference = z.string().max(4096).nullish();
const firstFrame = z
  .union([
    z.strictObject({ attachmentId: frameReference, path: frameReference, url: frameReference }),
    frameReference.refine((value) => framePlaceholder(value, "url"), "Use an image reference"),
  ])
  .nullish()
  .transform((input) => {
    if (input == null || typeof input === "string") return undefined;
    const refs = Object.entries(input).filter(([key, value]) => !framePlaceholder(value, key));
    return refs.length ? Object.fromEntries(refs) : undefined;
  })
  .pipe(
    z
      .union([
        z.strictObject({ attachmentId: z.uuid() }),
        z.strictObject({
          path: z
            .string()
            .min(1)
            // A refine, not a regex: OpenAI's tool-schema validator rejects the \0 escape in a pattern.
            .refine((value) => !/[\0\r\n]/.test(value), "path must be a single line"),
        }),
        z.strictObject({
          url: WebUrlSchema.pipe(
            z.string().refine((value) => {
              const url = new URL(value);
              return !url.username && !url.password && !url.hash;
            }),
          ),
        }),
      ])
      .optional(),
  )
  .describe(
    "Omit firstFrame unless the person supplied an image. Use one reference to that image.",
  );

export const GenerateVideoSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(4000),
  model: ModelPreferenceSchema.optional(),
  duration: z.number().int().min(1).max(30).optional(),
  aspect: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]).optional(),
  size: z
    .union([
      z.string().regex(/^(?:[1-9][0-9]{1,3}x[1-9][0-9]{1,3}|360p|480p|720p|1080p|4k)$/),
      AgnesVideoSizeSchema,
    ])
    .optional(),
  seed: z.number().int().optional(),
  firstFrame,
});
export type GenerateVideo = z.infer<typeof GenerateVideoSchema>;

export const VideoStatusSchema = z.enum([
  "queued",
  "generating",
  "downloading",
  "done",
  "failed",
  "cancelled",
]);
export const VideoErrorSchema = z.enum([
  "timeout",
  "size_limit",
  "auth_failed",
  "billing",
  "provider_rejected",
  "network",
  "provider_error",
  "provider_changed",
  "interrupted_create",
  "delivery_failed",
]);
export const VideoJobSchema = z.strictObject({
  id: z.uuid(),
  model: z.string().min(1).max(200),
  status: VideoStatusSchema,
  progress: z.number().min(0).max(100).optional(),
  queueFull: z.literal(true).optional(),
  error: VideoErrorSchema.optional(),
  workspaceSaved: z.boolean().optional(),
});
export type VideoJob = z.infer<typeof VideoJobSchema>;

export const VideoMethods = {
  "videos.models": {
    params: z.strictObject({
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(200),
    }),
    result: z.array(ModelPreferenceSchema.extend({ providerName: z.string().min(1) })).max(200),
  },
  "videos.get": {
    params: z.strictObject({ id: z.uuid(), messageId: IdSchema }),
    result: VideoJobSchema,
  },
  "videos.cancel": {
    params: z.strictObject({ id: z.uuid(), messageId: IdSchema }),
    result: VideoJobSchema,
  },
} as const;
export const VideoEvents = {
  "videos.changed": z.strictObject({ id: z.uuid(), messageId: IdSchema }),
} as const;

export const videoTools = {
  list_video_models: {
    group: "video",
    schema: z.strictObject({}),
    description:
      "List configured video models, their exact provider and model IDs, and the acting Bot’s default.",
    policy: { category: "tool_discovery" },
    attributes: { readOnly: true },
  },
  generate_video: {
    group: "video",
    schema: GenerateVideoSchema,
    description:
      "Start one paid video generation job. The chat shows progress and independently receives the generated MP4. Omit firstFrame unless the person supplied an image. Specify an exact configured provider/model pair when the person names one. Otherwise Pi Bot uses the acting Bot’s default (the first configured model if unset), or the sole configured model if the saved choice is gone. If the default is unavailable and multiple models remain, ask the person to choose a model or update the Bot’s settings. For Agnes, use a publicly reachable firstFrame.url for image-to-video. Agnes accepts an optional integer seed, 4–12 seconds, and size 720P, 1080P, 1K, or 2K (Flash only supports 720P). For other providers a first frame can be a current-topic image attachment ID or a readable image path within this workspace. Gemini Omni supports 3–15 seconds, 16:9 or 9:16, and 360p, 720p, 1080p, or 4k. Match duration, aspect ratio and size to the chosen model. A queued job is not a finished video. Never retry automatically.",
    policy: { category: "video_generation" },
    attributes: { permission: "web", readOnly: false, output: "file" },
  },
} as const satisfies Record<string, CapabilityToolSpec>;

export const videoToolGroup = {
  id: "video",
  description: "使用已配置的模型生成视频 / Generate videos using configured models",
  rule: {
    zh: "用户要求生成视频时使用 generate_video。",
    en: "Use generate_video when the person asks to generate a video.",
  },
} as const satisfies CapabilityToolGroup;
