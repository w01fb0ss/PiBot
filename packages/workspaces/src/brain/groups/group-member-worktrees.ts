import type {
  WorkspaceGroups as GroupService,
  PlanStepWorkspace,
  StepKeep,
  StepWorkspaceFallback,
  ToolRunContext,
} from "@pibot/brain/kit";
import { abortable } from "@pibot/brain/kit";
import {
  createGitReader,
  createManagedFolders,
  createManagedGit,
  isManagedFolderRepository,
} from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import {
  actualRootReferences,
  type GroupMemberWorkspace,
  GroupMemberWorkspacesRepo,
  type ManagedRecord,
  ManagedWorktreesRepo,
} from "@pibot/storage";
import {
  type Group,
  RpcError,
  type Run,
  type WorkspaceSnapshot,
} from "@pibot/workspaces-contract/full";
import { isManagedCleanupFailure } from "../managed/managed-failure.ts";
import { groupWorkplace } from "../runtime.ts";
import {
  discardStepWorkspace,
  endPlanWorkspaces,
  managedPlanKeys,
  stepWorkspaceRoot,
} from "./group-step-cleanup.ts";
import { adoptedStepWorkspace, adoptStepWorkspace, keepStepWorkspace } from "./group-step-keep.ts";
import { mergeStep } from "./group-step-merge.ts";
import { isPlanStepWorkspace } from "./group-step-output.ts";
import { prepareFailureCode, prepareStepWorktree, SETUP_FAILED } from "./group-step-prepare.ts";
import { StepTurns } from "./group-step-turns.ts";
import { UnansweredWorktreeApproval } from "./group-worktree-authority.ts";
import { createMemberWorktree } from "./group-worktree-create.ts";
import { localWorktreeHost, remoteWorktreeHost, type WorktreeHost } from "./group-worktree-host.ts";
import { integrateMemberWorktree } from "./group-worktree-integrate.ts";
import { resolveMemberWorkplace, verifyMemberWorktree } from "./group-worktree-place.ts";

type Place = Awaited<ReturnType<typeof groupWorkplace>>;
export type Active = { context: ToolRunContext; member: GroupMemberWorkspace; tree: ManagedRecord };
function fail(code: string): never {
  throw new RpcError(-32602, code);
}

/** The group selection is the integration target; member capabilities never mutate that selection. */
export class GroupMemberWorktrees {
  readonly repo: GroupMemberWorkspacesRepo;
  readonly registry: ManagedWorktreesRepo;
  readonly git;
  readonly localHost: WorktreeHost;
  readonly reader;
  /** Pi Bot's own repositories for plan folders that are not usable Git repositories. */
  readonly folders;
  private readonly stop = new AbortController();
  readonly active = new Map<string, Active>();
  private readonly pending = new Map<string, { active: Active; record: Run }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private uncertain: unknown;
  /** Paths an uncertain cleanup still holds; only work there waits for a restart. */
  private readonly uncertainPaths: string[] = [];
  private readonly chains = new Map<string, Promise<void>>();
  /** Plan step runs whose prepare took turns in the shared folder, with the fixed reason. */
  private readonly fallbacks = new Map<string, string>();
  readonly turns: StepTurns;
  constructor(readonly service: GroupService) {
    const local = service.deps.local;
    this.turns = new StepTurns((groupId) =>
      local.deps.peer.emit("groups.changed", { groupId, reason: "updated" }),
    );
    this.repo = new GroupMemberWorkspacesRepo(local.deps.db);
    this.registry = new ManagedWorktreesRepo(local.deps.db);
    this.repo.interrupted();
    this.reader = createGitReader({
      platform: local.deps.platform,
      env: local.deps.env,
      userHome: local.deps.userHome,
      resourcesDir: local.deps.resourcesDir,
    });
    this.git = createManagedGit({
      platform: local.deps.platform,
      env: local.deps.env,
      systemHome: local.deps.userHome,
      tempDir: local.deps.tempDir,
      resourcesDir: local.deps.resourcesDir,
      proxy: local.deps.proxy,
      redactor: local.deps.redactor,
    });
    this.folders = createManagedFolders({
      platform: local.deps.platform,
      env: local.deps.env,
      tempDir: local.deps.tempDir,
      resourcesDir: local.deps.resourcesDir,
    });
    this.localHost = localWorktreeHost(local, this.git, this.reader);
    this.timer = setInterval(() => {
      void this.flush().catch(() => local.deps.logger.warn("Group workspace settlement deferred"));
    }, 5000);
    this.timer.unref();
  }
  /** A step whose workspace setup failed took turns instead: its task has no workspace. */
  workspace(taskId: string) {
    const member = this.repo.get(taskId);
    return member?.state === "removed" && member.errorCode === SETUP_FAILED ? undefined : member;
  }
  serial<T>(key: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const pending = (async () => {
      await abortable(prior, signal);
      signal.throwIfAborted();
      return operation();
    })();
    // An aborted waiter must not detach the still-running predecessor from shutdown/order.
    const tail = Promise.all([
      prior,
      pending.then(
        () => {},
        () => {},
      ),
    ]).then(() => {});
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return pending;
  }
  async exclusive<T>(
    id: string,
    botId: string,
    paths: string[],
    signal: AbortSignal,
    operation: () => Promise<T>,
    blockedRunId?: string,
  ) {
    const locks = this.service.deps.local.writeLocks;
    const busy = new AbortController();
    const acquiring = blockedRunId ? AbortSignal.any([signal, busy.signal]) : signal;
    await locks.acquire({ botId, runId: id }, paths, acquiring, (holder) => {
      if (holder.runId === blockedRunId) busy.abort(new RpcError(-32011, "group_workspace_busy"));
    });
    let retained = false;
    try {
      return await operation();
    } catch (error) {
      retained = isManagedCleanupFailure(error);
      if (retained) {
        this.uncertain = error;
        this.uncertainPaths.push(...paths);
      }
      throw error;
    } finally {
      if (!retained) locks.release(id);
    }
  }
  signal(signal: AbortSignal) {
    return AbortSignal.any([signal, this.stop.signal, AbortSignal.timeout(120000)]);
  }
  /**
   * Whether an uncertain cleanup still holds any of `paths`. Its lock stays until a restart; work
   * in other folders and repositories goes on (it used to stop every group's workspaces).
   */
  cleanupPending(paths: readonly string[]) {
    const platform = this.service.deps.local.deps.platform;
    return this.uncertainPaths.some((held) =>
      paths.some(
        (path) => containsPath(held, path, platform) || containsPath(path, held, platform),
      ),
    );
  }
  current(context: ToolRunContext, member: GroupMemberWorkspace) {
    if (this.cleanupPending([member.integrationPath])) fail("group_workspace_cleanup_pending");
    const group = this.service.active(member.groupId, context.botId, context.conversationId);
    if (group.conversationId !== member.sourceConversationId) fail("group_workspace_changed");
    const primary = group.folders?.find((f) => f.id === group.primaryFolderId);
    if (
      !primary ||
      // A plan step on a non-Git folder integrates into Pi Bot's repository inside that folder.
      (primary.path !== member.integrationPath &&
        !isManagedFolderRepository(primary.path, member.integrationPath)) ||
      (group.workspaceRevision ?? 0) !== member.workspaceRevision
    )
      fail("group_workspace_changed");
    return group;
  }
  state(
    member: GroupMemberWorkspace,
    state: GroupMemberWorkspace["state"],
    errorCode: string | null = null,
  ) {
    const saved = this.repo.save({ ...member, state, errorCode });
    this.service.deps.local.deps.peer.emit("groups.changed", {
      groupId: member.groupId,
      reason: "updated",
    });
    return saved;
  }
  audit(context: ToolRunContext, action: string, state: "started" | "done" | "error", id: string) {
    this.service.deps.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: state === "started" ? "exec.started" : "exec.finished",
      summary: "Parallel task workspace / 并行任务工作区",
      detail: {
        toolName: `group_workspace.${action}`,
        actor: "system",
        groupId: context.groupId,
        target: id,
        reasonCode: state,
      },
    });
  }
  /** The group's primary folder decides where its member worktrees live. */
  host(boundary: WorkspaceSnapshot): WorktreeHost {
    return boundary.location && boundary.location.target !== "local"
      ? remoteWorktreeHost(this.service.deps.local, boundary)
      : this.localHost;
  }
  verify(tree: ManagedRecord, signal: AbortSignal, host: WorktreeHost = this.localHost) {
    const current = this.registry.get(tree.id);
    if (!current || current.version !== tree.version || current.state !== "ready")
      fail("group_workspace_changed");
    return verifyMemberWorktree(host, current, signal);
  }
  /** Last step a prepare reached, for the failure log only (step names, never paths). */
  private readonly stages = new Map<string, string>();
  stage(runId: string, name: string) {
    this.stages.set(runId, name);
  }
  stageOf(runId: string) {
    return this.stages.get(runId) ?? "start";
  }
  async prepare(
    context: ToolRunContext,
    group: Group,
    parent: AbortSignal,
    step?: PlanStepWorkspace,
  ): Promise<StepWorkspaceFallback | undefined> {
    try {
      await this.prepareWorktree(context, group, parent, step);
      this.stages.delete(context.runId);
      const fallback = this.fallbacks.get(context.runId);
      this.fallbacks.delete(context.runId);
      return fallback ? { fallback } : undefined;
    } catch (error) {
      const unansweredApproval = error instanceof UnansweredWorktreeApproval;
      // Keep the specific workspace outcome in the log (codes only).
      if (unansweredApproval || !parent.aborted)
        this.service.deps.local.deps.logger[unansweredApproval ? "info" : "warn"](
          JSON.stringify({
            module: "group",
            event: unansweredApproval ? "worktree_approval_unanswered" : "worktree_prepare_failed",
            groupId: group.id,
            runId: context.runId,
            stage: this.stageOf(context.runId),
            code: unansweredApproval ? error.code : prepareFailureCode(error),
          }),
        );
      this.stages.delete(context.runId);
      this.fallbacks.delete(context.runId);
      throw error;
    }
  }
  /**
   * A plan step that cannot have its own workspace takes turns; the reason is shown to people.
   * With `folder` it also joins that folder's line, and its run waits there (waitTurn).
   */
  takeTurns(context: ToolRunContext, taskId: string, reason: string, folder?: string) {
    const serialTask = this.service.tasks.serialFallback(taskId);
    if (serialTask) this.service.taskChanged(serialTask);
    this.fallbacks.set(context.runId, reason);
    if (folder) this.turns.join(context.runId, taskId, context.groupId, folder, reason);
    this.service.deps.local.deps.logger.info(
      JSON.stringify({ module: "group", event: "step_workspace_fallback", taskId, reason }),
    );
  }
  /** Waits until the steps ahead of this run in its folder's line have ended. */
  waitTurn(context: ToolRunContext, signal: AbortSignal) {
    return this.turns.wait(context.runId, signal);
  }
  waitingTurn(taskId: string) {
    return this.turns.waiting(taskId);
  }
  private async prepareWorktree(
    context: ToolRunContext,
    group: Group,
    parent: AbortSignal,
    step?: PlanStepWorkspace,
  ) {
    if (
      this.service.deps.local.tasks.hasAuthority(context) ||
      !context.taskId ||
      !group.folders?.some((f) => f.id === group.primaryFolderId)
    )
      return;
    const task = this.service.tasks.get(context.taskId);
    if (task?.executionMode !== "parallel") return;
    if (task.source?.conversationId !== group.conversationId) fail("group_workspace_changed");
    const local = this.service.deps.local,
      signal = this.signal(parent);
    this.stage(context.runId, "workplace");
    const baseline = await groupWorkplace(local, context.botId, group, signal);
    if (
      local.execution.get({
        botId: context.botId,
        conversationId: context.conversationId as string,
      }).mode !== "execute"
    )
      return;
    if (step) {
      await this.serial(`task:${context.taskId}`, signal, () =>
        prepareStepWorktree(this, context, group, baseline, task, step, signal),
      );
      return;
    }
    // Non-Git groups retain their normal folders. Git errors are never a shared-write fallback.
    this.stage(context.runId, "host");
    const host = this.host(baseline.boundary);
    const location =
      baseline.boundary.location && baseline.boundary.location.target !== "local"
        ? baseline.boundary.location.target
        : null;
    this.stage(context.runId, "probe");
    if (!(await host.isRepository(baseline.cwd, signal))) {
      const serialTask = this.service.tasks.serialFallback(task.id);
      if (serialTask) this.service.taskChanged(serialTask);
      return;
    }
    await this.serial(`task:${context.taskId}`, signal, async () => {
      const retained = this.repo.get(context.taskId as string);
      if (retained && retained.state !== "integrated") {
        await this.reattach(context, group, task, retained, host, location, signal);
        return;
      }
      const active = await createMemberWorktree(this, host, context, group, baseline, signal);
      this.active.set(context.runId, active);
    });
  }
  /** A later run of the same task (continuation, resume) works on in the tree it already has. */
  async reattach(
    context: ToolRunContext,
    group: Group,
    task: { id: string; status: string },
    retained: GroupMemberWorkspace,
    host: WorktreeHost,
    location: string | null,
    signal: AbortSignal,
  ) {
    this.current(context, retained);
    if ((retained.executionLocation ?? null) !== location) fail("group_workspace_changed");
    if (retained.state === "removed") fail("group_workspace_removed");
    if (
      retained.state !== "working" &&
      !(retained.state === "interrupted" && task.status === "open")
    )
      fail(retained.errorCode ?? "group_workspace_interrupted");
    const tree = this.registry.get(retained.worktreeId);
    if (!tree) fail("group_workspace_interrupted");
    await this.verify(tree, signal, host);
    for (const [id, value] of this.pending)
      if (value.active.member.groupId === group.id && value.active.member.taskId === task.id)
        this.pending.delete(id);
    const member = this.repo.save({
      ...retained,
      state: "working",
      errorCode: null,
      runId: context.runId,
    });
    context.groupMemberWorktreeId = tree.id;
    this.active.set(context.runId, { context, member, tree });
  }
  workplace(context: ToolRunContext, group: Group, parent: AbortSignal): Promise<Place> {
    return resolveMemberWorkplace(this, context, group, parent);
  }
  /**
   * No run works in this workspace now. A run that ended without finishing leaves its tree in
   * `working` (a resume may continue there); a plan's redo is a new task, so that tree is idle.
   */
  idle(member: GroupMemberWorkspace) {
    if (member.state === "preparing" || member.state === "integrating") return false;
    if (member.state !== "working") return true;
    for (const active of this.active.values())
      if (active.member.taskId === member.taskId) return false;
    const run = member.runId ? this.service.deps.chat.queue.repo.get(member.runId) : undefined;
    return !run || !["queued", "running", "waiting", "stopping"].includes(run.status);
  }
  blocksWake(taskId: string) {
    const state = this.repo.get(taskId)?.state;
    return state === "preparing" || state === "working" || state === "integrating";
  }
  async settled(record: Run) {
    this.turns.release(record.id);
    const active = this.active.get(record.id);
    this.active.delete(record.id);
    if (
      active &&
      record.status === "done" &&
      record.stopReason === "stop" &&
      !active.context.todoRun?.paused
    ) {
      const task = record.taskId ? this.service.tasks.get(record.taskId) : undefined;
      if (!task || task.status === "done") this.pending.set(record.id, { active, record });
    }
    await this.flush();
  }
  private flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushPending().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  private async flushPending() {
    for (const [id, value] of this.pending) {
      if (this.stop.signal.aborted || this.service.deps.local.shutdown.signal.aborted) return;
      const { active, record } = value;
      const current = this.repo.get(active.member.taskId);
      if (current?.runId !== id || current.state !== "working") {
        this.pending.delete(id);
        continue;
      }
      if (this.pendingResources(active.member, active.tree)) continue;
      this.pending.delete(id);
      this.state(active.member, "awaiting_integration");
      if (record.taskId) this.service.wakes.enqueue(record.taskId);
    }
  }
  pendingResources(member: GroupMemberWorkspace, tree: ManagedRecord, planStep = false) {
    const local = this.service.deps.local,
      task = this.service.tasks.get(member.taskId);
    const resources = this.service.deps.chat.queue.resources();
    if (
      !resources.healthy ||
      !task ||
      local.tasks.continuations.hasPending(task.threadConversationId)
    )
      return true;
    if (
      resources.contexts.some((context) => {
        if (context.botId !== member.botId) return false;
        if (context.conversationId === task.threadConversationId) return true;
        if (!local.tasks.hasAuthority(context)) return false;
        try {
          return (
            local.tasks.source({ ...context, signal: this.stop.signal, language: "en" })
              .groupMemberWorktreeId === tree.id
          );
        } catch {
          // An unresolved SDK session can retain files even after its persisted status changes.
          return true;
        }
      })
    )
      return true;
    return actualRootReferences(
      local.deps.db,
      tree.path,
      local.deps.platform,
      local.deps.dataDir,
      // Pi Bot's folder repository is never a workspace itself; the folder holding it is.
      stepWorkspaceRoot(this, member)?.primary ?? tree.sourcePath,
      planStep,
    );
  }
  async integrateTask(context: ToolRunContext, taskId: string, parent: AbortSignal) {
    const member = this.repo.get(taskId);
    if (!member || member.groupId !== context.groupId) fail("group_workspace_missing");
    const group = this.current(context, member);
    if (group.coordinatorBotId !== context.botId || context.threadId)
      fail("group_workspace_coordinator_required");
    const task = this.service.tasks.get(taskId);
    if (task?.status !== "done") fail("group_workspace_task_unfinished");
    // Plan steps are merged by the program with their output files; a bare merge would lose them.
    if (await isPlanStepWorkspace(this.service.deps.local, taskId))
      fail("group_workspace_plan_step");
    if (member.state === "integrated") return;
    if (!["awaiting_integration", "conflict", "working", "interrupted"].includes(member.state))
      fail("group_workspace_not_ready");
    const tree = this.registry.get(member.worktreeId);
    if (!tree) fail("group_workspace_missing");
    if (
      await this.service.deps.local.writeLocks.overlapsHeld(context.runId, [
        member.integrationPath,
        tree.commonDir,
        tree.path,
      ])
    )
      throw new RpcError(-32011, "group_workspace_busy");
    if (this.pendingResources(member, tree)) fail("group_workspace_not_drained");
    const signal = this.signal(parent);
    try {
      await this.serial(
        `integrate:${member.groupId}:${member.sourceConversationId}`,
        signal,
        async () => {
          const current = this.repo.get(taskId);
          if (current?.state === "integrated") return;
          if (!current || current.worktreeId !== tree.id || current.state === "removed")
            fail("group_workspace_changed");
          await integrateMemberWorktree(this, { context, member: current, tree }, signal);
        },
      );
    } catch (error) {
      // A concurrent user action may already have completed and removed this tree.
      const current = this.repo.get(taskId),
        registered = this.registry.get(tree.id);
      if (
        current?.worktreeId === tree.id &&
        !["integrated", "removed"].includes(current.state) &&
        registered?.state !== "removed" &&
        !(error instanceof RpcError && error.message === "group_workspace_busy")
      )
        this.state(
          current,
          "conflict",
          error instanceof RpcError ? error.message : "group_workspace_integration_failed",
        );
      this.audit(context, "integrate", "error", tree.id);
      throw error;
    }
  }
  isolated(taskId: string) {
    const member = this.repo.get(taskId);
    if (!member || ["integrated", "removed"].includes(member.state)) return undefined;
    return stepWorkspaceRoot(this, member);
  }
  integratedRoot(taskId: string) {
    const member = this.repo.get(taskId);
    return member?.state === "integrated" ? stepWorkspaceRoot(this, member, true) : undefined;
  }
  mergeStep(taskId: string, signal: AbortSignal) {
    return mergeStep(this, taskId, signal);
  }
  discardStep(taskId: string, signal: AbortSignal) {
    return discardStepWorkspace(this, taskId, this.signal(signal));
  }
  keepStep(taskId: string, botId: string, signal: AbortSignal) {
    return keepStepWorkspace(this, taskId, botId, this.signal(signal));
  }
  adoptStep(fromTaskId: string, toTaskId: string, kept: Extract<StepKeep, { state: "kept" }>) {
    return adoptStepWorkspace(this, fromTaskId, toTaskId, kept);
  }
  adoptedStep(fromTaskId: string, toTaskId: string) {
    return adoptedStepWorkspace(this, fromTaskId, toTaskId);
  }
  endPlan(primaryPath: string, planKey: string) {
    return endPlanWorkspaces(this, primaryPath, planKey);
  }
  openWorkspaces() {
    return this.repo.open();
  }
  managedPlanKeys(primaryPath: string) {
    return managedPlanKeys(primaryPath);
  }
  cancel() {
    this.stop.abort();
    clearInterval(this.timer);
    this.turns.dispose();
  }
  async dispose() {
    this.cancel();
    await Promise.allSettled([...this.chains.values(), ...(this.flushing ? [this.flushing] : [])]);
    this.pending.clear();
    this.git.dispose();
    this.reader.dispose();
    if (this.uncertain) throw this.uncertain;
  }
}
