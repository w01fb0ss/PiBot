import type { BrainCapability } from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { GenerateVideoSchema } from "@pibot/videos-contract";
import { videoView } from "../store/jobs.ts";
import { configuredVideos, loadFrame, prepareVideo, selectVideo } from "./prepare.ts";
import { type VideoOptions, VideoService } from "./service.ts";

export type { VideoOptions } from "./service.ts";

export function videosCapability(options: VideoOptions = {}): BrainCapability {
  return {
    id: "videos",
    register(ctx) {
      const service = new VideoService(ctx, options);
      ctx.sleep.participate({ idle: service.idle });
      ctx.local.provideToolPolicyFor("generate_video", (run, call, _tool, input, signal) =>
        prepareVideo(ctx, run, call.id, input, signal),
      );
      ctx.tools.executor("list_video_models", async (run) => {
        const models = configuredVideos(ctx);
        const preferred = selectVideo(ctx, run.botId, models);
        const settingsAction = !models.length
          ? (ctx.local.models?.videoModelsToEnable?.()[0] ?? {
              kind: "open_settings" as const,
              page: "models" as const,
            })
          : undefined;
        return {
          text: JSON.stringify(
            models.map((model) => ({
              providerId: model.providerId,
              providerName: model.providerName,
              id: model.id,
              api: model.api,
              default: model === preferred,
              priceUsdPerClip: model.priceUsdPerClip,
              priceUsdPerSecond: model.priceUsdPerSecond,
              priceUsdPerSecondBySize: model.priceUsdPerSecondBySize,
              cachedPricing: model.cachedPricing,
            })),
          ),
          summary: "list_video_models",
          ...(settingsAction ? { details: { settingsAction } } : {}),
        };
      });
      ctx.rpc.handle("videos.models", ({ offset, limit }) =>
        configuredVideos(ctx)
          .slice(offset, offset + limit)
          .map(({ providerId, providerName, id }) => ({
            provider: providerId,
            providerName,
            id,
          })),
      );
      ctx.tools.executor("generate_video", async (run, call, signal, authorization) => {
        const request = GenerateVideoSchema.parse(call.input);
        const current = await prepareVideo(ctx, run, call.id, request, signal);
        const approved = authorization?.data as { binding?: string } | undefined;
        if (
          !authorization?.confirmedNow ||
          !current.prepared ||
          approved?.binding !== current.prepared.binding
        )
          throw new RpcError(RpcErrorCodes.invalidParams, "video_approval_changed");
        if (service.full()) throw new RpcError(RpcErrorCodes.invalidParams, "video_jobs_busy");
        const frame = await loadFrame(ctx, run, call.id, request.firstFrame, signal);
        authorization.assertCurrent();
        signal.throwIfAborted();
        const id = service.queue(run, request, current.prepared, frame);
        return {
          text: `Video job ${id} queued. The chat card reports progress and delivers the file when ready.`,
          summary: "generate_video",
        };
      });
      ctx.rpc.handle("videos.get", async ({ id, messageId }) =>
        videoView(service.get(id, messageId)),
      );
      ctx.rpc.handle("videos.cancel", async ({ id, messageId }) =>
        videoView(await service.cancel(id, messageId)),
      );
      return { start: () => service.start(), stop: () => service.stop() };
    },
  };
}
