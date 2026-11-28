import { randomUUID } from "node:crypto";
import {
  AttachmentService,
  authorizationSnapshot,
  type CapabilityContext,
  prepareTool,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { BinaryPublicationError, binaryRevision, writeBinaryFile } from "@pibot/execution";
import { BotsRepo, ConversationsRepo, GroupsRepo } from "@pibot/storage";
import type { JobRecord } from "../store/jobs.ts";

export function ownerAvailable(ctx: CapabilityContext, job: JobRecord) {
  const topic = new ConversationsRepo(ctx.db).get(job.conversationId);
  const bot = new BotsRepo(ctx.db).get(job.botId);
  if (
    !topic ||
    topic.archivedAt ||
    !bot ||
    bot.archivedAt ||
    new ConversationsRepo(ctx.db).isInternal(topic.id)
  )
    return false;
  if (topic.kind === "dm") return topic.botId === job.botId;
  const group =
    job.groupId && topic.groupId === job.groupId
      ? new GroupsRepo(ctx.db).get(job.groupId)
      : undefined;
  return !!group && !group.archivedAt && group.members.some(({ botId }) => botId === job.botId);
}

export async function exportVideo(
  ctx: CapabilityContext,
  job: JobRecord,
  bytes: Buffer,
  signal: AbortSignal,
) {
  const intent = job.workspace;
  if (!intent) return false;
  const run: ToolRunContext = {
    botId: job.botId,
    conversationId: job.conversationId,
    groupId: job.groupId,
    threadId: job.threadId,
    runId: job.runId,
    messageId: job.originatingMessageId,
    language: "en",
    signal,
    runWorkplace: { cwd: intent.cwd, boundary: intent.boundary },
  };
  const call = { id: randomUUID(), tool: "write_file", input: { path: intent.path, content: "" } };
  const revalidate = async () => {
    signal.throwIfAborted();
    const current = await prepareTool(ctx.local, run, call, signal);
    if (
      !ownerAvailable(ctx, job) ||
      !ctx.local.execution.allows(run, "write_file") ||
      current.result.decision !== "allow" ||
      current.result.path?.path !== intent.path ||
      authorizationSnapshot(ctx.local, job.botId, run) !== intent.authorization
    )
      throw new Error("video_workspace_changed");
  };
  const options = {
    path: intent.path,
    expectedPath: intent.path,
    cwd: intent.cwd,
    rootIdentities: intent.boundary.roots,
    writeRoots: intent.boundary.writeRoots,
    denyWriteRoots: intent.boundary.denyWriteRoots,
    signal,
  };
  try {
    return await ctx.local.writeLocks.withLock(
      { runId: job.runId, botId: job.botId },
      options.writeRoots,
      signal,
      async () => {
        await revalidate();
        try {
          await writeBinaryFile({ ...options, bytes, revalidate });
          return true;
        } catch (error) {
          if (error instanceof BinaryPublicationError) return true;
          // A restart can land between publishing the file and committing the chat attachment.
          if (!(error instanceof Error) || !("code" in error) || error.code !== "file_conflict")
            throw error;
          const existing = await ctx.local.target.readBinary(options);
          return existing.revision === binaryRevision(bytes);
        }
      },
    );
  } catch {
    signal.throwIfAborted();
    // Workspace revocation or conflict must not discard an already paid-for attachment.
    return false;
  }
}

export function videoAttachmentService(ctx: CapabilityContext) {
  return new AttachmentService(ctx.db, ctx.dataDir, ctx.host.attachments);
}
