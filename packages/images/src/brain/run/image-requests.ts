import { randomUUID } from "node:crypto";
import { AgentError, mapAgentError } from "@pibot/agent";
import type {
  ImageRunHost,
  LocalService,
  PreparedAttachments,
  ToolRunContext,
} from "@pibot/brain/kit";
import { AttachmentService, auditText } from "@pibot/brain/kit";
import {
  type AgentErrorCode,
  type ImageContent,
  type ImageGenerationOptions,
  type ImageGenerationResults,
  ImageGenerationResultsSchema,
  type ImageMode,
  type ImageModelInfo,
  imageGenerationResultCounts,
} from "@pibot/images-contract/full";
import { imageErrorKey, mediaEn, mediaZh } from "@pibot/images-contract/i18n";
import type { ImageAuthorization } from "../artifacts/image-service.ts";
import { imageQualityPrompt } from "./image-quality-prompt.ts";
import { imageUsage, observedImageUsage, validatedImages } from "./image-run-output.ts";

export const IMAGE_GENERATION_TIMEOUT_MS = 300_000;

type Entry = {
  model: ImageModelInfo;
  prompt: string;
};
type Outcome =
  | { status: "success"; prepared: PreparedAttachments }
  | { status: "failed"; reasonCode: AgentErrorCode };

function entries(
  models: ImageModelInfo[],
  text: string,
  options?: ImageGenerationOptions,
): Entry[] {
  if (options?.kind === "compare")
    return models.map((model) => ({ model, prompt: options.prompt }));
  const model = models[0];
  if (!model) throw new AgentError("no_model");
  if (!options) return [{ model, prompt: text }];
  return Array.from({ length: options.prompts?.length ?? options.count ?? 1 }, (_, index) => ({
    model,
    prompt: options.prompts?.[index] ?? options.prompt ?? text,
  }));
}

export function imageResultsText(language: "zh" | "en", results: ImageGenerationResults) {
  const text = language === "zh" ? mediaZh : mediaEn;
  const { images, success, total } = imageGenerationResultCounts(results);
  return [
    text["media.multi.summary"]
      .replace("{images}", String(images))
      .replace("{success}", String(success))
      .replace("{total}", String(total)),
    ...results.items.flatMap((item, index) => {
      if (item.status === "success") return [];
      const label =
        results.kind === "compare"
          ? item.model
          : text["media.multi.item"].replace("{index}", String(index + 1));
      const reason = text[imageErrorKey(item.reasonCode) ?? "media.multi.failureGeneric"];
      return [`- ${label} · ${text["media.multi.failure"].replace("{code}", reason)}`];
    }),
  ].join("\n");
}

export async function generateImageRequests(input: {
  deps: ImageRunHost;
  local: LocalService;
  context: ToolRunContext;
  authorization: ImageAuthorization;
  models: ImageModelInfo[];
  mode: ImageMode;
  images: ImageContent[];
  text: string;
  norms?: string;
  options?: ImageGenerationOptions;
  assertReferences(): void;
  onRequestStart?(model: ImageModelInfo): void;
  stopCode(error: unknown): AgentErrorCode;
}) {
  const { deps, local, context, authorization, models, mode, images, text, norms, options } = input;
  if (!deps.agent.generateImage) throw new AgentError("image_unsupported");
  const generate = deps.agent.generateImage.bind(deps.agent);
  const timeoutMs = Math.min(
    local.deps.imageGenerationTimeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS,
    IMAGE_GENERATION_TIMEOUT_MS,
  );
  const attachments = new AttachmentService(deps.db, deps.dataDir, local.deps.host.attachments);
  const accounting = local.budgets.observer(context);
  const queue = entries(models, text, options);
  let caption = "";
  let usage: ReturnType<typeof imageUsage> = {};
  const outcomes: Outcome[] = [];
  let next = 0;
  // The desktop attachment host has one decoder slot. Provider requests can overlap while
  // attachment preparation takes turns, and each worker holds at most one response.
  let preparing = Promise.resolve();

  async function request({ model, prompt }: Entry, index: number) {
    context.signal.throwIfAborted();
    const assertCurrent = () => {
      authorization.assertCurrent();
      input.assertReferences();
    };
    assertCurrent();
    const id = randomUUID();
    accounting.beforeRequest({
      id,
      kind: "response",
      provider: model.provider,
      model: model.id,
      pricingKnown:
        (mode === "image-to-image" ? model.editPrice : model.generationPrice)?.currency === "USD",
    });
    const requestStartedAt = Date.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([context.signal, deadline]);
    const dimensions = model.workflowOutput
      ? []
      : [
          options?.ratio &&
            !model.aspectRatio &&
            !model.size?.includes("x") &&
            `Requested aspect ratio: ${options.ratio}.`,
          options?.size &&
            !model.size &&
            !model.aspectRatio &&
            `Requested image size: ${options.size} pixels.`,
        ].filter(Boolean);
    const preparedPrompt = imageQualityPrompt(
      deps.redactor.redact([prompt, ...dimensions].join("\n")),
      context.language,
      norms ? deps.redactor.redact(norms) : undefined,
    );
    const metadata = {
      toolName: "image_generation",
      category: "web" as const,
      providerId: auditText(model.provider, deps.redactor),
      modelId: auditText(model.id, deps.redactor),
      imageMode: mode,
      target: model.recipient,
    };
    let settled = false;
    let outputCount = 0;
    let outcome: AgentErrorCode | "done" = "done";
    const result = await (async () => {
      try {
        if (options)
          local.approvals.audit.append({
            botId: context.botId,
            runId: context.runId,
            kind: "image.started",
            summary: "Image generation started / 开始生成图片",
            detail: { ...metadata, ...(!model.workflowOutput ? { imageCount: 1 } : {}) },
          });
        input.onRequestStart?.(model);
        const value = await generate({
          model: { provider: model.provider, id: model.id },
          recipient: model.recipient,
          origin: model.origin,
          assertCurrent,
          mode,
          prompt: preparedPrompt.text,
          images,
          signal,
          timeoutMs,
        });
        settled = true;
        accounting.settled({ id, complete: true, usage: observedImageUsage(value.usage) });
        const outputs = validatedImages(value.images);
        if (options && !model.workflowOutput && outputs.length !== 1)
          throw new AgentError("provider_error");
        outputCount = outputs.length;
        return { value, outputs };
      } catch (error) {
        outcome =
          !context.signal.aborted && deadline.aborted && mapAgentError(error) === "aborted"
            ? "image_timeout"
            : input.stopCode(error);
        throw new AgentError(outcome);
      } finally {
        if (!settled) accounting.settled({ id, complete: false });
        if (options)
          local.approvals.audit.append({
            botId: context.botId,
            runId: context.runId,
            kind: "image.finished",
            summary: "Image request ended / 图片请求结束",
            detail: {
              ...metadata,
              imageCount: outputCount,
              reasonCode: outcome,
              durationMs: Date.now() - requestStartedAt,
            },
          });
        const lengths = preparedPrompt.lengths;
        deps.logger.info(
          `image.generation run=${context.runId} provider=${metadata.providerId} model=${metadata.modelId} mode=${mode} promptChars=${lengths.promptChars} requestChars=${lengths.requestChars} normsChars=${lengths.normsChars} guidanceChars=${lengths.guidanceChars} referenceImages=${images.length} durationMs=${Date.now() - requestStartedAt} timeoutMs=${timeoutMs} outcome=${outcome}`,
        );
      }
    })();
    const { value, outputs } = result;
    if (!options) {
      caption =
        value.text?.trim() || (context.language === "zh" ? "图片已生成。" : "Image generated.");
      usage = imageUsage(value.usage);
    }
    // A completed paid response is retained even if Stop or a budget limit just fired.
    const prepared = preparing.then(() =>
      attachments.prepareOutput(
        context.botId,
        outputs.map(({ bytes, image }, offset) => ({
          name: `image-${options && outputs.length > 1 ? `${index + 1}-${offset + 1}` : index + offset + 1}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]}`,
          bytes,
        })),
        AbortSignal.any([local.shutdown.signal, AbortSignal.timeout(20_000)]),
      ),
    );
    preparing = prepared.then(
      () => {},
      () => {
        // The worker reports this item's error. The next attachment still needs the decoder.
      },
    );
    return prepared;
  }

  async function worker() {
    while (next < queue.length && !context.signal.aborted) {
      const index = next++;
      const entry = queue[index] as Entry;
      try {
        outcomes[index] = { status: "success", prepared: await request(entry, index) };
      } catch (error) {
        outcomes[index] = { status: "failed", reasonCode: input.stopCode(error) };
      }
    }
  }

  if (options) {
    const concurrency = options.kind === "compare" ? queue.length : Math.min(2, queue.length);
    await Promise.all(Array.from({ length: concurrency }, worker));
  } else {
    return {
      attachments,
      prepared: await request(queue[0] as Entry, 0),
      results: undefined,
      caption,
      usage,
    };
  }
  const batches = outcomes.flatMap((item) => (item.status === "success" ? [item.prepared] : []));
  const prepared: PreparedAttachments = {
    items: batches.flatMap((batch) => batch.items),
    images: [],
    text: "",
    discard: async () => {
      await Promise.all(batches.map((batch) => batch.discard()));
    },
  };
  try {
    const results = ImageGenerationResultsSchema.parse({
      kind: options.kind,
      items: queue.map(({ model }, index) => {
        const outcome = outcomes[index];
        const name =
          auditText(model.name, deps.redactor) || auditText(model.id, deps.redactor) || "—";
        if (outcome?.status !== "success")
          return {
            model: name,
            status: "failed",
            reasonCode: outcome?.reasonCode ?? input.stopCode(new AgentError("aborted")),
          };
        const [attachmentId, ...additionalAttachmentIds] = outcome.prepared.items.map(
          ({ metadata }) => metadata.id,
        );
        return {
          model: name,
          status: "success",
          attachmentId,
          ...(additionalAttachmentIds.length ? { additionalAttachmentIds } : {}),
        };
      }),
    });
    return {
      attachments,
      prepared,
      results,
      caption: imageResultsText(context.language, results),
      usage,
    };
  } catch (error) {
    await prepared.discard();
    throw error;
  }
}
