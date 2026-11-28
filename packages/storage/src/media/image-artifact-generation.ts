import type { DatabaseSync } from "node:sqlite";
import { MAX_GENERATED_IMAGES } from "@pibot/protocol-base";
import { AttachmentsRepo } from "../conversations/attachments.ts";
import { RunsRepo } from "../runs/runs.ts";
import { MessagesRepo } from "../workspace/repositories.ts";
import type { ImageArtifactRecord } from "./image-artifact-types.ts";

/** Called inside the same transaction that publishes the managed generation, never on an unpaid intent. */
export function markArtifactGenerated(
  db: DatabaseSync,
  artifact: ImageArtifactRecord | undefined,
  sourceRunId: string,
) {
  const source = artifact?.target.source;
  const run = source ? new RunsRepo(db).get(sourceRunId) : undefined;
  const message = source ? new MessagesRepo(db).get(source.messageId) : undefined;
  const usage = message?.usage;
  const images = message?.attachments?.filter((item) => item.kind === "image") ?? [];
  if (
    !artifact ||
    !source ||
    !message ||
    message.role !== "assistant" ||
    message.botId !== source.botId ||
    message.runId !== sourceRunId ||
    message.conversationId !== source.conversationId ||
    run?.botId !== source.botId ||
    run.messageId !== source.messageId ||
    run.conversationId !== source.conversationId ||
    run.groupId !== (source.groupId ?? null) ||
    run.taskId !== (source.taskId ?? null) ||
    run.cycleId !== (source.cycleId ?? null) ||
    !usage ||
    typeof usage !== "object" ||
    Array.isArray(usage) ||
    usage.imageGeneration !== true ||
    !images.length ||
    images.length > MAX_GENERATED_IMAGES ||
    (usage.imageMode !== undefined && usage.imageMode !== artifact.model.mode) ||
    (usage.imageCount !== undefined && usage.imageCount !== images.length)
  )
    throw new TypeError("image_artifact_generation_invalid");
  for (const metadata of images) {
    const attachment = new AttachmentsRepo(db).get(metadata.id);
    if (
      !attachment ||
      attachment.botId !== source.botId ||
      attachment.messageId !== source.messageId ||
      attachment.metadata.kind !== "image"
    )
      throw new TypeError("image_artifact_generation_invalid");
  }
  if (artifact.generatedAt) return;
  if (run.status !== "running" || message.status !== "streaming")
    throw new TypeError("image_artifact_generation_invalid");
  db.prepare(
    "UPDATE image_artifacts SET generation_succeeded_at=? WHERE source_run_id=? AND generation_succeeded_at IS NULL",
  ).run(new Date().toISOString(), sourceRunId);
  // Public reuse identity commits with the trusted marker, before any workspace save can fail.
  new MessagesRepo(db).update(message.id, {
    usage: { ...usage, imageArtifactSourceRunId: sourceRunId },
  });
}
