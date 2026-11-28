import { join } from "node:path";
import { AgentError, mapAgentError } from "@pibot/agent";
import type { ChatRun, ImageDispatchModel, ImageRunHost, ToolRunContext } from "@pibot/brain/kit";
import {
  auditText,
  ChatReplies,
  type PreparedAttachments,
  resolveRunWorkplace,
  topicWorkplaceSnapshot,
} from "@pibot/brain/kit";
import { imageExportFileName } from "@pibot/execution";
import {
  type AgentErrorCode,
  type Bot,
  type ImageContent,
  type ImageDelivery,
  ImageDeliverySchema,
  type ImageGenerationResults,
  type ImageMode,
  type Message,
  MessageSchema,
} from "@pibot/images-contract/full";
import { AttachmentsRepo, MessagesRepo, RunsRepo, transaction } from "@pibot/storage";
import type { ImageArtifactService } from "../artifacts/image-artifact-service.ts";
import { ImageApprovalDeclined, ImageAuthorization } from "../artifacts/image-service.ts";
import { prepareImageWorkspace } from "../workspace/image-workspace-target.ts";
import { imageContextInputs } from "./image-context-input.ts";
import { imageDeliveryText } from "./image-delivery-text.ts";
import { generateImageRequests, imageResultsText } from "./image-requests.ts";
import { validatedImages } from "./image-run-output.ts";
import { retainGeneratedImage } from "./image-run-retained.ts";

export { IMAGE_GENERATION_TIMEOUT_MS } from "./image-requests.ts";

/** The run queue owns the Bot lock until both HTTP and attachment work have settled. */
export async function generateImageRun(
  deps: ImageRunHost,
  run: ChatRun,
  text: string,
  bot: Bot,
  images: ImageContent[],
  artifacts: ImageArtifactService,
  dispatchModel?: ImageDispatchModel,
) {
  const local = deps.local;
  let mode: ImageMode = images.length ? "image-to-image" : "text-to-image";
  const route = {
    botId: run.botId,
    conversationId: run.conversationId,
    ...(run.groupId ? { groupId: run.groupId } : {}),
    ...(run.threadId ? { threadId: run.threadId } : {}),
  };
  const signal = local ? AbortSignal.any([run.signal, local.shutdown.signal]) : run.signal;
  const context: ToolRunContext = {
    ...route,
    runId: run.runId,
    messageId: run.messageId,
    cycleId: run.cycleId,
    taskId: run.taskId,
    signal,
    language: deps.language(),
    ...(run.routine
      ? {
          routineRunId: run.routine.id,
          routineSource: run.routine.source,
          routineName: run.routine.name,
          routineClock: run.routine.clock,
          routineApprovalWaitMs: run.routine.approvalWaitMs,
          routineWorkplace: run.routine.workplace,
        }
      : {}),
  };
  const replies = new ChatReplies(deps.db, run, deps.peer, deps.redactor, () => {});
  const runs = new RunsRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  let batch: PreparedAttachments | undefined;
  let committed = false;
  let startedAt = 0;
  let authorization: ImageAuthorization | undefined;
  let imageResults: ImageGenerationResults | undefined;
  let finalText = "";
  let attemptedModel: { provider: string; id: string } | undefined;
  const emit = (action: () => void) => {
    try {
      action();
    } catch {
      deps.logger.warn("Image notification deferred; history retains committed metadata");
    }
  };
  // Keep the activity visible until all paid requests and attachment preparation settle.
  // Task runs have no visible reply, as in chat-run.
  const activity = (phase: "executing_tool" | "clear") => {
    if (run.executionTaskId) return;
    emit(() =>
      deps.peer.emit("chat.activity", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        ...(phase === "clear" ? { phase } : { phase, tool: "image_generation" }),
      }),
    );
  };
  const stopCode = (error: unknown): AgentErrorCode => {
    if (local?.budgets.repo.get(run.budgetRootRunId ?? run.runId)?.exhaustedReason)
      return "budget_exhausted" as const;
    if (run.aborted || signal.aborted) return "aborted" as const;
    return mapAgentError(error);
  };
  const metadata = {
    toolName: "image_generation",
    category: "web" as const,
    providerId: auditText(bot.modelProvider ?? "", deps.redactor),
    modelId: auditText(bot.modelId ?? "", deps.redactor),
    imageMode: mode,
    source: run.routine?.source ?? ("chat" as const),
    ...(run.routine ? { routineRunId: run.routine.id } : {}),
  };
  try {
    signal.throwIfAborted();
    if (!local || !deps.agent.generateImage) throw new AgentError("image_unsupported");
    local.budgets.begin(
      context,
      local.execution.get({ botId: bot.id, conversationId: run.conversationId }).limits,
    );
    if (run.routine?.resumeDecision || run.parking) throw new AgentError("image_unsupported");
    if (images.length) validatedImages(images);
    context.topicWorkplace = topicWorkplaceSnapshot(local, context);
    const place = await resolveRunWorkplace(local, context, signal);
    local.setRunWorkplace(context, place);
    // Image generation bypasses LocalRun, but exporting its file still needs the original
    // workspace context when the queue captures checkpoints before releasing this run.
    local.retainRunContext(context);
    const options = run.imageGeneration;
    // The structured dispatch describes new images. References still come from the caller's
    // attachments or explicit quote, never from an unrelated earlier generation in the topic.
    const references = options
      ? { images, assertCurrent: () => signal.throwIfAborted() }
      : await imageContextInputs(local, context, images);
    images = references.images;
    mode = images.length ? "image-to-image" : "text-to-image";
    metadata.imageMode = mode;
    if (dispatchModel && !options)
      bot = (await dispatchModel(images.length > 0, undefined, context.executionClock)) ?? bot;
    const generate = async () => {
      const attempt = new ImageAuthorization(
        local,
        deps.agent,
        bot,
        context,
        mode,
        images.length,
        options,
      );
      authorization = attempt;
      const models = await attempt.authorize();
      const model = models[0];
      if (!model) throw new AgentError("no_model");
      metadata.providerId = auditText(model.provider, deps.redactor);
      metadata.modelId = auditText(model.id, deps.redactor);
      const target = await prepareImageWorkspace(local, context);
      artifacts.repo.capture(target, {
        provider: model.provider,
        id: model.id,
        recipient: model.recipient,
        mode,
        ...(options
          ? { botModel: { provider: bot.modelProvider ?? "", id: bot.modelId ?? "" } }
          : {}),
      });
      attempt.assertCurrent();
      references.assertCurrent();
      if (options) startedAt = Date.now();
      activity("executing_tool");
      const endExec = attempt.timing.enter("exec");
      const generated = await generateImageRequests({
        deps,
        local,
        context,
        authorization: attempt,
        models,
        mode,
        images,
        text,
        norms: bot.norms ?? undefined,
        options,
        assertReferences: references.assertCurrent,
        onRequestStart(model) {
          if (options) return;
          local.approvals.audit.append({
            botId: bot.id,
            runId: run.runId,
            kind: "image.started",
            summary: "Image generation started / 开始生成图片",
            detail: { ...metadata, target: model.recipient, imageCount: images.length },
          });
          attemptedModel = { provider: metadata.providerId, id: metadata.modelId };
          startedAt = Date.now();
        },
        stopCode,
      }).finally(() => {
        endExec();
        activity("clear");
      });
      return { generated, model, target, attempt };
    };
    let result: Awaited<ReturnType<typeof generate>>;
    for (;;) {
      try {
        result = await generate();
        break;
      } catch (error) {
        if (error instanceof ImageApprovalDeclined || options || signal.aborted || !dispatchModel)
          throw error;
        const failedAt = Date.now();
        const reason = stopCode(error);
        const replacement = await dispatchModel(images.length > 0, error, context.executionClock);
        if (!replacement) throw error;
        if (startedAt) {
          local.approvals.audit.append({
            botId: bot.id,
            runId: run.runId,
            kind: "image.finished",
            summary: "Image generation stopped / 图片生成停止",
            detail: {
              ...metadata,
              durationMs: failedAt - startedAt,
              reasonCode: reason === "image_timeout" ? "timeout" : reason,
            },
          });
          startedAt = 0;
        }
        authorization?.finish("error");
        authorization = undefined;
        // A rejected provider request committed no image. Keep completed artifacts immutable.
        artifacts.repo.releaseUncommitted(run.runId);
        bot = replacement;
      }
    }
    const { generated, model, target, attempt } = result;
    batch = generated.prepared;
    imageResults = generated.results;
    finalText = deps.redactor.redact(generated.caption);
    if (!batch.items.length) {
      const failure = imageResults?.items.find((item) => item.status === "failed");
      throw new AgentError(failure?.reasonCode ?? "provider_error");
    }
    const endPost = attempt.timing.enter("post");
    let usage = MessageSchema.shape.usage.parse({
      ...generated.usage,
      ...(imageResults ? { imageResults } : {}),
      imageGeneration: true,
      ...(!options ? { runModel: { provider: model.provider, id: model.id } } : {}),
      imageMode: mode,
      imageCount: batch.items.length,
      stopReason: "stop",
      ...(run.routine ? { finalReply: finalText } : {}),
      ...(run.threadId
        ? { taskReply: finalText.slice(0, 100_000).replace(/[\uD800-\uDBFF]$/u, "") }
        : {}),
    });
    // Paid generation and managed delivery commit before the independent workspace operation.
    transaction(deps.db, () => {
      // Retention completes an already-authorized request. It cannot authorize another request,
      // a project write or a new source; cancellation must not discard a paid response.
      const currentRun = runs.get(run.runId);
      const currentMessage = messages.get(run.messageId);
      if (
        currentRun?.botId !== bot.id ||
        currentRun.conversationId !== run.conversationId ||
        currentRun.messageId !== run.messageId ||
        currentMessage?.botId !== bot.id ||
        currentMessage.conversationId !== run.conversationId ||
        currentMessage.runId !== run.runId
      )
        throw new AgentError("permission_denied");
      generated.attachments.persist(run.messageId, generated.prepared, bot.id);
      messages.update(run.messageId, { content: finalText, usage });
      artifacts.repo.markGenerated(run.runId);
    });
    committed = true;
    endPost();
    attempt.timing.finish();
    // The paid image is already available while the separate workspace approval is pending.
    emit(() =>
      deps.peer.emit("chat.attachments", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        attachments:
          new AttachmentsRepo(deps.db).forMessages([run.messageId]).get(run.messageId) ?? [],
      }),
    );
    signal.throwIfAborted();
    await attempt.revalidate();
    signal.throwIfAborted();
    let delivery: ImageDelivery;
    try {
      delivery = await artifacts.exporter.save(
        context,
        target,
        batch.items.map((item) => item.metadata.id),
      );
    } catch {
      // Once the managed image exists, save failure/cancellation cannot discard it or regenerate it.
      delivery = ImageDeliverySchema.parse({
        attachments: "delivered",
        workspace: batch.items.map((item) => {
          const extension =
            item.metadata.mimeType === "image/jpeg" ? "jpg" : item.metadata.mimeType.split("/")[1];
          const fileName = imageExportFileName({
            runId: run.runId,
            attachmentId: item.metadata.id,
            extension: extension as "png" | "jpg" | "webp" | "gif",
          });
          return {
            attachmentId: item.metadata.id,
            fileName,
            targetPath: join(target.cwd, fileName),
            status: signal.aborted ? "cancelled" : "failed",
            errorCode: signal.aborted ? "cancelled" : "file_failed",
          };
        }),
      });
      deps.logger.warn(`Image workspace save incomplete run=${run.runId}`);
    }
    finalText = deps.redactor.redact(
      [finalText, imageDeliveryText(context.language, delivery)].filter(Boolean).join("\n\n"),
    );
    usage = MessageSchema.shape.usage.parse({
      ...(usage as Record<string, unknown>),
      imageDelivery: delivery,
      imageArtifactSourceRunId: run.runId,
      ...(run.routine ? { finalReply: finalText } : {}),
      ...(run.threadId
        ? { taskReply: finalText.slice(0, 100_000).replace(/[\uD800-\uDBFF]$/u, "") }
        : {}),
    });
    let updates: Message[] = [];
    const completed = transaction(deps.db, () => {
      // Content, usage and the done state commit together; no half-delivered message on failure.
      messages.update(run.messageId, { content: finalText, usage });
      replies.content = finalText;
      updates = replies.finish("done", usage);
      runs.finish(run.runId, "done", "stop");
      attempt.finish("done");
      if (!options)
        local.approvals.audit.append({
          botId: bot.id,
          runId: run.runId,
          kind: "image.finished",
          summary: "Image generation completed / 图片生成完成",
          detail: {
            ...metadata,
            target: model?.recipient,
            imageCount: batch?.items.length,
            durationMs: Date.now() - startedAt,
            reasonCode: "done",
          },
        });
      // Successful member output uses the existing automatic completion and attachment source.
      return local.collaboration?.completeRun?.(context, finalText, "stop", []);
    });
    committed = true;
    if (!run.groupId || run.threadId || !messages.hasResultMessage(run.messageId))
      emit(() =>
        deps.peer.emit("chat.delta", {
          ...route,
          runId: run.runId,
          messageId: run.messageId,
          text: finalText,
        }),
      );
    emit(() => replies.publishUpdates(updates));
    emit(() => completed?.());
    emit(() =>
      deps.peer.emit("chat.attachments", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        attachments:
          new AttachmentsRepo(deps.db).forMessages([run.messageId]).get(run.messageId) ?? [],
      }),
    );
    emit(() =>
      deps.peer.emit("chat.done", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        usage,
        stopReason: "stop",
      }),
    );
  } catch (error) {
    const code = stopCode(error);
    const declined =
      code === "permission_denied" && error instanceof ImageApprovalDeclined
        ? {
            providerId: auditText(error.model.provider, deps.redactor),
            modelId: auditText(error.model.id, deps.redactor),
          }
        : undefined;
    const replacementDeclined = declined && attemptedModel;
    const declineReason = declined
      ? replacementDeclined
        ? "image_replacement_approval_declined"
        : "image_approval_declined"
      : undefined;
    const receiptModel = replacementDeclined ? attemptedModel : run.selectedModel;
    const cancelled = run.aborted || signal.aborted;
    const exhausted = local?.budgets.repo.get(run.budgetRootRunId ?? run.runId)?.exhaustedReason;
    run.stopCause ??= {
      code:
        exhausted === "repeated_operation"
          ? "repeated_operation"
          : exhausted
            ? "budget_exhausted"
            : code === "image_timeout"
              ? "timeout"
              : "error",
    };
    run.controller.abort(run.stopCause);
    if (batch && !committed) await batch.discard();
    if (committed) {
      retainGeneratedImage(
        deps,
        run,
        replies,
        context.language,
        authorization,
        emit,
        exhausted ? "budget_exhausted" : cancelled ? "aborted" : undefined,
      );
      return;
    }
    // image_timeout is an error (with Retry), never "aborted": the user did not stop it.
    const updates = transaction(deps.db, () => {
      if (imageResults) {
        // If the attachment transaction failed, none of its attachment IDs were published.
        imageResults.items = imageResults.items.map((item) =>
          item.status === "success"
            ? { model: item.model, status: "failed", reasonCode: code }
            : item,
        );
        finalText = deps.redactor.redact(imageResultsText(context.language, imageResults));
        replies.content = finalText;
        messages.update(run.messageId, { content: finalText });
      }
      const updates = replies.finish(
        code === "aborted" ? "aborted" : "error",
        {
          stopReason: code,
          ...(declined
            ? replacementDeclined
              ? {
                  imageReplacementDeclined: {
                    attemptedModel: `${replacementDeclined.provider}/${replacementDeclined.id}`,
                    replacementModel: `${declined.providerId}/${declined.modelId}`,
                  },
                }
              : { imageApprovalDeclined: true }
            : {}),
          imageMode: mode,
          ...(receiptModel ? { runModel: receiptModel } : {}),
          ...(imageResults ? { imageGeneration: true, imageResults } : {}),
        },
        code,
      );
      runs.finish(
        run.runId,
        code === "aborted" ? "aborted" : "error",
        code === "aborted" ? "aborted" : "error",
        declineReason ?? (code === "permission_denied" ? "image_request_incomplete" : code),
      );
      authorization?.finish(code === "aborted" ? "aborted" : "error");
      local?.approvals.audit.append({
        botId: bot.id,
        runId: run.runId,
        kind: "image.finished",
        summary: "Image generation stopped / 图片生成停止",
        detail: {
          ...metadata,
          ...declined,
          reasonCode: declineReason ?? (code === "image_timeout" ? "timeout" : code),
          durationMs: startedAt ? Date.now() - startedAt : 0,
        },
      });
      return updates;
    });
    emit(() => replies.publishUpdates(updates));
    emit(() =>
      deps.peer.emit("chat.error", {
        ...route,
        runId: run.runId,
        messageId: run.messageId,
        code,
        message: code,
      }),
    );
    if (code === "internal") deps.logger.error(`Image run ${run.runId} internal`);
    else deps.logger.warn(`Image run ${run.runId} ${code}`);
  } finally {
    try {
      local?.budgets.end(context);
      replies.interruptAdditions();
    } finally {
      run.stopCause ??= { code: "completed" };
      run.controller.abort(run.stopCause);
      deps.finished(run);
    }
  }
}
