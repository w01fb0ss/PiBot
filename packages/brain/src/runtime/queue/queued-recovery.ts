import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "@pibot/observability";
import type { Run } from "@pibot/protocol-base";
import { BotsRepo, ConversationsRepo, RunRecoveryRepo } from "@pibot/storage";
import type { LocalService } from "../../local-service.ts";
import { restoreWorkflow } from "../workflows/workflow-recovery.ts";
import { workflowUserText } from "../workflows/workflow-text.ts";
import type { QueueInput, RunQueue } from "./run-queue.ts";

/**
 * A private-chat workflow run that was still queued when the
 * previous process ended goes back into the queue as the same workflow. It never started, so
 * nothing is replayed; its whole launch is rebuilt from the persisted identity and the current
 * skill file (same version only). Anything that no longer fits (Bot archived or without a model,
 * topic gone, skill removed or changed) ends the run as a restart did before.
 */
export async function republishQueuedWorkflows(deps: {
  db: DatabaseSync;
  queue: RunQueue;
  local?: LocalService;
  logger: Logger;
  language(): "zh" | "en";
  signal: AbortSignal;
}) {
  const bots = new BotsRepo(deps.db);
  const conversations = new ConversationsRepo(deps.db);
  for (const { run, workflow: identity } of new RunRecoveryRepo(deps.db).queuedWorkflows()) {
    deps.signal.throwIfAborted();
    const bot = bots.get(run.botId);
    const topic = conversations.get(run.conversationId);
    const usable =
      !!bot &&
      !bot.archivedAt &&
      (!!topic?.modelOverride || (!!bot.modelProvider && !!bot.modelId)) &&
      topic?.kind === "dm" &&
      topic.botId === run.botId &&
      !topic.archivedAt;
    const workflow =
      usable && identity
        ? await restoreWorkflow(deps.local?.skills, run.botId, undefined, identity)
        : undefined;
    deps.signal.throwIfAborted();
    if (!bot || !workflow) {
      deps.queue.abandon(run, {}, "restart");
      log(deps.logger, run, usable ? "workflow_unavailable" : "source_unavailable");
      continue;
    }
    const input: QueueInput = {
      userInitiated: true,
      bot,
      conversationId: run.conversationId,
      ...(run.userMessageId ? { userMessageId: run.userMessageId } : {}),
      // The original send had no attachments or quote: this is exactly the text it queued.
      text: workflowUserText(workflow, deps.language()),
      workflow,
    };
    try {
      deps.queue.publish(run, input);
    } catch (error) {
      // Same as a send whose publish throws: reclaim the durable row so it cannot linger.
      deps.queue.abandon(run, {}, "restart");
      log(deps.logger, run, "publish_failed");
      if (deps.signal.aborted) throw error;
      continue;
    }
    log(deps.logger, run, "requeued");
  }
}

function log(logger: Logger, run: Run, outcome: string) {
  logger[outcome === "requeued" ? "info" : "warn"](
    JSON.stringify({
      module: "chat",
      event: "queued_workflow_recovered",
      botId: run.botId,
      runId: run.id,
      outcome,
    }),
  );
}
