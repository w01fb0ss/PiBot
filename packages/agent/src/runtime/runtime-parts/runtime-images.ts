import {
  AgentErrorCodeSchema,
  canonicalImageModelId,
  ImageContentSchema,
  MAX_ATTACHMENTS,
} from "@pibot/protocol-base";
import { AgentError, mapAgentError } from "../../core/errors.ts";
import type { AgentRuntime } from "../../core/types.ts";
import { imageInfo } from "../../images/image-catalog.ts";
import type { RuntimeContext } from "../runtime.ts";
export function createImagesOperations({
  injectKey,
  buildRuntime,
  deps,
}: RuntimeContext): Pick<AgentRuntime, "listImageModels" | "generateImage"> {
  return {
    async listImageModels(opts) {
      const signal = opts?.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000);
      try {
        signal.throwIfAborted();
        const { runtime, custom } = await buildRuntime();
        const available = await runtime.getAvailableOfType("image", undefined, { signal });
        signal.throwIfAborted();
        const configured = new Set(available.map((model) => `${model.provider}\0${model.id}`));
        return (opts?.availableOnly ? available : runtime.getModelsOfType("image"))
          .filter((model) => model.output.includes("image"))
          .map((model) => {
            const config = custom.find((c) => c.id === model.provider);
            return imageInfo(model, configured.has(`${model.provider}\0${model.id}`), config);
          })
          .filter((model) => !opts?.mode || model.modes.includes(opts.mode));
      } catch (error) {
        throw new AgentError(signal.aborted ? "aborted" : mapAgentError(error));
      }
    },

    async generateImage(request) {
      const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 300_000, 1), 300_000);
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([request.signal, deadline]);
      // Only the caller's signal is a stop; the cap firing alone means the service never answered.
      const abortCode = () =>
        deadline.aborted && !request.signal.aborted ? "image_timeout" : "aborted";
      try {
        signal.throwIfAborted();
        if (!deps.network) throw new AgentError("image_unsupported");
        if (!request.prompt.trim() || request.images.length > MAX_ATTACHMENTS)
          throw new AgentError("provider_error");
        if (request.mode === "image-to-image" && !request.images.length)
          throw new AgentError("image_input_required");
        if (request.mode === "text-to-image" && request.images.length)
          throw new AgentError("image_mode_mismatch");
        const images = request.images.map((image) => {
          const parsed = ImageContentSchema.safeParse(image);
          if (!parsed.success) throw new AgentError("provider_error");
          return parsed.data;
        });
        const { runtime, custom } = await buildRuntime();
        const model = runtime.getModelOfType(
          "image",
          request.model.provider,
          canonicalImageModelId(request.model.provider, request.model.id),
        );
        if (!model) throw new AgentError("no_model");
        const config = custom.find((c) => c.id === model.provider);
        const info = imageInfo(model, true, config);
        if (
          !info.modes.includes(request.mode) ||
          (info.maxReferences !== undefined && images.length > info.maxReferences)
        )
          throw new AgentError("image_mode_mismatch");
        if (info.recipient !== request.recipient || (info.origin && request.origin !== info.origin))
          throw new AgentError("permission_denied");
        if (config?.imageApi !== "comfyui-images") await injectKey(runtime, model.provider);
        signal.throwIfAborted();
        // Auth resolution stays in pi, including lazy subscription refresh via the injected transport.
        const auth = await runtime.getAuth(model, { signal });
        if (!auth) throw new AgentError("auth_failed");
        signal.throwIfAborted();
        if (info.origin) {
          // Config and credentials load independently. Refuse an origin change while resolving a key.
          const current = deps.customProviders().find((c) => c.id === model.provider);
          if (!current || new URL(current.baseUrl).origin !== info.origin)
            throw new AgentError("permission_denied");
        }
        request.assertCurrent?.();
        const result = await runtime.generateImages(
          model,
          { input: [{ type: "text", text: request.prompt }, ...images] },
          { signal, timeoutMs, maxRetries: 0 },
        );
        // A complete paid result must reach brain's managed retention even if Stop wins now.
        // Transport still cancels in flight; non-success/invalid outputs remain errors below.
        if (result.stopReason !== "stop") {
          const parsedCode = AgentErrorCodeSchema.safeParse(result.errorMessage);
          const code = parsedCode.success ? parsedCode.data : mapAgentError(result.errorMessage);
          throw new AgentError(result.stopReason === "aborted" ? abortCode() : code);
        }
        const outputs = result.output
          .filter((part) => part.type === "image")
          .map((part) => {
            const parsed = ImageContentSchema.safeParse(part);
            if (!parsed.success) throw new AgentError("provider_error");
            return parsed.data;
          });
        if (!outputs.length || outputs.length > MAX_ATTACHMENTS)
          throw new AgentError("provider_error");
        return {
          text: result.output.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          images: outputs,
          usage: result.usage,
        };
      } catch (error) {
        throw new AgentError(signal.aborted ? abortCode() : mapAgentError(error));
      }
    },
  };
}
