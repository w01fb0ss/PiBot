import { createHash } from "node:crypto";
import type {
  ContinuationStop,
  LocalService,
  QueueInput,
  RunQueue,
} from "@pibot/brain/orchestration-kit";
import {
  ACTIVE_TASK_STATUSES,
  CONTINUATION_ROOT_CAPACITY,
  CONTINUATION_TRIGGER_ATTEMPTS,
  continuationKey,
  intersectTaskPermissions,
  noteContinuationStopped,
  resultPrompt,
  runPermissions,
  TASK_CONTINUATION_KIND,
  TASK_TREE_MAX,
  TASK_TREE_PAGE,
  taskPermissionsNarrowed,
} from "@pibot/brain/orchestration-kit";
import type { Run, TaskSummary } from "@pibot/protocol-base";
import { RpcError } from "@pibot/protocol-base";
import {
  BotsRepo,
  type ContinuationBatchEntry,
  GroupCyclesRepo,
  GroupsRepo,
  GroupTasksRepo,
  type TaskAuthority,
  transaction,
} from "@pibot/storage";
import { ContinuationRestore } from "./continuation-restore.ts";
import { type ParentAdmission, TaskParentFollowThrough } from "./task-parent-followthrough.ts";
import type { TaskService } from "./task-service.ts";

/** Stop reason marking a continuation whose publish was rolled back; such a row can be retried. */
const CONTINUATION_REJECTED = "continuation_rejected";
/** A round previewed inside `prepare` was refused at commit time; the insert was rolled back. */
class RoundRefused extends Error {
  constructor(readonly reason: ContinuationStop) {
    super("continuation_round_refused");
  }
}
interface PendingResults {
  source: TaskSummary;
  versions: Map<string, string>;
}
const resultVersion = (task: TaskSummary) => `${task.runId}:${task.version}`;
/**
 * No startup replay: only this process's certified settlements can create an automatic prompt.
 * Chains an earlier process left behind wait in `restore` for the user's confirmation,
 * which reuses `queueBatch` and the shared `chainQuiet`/`finalize`/`refuse` rules below.
 */
export class TaskContinuations {
  readonly parents: TaskParentFollowThrough;
  private readonly restore: ContinuationRestore;
  private readonly pending = new Map<string, PendingResults>();
  private readonly cancelled = new Set<string>();
  /** The process is going down or detached: durable rows become the next process's candidates. */
  private draining = false;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private queue?: RunQueue;
  constructor(
    private readonly local: LocalService,
    private readonly service: TaskService,
  ) {
    this.parents = new TaskParentFollowThrough(local);
    this.restore = new ContinuationRestore(local, this);
  }
  attach(queue: RunQueue) {
    this.unsubscribe?.();
    this.queue = queue;
    // A fresh queue admits work again, so the idle sweep is allowed to settle finished chains.
    this.draining = false;
    this.unsubscribe = queue.onAvailable(() => this.schedule());
    this.restore.scan(queue);
  }
  restorable(after?: string, limit?: number) {
    return this.restore.list(after, limit);
  }
  resumeRestored(conversationId: string, signal: AbortSignal) {
    if (!this.queue) throw new RpcError(-32011, "continuation_unavailable");
    return this.restore.resume(this.queue, conversationId, signal);
  }
  discardRestored(conversationId: string) {
    if (!this.queue) throw new RpcError(-32011, "continuation_unavailable");
    return this.restore.discard(this.queue, conversationId);
  }
  isIdle() {
    return this.pending.size === 0 && this.timer === undefined;
  }
  hasPending(conversationId: string) {
    return [...this.pending.values()].some(
      (entry) => entry.source.conversationId === conversationId,
    );
  }
  observe(task: TaskSummary) {
    if (this.cancelled.has(task.rootRunId)) {
      if (!this.tree(task).some((item) => ACTIVE_TASK_STATUSES.has(item.status)))
        this.cancelled.delete(task.rootRunId);
      return;
    }
    if (!this.queue?.acceptingContinuations || this.local.shutdown.signal.aborted) return;
    // Queue capacity bounds pending roots and every child belongs to a live tree; never accumulate unbounded retries.
    if (!this.pending.has(task.rootRunId) && this.pending.size >= CONTINUATION_ROOT_CAPACITY) {
      // An optional summary cannot invalidate a successfully drained child or release certificate.
      this.local.deps.logger.warn(`Task continuation capacity reached root=${task.rootRunId}`);
      return;
    }
    const root = task.rootRunId;
    const pending = this.pending.get(root) ?? { source: task, versions: new Map() };
    pending.versions.set(task.id, resultVersion(task));
    this.pending.set(root, pending);
    this.local.continuationState.owned(root);
    // A per-child reference: a restart re-checks this exact run/version instead of re-collecting
    // every finished task and trusting a trigger key.
    this.local.continuationState.intents.save({
      rootRunId: root,
      kind: "summary",
      subjectId: task.id,
      botId: task.botId,
      conversationId: task.conversationId,
      runId: task.runId,
      authorityRef: null,
      planVersion: null,
      planFingerprint: null,
      progress: null,
      triggerId: null,
      groupId: null,
      taskId: task.id,
      pauseState: "clear",
      pauseReason: null,
      taskVersion: task.version,
      dispatchedRunId: null,
    });
    this.schedule();
  }
  cancel(root: string) {
    this.pending.delete(root);
    // The user stopped this chain; whatever settles next starts a new, separately bounded one.
    // One transaction so a crash cannot leave a restorable intent behind a spent budget.
    transaction(this.local.deps.db, () => {
      this.parents.forget(root);
      this.local.continuationState.release(root);
    });
    // Only roots with live children can produce another settlement; the last one retires this mark.
    const run = this.queue?.repo.get(root);
    if (
      run &&
      this.service.tasks
        .list(run, { rootRunId: root, limit: 1 })
        .items.some((task) => this.tree(task).some((item) => ACTIVE_TASK_STATUSES.has(item.status)))
    )
      this.cancelled.add(root);
  }
  private schedule() {
    if (this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const [root, pending] of this.pending) {
        try {
          if (this.dispatch(pending)) {
            this.pending.delete(root);
            // A batch that queued a run keeps the chain live; one that can never dispatch must not
            // leave the root waiting for a settlement that will not come.
            this.finalize(root);
          }
        } catch (error) {
          if (error instanceof RpcError && error.code === -32011) continue;
          this.pending.delete(root);
          if (error instanceof RpcError && error.code === -32602) {
            // A changed source, plan or mode cannot be restored by any confirmation: the whole
            // chain goes, including the ledger, unless its run is still working.
            noteContinuationStopped(this.local, {
              conversationId: pending.source.conversationId,
              botId: pending.source.botId,
              root,
              reasonCode: "authority_narrowed",
              used: this.local.continuationBudget.peek(root)?.used ?? 0,
            });
            this.refuse(root);
            continue;
          }
          // An unexpected failure is not proof that the chain is over: keep the durable candidate
          // for the restart prompt, but still free a chain which genuinely ended.
          this.local.deps.logger.warn(`Task continuation unavailable root=${root}`);
          this.finalize(root);
        }
      }
    }, 50);
    this.timer.unref();
  }
  /**
   * Only a row this process reclaimed for a rejected batch may be replaced; any other existing row
   * already represents this batch, so the caller must not publish a duplicate.
   */
  private freeTriggerKey(queue: RunQueue, triggerId: string, root: string, restoring: boolean) {
    for (let attempt = 0; attempt < CONTINUATION_TRIGGER_ATTEMPTS; attempt++) {
      const key = continuationKey(TASK_CONTINUATION_KIND, root, triggerId, attempt);
      const existing = queue.repo.trigger(key);
      if (!existing) return key;
      if (existing.status !== "aborted") return;
      if (existing.stopReason === CONTINUATION_REJECTED) continue;
      // Startup aborts every queued run before it starts; the batch rows a confirmation restores
      // still exist only when that run never got to consume them, so its key may be reused.
      if (!restoring || existing.stopReason !== "restart") return;
    }
    this.local.deps.logger.warn(`Task continuation retries exhausted root=${root}`);
  }
  /** Facts only: which chain stopped, why, and how many rounds it had spent. Never content. */
  private limited(task: TaskSummary, reasonCode: string, runId = task.rootRunId) {
    const used = this.local.continuationBudget.peek(task.rootRunId)?.used ?? 0;
    // Rejected publishes and exhausted dedupe keys are technical retries, not a stop to explain.
    if (reasonCode === "round_limit" || reasonCode === "no_progress")
      noteContinuationStopped(this.local, {
        conversationId: task.conversationId,
        botId: task.botId,
        root: task.rootRunId,
        reasonCode,
        used,
      });
    this.local.approvals.audit.append({
      botId: task.botId,
      runId,
      kind: "execution.continuation.limited",
      summary: "Automatic continuation stopped at its limit / 自动接续已达到上限",
      detail: {
        conversationId: task.conversationId,
        target: task.rootRunId,
        actor: "automatic",
        reasonCode,
        used,
      },
    });
  }
  /**
   * Whether no part of this root's chain can settle again: its own run, a queued/running/stopping
   * continuation or child attempt, and every task of its tree. A done root proves nothing on its
   * own: children can still execute in their own internal topics. Used by `finalize` and the
   * refusal path, so a failed dispatch can never release a live chain's budget.
   */
  chainQuiet(root: string): boolean {
    const queue = this.queue;
    const run = queue?.repo.get(root);
    // No run row means no later settlement can clean this root up: keeping a stale ledger costs one
    // capacity slot, while releasing a live chain would hand it a fresh budget.
    if (!queue || !run) return false;
    if (ACTIVE_TASK_STATUSES.has(run.status)) return false;
    // A queued/running continuation or the current attempt of a spawned child still owes a settle.
    if (queue.repo.hasActiveChild(root)) return false;
    const item = this.service.tasks.list(run, { rootRunId: root, limit: 1 }).items[0];
    if (!item) return true;
    try {
      return !this.tree(item).some((task) => ACTIVE_TASK_STATUSES.has(task.status));
    } catch (error) {
      // `task_tree_limit` only says the tree did not fit one read: an unreadable tree is not proof
      // that nothing is running. The ledger stays, and a later settle re-checks this same rule.
      this.local.deps.logger.warn(`Task tree unreadable root=${root} error=${String(error)}`);
      return false;
    }
  }
  /**
   * One place deciding whether a root's durable rows may go, shared by the idle sweep and the
   * dispatch failure path. A chain still running, still dispatchable, or paused for the user keeps
   * its budget; anything else must not occupy one of the bounded capacity slots.
   */
  finalize(root: string): boolean {
    if (this.pending.has(root)) return false;
    if (!this.chainQuiet(root)) return false;
    const parent = this.local.continuationState.intents.get(root, "parent");
    // A pause is the user's to settle, and a row written by an earlier process awaits the restart
    // prompt; neither is an idle sweep's to erase.
    if (parent && (parent.pauseState !== "clear" || !this.local.continuationState.owns(root)))
      return false;
    // Settled results no run has consumed are the restart prompt's evidence, not dead weight.
    if (this.local.continuationState.intents.undispatched(root).length) return false;
    // Exit or detach: any durable row becomes the next process's candidate, so a normal quit must
    // not turn into a silent discard just because this process's pending cache is empty.
    if (this.draining && this.local.continuationState.intents.has(root)) return false;
    this.forgetChain(root);
    return true;
  }
  /**
   * An idle root whose tree is quiet and whose results are not pending can never continue again.
   * Keeping its ledger would let finished roots fill the capacity and deny new runs their budget.
   */
  releaseIfIdle(root: string) {
    this.finalize(root);
  }
  /**
   * A thrown refusal (frozen source, plan or mode changed) or a terminal stop (spent rounds or
   * budget, exhausted retries, a gone source Bot) means neither the parent nor the collected
   * results may execute or be restored by a confirmation. The ledger is a separate
   * question: it is released only once the whole chain is quiet, because a root which is merely
   * done can still have children running and a fresh budget would reset their 32 rounds.
   */
  refuse(root: string) {
    this.parents.discard(root);
    this.deleteSummaries(root);
    if (this.chainQuiet(root)) this.forgetChain(root);
  }
  tree(task: TaskSummary) {
    const items: TaskSummary[] = [];
    let before: string | undefined;
    do {
      const page = this.service.tasks.list(task, {
        rootRunId: task.rootRunId,
        limit: TASK_TREE_PAGE,
        before,
      });
      items.push(...page.items);
      if (items.length > TASK_TREE_MAX) throw new RpcError(-32602, "task_tree_limit");
      before = page.nextBefore ?? undefined;
    } while (before);
    return items.sort((a, b) => a.id.localeCompare(b.id));
  }
  authority(items: TaskSummary[]) {
    let combined: TaskAuthority | undefined;
    const verified = new Set<string>();
    for (const task of items) {
      const value = this.service.tasks.internal(task.id)?.authority;
      if (!value) throw new RpcError(-32602, "task_source_changed");
      const { reviewProfile: _, ...authority } = value;
      const sourceKey = JSON.stringify(authority.source);
      // Siblings normally share one frozen source: do not repeat the same filesystem pins 100 times.
      if (!verified.has(sourceKey)) {
        this.service.verifySource(value, this.local.shutdown.signal);
        verified.add(sourceKey);
      }
      if (!combined) combined = authority;
      else {
        const { displayFolders: _combinedDisplay, ...combinedWorkplace } = combined.workplace;
        const { displayFolders: _display, ...workplace } = authority.workplace;
        if (JSON.stringify(combinedWorkplace) !== JSON.stringify(workplace))
          throw new RpcError(-32602, "task_workplace_changed");
        combined = {
          ...combined,
          permissions: intersectTaskPermissions(combined.permissions, authority.permissions),
          mode: combined.mode === "plan" || authority.mode === "plan" ? "plan" : "execute",
        };
      }
    }
    if (!combined) throw new RpcError(-32602, "task_source_changed");
    // A newly revoked source must not silently send previously collected private results to a model.
    const current = runPermissions(this.local, combined.source);
    if (taskPermissionsNarrowed(combined.permissions, current))
      throw new RpcError(-32602, "task_source_changed");
    return combined;
  }
  private dispatch(pending: PendingResults): boolean {
    const task = pending.source;
    const queue = this.queue;
    if (!queue?.acceptingContinuations || this.local.shutdown.signal.aborted) return true;
    const root = queue.repo.get(task.rootRunId);
    if (!root || root.status === "aborted" || root.status === "error") {
      // The chain is over for good here, so neither its intents nor its ledger keep a slot.
      this.forgetChain(task.rootRunId);
      return true;
    }
    const budget = this.local.budgets.snapshot(task.rootRunId);
    if (!budget || this.local.budgets.repo.reason(budget)) {
      // The chain is out of budget for good: no confirmation could restore the plan or the batch.
      this.refuse(task.rootRunId);
      return true;
    }
    const tree = this.tree(task);
    const items = tree.filter(
      (item) =>
        !ACTIVE_TASK_STATUSES.has(item.status) &&
        pending.versions.get(item.id) === resultVersion(item),
    );
    if (!items.length) {
      // Stored versions match nothing settled any more: those references can never dispatch.
      this.deleteSummaries(task.rootRunId);
      return true;
    }
    // A batch contains only newly settled attempts; slower siblings may keep doing independent work.
    if (root.status !== "done") return false;
    if (!queue.canContinue(task.botId, task.conversationId)) return false;
    // A summary always carries new child results, so it only competes for the shared round budget.
    const round = this.local.continuationBudget.preview(task.rootRunId, "summary", true);
    if (!round.ok) {
      this.limited(task, round.reason);
      // Undispatched rows would make `finalize` keep this spent chain forever, one capacity slot each.
      this.refuse(task.rootRunId);
      return true;
    }
    const summaryAuthority = this.authority(items);
    // Only this process's certified plan may be resumed; a paused or earlier-process parent drops
    // out here and the batch is summarized on its own, without releasing the parent's pause.
    const parent = this.parents.prepare(task.rootRunId, tree);
    this.queueBatch(task, items, tree, parent, summaryAuthority);
    return true;
  }
  /**
   * Queues one admitted batch as a run: the settle-driven dispatch and the restart confirmation
   * share this, so both spend rounds, mark batches and roll back a rejected publish the
   * same way. Returns the queued run; undefined means the batch was refused for good instead.
   * A rejected publish rethrows after rolling back.
   */
  queueBatch(
    task: TaskSummary,
    items: TaskSummary[],
    tree: TaskSummary[],
    parent: ParentAdmission | undefined,
    summaryAuthority: TaskAuthority | undefined,
    restoring = false,
  ): Run | undefined {
    const queue = this.queue;
    if (!queue) return undefined;
    const triggerId = `${parent ? "execute:" : ""}${createHash("sha256")
      .update(JSON.stringify(items.map((item) => [item.id, item.runId, item.version])))
      .digest("hex")}`;
    const triggerKey = this.freeTriggerKey(queue, triggerId, task.rootRunId, restoring);
    const batch: ContinuationBatchEntry[] = items.map((item) => ({
      subjectId: item.id,
      version: item.version,
    }));
    if (!triggerKey) {
      this.limited(task, "retries_exhausted");
      // Either a live row already represents this batch or it can never be published: its
      // references are spent, but the parent plan is not ours to drop here.
      this.consumeSummaries(task.rootRunId, batch);
      return undefined;
    }
    const authority = parent?.authority ?? summaryAuthority;
    if (!authority) return undefined;
    const source = authority.source;
    const bot = new BotsRepo(this.local.deps.db).get(source.botId);
    if (!bot || bot.archivedAt || bot.category === "image") {
      this.refuse(task.rootRunId);
      return undefined;
    }
    // Snapshot what the transaction changes, so a rejected publish restores it exactly.
    const priorLedger = this.local.continuationBudget.snapshot(task.rootRunId);
    const priorBaseline = parent ? this.parents.baseline(task.rootRunId) : undefined;
    const input: QueueInput = {
      bot,
      conversationId: source.conversationId,
      text: this.local.deps.redactor.redact(resultPrompt(parent ? tree : items, !!parent)),
      automatic: true,
      parentRunId: task.rootRunId,
      afterRunId: parent?.afterRunId ?? task.rootRunId,
      budgetRootRunId: task.rootRunId,
      continuationAuthority: authority,
      ...(parent ? { parentFollowThrough: { planVersion: parent.planVersion } } : {}),
      triggerKey,
      ...(source.groupId ? { groupId: source.groupId, cycleId: source.cycleId } : {}),
      ...(source.threadId ? { threadId: source.threadId } : {}),
    };
    let record: Run;
    try {
      record = transaction(this.local.deps.db, () => {
        if (source.groupId) {
          const group = new GroupsRepo(this.local.deps.db).get(source.groupId);
          if (!group || group.paused || !source.cycleId)
            throw new RpcError(-32602, "task_source_changed");
          if (new GroupCyclesRepo(this.local.deps.db).consume(group.id, source.cycleId) !== "ok")
            throw new RpcError(-32602, "task_source_changed");
          // Group auto-completion only trusts the admitted runs.task_id. The summary run
          // finishes the parent's bound group task, so it must carry that binding; a task closed
          // meanwhile keeps the old taskless summary rather than refusing the continuation.
          if (
            source.taskId &&
            new GroupTasksRepo(this.local.deps.db, (text) => text).get(source.taskId)?.status ===
              "open"
          )
            input.taskId = source.taskId;
        }
        const created = queue.insert(input);
        // The round, the exact batch reference and the run row commit together: a crash cannot
        // queue a run while forgetting the round it spent or which tasks it summarized.
        const taken = parent
          ? this.parents.commit(task.rootRunId)
          : this.local.continuationBudget.take(task.rootRunId, "summary", true);
        if (!taken.ok) throw new RoundRefused(taken.reason);
        // Both dispatch paths record the exact batch they consume in the same transaction as the
        // run row: a crash must not leave received results looking undispatched (or vice versa).
        this.local.continuationState.intents.dispatched(task.rootRunId, batch, created.id);
        this.local.approvals.audit.append({
          botId: created.botId,
          runId: created.id,
          kind: "execution.task.changed",
          summary: parent
            ? "Parent authorized plan queued to continue / 父任务已排队继续授权计划"
            : "Task results queued for parent summary / 子任务结果已排队汇总",
          detail: {
            conversationId: created.conversationId,
            target: task.rootRunId,
            actor: "automatic",
            reasonCode: parent ? "parent_execution_queued" : "continuation_queued",
          },
        });
        return created;
      });
    } catch (error) {
      if (!(error instanceof RoundRefused)) throw error;
      // A preview passed but the stored counters changed; nothing was queued or spent.
      this.limited(task, error.reason);
      return undefined;
    }
    try {
      queue.publish(record, input);
    } catch (error) {
      // The row is durable but the queue never accepted it: reclaim it here or the topic stays busy
      // and the same dedupe key can never be retried. Group cycle rounds are not refunded on purpose.
      queue.abandon(record, input, CONTINUATION_REJECTED);
      transaction(this.local.deps.db, () => {
        if (parent && priorBaseline)
          this.parents.rollback(task.rootRunId, priorBaseline, priorLedger);
        else this.local.continuationBudget.refund(task.rootRunId, priorLedger);
        // The batch was never handed to a run, so a restart must not treat it as dispatched.
        this.local.continuationState.intents.dispatched(task.rootRunId, batch, null);
      });
      this.local.deps.logger.warn(`Task continuation rejected root=${task.rootRunId}`);
      this.limited(task, CONTINUATION_REJECTED, record.id);
      // The original schedule() branch keeps pending on -32011 and drops it otherwise.
      throw error;
    }
    if (parent) this.parents.admitted(task.rootRunId);
    // Either way the batch is consumed now; a newer settlement of a task keeps its own row.
    this.consumeSummaries(task.rootRunId, batch);
    return record;
  }
  forgetChain(root: string) {
    transaction(this.local.deps.db, () => {
      this.parents.forget(root);
      this.local.continuationState.release(root);
    });
  }
  private deleteSummaries(root: string, batch?: readonly ContinuationBatchEntry[]) {
    transaction(this.local.deps.db, () => {
      if (!batch) {
        this.local.continuationState.intents.deleteKind(root, "summary");
        return;
      }
      this.local.continuationState.intents.consume(root, batch);
    });
  }
  private consumeSummaries(root: string, batch: readonly ContinuationBatchEntry[]) {
    this.deleteSummaries(root, batch);
  }
  pause() {
    clearTimeout(this.timer);
    this.timer = undefined;
    // Nothing continues while the process is draining, so every durable row is a candidate for
    // the restart prompt rather than something this process may release.
    this.draining = true;
    this.pending.clear();
    this.parents.clear();
    this.local.continuationBudget.clear();
  }
  dispose() {
    this.pause();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.queue = undefined;
    this.cancelled.clear();
  }
}
