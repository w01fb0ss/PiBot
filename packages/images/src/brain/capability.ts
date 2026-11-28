import type { BrainCapability, ImagesPort } from "@pibot/brain/kit";
import { ImageArtifactService } from "./artifacts/image-artifact-service.ts";
import { imageBotName } from "./artifacts/image-name.ts";
import { requireImageModel } from "./artifacts/image-preflight.ts";
import { reuseImageRun } from "./run/image-reuse-run.ts";
import { generateImageRun } from "./run/image-run.ts";
export function imagesCapability(): BrainCapability {
  return {
    id: "images",
    register(ctx) {
      const artifacts = new ImageArtifactService(ctx.local);
      const port: ImagesPort = {
        requireModel: (selected, mode, signal) =>
          requireImageModel(ctx.agent, selected, mode, signal),
        name: imageBotName,
        assertVisible: (context, operation) => artifacts.assertVisible(context, operation),
        execute: (context, operation) => artifacts.execute(context, operation),
        run: (deps, run, text, bot, images, dispatchModel) =>
          run.imageOperation
            ? reuseImageRun(deps, run, artifacts)
            : generateImageRun(deps, run, text, bot, images, artifacts, dispatchModel),
      };
      ctx.images.provide(port);
      ctx.rpc.handle("images.reuse", async (params) => artifacts.enqueue(ctx.chat.queue, params));
      return {};
    },
  };
}
