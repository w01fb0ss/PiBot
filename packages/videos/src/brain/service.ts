import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { auditText, type CapabilityContext, type ToolRunContext } from "@pibot/brain/kit";
import { createNetworkFetch } from "@pibot/execution";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { MessagesRepo, transaction } from "@pibot/storage";
import type { GenerateVideo } from "@pibot/videos-contract";
import { ZodError } from "zod";
import { isActive, type JobRecord, VideoJobs } from "../store/jobs.ts";
import { exportVideo, ownerAvailable, videoAttachmentService } from "./delivery.ts";
import { configuredVideos, type PreparedVideo } from "./prepare.ts";
import {
  cancellationPath,
  createVideo,
  type Frame,
  omniOutput,
  pollPath,
  providerJob,
  providerState,
} from "./provider.ts";
import {
  decodeInlineMp4,
  type PublicVideoDownload,
  publicVideoDownload,
  RetryableVideoRequest,
  VideoFailure,
  VideoQueueFull,
  VideoTransport,
} from "./transport.ts";

export interface VideoOptions {
  pollMs?: number;
  timeoutMs?: number;
  publicDownload?: PublicVideoDownload;
}

type VideoStep = "submit" | "poll" | "download" | "deliver";

function failureDetails(error: unknown, redactor: CapabilityContext["redactor"]) {
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(value)
      ? redactor.redact(value)
      : undefined;
  let errorName = "Error";
  let errorCode: string | number | undefined;
  // Keep the underlying transport or delivery diagnostics without serializing exception text.
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    errorName = identifier(error.name === "Error" ? error.constructor.name : error.name) ?? "Error";
    const code =
      error instanceof ZodError
        ? error.issues[0]?.code
        : "code" in error
          ? error.code
          : "reason" in error
            ? error.reason
            : undefined;
    errorCode =
      typeof code === "number" && Number.isSafeInteger(code)
        ? code
        : (identifier(code) ?? errorCode);
    error = error.cause;
  }
  return { errorName, errorCode };
}

export class VideoService {
  private readonly jobs: VideoJobs;
  private readonly messages: MessagesRepo;
  private readonly network;
  private readonly lifetime = new AbortController();
  private readonly active = new Map<string, { abort: AbortController; work: Promise<void> }>();
  private readonly committing = new Set<string>();

  constructor(
    private readonly ctx: CapabilityContext,
    private readonly options: VideoOptions,
  ) {
    this.jobs = new VideoJobs(ctx.db);
    this.messages = new MessagesRepo(ctx.db);
    // Omni can take longer than Undici's response timeout before sending headers.
    this.network = createNetworkFetch(() => ctx.local.deps.proxy?.(), { responseTimeoutMs: 0 });
  }

  idle = () => this.active.size === 0;
  full = () => this.jobs.countActive() >= 8;

  start() {
    let after = { id: "", createdAt: 0 };
    while (true) {
      const page = this.jobs.active(after);
      for (const job of page) this.launch(job);
      const last = page.at(-1);
      if (!last) break;
      after = last;
    }
  }

  async stop() {
    this.lifetime.abort();
    for (const { abort } of this.active.values()) abort.abort();
    await Promise.all([...this.active.values()].map(({ work }) => work));
    await this.network.stop();
  }

  get(id: string, messageId: string) {
    const job = this.jobs.get(id);
    if (!job || job.messageId !== messageId || !this.messages.get(messageId))
      throw new RpcError(RpcErrorCodes.invalidParams, "video_job_unavailable");
    return job;
  }

  async cancel(id: string, messageId: string) {
    const job = this.get(id, messageId);
    if (!isActive(job) || this.committing.has(id)) return job;
    const cancelled = { ...job, status: "cancelled", queueFull: undefined } as const;
    this.settle(cancelled);
    const active = this.active.get(id);
    active?.abort.abort();
    // The worker owns this request too, so shutdown drains provider cancel before closing storage.
    await active?.work;
    return cancelled;
  }

  queue(
    run: ToolRunContext,
    request: GenerateVideo,
    prepared: PreparedVideo,
    frame: Frame | undefined,
  ) {
    this.lifetime.signal.throwIfAborted();
    const conversationId = run.conversationId;
    if (this.full() || !conversationId)
      throw new RpcError(RpcErrorCodes.invalidParams, "video_jobs_busy");
    const id = randomUUID();
    const { model, pricing, artifact, workspace } = prepared;
    const now = Date.now();
    const job = transaction(this.ctx.db, () => {
      const message = this.messages.create({
        botId: run.botId,
        conversationId,
        runId: run.runId,
        role: "assistant",
        status: "done",
        content: "",
        usage: { videoJobId: id },
        markUnread: false,
      });
      const job: JobRecord = {
        id,
        messageId: message.id,
        originatingMessageId: run.messageId,
        botId: run.botId,
        conversationId: message.conversationId,
        groupId: run.groupId,
        threadId: run.threadId,
        runId: run.runId,
        providerId: model.providerId,
        model: model.id,
        api: model.api,
        root: model.root,
        duration: pricing.duration,
        size: pricing.label,
        estimate: pricing.estimate,
        artifact,
        workspace,
        status: "queued",
        createdAt: now,
        deadline: now + (this.options.timeoutMs ?? (model.timeoutMinutes ?? 15) * 60_000),
        promptSnippet: auditText(request.prompt, this.ctx.redactor, 120),
      };
      this.jobs.create(job);
      this.audit(job, "video.started");
      return job;
    });
    this.publishMessage(job);
    this.launch(job, { request, prepared, frame });
    return id;
  }

  private launch(
    job: JobRecord,
    create?: { request: GenerateVideo; prepared: PreparedVideo; frame?: Frame },
  ) {
    const abort = new AbortController();
    const work = Promise.resolve()
      .then(() => this.run(job, abort.signal, create))
      .catch(() => {
        // DB or event failures can contain paths. Startup can recover the persisted state.
        this.ctx.logger.error(`Video job update failed run=${job.runId}`);
      })
      .finally(() => this.active.delete(job.id));
    this.active.set(job.id, { abort, work });
  }

  private async transport(job: JobRecord, quotedModel?: PreparedVideo["model"]) {
    const matches = () =>
      configuredVideos(this.ctx).some(
        (model) =>
          model.providerId === job.providerId &&
          model.id === job.model &&
          model.api === job.api &&
          model.root === job.root &&
          (!quotedModel || JSON.stringify(model) === JSON.stringify(quotedModel)),
      );
    if (!matches()) throw new VideoFailure("provider_changed");
    const key = await this.ctx.local.models?.getApiKey(job.providerId);
    if (!key || !matches()) throw new VideoFailure("provider_changed");
    return new VideoTransport(
      this.network.fetch,
      this.options.publicDownload ?? publicVideoDownload(() => this.ctx.local.deps.proxy?.()),
      job.root,
      job.api,
      key,
    );
  }

  private async run(
    job: JobRecord,
    abort: AbortSignal,
    create?: { request: GenerateVideo; prepared: PreparedVideo; frame?: Frame },
  ) {
    const timeout = AbortSignal.timeout(Math.max(0, job.deadline - Date.now()));
    const signal = AbortSignal.any([abort, this.lifetime.signal, timeout]);
    let transport: VideoTransport | undefined;
    let step: VideoStep = job.remote ? "poll" : "submit";
    try {
      if (Date.now() >= job.deadline) throw new VideoFailure("timeout");
      signal.throwIfAborted();
      if (!job.remote && !create) throw new VideoFailure("interrupted_create");
      if (!ownerAvailable(this.ctx, job)) {
        step = "deliver";
        throw new VideoFailure("delivery_failed");
      }
      if (!job.remote && create) {
        const submitted = await this.submit(job, create, signal);
        ({ job, transport } = submitted);
        if (submitted.data !== undefined) {
          step = "download";
          signal.throwIfAborted();
          this.update({ ...job, status: "downloading" });
          const bytes = decodeInlineMp4(submitted.data);
          step = "deliver";
          await this.deliver(job, bytes, signal);
          return;
        }
        // A restart must never replay a paid create whose outcome was indeterminate.
        if (!this.jobs.save(job)) return;
        this.emit(job);
      } else {
        transport = await this.transport(job);
      }
      step = "poll";
      await this.poll(job, transport, signal, (nextStep) => {
        step = nextStep;
      });
    } catch (error) {
      if (this.lifetime.signal.aborted || abort.aborted) return;
      const reason = timeout.aborted
        ? "timeout"
        : error instanceof VideoFailure
          ? error.reason
          : "provider_error";
      this.fail(job, step, error, reason);
    } finally {
      const status = this.jobs.get(job.id)?.status;
      const path = job.remote && cancellationPath(job.api, job.remote);
      if (
        transport &&
        path &&
        (abort.aborted || timeout.aborted) &&
        !this.lifetime.signal.aborted &&
        status !== "done"
      )
        await this.cancelRemote(job, transport, path);
    }
  }

  private async submit(
    job: JobRecord,
    {
      request,
      prepared,
      frame,
    }: { request: GenerateVideo; prepared: PreparedVideo; frame?: Frame },
    signal: AbortSignal,
  ) {
    const payload = createVideo(job.api, job.model, request, prepared.pricing, frame);
    const interval = this.options.pollMs ?? 5000;
    let backoff = interval;
    while (true) {
      signal.throwIfAborted();
      const transport = await this.transport(job, prepared.model);
      signal.throwIfAborted();
      try {
        if (job.api === "gemini-omni") {
          job = { ...job, status: "generating" };
          this.update(job);
        }
        const response = await transport.json(payload, signal, "POST");
        const kind = request.firstFrame ? "image" : "text";
        const { remote, data } =
          job.api === "gemini-omni"
            ? omniOutput(response, kind)
            : { remote: providerJob(job.api, response, kind, job.root), data: undefined };
        return { job: { ...job, remote, queueFull: undefined }, transport, data };
      } catch (error) {
        // Only a definite rejection is safe to retry with the same approval.
        if (!(error instanceof VideoQueueFull)) throw error;
        if (!job.queueFull) {
          job = { ...job, queueFull: true };
          this.update(job);
        }
        await delay(backoff, undefined, { signal });
        backoff = Math.min(backoff * 2, Math.max(interval, 60_000));
      }
    }
  }

  private async cancelRemote(job: JobRecord, transport: VideoTransport, path: string) {
    let accepted = false;
    try {
      accepted = await transport.cancel(
        path,
        AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5000)]),
      );
    } catch {
      // Local cancellation is already committed even if the provider cannot stop a running task.
    }
    this.ctx.local.approvals.audit.append({
      botId: job.botId,
      runId: job.runId,
      kind: "video.finished",
      summary: "Requested provider video cancellation / 已向供应商请求取消视频",
      detail: {
        toolName: "generate_video",
        providerId: job.providerId,
        modelId: job.model,
        reasonCode: accepted ? "video_remote_cancel_accepted" : "video_remote_cancel_unavailable",
      },
    });
  }

  private async poll(
    job: JobRecord,
    transport: VideoTransport,
    signal: AbortSignal,
    setStep: (step: VideoStep) => void,
  ) {
    const remote = job.remote;
    if (!remote) throw new VideoFailure("interrupted_create");
    const path = pollPath(job.api, remote, job.model);
    const interval = this.options.pollMs ?? 5000;
    let emittedAt = 0;
    while (true) {
      signal.throwIfAborted();
      let response: unknown;
      try {
        response = await transport.json({ path }, signal, "GET");
      } catch (error) {
        if (!(error instanceof RetryableVideoRequest)) throw error;
        await delay(interval, undefined, { signal });
        continue;
      }
      const state = providerState(job.api, response, remote, job.root);
      if (state.status === "failed") {
        const reason = state.error ?? "provider_error";
        this.fail(
          job,
          "poll",
          new VideoFailure(reason, { code: state.errorCode ?? "provider_job_failed" }),
          reason,
        );
        return;
      }
      if (state.status === "cancelled") {
        this.settle({ ...job, status: "cancelled" });
        return;
      }
      if (state.status === "ready") {
        setStep("download");
        this.update({ ...job, status: "downloading", progress: undefined });
        const bytes = await transport.download(state.url, signal);
        setStep("deliver");
        await this.deliver(job, bytes, signal);
        return;
      }
      if (
        job.status !== state.status ||
        ("progress" in state && job.progress !== state.progress && Date.now() - emittedAt >= 1000)
      ) {
        job = {
          ...job,
          status: state.status,
          progress: "progress" in state ? state.progress : undefined,
        };
        this.update(job);
        emittedAt = Date.now();
      }
      await delay(interval, undefined, { signal });
    }
  }

  private async deliver(job: JobRecord, bytes: Buffer, signal: AbortSignal) {
    signal.throwIfAborted();
    this.committing.add(job.id);
    try {
      await this.commitDelivery(job, bytes, signal);
    } catch (cause) {
      signal.throwIfAborted();
      throw new VideoFailure("delivery_failed", { cause });
    } finally {
      this.committing.delete(job.id);
    }
  }

  private async commitDelivery(job: JobRecord, bytes: Buffer, signal: AbortSignal) {
    if (!isActive(this.get(job.id, job.messageId)) || !ownerAvailable(this.ctx, job))
      throw new VideoFailure("delivery_failed");
    const attachments = videoAttachmentService(this.ctx);
    const batch = await attachments.prepareOutput(
      job.botId,
      [{ name: job.artifact, bytes }],
      signal,
    );
    try {
      const workspaceSaved = await exportVideo(this.ctx, job, bytes, signal);
      signal.throwIfAborted();
      transaction(this.ctx.db, () => {
        if (
          !ownerAvailable(this.ctx, job) ||
          !this.jobs.save({ ...job, progress: undefined, status: "done", workspaceSaved })
        )
          throw new VideoFailure("delivery_failed");
        attachments.persist(job.messageId, batch, job.botId);
        this.audit({ ...job, status: "done", workspaceSaved }, "video.finished", bytes.length);
      });
    } catch (error) {
      await batch.discard();
      throw error;
    }
    this.publishMessage(job);
    this.emit(job);
  }

  private update(job: JobRecord) {
    if (this.jobs.save(job)) this.emit(job);
  }

  private fail(
    job: JobRecord,
    step: VideoStep,
    error: unknown,
    reason: NonNullable<JobRecord["error"]>,
  ) {
    const { errorName, errorCode } = failureDetails(error, this.ctx.redactor);
    this.ctx.logger.warn(
      JSON.stringify({
        module: "videos",
        event: "job_failed",
        jobId: job.id,
        api: job.api,
        step,
        reasonCode: reason,
        errorName,
        errorCode: errorCode ?? reason,
      }),
    );
    this.settle({ ...job, status: "failed", error: reason, queueFull: undefined });
  }

  private settle(job: JobRecord) {
    const changed = transaction(this.ctx.db, () => {
      if (!this.jobs.save(job)) return false;
      this.audit(job, "video.finished");
      return true;
    });
    if (changed) this.emit(job);
  }

  private audit(job: JobRecord, kind: "video.started" | "video.finished", bytes?: number) {
    this.ctx.local.approvals.audit.append({
      botId: job.botId,
      runId: job.runId,
      kind,
      summary:
        kind === "video.started"
          ? "Requested video generation / 已请求生成视频"
          : "Video job settled / 视频任务已结束",
      detail: {
        toolName: "generate_video",
        providerId: job.providerId,
        modelId: job.model,
        target: job.artifact,
        bytes,
        reasonCode: job.error,
        video: {
          duration: job.duration,
          size: job.size,
          status: job.status,
          estimateUsd: job.estimate,
          workspaceSaved: job.workspaceSaved,
          promptSnippet: job.promptSnippet,
        },
      },
    });
  }

  private emit(job: JobRecord) {
    this.ctx.peer.emit("videos.changed", { id: job.id, messageId: job.messageId });
  }
  private publishMessage(job: JobRecord) {
    const message = this.messages.get(job.messageId);
    if (message)
      this.ctx.peer.emit("chat.message", {
        botId: job.botId,
        conversationId: job.conversationId,
        runId: job.runId,
        messageId: job.messageId,
        message,
      });
  }
}
