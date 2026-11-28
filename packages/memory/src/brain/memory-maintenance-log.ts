// Emits one content-free receipt when a claimed maintenance attempt settles.
import type { DatabaseSync } from "node:sqlite";
import type { BrainRedactor } from "@pibot/brain/kit";
import { AgentErrorCodeSchema, type MemoryModelFallback } from "@pibot/protocol-base";
import { AuditRepo, memoryAttemptReceipt } from "@pibot/storage";

type Task = "extraction" | "organization";
type Attempt = { id: string; botId: string; conversationId?: string };
type Deps = {
  db: DatabaseSync;
  logger: { info?(message: string): void; warn(message: string): void };
  statusChanged?(botId: string): void;
};

const localResults = new Set([
  "already_covered",
  "automation_acp",
  "automation_internal_task",
  "automation_no_human",
  "automation_routine",
  "bot_busy",
  "bot_preempted",
  "cancelled",
  "candidates_invalid",
  "candidates_not_applied",
  "correction_source_unavailable",
  "draft_invalid",
  "extraction_disabled_or_scope_changed",
  "extraction_failed",
  "limited",
  "no_candidates",
  "no_new_human_content",
  "organization_failed",
  "source_changed",
  "topic_missing",
  "worker_stopped",
]);

function resultCode(error: unknown, status: string) {
  if (typeof error === "string")
    return (
      AgentErrorCodeSchema.safeParse(error).data ?? (localResults.has(error) ? error : "failed")
    );
  return status === "done" || status === "skipped" ? status : "deferred";
}

export function logMemoryAttempt(deps: Deps, task: Task, attempt: Attempt, started: number) {
  const result = memoryAttemptReceipt(deps.db, task, attempt.id);
  const status = String(result?.status ?? "deferred");
  const receipt = JSON.stringify({
    module: "memory",
    event: "memory_maintenance_result",
    task,
    botId: attempt.botId,
    ...(attempt.conversationId ? { conversationId: attempt.conversationId } : {}),
    status,
    reasonCode: resultCode(result?.error, status),
    durationMs: Math.round(performance.now() - started),
    tokens: Number(result?.tokens ?? 0),
  });
  if (status === "failed") deps.logger.warn(receipt);
  else deps.logger.info?.(receipt);
  try {
    deps.statusChanged?.(attempt.botId);
  } catch {
    // A disconnected peer can still read the durable result when it reconnects.
    deps.logger.warn(JSON.stringify({ module: "memory", reasonCode: "status_notify_failed" }));
  }
}

export function logMemoryFallback(deps: Deps & { redactor: BrainRedactor }, botId: string) {
  return ({ from, to }: MemoryModelFallback) => {
    const entry = new AuditRepo(deps.db, deps.redactor).append({
      botId,
      kind: "memory.changed",
      summary: "Memory switched model provider / 记忆维护已切换模型厂商",
      detail: {
        reasonCode: "memory_model_fallback",
        previousModelId: from.id.slice(0, 200),
        modelId: to.id.slice(0, 200),
      },
    });
    deps.logger.info?.(
      JSON.stringify({ module: "memory", event: "memory_model_fallback", ...entry.detail }),
    );
  };
}
