import { join } from "node:path";
import type { LocalService, ToolRunContext } from "@pibot/brain/kit";
import { auditText, FolderLockError, readManagedImage, ToolTimer } from "@pibot/brain/kit";
import {
  BinaryWriteError,
  type BinaryWriteReceipt,
  ExecError,
  imageExportFileName,
} from "@pibot/execution";
import {
  type ImageDelivery,
  ImageDeliverySchema,
  type ImageWorkspaceDelivery,
  MAX_GENERATED_IMAGES,
} from "@pibot/images-contract/full";
import { containsPath } from "@pibot/policy";
import type { StoredAttachment } from "@pibot/storage";
import { ImageArtifactsRepo, ToolCallsRepo } from "@pibot/storage";
import { authorizeImageWorkspace } from "./image-workspace-authorization.ts";
import { recordImageWorkspaceDelivery } from "./image-workspace-delivery.ts";
import { generatedImageSource } from "./image-workspace-source.ts";
import { type ImageWorkspaceTarget, imageSaveCall } from "./image-workspace-target.ts";

/** A trusted durable adapter is required; receipts must never come from an RPC or model claim. */
export interface ImageWorkspaceReceipts {
  get(key: string): BinaryWriteReceipt | undefined;
  put(key: string, receipt: BinaryWriteReceipt): undefined;
}
const extensions: Record<string, "png" | "jpg" | "webp" | "gif"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
function errorCode(error: unknown, signal: AbortSignal): ImageWorkspaceDelivery["errorCode"] {
  if (signal.aborted) return "cancelled";
  if (error instanceof FolderLockError) return "file_failed";
  if (error instanceof ExecError) {
    if (error.code === "outside_workplace") return "workspace_changed";
    if (error.code === "file_conflict") return "file_conflict";
    if (error.code === "invalid_input") return "attachment_invalid";
    return "file_failed";
  }
  return "internal";
}

/** Generation and explicit reuse share this port without granting it a model/HTTP capability. */
export class ImageWorkspaceExporter {
  private readonly busy = new Set<string>();
  private readonly artifacts: ImageArtifactsRepo;
  constructor(
    private readonly local: LocalService,
    private readonly receipts: ImageWorkspaceReceipts,
  ) {
    this.artifacts = new ImageArtifactsRepo(local.deps.db);
  }

  async save(
    context: ToolRunContext,
    target: ImageWorkspaceTarget,
    attachmentIds: string[],
  ): Promise<ImageDelivery> {
    if (
      !attachmentIds.length ||
      attachmentIds.length > MAX_GENERATED_IMAGES ||
      new Set(attachmentIds).size !== attachmentIds.length
    )
      throw new ExecError("invalid_input");
    if (this.busy.has(target.source.runId)) throw new ExecError("busy");
    this.busy.add(target.source.runId);
    // ApprovalService owns human-wait expiry; IO deadlines must not cancel an unanswered card.
    const signal = AbortSignal.any([context.signal, this.local.shutdown.signal]);
    const current = { ...context, signal };
    const intent = structuredClone(target);
    let claimed = false;
    try {
      const sources = attachmentIds.map((id) =>
        generatedImageSource(this.local, current, intent, id),
      );
      if (!this.artifacts.tryClaim(intent.source.runId, current.runId)) throw new ExecError("busy");
      claimed = true;
      const workspace: ImageWorkspaceDelivery[] = [];
      for (const source of sources) workspace.push(await this.saveOne(current, intent, source));
      const delivery = ImageDeliverySchema.parse({ attachments: "delivered", workspace });
      recordImageWorkspaceDelivery(this.local, intent, delivery);
      return delivery;
    } finally {
      try {
        if (claimed) this.artifacts.release(intent.source.runId, current.runId);
      } finally {
        this.busy.delete(target.source.runId);
      }
    }
  }

  private async saveOne(
    context: ToolRunContext,
    target: ImageWorkspaceTarget,
    source: StoredAttachment,
  ) {
    const local = this.local;
    let signal = context.signal;
    const attachmentId = source.metadata.id;
    const extension = extensions[source.metadata.mimeType];
    if (!extension) throw new ExecError("invalid_input");
    const identity = { runId: target.source.runId, attachmentId, extension };
    const fileName = imageExportFileName(identity),
      path = join(target.cwd, fileName);
    const result: ImageWorkspaceDelivery = {
      attachmentId,
      fileName,
      targetPath: path,
      status: "failed",
    };
    const key = JSON.stringify([target.source.botId, target.source.runId, attachmentId, path]);
    const call = imageSaveCall(path);
    const timing = new ToolTimer();
    const previousTiming = context.toolTiming;
    context = { ...context, toolTiming: (id) => (id === call.id ? timing : previousTiming?.(id)) };
    const tools = new ToolCallsRepo(local.deps.db);
    const record = tools.create({
      messageId: context.messageId,
      toolCallId: call.id,
      tool: "write_file",
      summary: "Save generated image / 保存生成图片",
      status: "pending",
    });
    let published: BinaryWriteReceipt | undefined;
    let freshWrite = false;
    try {
      const authorization = await timing.measure("policy", () =>
        authorizeImageWorkspace(local, context, target, attachmentId, call),
      );
      if (!authorization) {
        result.status = signal.aborted ? "cancelled" : "denied";
        result.errorCode = signal.aborted ? "cancelled" : "permission_denied";
        return result;
      }
      signal = AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]);
      const endExec = timing.enter("exec");
      const loaded = await readManagedImage(local.deps, attachmentId, signal);
      generatedImageSource(local, { ...context, signal }, target, attachmentId);
      // Saving into the folder waits for another run writing there (reentrant for this run).
      const owning = authorization.writeRoots.filter((root) =>
        containsPath(root, path, local.deps.platform),
      );
      const endQueue = timing.enter("queue");
      const saved = await local.writeLocks.withLock(
        { runId: context.runId, botId: context.botId },
        owning.length ? owning : authorization.writeRoots,
        signal,
        () => {
          endQueue();
          return local.target.writeImage({
            ...identity,
            bytes: loaded.bytes,
            cwd: target.cwd,
            expectedPath: path,
            signal,
            writeRoots: authorization.writeRoots,
            denyWriteRoots: [
              ...new Set([
                ...target.boundary.denyWriteRoots,
                ...(authorization.prepared.boundary?.denyWriteRoots ?? []),
              ]),
            ],
            rootIdentities: [
              ...target.boundary.roots,
              ...(authorization.prepared.boundary?.roots ?? []),
            ],
            previous: this.receipts.get(key),
            revalidate: authorization.revalidate,
          });
        },
      );
      endExec();
      published = saved.receipt;
      freshWrite = saved.status === "written";
      if (!this.recordWrite(context, key, published, freshWrite)) {
        result.status = "needs_verification";
        result.errorCode = "receipt_failed";
        return result;
      }
      result.status = "saved";
      result.savedPath = saved.receipt.path;
      return result;
    } catch (error) {
      if (error instanceof BinaryWriteError) {
        published = error.receipt;
        freshWrite = true;
        const retained = this.recordWrite(context, key, published, freshWrite);
        result.status = "needs_verification";
        result.errorCode = retained ? errorCode(error, signal) : "receipt_failed";
      } else
        result.status = published ? "needs_verification" : signal.aborted ? "cancelled" : "failed";
      result.errorCode ??=
        published && !(error instanceof BinaryWriteError)
          ? "receipt_failed"
          : errorCode(error, signal);
      return result;
    } finally {
      tools.update(record.id, {
        performance: timing.finish(),
        status: result.status === "saved" ? "done" : signal.aborted ? "aborted" : "error",
        finishedAt: new Date().toISOString(),
      });
    }
  }

  private recordWrite(
    context: ToolRunContext,
    key: string,
    receipt: BinaryWriteReceipt,
    changed: boolean,
  ) {
    // Record the real side effect even if cancellation arrived after exclusive publication.
    let recorded = true;
    try {
      this.receipts.put(key, receipt);
    } catch {
      recorded = false;
      this.local.deps.logger.error(
        `Image workspace receipt failed bot=${context.botId} run=${context.runId}`,
      );
    }
    if (changed) {
      try {
        this.local.approvals.audit.append({
          botId: context.botId,
          runId: context.runId,
          kind: "file.written",
          summary: "Saved generated image / 已保存生成图片",
          detail: {
            toolName: "write_file",
            category: "write_file",
            target: auditText(receipt.path, this.local.deps.redactor),
            bytes: receipt.bytes,
          },
        });
      } catch {
        recorded = false;
        this.local.deps.logger.error(
          `Image workspace audit failed bot=${context.botId} run=${context.runId}`,
        );
      }
    }
    return recorded;
  }
}
