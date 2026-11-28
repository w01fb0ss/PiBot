import { lstatSync } from "node:fs";
import { AgentError } from "@pibot/agent";
import type { LocalService, ToolRunContext } from "@pibot/brain/orchestration-kit";
import {
  CONTINUATION_ROOT_CAPACITY,
  canonicalExistingPathSync,
  continuedMode,
  groupAuthorization,
  intersectTaskPermissions,
  matchesFileIdentity,
  resolveRunWorkplace,
  runPermissions,
  samePathSpelling,
  taskPermissionsNarrowed,
  topicWorkplaceSnapshot,
} from "@pibot/brain/orchestration-kit";
import { type ExecutionMode, type PermissionsSettings, RpcError } from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationsRepo,
  ConversationYoloRepo,
  GroupCyclesRepo,
  GroupsRepo,
  RunsRepo,
  type TaskAuthority,
  type TaskRepo,
} from "@pibot/storage";

/** A child has its own run/session identity, and separately the authority of the originating topic. */
export class TaskAuthorityService {
  private readonly continuationAuthorities = new Map<string, TaskAuthority>();
  private readonly parentResumes = new Set<string>();
  constructor(
    private readonly local: LocalService,
    private readonly repo: TaskRepo,
  ) {}
  hasAuthority(context: Pick<ToolRunContext, "runId" | "executionTaskId">) {
    return !!context.executionTaskId || this.continuationAuthorities.has(context.runId);
  }
  bindContinuation(runId: string, authority: TaskAuthority, parentResume = false) {
    if (this.continuationAuthorities.size >= CONTINUATION_ROOT_CAPACITY)
      throw new RpcError(-32011, "task_continuation_capacity");
    this.continuationAuthorities.set(runId, authority);
    if (parentResume) this.parentResumes.add(runId);
  }
  releaseContinuation(runId: string) {
    this.continuationAuthorities.delete(runId);
    this.parentResumes.delete(runId);
  }
  isParentResume(runId: string) {
    return this.parentResumes.has(runId);
  }
  isContinuation(runId: string) {
    return this.continuationAuthorities.has(runId);
  }
  verifyContinuation(runId: string, signal: AbortSignal) {
    const authority = this.continuationAuthorities.get(runId);
    if (!authority) return;
    if (this.isParentResume(runId) && new RunsRepo(this.local.deps.db).hasNewUserRunAfter(runId))
      throw new RpcError(-32602, "task_source_changed");
    this.verifySource(authority, signal);
    if (authority.source.groupId) {
      const group = new GroupsRepo(this.local.deps.db).get(authority.source.groupId);
      if (
        !group ||
        group.paused ||
        new GroupCyclesRepo(this.local.deps.db).get(group.id).cycleId !== authority.source.cycleId
      )
        throw new RpcError(-32602, "task_source_changed");
    }
    const current = runPermissions(this.local, authority.source);
    if (taskPermissionsNarrowed(authority.permissions, current))
      throw new RpcError(-32602, "task_source_changed");
  }
  private record(context: ToolRunContext) {
    const continuation = this.continuationAuthorities.get(context.runId);
    if (continuation) {
      if (
        context.executionTaskId ||
        continuation.source.botId !== context.botId ||
        continuation.source.conversationId !== context.conversationId
      )
        throw new RpcError(-32602, "task_identity_changed");
      return { authority: continuation };
    }
    const task = context.executionTaskId ? this.repo.get(context.executionTaskId) : undefined;
    const internal = task ? this.repo.internal(task.id) : undefined;
    if (
      !task ||
      !internal ||
      task.botId !== context.botId ||
      task.runId !== context.runId ||
      internal.conversationId !== context.conversationId
    )
      throw new RpcError(-32602, "task_identity_changed");
    return { task, ...internal };
  }
  source(context: ToolRunContext): ToolRunContext {
    if (!this.hasAuthority(context)) return context;
    const { authority } = this.record(context);
    return {
      ...authority.source,
      runWorkplace: { cwd: authority.workplace.cwd, boundary: authority.workplace.boundary },
      signal: context.signal,
      language: context.language,
    };
  }
  guardSync(context: ToolRunContext) {
    if (!this.hasAuthority(context)) return;
    context.signal.throwIfAborted();
    try {
      this.assertIdentity(context);
    } catch (error) {
      const errno = (error as { code?: unknown } | null)?.code;
      // A folder identity mismatch keeps its own reason: "unavailable" sent people (and the
      // model) after the task or conversation when the recorded folder was what differed.
      if (error instanceof RpcError && error.message === "task_workplace_changed")
        throw new AgentError("task_workplace_changed");
      if (
        (error instanceof RpcError && error.message.startsWith("task_")) ||
        (typeof errno === "string" &&
          ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(errno))
      )
        throw new AgentError("task_unavailable");
      throw error;
    }
  }
  private assertIdentity(context: ToolRunContext) {
    const { authority } = this.record(context),
      db = this.local.deps.db;
    const run = new RunsRepo(db).get(context.runId);
    if (
      run?.botId !== context.botId ||
      run.conversationId !== context.conversationId ||
      run.status !== "running"
    )
      throw new RpcError(-32602, "task_identity_changed");
    if (this.isContinuation(context.runId)) this.verifyContinuation(context.runId, context.signal);
    else this.verifySource(authority, context.signal, context.language);
    if (
      this.isParentResume(context.runId) &&
      context.todoRun?.planVersion !==
        this.local.execution.todo({
          botId: authority.source.botId,
          conversationId: authority.source.conversationId as string,
        }).version
    )
      throw new RpcError(-32602, "task_source_changed");
  }
  verifySource(authority: TaskAuthority, signal: AbortSignal, language: "zh" | "en" = "en") {
    signal.throwIfAborted();
    const source = { ...authority.source, signal, language },
      db = this.local.deps.db;
    const bot = new BotsRepo(db).get(source.botId),
      conversation = new ConversationsRepo(db).get(source.conversationId as string);
    if (!bot || bot.archivedAt || !conversation || conversation.archivedAt)
      throw new RpcError(-32602, "task_source_changed");
    if (source.groupId) {
      const group = new GroupsRepo(db).get(source.groupId);
      if (
        !group?.members.some((member) => member.botId === bot.id) ||
        groupAuthorization(this.local, source) !== source.groupAuthorization
      )
        throw new RpcError(-32602, "task_source_changed");
    } else if (
      conversation.kind !== "dm" ||
      conversation.botId !== bot.id ||
      JSON.stringify(topicWorkplaceSnapshot(this.local, source)) !==
        JSON.stringify(source.topicWorkplace)
    )
      throw new RpcError(-32602, "task_source_changed");
    for (const root of authority.workplace.boundary.roots) {
      const stat = lstatSync(root.path, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !samePathSpelling(canonicalExistingPathSync(root.path), root.canonicalPath) ||
        !matchesFileIdentity(stat, root)
      )
        throw new RpcError(-32602, "task_workplace_changed");
    }
  }
  async guard(context: ToolRunContext, signal: AbortSignal) {
    if (!this.hasAuthority(context)) return;
    this.guardSync(context);
    await resolveRunWorkplace(this.local, this.source(context), signal);
    this.guardSync(context);
  }
  settings(context: ToolRunContext, current: PermissionsSettings) {
    if (!this.hasAuthority(context)) return current;
    this.guardSync(context);
    return intersectTaskPermissions(this.record(context).authority.permissions, current);
  }
  mode(context: ToolRunContext): ExecutionMode {
    const { authority } = this.record(context);
    this.guardSync(context);
    return continuedMode(
      authority.mode,
      this.local.execution.get({
        botId: authority.source.botId,
        conversationId: authority.source.conversationId,
      }).mode,
    );
  }
  yolo(context: ToolRunContext) {
    this.guardSync(context);
    const { source } = this.record(context).authority;
    return new ConversationYoloRepo(this.local.deps.db).active(
      source.conversationId,
      source.groupId,
    );
  }
  async workplace(context: ToolRunContext, signal: AbortSignal) {
    await this.guard(context, signal);
    return this.record(context).authority.workplace;
  }
  async freeze(
    context: ToolRunContext,
    signal: AbortSignal,
    forcePlan: boolean,
  ): Promise<TaskAuthority> {
    if (context.routineRunId || context.routineSource)
      throw new RpcError(-32602, "task_scheduled_source_not_supported");
    const source = this.source(context);
    if (!source.conversationId || this.repo.isInternalConversation(source.conversationId))
      throw new RpcError(-32602, "task_source_unavailable");
    const groupSource = source.groupId ? groupAuthorization(this.local, source) : undefined;
    if (source.groupAuthorization !== undefined && groupSource !== source.groupAuthorization)
      throw new RpcError(-32602, "task_source_changed");
    if (!context.executionTaskId) {
      const run = new RunsRepo(this.local.deps.db).get(context.runId);
      if (
        run?.status !== "running" ||
        run.botId !== context.botId ||
        run.conversationId !== context.conversationId
      )
        throw new RpcError(-32602, "task_source_unavailable");
    }
    const workplace = await resolveRunWorkplace(this.local, source, signal);
    if (source.groupId && groupAuthorization(this.local, source) !== groupSource)
      throw new RpcError(-32602, "task_source_changed");
    if (this.hasAuthority(context)) this.guardSync(context);
    const selected = {
      botId: source.botId,
      conversationId: source.conversationId,
      runId: source.runId,
      messageId: source.messageId,
      ...(source.groupId
        ? { groupId: source.groupId, groupAuthorization: groupAuthorization(this.local, source) }
        : {}),
      ...(source.threadId ? { threadId: source.threadId } : {}),
      ...(source.taskId ? { taskId: source.taskId } : {}),
      ...(source.cycleId ? { cycleId: source.cycleId } : {}),
      ...(source.groupMemberWorktreeId
        ? { groupMemberWorktreeId: source.groupMemberWorktreeId }
        : {}),
      ...(!source.groupId ? { topicWorkplace: topicWorkplaceSnapshot(this.local, source) } : {}),
    };
    return {
      source: selected,
      workplace,
      permissions: this.settings(context, runPermissions(this.local, context)),
      mode:
        forcePlan ||
        (this.hasAuthority(context) ? this.mode(context) : this.local.execution.mode(context)) ===
          "plan"
          ? "plan"
          : "execute",
    };
  }
}
