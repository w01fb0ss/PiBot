// Verification follows durable code contributions so completed plans can resume after a crash.
import { type GroupVerification, RpcError, type Run } from "@pibot/protocol-base";
import {
  ChatNoticesRepo,
  GroupVerificationRulesRepo,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { requestVerificationAssignee } from "./group-verification-assignment.ts";
import { verificationFacts, verificationMembers } from "./group-verification-facts.ts";
import { completedVerificationFacts } from "./group-verification-finished.ts";
import { verificationPlan } from "./group-verification-plan.ts";
import { selectVerifiers } from "./group-verification-selection.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

export function verificationCovered(service: GroupService, run: Run) {
  if (!run.groupId || !run.cycleId) return false;
  const group = service.groups.get(run.groupId);
  if (!group) return false;
  if (service.plans.repo.forVerification(group.conversationId, run.cycleId, run.id)) return true;
  const current = service.plans.repo.forCycle(group.conversationId, run.cycleId);
  const own = run.taskId ? service.workflows.repo.byTask(run.taskId) : undefined;
  const record = own
    ? service.workflows.repo.get(own.workflowRunId)
    : current
      ? service.workflows.repo.byPlan(current.card.id)
      : undefined;
  const plan = record ? workflowOf(record).contract : current?.card.plan;
  if (!plan?.steps) return false;
  if (!own && current?.card.originRunId !== run.id) return false;
  const states = record
    ? new Map(service.workflows.repo.steps(record.id).map((step) => [step.stepId, step.status]))
    : undefined;
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const dependsOn = (id: string, seen = new Set<string>()): boolean => {
    if (!own) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const step = byId.get(id);
    return (
      !!step &&
      (step.dependsOn.includes(own.stepId) || step.dependsOn.some((dep) => dependsOn(dep, seen)))
    );
  };
  return plan.steps.some(
    (step) =>
      step.acceptance.some((item) => item.check === "verdict") &&
      states?.get(step.id) !== "skipped" &&
      dependsOn(step.id),
  );
}

type VerificationOrigin = Pick<Run, "id" | "groupId" | "cycleId">;

export class GroupAutoVerification {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly shutdown = new AbortController();
  private recovery?: Promise<void>;
  constructor(private readonly service: GroupService) {}

  recover() {
    if (this.recovery) return;
    this.recovery = (async () => {
      await this.recoverPending();
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let after = "";
      while (!this.shutdown.signal.aborted && !this.service.signal.aborted) {
        const page = this.service.plans.repo.completedVerificationPlans(since, after);
        for (const id of page) await this.finished(id);
        if (page.length < 50) return;
        after = page.at(-1) ?? after;
      }
    })().catch(() => {
      this.service.deps.logger.warn(
        JSON.stringify({
          module: "group-verification",
          event: "recovery_deferred",
          code: "verification_recovery_failed",
        }),
      );
    });
  }

  private async recoverPending() {
    let after = "";
    while (!this.shutdown.signal.aborted && !this.service.signal.aborted) {
      const page = this.service.plans.repo.pendingVerifications(after);
      for (const row of page) {
        if (row.workflowRunId) await this.finished(row.workflowRunId);
        else {
          const source = this.service.runs.get(row.sourceRunId);
          if (source) await this.settled(source);
        }
      }
      if (page.length < 50) return;
      after = page.at(-1)?.messageId ?? after;
    }
  }

  async finished(workflowRunId: string) {
    const record = this.service.workflows.repo.get(workflowRunId);
    if (record?.status !== "passed") return;
    const origin = {
      id: record.budgetRootRunId ?? record.id,
      groupId: record.groupId,
      cycleId: record.cycleId,
    };
    await this.enqueue(origin, async () => {
      const signal = AbortSignal.any([
        this.service.signal,
        this.shutdown.signal,
        AbortSignal.timeout(30_000),
      ]);
      const facts = await completedVerificationFacts(this.service, workflowRunId, signal);
      if (!facts) return;
      const source = this.service.runs.get(facts.sourceRunId);
      if (!source) throw new RpcError(-32602, "verification_source_unavailable");
      await this.verify(source, facts);
    });
  }

  /**
   * Sources whose round still had other runs going (video dry run 2026-11-20: the coordinator
   * assigned its own review tasks, and the program's check started beside them as a second
   * verification path). Each waits for the round to go quiet, then is checked once.
   */
  private readonly deferred = new Map<string, Map<string, Run>>();

  async settled(run: Run) {
    await this.enqueue(run, () => this.verify(run));
    const waiting = run.groupId ? this.deferred.get(run.groupId) : undefined;
    if (!waiting?.size || !run.groupId) return;
    for (const source of [...waiting.values()]) {
      if (!source.cycleId || this.service.runs.hasActiveForCycle(run.groupId, source.cycleId))
        continue;
      waiting.delete(source.id);
      await this.enqueue(source, () => this.verify(source, undefined, true));
    }
    if (!waiting.size) this.deferred.delete(run.groupId);
  }

  private async enqueue(run: VerificationOrigin, operation: () => Promise<void>) {
    if (
      !run.groupId ||
      this.shutdown.signal.aborted ||
      this.service.signal.aborted ||
      !this.service.interactive
    )
      return;
    const groupId = run.groupId;
    const previous = this.jobs.get(groupId) ?? Promise.resolve();
    const job = previous
      .catch(() => {
        /* The preceding job already reported its failure; later runs remain independent. */
      })
      .then(operation)
      .catch((error: unknown) => this.failed(run, error));
    this.jobs.set(groupId, job);
    try {
      await job;
    } finally {
      if (this.jobs.get(groupId) === job) this.jobs.delete(groupId);
    }
  }

  private async verify(run: Run, completed?: GroupVerification, quiet = false) {
    const workflowRunId = completed?.workflowRunId;
    if (
      this.shutdown.signal.aborted ||
      !run.groupId ||
      !run.cycleId ||
      (!completed && (run.status !== "done" || run.stopReason !== "stop"))
    )
      return;
    const group = this.service.active(run.groupId, run.botId);
    const cycle = this.service.cycles.get(group.id);
    if (cycle.cycleId !== run.cycleId) return;
    if (!workflowRunId && run.taskId && this.service.workflows.repo.byTask(run.taskId)) return;
    if (this.service.workflows.repo.activePlan(group.id, run.cycleId)) return;
    if (!workflowRunId && !quiet && this.service.runs.hasActiveForCycle(group.id, run.cycleId)) {
      const waiting = this.deferred.get(group.id) ?? new Map<string, Run>();
      waiting.set(run.id, run);
      this.deferred.set(group.id, waiting);
      return;
    }
    // A coordinator plan still waiting for the user's start covers this cycle: it is verified when
    // it finishes, and an automatic plan beside it would split the cycle between two plans.
    const waiting = this.service.plans.repo.forCycle(group.conversationId, run.cycleId)?.card;
    if (waiting && !waiting.verification && waiting.status !== "started") return;
    const members = verificationMembers(this.service, group);
    if (members.filter((bot) => bot.category !== "image").length < 2) return;
    const signal = AbortSignal.any([
      this.service.signal,
      this.shutdown.signal,
      AbortSignal.timeout(30_000),
    ]);
    const saved = this.service.plans.repo.forVerification(
      group.conversationId,
      run.cycleId,
      run.id,
    );
    if (!workflowRunId && !saved && verificationCovered(this.service, run)) return;
    const facts = completed ?? (await verificationFacts(this.service, run, signal));
    if (!facts) return;
    const source = this.service.runs.get(facts.sourceRunId);
    if (!source) throw new RpcError(-32602, "verification_source_unavailable");
    const existing = this.service.plans.repo.forVerification(
      group.conversationId,
      run.cycleId,
      source.id,
    );
    if (existing) {
      if (existing.card.verification && ["ready", "starting"].includes(existing.card.status)) {
        if (group.paused || cycle.limited)
          throw new RpcError(
            -32602,
            group.paused ? "verification_paused" : "verification_round_limit",
          );
        await this.service.plans.verify(
          source,
          existing.card.plan,
          existing.card.verification,
          signal,
        );
      }
      return;
    }
    if (group.paused || cycle.limited)
      throw new RpcError(-32602, group.paused ? "verification_paused" : "verification_round_limit");
    const team = selectVerifiers(
      members,
      facts,
      group.coordinatorBotId,
      new GroupVerificationRulesRepo(this.service.deps.db).get(group.id),
    );
    if (!team) {
      await requestVerificationAssignee(this.service, source, facts, signal);
      return;
    }
    const root = this.service.deps.local.tasks.budgetRoot(source);
    const sourceId = this.service.runs.get(root)?.userMessageId ?? source.userMessageId;
    const request = sourceId ? new MessagesRepo(this.service.deps.db).get(sourceId) : undefined;
    const text =
      request?.role === "user" && request.conversationId === group.conversationId
        ? request.content
        : "";
    await this.service.plans.verify(
      source,
      verificationPlan(
        facts,
        team,
        text,
        this.service.deps.chat.currentLanguage() === "en" ? "en" : "zh",
      ),
      facts,
      signal,
    );
  }

  private failed(run: VerificationOrigin, error: unknown) {
    if (this.shutdown.signal.aborted || this.service.signal.aborted || !this.service.interactive)
      return;
    const code =
      error instanceof RpcError && /^[a-z_]{1,80}$/u.test(error.message)
        ? error.message
        : "verification_unavailable";
    this.service.deps.logger.warn(
      JSON.stringify({
        module: "group-verification",
        event: "deferred",
        runId: run.id,
        groupId: run.groupId,
        code,
      }),
    );
    const group = run.groupId ? this.service.groups.get(run.groupId) : undefined;
    if (!group || this.service.cycles.get(group.id).cycleId !== run.cycleId) return;
    // Startup recovery re-runs finished plans; the same cause for the same run is said once, not
    // again after every restart.
    const { db, peer } = this.service.deps;
    const notice = transaction(db, () => {
      const said = db
        .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?, 'true')")
        .run(`group-verification-unstarted:${group.id}:${run.cycleId}:${run.id}:${code}`);
      if (!Number(said.changes)) return;
      return new ChatNoticesRepo(db).addGroupVerification({
        conversationId: group.conversationId,
        botId: group.coordinatorBotId,
        reason:
          code === "group_plan_waits_for_user"
            ? "direct_completion"
            : code === "verification_paused"
              ? "paused"
              : code === "verification_round_limit" || code === "group_plan_round_limit"
                ? "round_limit"
                : "unavailable",
      });
    });
    if (notice) peer.emit("chat.notice", notice);
  }

  async stop() {
    this.shutdown.abort();
    await Promise.allSettled([...(this.recovery ? [this.recovery] : []), ...this.jobs.values()]);
  }
}
