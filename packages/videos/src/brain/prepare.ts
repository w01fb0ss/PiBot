import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  auditText,
  authorizationSnapshot,
  type CapabilityContext,
  checkedImage,
  prepareTool,
  readManagedImage,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { assertPublicWebTarget, samePathSpelling } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { IMAGE_LIMIT, IMAGE_MIMES, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { AttachmentsRepo, BotsRepo, ConversationsRepo, MessagesRepo } from "@pibot/storage";
import { type GenerateVideo, GenerateVideoSchema } from "@pibot/videos-contract";
import { videoApprovalText } from "@pibot/videos-contract/i18n";
import type { WorkspaceIntent } from "../store/jobs.ts";
import { type Frame, providerRoot, videoParameters } from "./provider.ts";

export function configuredVideos(ctx: CapabilityContext) {
  return (ctx.local.models?.videoProviders() ?? []).flatMap((provider) =>
    provider.videoModels.map((model) => ({
      ...model,
      providerId: provider.id,
      providerName: provider.name,
      api: provider.videoApi,
      root: providerRoot(provider.baseUrl, provider.videoApi),
    })),
  );
}
type Model = ReturnType<typeof configuredVideos>[number];

export function selectVideo(
  ctx: CapabilityContext,
  botId: string,
  models: Model[],
  named?: GenerateVideo["model"],
) {
  if (named) {
    const exact = models.find(
      (model) => model.providerId === named.provider && model.id === named.id,
    );
    const matches = exact
      ? []
      : models.filter((model) => model.providerName === named.provider && model.id === named.id);
    return exact ?? (matches.length === 1 ? matches[0] : undefined);
  }
  const saved = new BotsRepo(ctx.db).get(botId)?.defaultVideoModel;
  if (!saved) return models[0];
  return (
    models.find((model) => model.providerId === saved.provider && model.id === saved.id) ??
    (models.length === 1 ? models[0] : undefined)
  );
}

export function quote(model: Model, request: GenerateVideo) {
  const parameters = videoParameters(model.api, model.id, request);
  const priceUsdPerSecond =
    model.priceUsdPerSecond ??
    model.priceUsdPerSecondBySize?.[(parameters.size ?? "720p").toLowerCase()];
  const estimate =
    model.priceUsdPerClip ??
    (priceUsdPerSecond === undefined ? undefined : priceUsdPerSecond * parameters.duration);
  return {
    ...parameters,
    label: parameters.size ? `${parameters.aspect} ${parameters.size}` : parameters.aspect,
    priceUsdPerSecond,
    estimate,
  };
}

function fileName(ctx: CapabilityContext, run: ToolRunContext, callId: string, prompt: string) {
  const name = auditText(prompt, ctx.redactor, 48)
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  const suffix = createHash("sha256")
    .update(JSON.stringify([run.runId, callId]))
    .digest("hex")
    .slice(0, 12);
  return `video-${name ? `${name}-` : ""}${suffix}.mp4`;
}

function invalidFrame(): never {
  throw new RpcError(RpcErrorCodes.invalidParams, "video_first_frame_unavailable");
}

function checkFrameScope(ctx: CapabilityContext, run: ToolRunContext, id: string) {
  const attachment = new AttachmentsRepo(ctx.db).get(id);
  const message = attachment && new MessagesRepo(ctx.db).get(attachment.messageId);
  if (
    attachment?.metadata.kind !== "image" ||
    !message ||
    message.conversationId !== run.conversationId
  )
    invalidFrame();
}

function frameMime(bytes: Buffer): string {
  const data = bytes.toString("base64");
  for (const mime of IMAGE_MIMES) {
    try {
      checkedImage(data, mime);
      return mime;
    } catch (error) {
      // Try only the supported raster formats. Invalid image data never reaches the provider.
      if (!(error instanceof RpcError)) throw error;
    }
  }
  return invalidFrame();
}

export async function loadFrame(
  ctx: CapabilityContext,
  run: ToolRunContext,
  callId: string,
  input: GenerateVideo["firstFrame"],
  signal: AbortSignal,
): Promise<Frame | undefined> {
  if (!input) return;
  if ("url" in input) {
    await assertPublicWebTarget(input.url, signal);
    return;
  }
  if ("attachmentId" in input) {
    checkFrameScope(ctx, run, input.attachmentId);
    const result = await readManagedImage(ctx.local.deps, input.attachmentId, signal);
    checkFrameScope(ctx, run, input.attachmentId);
    return { bytes: result.bytes, mimeType: result.image.mimeType };
  }
  const place = run.runWorkplace;
  if (place?.boundary.location?.target !== "local") invalidFrame();
  const read = await prepareTool(
    ctx.local,
    run,
    { id: callId, tool: "read_file", input: { path: input.path } },
    signal,
  );
  const path = read.result.path?.path;
  const roots = place.boundary.readRoots;
  if (
    read.result.decision !== "allow" ||
    !path ||
    !roots.some((root) => containsPath(root, path, ctx.local.deps.platform))
  )
    invalidFrame();
  const result = await ctx.local.target.readBinary({
    path,
    expectedPath: path,
    cwd: place.cwd,
    writeRoots: [],
    rootIdentities: place.boundary.roots,
    maxBytes: IMAGE_LIMIT,
    signal,
  });
  return { bytes: result.bytes, mimeType: frameMime(result.bytes) };
}

export async function prepareVideo(
  ctx: CapabilityContext,
  run: ToolRunContext,
  callId: string,
  raw: unknown,
  signal: AbortSignal,
) {
  const request = GenerateVideoSchema.parse(raw);
  if (
    !run.conversationId ||
    run.routineRunId ||
    run.routineWorkplace ||
    run.executionTaskId ||
    new ConversationsRepo(ctx.db).isInternal(run.conversationId)
  )
    return { requests: [], primary: true, refusal: "video_interactive_required" };
  const models = configuredVideos(ctx);
  const model = selectVideo(ctx, run.botId, models, request.model);
  if (!model) {
    const selected = request.model ?? new BotsRepo(ctx.db).get(run.botId)?.defaultVideoModel;
    const disabled = ctx.local.models?.videoModelsToEnable?.() ?? [];
    const enable = selected
      ? disabled.find(
          ({ providerId, model }) => providerId === selected.provider && model.id === selected.id,
        )
      : disabled[0];
    const settingsAction =
      enable ??
      (!models.length ? { kind: "open_settings" as const, page: "models" as const } : undefined);
    return {
      requests: [],
      primary: true,
      refusal:
        settingsAction?.kind === "enable_video_model"
          ? "video_enable_needed"
          : !models.length
            ? "video_no_models"
            : request.model
              ? "video_model_unavailable"
              : "video_default_unavailable",
      settingsAction,
    };
  }
  let pricing: ReturnType<typeof quote>;
  try {
    pricing = quote(model, request);
  } catch {
    // The selected API cannot represent the requested dimensions.
    return { requests: [], primary: true, refusal: "video_parameters_invalid" };
  }
  const artifact = fileName(ctx, run, callId, request.prompt);
  const place = run.runWorkplace;
  let workspace: WorkspaceIntent | undefined;
  if (
    place?.boundary.location?.target === "local" &&
    ctx.local.execution.allows(run, "write_file")
  ) {
    const path = join(place.cwd, artifact);
    const write = await prepareTool(
      ctx.local,
      run,
      { id: callId, tool: "write_file", input: { path, content: "" } },
      signal,
    );
    const canonical = write.result.path?.path;
    if (
      write.result.decision === "allow" &&
      canonical &&
      samePathSpelling(canonical, path) &&
      place.boundary.writeRoots.some((root) => containsPath(root, path, ctx.local.deps.platform))
    )
      workspace = {
        path: canonical,
        cwd: place.cwd,
        boundary: place.boundary,
        authorization: authorizationSnapshot(ctx.local, run.botId, run),
      };
  }
  const bind = (model: Model, pricing: ReturnType<typeof quote>) =>
    JSON.stringify({ model, pricing, workspace });
  const binding = bind(model, pricing);
  return {
    primary: true,
    requests: [
      {
        category: "video_generation" as const,
        recipient: new URL(model.root).hostname,
        provider: model.providerId,
        model: model.id,
      },
    ],
    binding,
    prepared: { model, pricing, artifact, workspace, binding },
    modelOptions: () =>
      models.flatMap((option) => {
        let pricing: ReturnType<typeof quote>;
        try {
          pricing = quote(option, request);
        } catch {
          // A different API may not accept the parameters or first-frame format of this request.
          return [];
        }
        const binding = bind(option, pricing);
        return [
          {
            id: createHash("sha256")
              .update(JSON.stringify({ model: option, pricing }))
              .digest("hex"),
            label: auditText(`${option.providerName} · ${option.id}`, ctx.redactor, 500),
            localized: {
              zh: costText(ctx, option, pricing, "zh"),
              en: costText(ctx, option, pricing, "en"),
            },
            input: { ...request, model: { provider: option.providerId, id: option.id } },
            binding,
          },
        ];
      }),
  };
}

export type PreparedVideo = NonNullable<Awaited<ReturnType<typeof prepareVideo>>["prepared"]>;

function costText(
  ctx: CapabilityContext,
  model: Model,
  pricing: ReturnType<typeof quote>,
  lang: "en" | "zh",
) {
  const text = videoApprovalText[lang];
  const { title, lead } = text;
  const { duration, label, estimate } = pricing;
  const format = new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
  const rate =
    model.priceUsdPerClip !== undefined
      ? text.clip
      : pricing.priceUsdPerSecond !== undefined
        ? ` (${format.format(pricing.priceUsdPerSecond)}${text.rate})`
        : "";
  return {
    title,
    lead,
    facts: [
      {
        kind: "network" as const,
        label: text.provider,
        value: auditText(`${model.providerName} · ${new URL(model.root).host}`, ctx.redactor),
      },
      {
        kind: "program" as const,
        label: text.model,
        labelKey: "videoModel" as const,
        value: auditText(`${model.providerName} · ${model.id}`, ctx.redactor, 500),
      },
      {
        kind: "program" as const,
        label: text.duration,
        value: `${duration} ${text.seconds}`,
      },
      { kind: "program" as const, label: text.size, value: label },
      {
        kind: "warning" as const,
        label: text.estimate,
        value:
          estimate === undefined
            ? text.unknown
            : format.format(estimate) + rate + (model.cachedPricing ? text.cached : ""),
      },
    ],
  };
}
