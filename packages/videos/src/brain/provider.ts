import { createHmac } from "node:crypto";
import type { VideoApi } from "@pibot/protocol-base";
import { AgnesVideoSizeSchema, type GenerateVideo, type VideoJob } from "@pibot/videos-contract";
import { z } from "zod";

const token = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.~-]{0,511}$/);
const openRouterId = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.:~-]{0,511}$/);
const operation = z
  .string()
  .max(1024)
  .regex(/^(?:models\/[A-Za-z0-9_.-]+\/)?operations\/[A-Za-z0-9_-][A-Za-z0-9_.~-]*$/);
const url = z.string().min(1).max(8192);
const errorDetail = z.union([
  z.string().max(4000),
  z.object({
    message: z.string().max(4000).optional(),
    code: z.union([z.string().max(200), z.number()]).optional(),
    type: z.string().max(200).optional(),
  }),
]);
const errorPayload = z.object({ error: errorDetail.optional() });
const openAi = z.object({
  id: token,
  status: z.string(),
  progress: z.number().min(0).max(100).optional(),
});
const gemini = z.object({
  name: operation.optional(),
  done: z.boolean().optional(),
  error: z.object({ code: z.number().optional() }).optional(),
  response: z
    .object({
      generateVideoResponse: z
        .object({
          generatedSamples: z.array(z.object({ video: z.object({ uri: url }) })).optional(),
        })
        .optional(),
    })
    .optional(),
});
const omniInteraction = z.object({
  status: z.literal("completed"),
  steps: z.array(z.object({ type: z.string(), content: z.array(z.unknown()).optional() })),
});
const omniVideo = z.object({
  type: z.literal("video"),
  mime_type: z.literal("video/mp4"),
  data: z.string().min(1).optional(),
  uri: url.optional(),
});
const omniFile = z.object({ state: z.enum(["PROCESSING", "ACTIVE", "FAILED"]) });
const omniSizes = z.enum(["360p", "720p", "1080p", "4k"]);
const kling = z.object({
  code: z.literal(0),
  data: z.object({
    task_id: token,
    task_status: z.string(),
    task_result: z.object({ videos: z.array(z.object({ url })) }).optional(),
  }),
});
const ark = z.object({
  id: token,
  status: z.string().optional(),
  content: z.object({ video_url: url.optional() }).optional(),
});
const agnesJob = z.union([z.object({ video_id: token }), z.object({ task_id: token })]);
const agnes = z.object({
  status: z.string(),
  progress: z.number().min(0).max(100).nullish(),
  video_url: url.nullish(),
  url: url.nullish(),
});
export const AgnesQueueFull = z.object({ code: z.literal("video_queue_full") });
const openRouterJob = z.object({
  id: openRouterId,
  status: z.string().optional(),
  polling_url: url.optional(),
});
const openRouterPoll = z.object({
  id: openRouterId.optional(),
  status: z.string(),
  progress: z.number().min(0).max(100).nullish(),
  urls: z.array(url).max(20).optional(),
  unsigned_urls: z.array(url).max(20).optional(),
  error: errorDetail.nullish(),
});

export type Frame = { bytes: Buffer; mimeType: string };
export type VideoParameters = Required<Pick<GenerateVideo, "duration" | "aspect">> &
  Pick<GenerateVideo, "size">;
export type VideoRequest = { path: string; body?: FormData | string };
export type ProviderState =
  | { status: "queued" | "generating"; progress?: number }
  | { status: "failed"; error?: NonNullable<VideoJob["error"]>; errorCode?: number }
  | { status: "cancelled" }
  | { status: "ready"; url: string };
export type ProviderJob = {
  id: string;
  kind: "text" | "image";
  legacy?: true;
  pollPath?: string;
};

const json = (value: unknown) => JSON.stringify(value);
const openAiSize = (aspect: VideoParameters["aspect"]) =>
  aspect === "9:16" ? "720x1280" : "1280x720";
const defaults = {
  "openai-videos": 4,
  "gemini-veo": 8,
  "gemini-omni": 10,
  kling: 5,
  "ark-seedance": 5,
  agnes: 5,
  "openrouter-videos": 5,
};

function errorSummary(error: z.infer<typeof errorDetail> | null | undefined) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return [error.code, error.type, error.message].filter((part) => part !== undefined).join(" ");
}

function classifyErrorText(text: string): NonNullable<VideoJob["error"]> | undefined {
  if (!text) return undefined;
  if (
    /\b(?:402|insufficient[_\s-]*credits?|quota|billing|payment[_\s-]*required|balance)\b/i.test(
      text,
    )
  )
    return "billing";
  if (
    /\b(?:401|unauthori[sz]ed|invalid[_\s-]*(?:api[_\s-]*)?key|auth(?:entication)?[_\s-]*failed)\b/i.test(
      text,
    )
  )
    return "auth_failed";
  if (
    /\b(?:moderat(?:ed|ion)|content[_\s-]*(?:policy|filter|violation|rejected|flagged)|safety|guardrail|nsfw|prohibited|flagged|rejected)\b/i.test(
      text,
    )
  )
    return "provider_rejected";
  return undefined;
}

export function httpVideoError(status: number, body?: unknown): NonNullable<VideoJob["error"]> {
  const parsed = errorPayload.safeParse(body);
  const summary = parsed.success ? errorSummary(parsed.data.error) : "";
  if (status === 401) return "auth_failed";
  if (status === 402) return "billing";
  const classified = classifyErrorText(summary);
  if (status === 403 || status === 400 || status === 422) return classified ?? "provider_rejected";
  if (status === 429) return classified === "billing" ? "billing" : "provider_error";
  return "provider_error";
}

export function videoParameters(
  api: VideoApi,
  model: string,
  input: GenerateVideo,
): VideoParameters {
  const duration = input.duration ?? defaults[api];
  const frameUrl = input.firstFrame && "url" in input.firstFrame;
  if (api === "agnes") {
    const size = input.size?.toUpperCase() ?? "720P";
    if (
      duration < 4 ||
      duration > 12 ||
      !AgnesVideoSizeSchema.safeParse(size).success ||
      (model === "agnes-video-2.5-flash" && size !== "720P") ||
      (input.firstFrame && !frameUrl)
    )
      throw new Error("video_parameters_invalid");
    return { aspect: input.aspect ?? "16:9", duration, size };
  }
  if (
    (frameUrl && api !== "openrouter-videos") ||
    (input.seed !== undefined && api !== "openrouter-videos") ||
    AgnesVideoSizeSchema.safeParse(input.size).success
  )
    throw new Error("video_parameters_invalid");
  if (api === "gemini-omni") {
    const aspect = input.aspect ?? "16:9";
    const size = input.size ?? "720p";
    if (
      duration < 3 ||
      duration > 15 ||
      (aspect !== "16:9" && aspect !== "9:16") ||
      !omniSizes.safeParse(size).success
    )
      throw new Error("video_parameters_invalid");
    return { aspect, duration, size };
  }
  const dimensions = input.size?.includes("x");
  const [width = 0, height = 0] = dimensions ? (input.size ?? "").split("x").map(Number) : [];
  const derivedAspect = width === height && width > 0 ? "1:1" : width < height ? "9:16" : "16:9";
  const aspect = input.aspect ?? derivedAspect;
  if (api === "openrouter-videos") {
    if (dimensions && input.aspect && aspect !== derivedAspect)
      throw new Error("video_parameters_invalid");
    return { aspect, duration, size: input.size };
  }
  if (api === "openai-videos") {
    if (
      input.size
        ? !dimensions || (input.aspect && aspect !== derivedAspect)
        : aspect !== "16:9" && aspect !== "9:16"
    )
      throw new Error("video_parameters_invalid");
    return { aspect, duration, size: input.size ?? openAiSize(aspect) };
  }
  if (
    (api === "gemini-veo" && !["16:9", "9:16"].includes(aspect)) ||
    (api === "kling" && (!["16:9", "9:16", "1:1"].includes(aspect) || input.size)) ||
    input.size === "360p" ||
    input.size === "4k" ||
    dimensions
  )
    throw new Error("video_parameters_invalid");
  return { aspect, duration, size: input.size };
}

export function providerRoot(baseUrl: string, api: VideoApi) {
  const base = new URL(baseUrl);
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("video_endpoint_invalid");
  const path = base.pathname.replace(/\/+$/, "");
  const version =
    api === "gemini-veo" || api === "gemini-omni"
      ? "/v1beta"
      : api === "ark-seedance"
        ? "/api/v3"
        : api === "openrouter-videos"
          ? "/api/v1"
          : "/v1";
  const hasVersion = api === "gemini-veo" ? /\/v1(?:beta)?$/.test(path) : path.endsWith(version);
  return base.origin + path + (hasVersion ? "" : version);
}

export function providerHeaders(api: VideoApi, key: string): Record<string, string> {
  if (api === "gemini-veo" || api === "gemini-omni") return { "x-goog-api-key": key };
  if (api === "openrouter-videos")
    return {
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://pibot.space",
      "X-Title": "Pi Bot",
    };
  if (api !== "kling") return { Authorization: `Bearer ${key}` };
  const [ak, sk, extra] = key.split(":");
  if (!ak || !sk || extra !== undefined) throw new Error("video_key_invalid");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    { alg: "HS256", typ: "JWT" },
    { iss: ak, exp: now + 180, nbf: now - 5 },
  ]
    .map((part) => Buffer.from(json(part)).toString("base64url"))
    .join(".");
  const signature = createHmac("sha256", sk).update(unsigned).digest("base64url");
  return { Authorization: `Bearer ${unsigned}.${signature}` };
}

function collection(api: VideoApi, kind: ProviderJob["kind"]) {
  if (api === "ark-seedance") return "contents/generations/tasks";
  if (api === "kling") return kind === "image" ? "videos/image2video" : "videos/text2video";
  return "videos";
}

export function createVideo(
  api: VideoApi,
  model: string,
  { prompt, firstFrame, seed }: GenerateVideo,
  parameters: VideoParameters,
  frame?: Frame,
): VideoRequest {
  const { duration, aspect, size } = parameters;
  const encoded = frame?.bytes.toString("base64");
  const path = collection(api, frame ? "image" : "text");
  switch (api) {
    case "openai-videos": {
      const body = new FormData();
      body.set("model", model);
      body.set("prompt", prompt);
      body.set("seconds", String(duration));
      if (size) body.set("size", size);
      if (frame)
        body.set(
          "input_reference",
          new Blob([new Uint8Array(frame.bytes)], { type: frame.mimeType }),
          `first-frame.${frame.mimeType.split("/")[1]}`,
        );
      return { path, body };
    }
    case "gemini-veo":
      return {
        path: `models/${encodeURIComponent(model.replace(/^models\//, ""))}:predictLongRunning`,
        body: json({
          instances: [
            {
              prompt,
              ...(frame && { image: { bytesBase64Encoded: encoded, mimeType: frame.mimeType } }),
            },
          ],
          parameters: {
            durationSeconds: duration,
            aspectRatio: aspect,
            ...(size && { resolution: size }),
          },
        }),
      };
    case "gemini-omni":
      return {
        path: "interactions",
        body: json({
          model,
          input: frame
            ? [
                { type: "text", text: `Use the supplied image as the first frame.\n${prompt}` },
                { type: "image", mime_type: frame.mimeType, data: encoded },
              ]
            : prompt,
          response_format: {
            type: "video",
            aspect_ratio: aspect,
            resolution: size,
            duration: `${duration}s`,
            delivery: "uri",
          },
        }),
      };
    case "kling":
      return {
        path,
        body: json({
          model_name: model,
          prompt,
          duration: String(duration),
          ...(frame ? { image: encoded } : { aspect_ratio: aspect }),
        }),
      };
    case "ark-seedance":
      return {
        path,
        body: json({
          model,
          content: [
            { type: "text", text: prompt },
            ...(frame
              ? [
                  {
                    type: "image_url",
                    image_url: { url: `data:${frame.mimeType};base64,${encoded}` },
                    role: "first_frame",
                  },
                ]
              : []),
          ],
          duration,
          ratio: aspect,
          ...(size && { resolution: size }),
        }),
      };
    case "agnes": {
      // Agnes keyframe mode uses a publicly reachable image URL:
      // https://wiki.agnes-ai.com/en/docs/agnes-video-25#mode-specific-parameters
      const firstFrameUrl = firstFrame && "url" in firstFrame ? firstFrame.url : undefined;
      return {
        path,
        body: json({
          model,
          prompt,
          mode: firstFrameUrl ? "keyframe" : "text",
          seconds: String(duration),
          size,
          aspect_ratio: aspect,
          seed,
          first_frame: firstFrameUrl,
        }),
      };
    }
    case "openrouter-videos": {
      const frameUrl = frame
        ? `data:${frame.mimeType};base64,${encoded}`
        : firstFrame && "url" in firstFrame
          ? firstFrame.url
          : undefined;
      const resolution = size && !size.includes("x") ? (size === "4k" ? "4K" : size) : undefined;
      const dimensions = size?.includes("x") ? size : undefined;
      return {
        path,
        body: json({
          model,
          prompt,
          duration,
          aspect_ratio: aspect,
          ...(resolution && { resolution }),
          ...(dimensions && { size: dimensions }),
          ...(seed !== undefined && { seed }),
          ...(frameUrl && {
            frame_images: [
              {
                type: "image_url",
                image_url: { url: frameUrl },
                frame_type: "first_frame",
              },
            ],
          }),
        }),
      };
    }
  }
}

function openRouterPollPath(root: string, pollingUrl?: string): string | undefined {
  if (!pollingUrl) return undefined;
  const rootUrl = new URL(`${root}/`);
  const resolved = new URL(pollingUrl, rootUrl);
  // Never allow a server-supplied polling_url to direct authenticated requests to another origin.
  if (resolved.origin !== rootUrl.origin || resolved.username || resolved.password || resolved.hash)
    throw new Error("video_endpoint_invalid");
  const relative = `${resolved.pathname}${resolved.search}`;
  if (!relative.startsWith("/") || relative.length > 1024)
    throw new Error("video_endpoint_invalid");
  return relative;
}

export function providerJob(
  api: Exclude<VideoApi, "gemini-omni">,
  response: unknown,
  kind: ProviderJob["kind"],
  root?: string,
): ProviderJob {
  switch (api) {
    case "openai-videos":
      return { id: z.object({ id: token }).parse(response).id, kind };
    case "gemini-veo":
      return { id: z.object({ name: operation }).parse(response).name, kind };
    case "kling":
      return { id: kling.parse(response).data.task_id, kind };
    case "ark-seedance":
      return { id: ark.parse(response).id, kind };
    case "agnes": {
      const value = agnesJob.parse(response);
      return "video_id" in value
        ? { id: value.video_id, kind }
        : { id: value.task_id, kind, legacy: true };
    }
    case "openrouter-videos": {
      const value = openRouterJob.parse(response);
      const pollPath = root ? openRouterPollPath(root, value.polling_url) : undefined;
      return { id: value.id, kind, ...(pollPath ? { pollPath } : {}) };
    }
  }
}

export function omniOutput(response: unknown, kind: ProviderJob["kind"]) {
  const { steps } = omniInteraction.parse(response);
  for (const step of steps) {
    if (step.type !== "model_output") continue;
    for (const part of step.content ?? []) {
      const output = omniVideo.safeParse(part);
      if (!output.success) continue;
      const { uri, data } = output.data;
      if (uri) {
        // Accept the documented URL and relative file names. Only the ID enters later requests.
        const origin = "https://generativelanguage.googleapis.com";
        const file = new URL(uri, `${origin}/v1beta/`);
        if (file.origin !== origin || file.username || file.password || file.hash)
          throw new Error("video_file_invalid");
        const id = /^\/v1beta\/files\/([^/]+?)(?::download)?$/.exec(file.pathname)?.[1];
        return { remote: { id: token.parse(id), kind } };
      }
      if (data) return { data };
    }
  }
  throw new Error("video_output_missing");
}

function jobPath(api: VideoApi, job: ProviderJob) {
  if (api === "gemini-veo") return operation.parse(job.id);
  if (api === "gemini-omni") return `files/${token.parse(job.id)}`;
  if (api === "openrouter-videos")
    return `videos/${encodeURIComponent(openRouterId.parse(job.id))}`;
  return `${collection(api, job.kind)}/${token.parse(job.id)}`;
}

export function pollPath(api: VideoApi, job: ProviderJob, model: string) {
  if (api === "agnes" && !job.legacy) {
    const query = new URLSearchParams({ video_id: token.parse(job.id), model_name: model });
    return `/agnesapi?${query}`;
  }
  if (api === "openrouter-videos" && job.pollPath) return job.pollPath;
  return jobPath(api, job);
}

export function providerState(
  api: VideoApi,
  response: unknown,
  job: ProviderJob,
  root: string,
): ProviderState {
  switch (api) {
    case "openai-videos": {
      const { status, progress } = openAi.parse(response);
      if (status === "queued" || status === "in_progress")
        return { status: status === "queued" ? "queued" : "generating", progress };
      if (status === "completed")
        return { status: "ready", url: `${root}/${jobPath(api, job)}/content` };
      return terminal(status);
    }
    case "gemini-veo": {
      const value = gemini.parse(response);
      if (value.error) return { status: value.error.code === 1 ? "cancelled" : "failed" };
      if (!value.done) return { status: "generating" };
      return ready(value.response?.generateVideoResponse?.generatedSamples?.[0]?.video.uri);
    }
    case "gemini-omni": {
      const { state } = omniFile.parse(response);
      if (state === "PROCESSING") return { status: "generating" };
      if (state === "ACTIVE")
        return { status: "ready", url: `${root}/${jobPath(api, job)}:download?alt=media` };
      return { status: "failed" };
    }
    case "kling": {
      const value = kling.parse(response).data;
      if (value.task_status === "submitted") return { status: "queued" };
      if (value.task_status === "processing") return { status: "generating" };
      if (value.task_status === "succeed") return ready(value.task_result?.videos?.[0]?.url);
      return terminal(value.task_status);
    }
    case "ark-seedance": {
      const value = ark.parse(response);
      if (value.status === "queued") return { status: "queued" };
      if (value.status === "running") return { status: "generating" };
      if (value.status === "succeeded") return ready(value.content?.video_url);
      return terminal(value.status);
    }
    case "agnes": {
      const value = agnes.parse(response);
      if (value.status === "queued" || value.status === "in_progress")
        return {
          status: value.status === "queued" ? "queued" : "generating",
          progress: value.progress ?? undefined,
        };
      if (value.status === "completed") return ready(value.video_url ?? value.url ?? undefined);
      return terminal(value.status);
    }
    case "openrouter-videos": {
      const value = openRouterPoll.parse(response);
      if (value.status === "pending" || value.status === "queued")
        return { status: "queued", progress: value.progress ?? undefined };
      if (
        value.status === "in_progress" ||
        value.status === "running" ||
        value.status === "processing"
      )
        return { status: "generating", progress: value.progress ?? undefined };
      if (value.status === "completed")
        return {
          status: "ready",
          url:
            value.unsigned_urls?.[0] ?? value.urls?.[0] ?? `${root}/${jobPath(api, job)}/content`,
        };
      if (value.status === "cancelled" || value.status === "canceled")
        return { status: "cancelled" };
      const code = typeof value.error === "object" ? value.error?.code : undefined;
      return {
        status: "failed",
        error: classifyErrorText(errorSummary(value.error)),
        errorCode: typeof code === "number" && Number.isSafeInteger(code) ? code : undefined,
      };
    }
  }
}

function ready(url: string | undefined): ProviderState {
  return url ? { status: "ready", url } : { status: "failed" };
}
function terminal(status: string | undefined): ProviderState {
  return { status: status === "cancelled" || status === "canceled" ? "cancelled" : "failed" };
}

export function cancellationPath(api: VideoApi, job: ProviderJob) {
  return api === "openai-videos" || api === "ark-seedance" ? jobPath(api, job) : undefined;
}
