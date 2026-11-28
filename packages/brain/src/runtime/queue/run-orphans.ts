// Runs whose row says queued or running while no queue entry owns them (a crashed or killed
// worker, or state someone edited by hand). Startup recovery settles these after a restart; this is
// the same settlement for one run while the brain keeps running, on the person's request.
import { RunEventsRepo, transaction } from "@pibot/storage";
import type { RunQueueOperations } from "./run-queue.ts";

/** `live`: a worker owns it (use the normal stop); `ended`: nothing left to settle. */
export type OrphanStopResult = "stopped" | "live" | "ended";

export async function stopOrphanStep(
  this: RunQueueOperations,
  id: string,
  actor: "user",
): Promise<OrphanStopResult> {
  if (this.entries.has(id)) return "live";
  const { db } = this.deps;
  const stopped = transaction(db, () => {
    const record = this.repo.get(id);
    // Routine runs park as `waiting` and belong to their owner; they are never orphans here.
    if (!record || record.kind === "routine" || !["queued", "running"].includes(record.status))
      return undefined;
    if (record.status === "queued") {
      if (!this.repo.abandonQueued(id, "user_stopped")) return undefined;
    } else {
      this.repo.requestUserStop(id);
      this.repo.recordStop(id, { code: "user_stopped" });
      this.repo.finish(id, "aborted", "user_stopped");
    }
    this.deps.local?.approvals.audit.append({
      botId: record.botId,
      runId: id,
      kind: "run.interrupted",
      summary: "Run without a worker stopped / 已停止没有进程的运行",
      detail: {
        actor,
        conversationId: record.conversationId,
        reasonCode: "orphan_stopped",
        ...(record.groupId ? { groupId: record.groupId } : {}),
      },
    });
    return record;
  });
  if (!stopped) return this.entries.has(id) ? "live" : "ended";
  const current = this.repo.get(id);
  // The same bookkeeping a drained run gets: its sub-task (if any) ends, budgets release.
  if (current) this.deps.local?.tasks.settled(current);
  transaction(db, () => new RunEventsRepo(db).sealTerminal(id));
  this.deps.peer.emit("chat.error", {
    botId: stopped.botId,
    conversationId: stopped.conversationId,
    ...(stopped.groupId ? { groupId: stopped.groupId } : {}),
    runId: id,
    messageId: stopped.messageId,
    code: "aborted",
    message: "aborted",
  });
  this.status(stopped, "idle");
  // The sidebar's "working" dot follows the run; its unread state is left as the person had it.
  const key = stopped.groupId ? `group:${stopped.groupId}` : `dm:${stopped.botId}`;
  this.deps.peer.emit("sidebar.changed", { conversationKey: key });
  this.notifyAvailable();
  this.pump();
  return "stopped";
}
