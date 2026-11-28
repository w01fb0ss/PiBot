import type { StepMerge } from "@pibot/brain/orchestration-kit";
import { type GroupWorkflowRunRecord, MessagesRepo, transaction } from "@pibot/storage";
import { stepMerged, stepTaskId } from "./group-plan-step-workspaces.ts";
import { planStepTitles } from "./group-plan-summary.ts";
import type { GroupService } from "./group-service.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { type WorkflowEngine, workflowOf } from "./group-workflow-snapshot.ts";

/**
 * A passed step usually waits only for its run's last bookkeeping (resources drained, workspace
 * settled): a second, not five. The check is a few local reads.
 */
const RETRY_MS = 1_000;
const SWEEP_MS = 30_000;
const MERGE_MS = 10 * 60_000;

/**
 * Maintainers 2026-11-14: Pi Bot merges each passed writing step into the group folder, one at a time
 * per group and in plan order, under the same integration policy as any other merge (the
 * coordinator is not woken per step). A conflict blocks the step with its files so the
 * coordinator can redo it from the merged base; the sweep removes workspaces nothing needs.
 */
export class GroupPlanMerges {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private sweeping?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly noted = new Set<string>();
  /** Plans that already showed the 「安装 Git」 card; one card per plan is enough. */
  private readonly gitCards = new Set<string>();
  constructor(private readonly engine: WorkflowEngine) {}

  private get service(): GroupService {
    return this.engine.service;
  }

  start() {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
    void this.sweep(true);
  }

  /** Every passed, unmerged step of a plan, earliest in the plan first. */
  requestAll(record: GroupWorkflowRunRecord) {
    for (const state of this.engine.repo.steps(record.id))
      if (state.status === "passed" && !stepMerged(this.service, state))
        this.request(record.id, state.stepId);
  }

  request(workflowRunId: string, stepId: string) {
    const key = `${workflowRunId}:${stepId}`;
    if (this.stopped || this.queued.has(key)) return;
    const record = this.engine.repo.get(workflowRunId);
    if (!record) return;
    this.queued.add(key);
    const prior = this.chains.get(record.groupId) ?? Promise.resolve();
    const next = prior
      .then(() => this.merge(workflowRunId, stepId))
      .catch((error: unknown) => {
        if (!this.stopped)
          this.service.deps.logger.warn(
            JSON.stringify({
              module: "group-workflow",
              event: "step_merge_error",
              workflowRunId,
              stepId,
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
      })
      .finally(() => this.queued.delete(key));
    this.chains.set(record.groupId, next);
    void next.then(() => {
      if (this.chains.get(record.groupId) === next) this.chains.delete(record.groupId);
    });
  }

  private async merge(workflowRunId: string, stepId: string) {
    if (this.stopped) return;
    const record = this.engine.repo.get(workflowRunId);
    if (!record || !["running", "waiting"].includes(record.status)) return;
    const state = this.engine.repo.steps(record.id).find((item) => item.stepId === stepId);
    const taskId = state ? stepTaskId(this.service, state) : undefined;
    if (state?.status !== "passed" || !taskId || stepMerged(this.service, state)) return;
    const signal = AbortSignal.any([
      this.service.signal,
      this.engine.shutdownSignal,
      AbortSignal.timeout(MERGE_MS),
    ]);
    const result = await this.service.memberWorktrees.mergeStep(taskId, signal);
    if (this.stopped || signal.aborted) return;
    this.service.deps.logger.info(
      JSON.stringify({
        module: "group-workflow",
        event: "step_merge",
        workflowRunId,
        stepId,
        state: result.state,
        ...(result.state === "conflict" || result.state === "failed" ? { code: result.code } : {}),
      }),
    );
    if (result.state === "pending") return this.retry(workflowRunId, stepId);
    if (result.state === "merged") {
      this.engine.audit(
        record,
        "group.workflow.step_merged",
        "Group plan step merged / 群计划步骤已合并",
        { actor: "system", stepId, taskId },
      );
      this.engine.announce(this.engine.repo.get(record.id) ?? record);
      this.service.changed(record.groupId, "updated");
      this.engine.schedule(record.id);
      return;
    }
    this.conflict(record, stepId, taskId, result);
  }

  /** The step goes back to the coordinator (a dynamic plan) or to the user, with the files. */
  private conflict(
    record: GroupWorkflowRunRecord,
    stepId: string,
    taskId: string,
    result: Extract<StepMerge, { state: "conflict" | "failed" }>,
  ) {
    const workflow = workflowOf(record);
    const definition = workflow.contract.steps?.find((step) => step.id === stepId);
    if (!definition) return;
    const reason = result.state === "conflict" ? "merge_conflict" : "merge_failed";
    const files = result.state === "conflict" ? result.files : [];
    const blocked = transaction(this.service.deps.db, () => {
      const latest = this.engine.repo.get(record.id);
      const state = this.engine.repo.steps(record.id).find((item) => item.stepId === stepId);
      if (!latest || !["running", "waiting"].includes(latest.status) || state?.status !== "passed")
        return undefined;
      this.engine.repo.updateStep(record.id, stepId, { status: "blocked" });
      this.engine.repo.updateRun(record.id, "waiting");
      const progress = progressOf(latest);
      this.engine.progress.save(latest, {
        ...progress,
        merges: {
          ...(progress.merges ?? {}),
          [stepId]: { code: reason, files: files.map((file) => file.slice(0, 500)).slice(0, 20) },
        },
      });
      this.engine.audit(
        record,
        "group.workflow.step_blocked",
        "Group workflow step blocked / 群工作流步骤已阻塞",
        { actor: "system", stepId, taskId, reasonCode: reason, reason },
      );
      return state;
    });
    if (!blocked) return;
    // A static workflow has no coordinator disposition: its stuck steps are the user's to decide.
    if (workflow.source.kind !== "dynamic")
      this.engine.createDecision(record, definition, blocked.attempt, reason);
    this.engine.announce(this.engine.repo.get(record.id) ?? record);
    this.service.changed(record.groupId, "updated");
    this.engine.schedule(record.id);
  }

  private retry(workflowRunId: string, stepId: string) {
    const key = `${workflowRunId}:${stepId}`;
    if (this.retries.has(key) || this.stopped) return;
    const timer = setTimeout(() => {
      this.retries.delete(key);
      this.request(workflowRunId, stepId);
    }, RETRY_MS);
    timer.unref();
    this.retries.set(key, timer);
  }

  /**
   * Removes workspaces nothing needs any more (a redone attempt, a replaced or ended plan) and
   * Pi Bot's folder repositories of ended plans; restarts merges a crash interrupted.
   */
  sweep(startup = false) {
    if (this.stopped || this.sweeping) return this.sweeping;
    this.sweeping = this.sweepNow(startup)
      .catch(() => {
        this.service.deps.logger.warn(
          JSON.stringify({ module: "group-workflow", event: "step_workspace_sweep_deferred" }),
        );
      })
      .finally(() => {
        this.sweeping = undefined;
      });
    return this.sweeping;
  }

  private async sweepNow(startup: boolean) {
    const { service, repo } = this.engine;
    const signal = AbortSignal.any([service.signal, this.engine.shutdownSignal]);
    const plans = new Map<string, string>();
    for (const workspace of service.memberWorktrees.openWorkspaces()) {
      if (this.stopped || signal.aborted) return;
      if (["preparing", "integrating"].includes(workspace.state)) continue;
      const step = service.handoffs.repo.get(workspace.taskId)?.spec.workflowStep;
      if (!step) continue; // A direct hand-off: its coordinator or the user integrates it.
      const record = repo.get(step.workflowRunId);
      const latest =
        record?.status === "cancelled" && record.budgetRootRunId
          ? (repo.latestPlan(record.groupId, record.cycleId, record.budgetRootRunId) ?? record)
          : record;
      const owner =
        latest && ["running", "waiting"].includes(latest.status)
          ? repo.steps(latest.id).find((state) => stepTaskId(service, state) === workspace.taskId)
          : undefined;
      if (!owner) {
        await service.memberWorktrees.discardStep(workspace.taskId, signal);
        if (record?.budgetRootRunId)
          plans.set(record.budgetRootRunId, primaryOf(workspace.integrationPath));
        continue;
      }
      if (owner.status === "passed" && workspace.state !== "conflict" && latest)
        this.request(latest.id, owner.stepId);
    }
    if (startup)
      for (const group of service.groups.list({ limit: 50 })) {
        const primary = group.folders?.find((folder) => folder.id === group.primaryFolderId);
        if (!primary || (primary.location && primary.location !== "local")) continue;
        for (const key of await service.memberWorktrees.managedPlanKeys(primary.path))
          plans.set(key, primary.path);
      }
    for (const [planKey, primary] of plans)
      if (primary && !repo.chainActive(planKey))
        await service.memberWorktrees.endPlan(primary, planKey);
  }

  /** One program line per step that could not have its own workspace, with the fixed reason. */
  tookTurns(context: { taskId?: string; runId: string }, reason: string) {
    const step = context.taskId
      ? this.service.handoffs.repo.get(context.taskId)?.spec.workflowStep
      : undefined;
    const record = step ? this.engine.repo.get(step.workflowRunId) : undefined;
    const group = record ? this.service.groups.get(record.groupId) : undefined;
    if (!step || !record || !group || this.noted.has(context.taskId as string)) return;
    this.noted.add(context.taskId as string);
    if (this.noted.size > 500) this.noted.delete(this.noted.values().next().value as string);
    const language = this.service.deps.chat.currentLanguage();
    const title = planStepTitles(workflowOf(record).contract.steps, language)(step.stepId);
    const zh = language === "zh";
    const why = turnsReason(reason, zh);
    // Maintainers 2026-11-21: without Git the plan offers to install it, once, at this point.
    const plan = record.budgetRootRunId ?? record.id;
    const gitCard = reason === "git_unavailable" && !this.gitCards.has(plan);
    if (gitCard) {
      this.gitCards.add(plan);
      if (this.gitCards.size > 200)
        this.gitCards.delete(this.gitCards.values().next().value as string);
    }
    new MessagesRepo(this.service.deps.db).create({
      conversationId: group.conversationId,
      botId: record.coordinatorBotId,
      role: "assistant",
      content: this.service.deps.redactor.redact(
        zh
          ? `「${title}」在群文件夹里和其他成员轮流写：${why}。`
          : `“${title}” takes turns in the group folder: ${why}.`,
      ),
      status: "done",
      usage: {
        groupWorkflowStatus: { workflowRunId: record.id },
        ...(gitCard ? { gitSetup: "parallel" } : {}),
      },
    });
    this.service.changed(record.groupId, "updated");
  }

  /** A plan ended: its leftover workspaces and Pi Bot's folder repository go. */
  ended(record: GroupWorkflowRunRecord) {
    const planKey = record.budgetRootRunId;
    if (this.stopped || !planKey || this.engine.repo.chainActive(planKey)) return;
    const primary = planPrimary(workflowOf(record));
    void Promise.resolve(this.sweep())
      .then(() => (primary ? this.service.memberWorktrees.endPlan(primary, planKey) : undefined))
      .catch(() => {
        // The periodic sweep tries again; a leftover repository never blocks another plan.
      });
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await Promise.allSettled([...this.chains.values(), ...(this.sweeping ? [this.sweeping] : [])]);
  }
}

/** The primary folder a plan was frozen on (its managed folder repository lives inside). */
function planPrimary(workflow: ReturnType<typeof workflowOf>) {
  return (
    workflow.delivery?.workspaceRoot ??
    workflow.workplace?.folders?.find((item) => item.id === workflow.workplace?.primaryFolderId)
      ?.path
  );
}

/** The folder a workspace mirrors: Pi Bot's folder repository sits three levels below it. */
function primaryOf(integrationPath: string) {
  const parts = integrationPath.split(/[\\/]/);
  return parts.at(-2) === "managed-git" && parts.at(-3) === ".pibot"
    ? parts.slice(0, -3).join(integrationPath.includes("\\") ? "\\" : "/")
    : "";
}

function turnsReason(reason: string, zh: boolean) {
  switch (reason) {
    case "runner_update_required":
      return zh
        ? "执行端需要更新才能建独立工作区"
        : "the runner needs an update for own workspaces";
    case "runner_folder_not_git":
      return zh ? "执行端上的文件夹不是 Git 仓库" : "the runner folder is not a Git repository";
    case "runner_folder_dirty":
      return zh ? "执行端上的仓库有未提交的改动" : "the runner repository has uncommitted changes";
    case "managed_folder_too_large":
      return zh ? "文件夹太大，建不了独立工作区" : "the folder is too large for own workspaces";
    case "git_unavailable":
      return zh
        ? "这台电脑没有安装 Git，建不了独立工作区"
        : "Git is not installed on this computer, so steps cannot have own workspaces";
    case "readonly_commands_unsupported":
      return zh
        ? "这个系统上独立工作区里还不能运行命令"
        : "commands cannot run in own workspaces on this system yet";
    case "group_workspace_setup_failed":
      return zh ? "这次建独立工作区没有成功" : "setting up its own workspace failed this time";
    case "group_workspace_cleanup_pending":
      return zh
        ? "之前的独立工作区还没清理完，重启 Pi Bot 后才能再建"
        : "an earlier workspace here is still being cleaned up; restart Pi Bot to use own workspaces again";
    case "worktree_quota":
      return zh
        ? "这个仓库的独立工作区已达上限"
        : "this repository has reached its workspace limit";
    default:
      return zh ? "这个文件夹暂时建不了独立工作区" : "this folder cannot have own workspaces now";
  }
}
