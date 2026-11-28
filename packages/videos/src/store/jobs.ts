import type { DatabaseSync } from "node:sqlite";
import {
  AbsolutePathSchema,
  IdSchema,
  VideoApiSchema,
  WorkspaceSnapshotSchema,
} from "@pibot/protocol-base";
import { VideoErrorSchema, VideoJobSchema, VideoStatusSchema } from "@pibot/videos-contract";
import { z } from "zod";

export const WorkspaceIntentSchema = z.strictObject({
  path: AbsolutePathSchema,
  cwd: AbsolutePathSchema,
  boundary: WorkspaceSnapshotSchema,
  authorization: z.string(),
});
const stored = z.strictObject({
  id: z.uuid(),
  messageId: IdSchema,
  originatingMessageId: IdSchema,
  runId: IdSchema,
  botId: IdSchema,
  conversationId: IdSchema,
  groupId: IdSchema.optional(),
  threadId: IdSchema.optional(),
  // Built-in providers (openai, google, openrouter) and presets use names, not UUIDs.
  providerId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  api: VideoApiSchema,
  root: z.url(),
  duration: z.number().int().min(1).max(30),
  size: z.string().max(40),
  estimate: z.number().nonnegative().max(3000).optional(),
  artifact: z.string().max(120),
  createdAt: z.number().int(),
  deadline: z.number().int(),
  promptSnippet: z.string().max(120),
  status: VideoStatusSchema,
  progress: z.number().min(0).max(100).optional(),
  queueFull: z.literal(true).optional(),
  error: VideoErrorSchema.optional(),
  workspaceSaved: z.boolean().optional(),
  remote: z
    .strictObject({
      id: z.string().max(1024),
      kind: z.enum(["text", "image"]),
      legacy: z.literal(true).optional(),
      pollPath: z.string().max(1024).optional(),
    })
    .optional(),
  workspace: WorkspaceIntentSchema.optional(),
});
const rowSchema = z.object({ record_json: z.string() });
export type JobRecord = z.infer<typeof stored>;
export type WorkspaceIntent = z.infer<typeof WorkspaceIntentSchema>;
export const isActive = (job: JobRecord) =>
  job.status === "queued" || job.status === "generating" || job.status === "downloading";

function parse(row: unknown) {
  return stored.parse(JSON.parse(rowSchema.parse(row).record_json));
}
export function videoView(job: JobRecord) {
  const { id, model, status, progress, queueFull, error, workspaceSaved } = job;
  return VideoJobSchema.parse({ id, model, status, progress, queueFull, error, workspaceSaved });
}

export class VideoJobs {
  constructor(private readonly db: DatabaseSync) {}

  create(job: JobRecord) {
    this.db
      .prepare(
        "INSERT INTO video_jobs (id, message_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(job.id, job.messageId, job.status, job.createdAt, JSON.stringify(stored.parse(job)));
  }
  get(id: string) {
    const row = this.db.prepare("SELECT record_json FROM video_jobs WHERE id = ?").get(id);
    return row ? parse(row) : undefined;
  }
  save(job: JobRecord) {
    return (
      this.db
        .prepare(`UPDATE video_jobs SET status = ?, record_json = ?
      WHERE id = ? AND status IN ('queued', 'generating', 'downloading')`)
        .run(job.status, JSON.stringify(stored.parse(job)), job.id).changes === 1
    );
  }
  active(after: { createdAt: number; id: string }) {
    return this.db
      .prepare(`SELECT record_json FROM video_jobs
      WHERE status IN ('queued', 'generating', 'downloading') AND (created_at, id) > (?, ?)
      ORDER BY created_at, id LIMIT 50`)
      .all(after.createdAt, after.id)
      .map(parse);
  }
  countActive() {
    return Number(
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM video_jobs
      WHERE status IN ('queued', 'generating', 'downloading')`)
        .get()?.count,
    );
  }
}
