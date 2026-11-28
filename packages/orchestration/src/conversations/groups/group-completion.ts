import { toolEffectClass } from "@pibot/agent";
import type { ToolRunContext } from "@pibot/brain/orchestration-kit";
import {
  auditText,
  collaborationAuditFields,
  GroupToolError,
} from "@pibot/brain/orchestration-kit";
import {
  type GroupTask,
  IdSchema,
  type KernelMethodParams,
  RpcError,
  type Run,
} from "@pibot/protocol-base";
import { BotsRepo, ExecutionRepo, MessagesRepo, transaction } from "@pibot/storage";
import { z } from "zod";
import { annotateResearchResult } from "./group-reply-citations.ts";
import type { GroupService } from "./group-service.ts";
import { staleTaskTarget, taskTarget } from "./group-task-targets.ts";

const StaleTaskCloseSchema = z.strictObject({
  groupId: IdSchema,
  taskId: IdSchema,
  summary: z.string().min(1).max(4000),
});

interface CompletionActor {
  botId: string;
  runId?: string;
  user?: boolean;
  automatic?: boolean;
  sourceMessageId?: string;
  replaceContent?: boolean;
  resultText?: string;
  attachmentSourceMessageId?: string;
  /** Health-repair stale-task cleanup: allows archived members and non-current group topics. */
  staleCleanup?: boolean;
}

/**
 * Bookkeeping keeps the member's own plan and memory tidy without producing an
 * artifact, running a command or sending anything, so a reply that only used these is still plain
 * talk. The user's own to-do list is not in here: an entry written there is what the user asked
 * for, so it stays work. `tool-effects.ts` cannot answer this: it classifies `todo_pause` and
 * `memory_*` as local effects because a replay must not repeat them, which is a different
 * question from whether the turn did work.
 */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  "todo_list",
  "todo_update",
  "todo_pause",
  "memory_add",
  "memory_update",
  "memory_remove",
]);

/** Task state, delivery reference, completion source and audit commit before notifications. */
export class GroupCompletion {
  private readonly closing = new Map<string, string>();
  private readonly requests = new Set<Promise<GroupTask>>();
  constructor(private readonly service: GroupService) {}
  changing(groupId: string) {
    return [...this.closing.values()].includes(groupId);
  }
  blocks(taskId: string | null) {
    return !!taskId && this.closing.has(taskId);
  }
  assertStepRun(context: ToolRunContext, task: GroupTask) {
    if (
      task.assigneeBotId !== context.botId ||
      !this.service.handoffs.repo.get(task.id)?.spec.workflowStep
    )
      return;
    const run = this.service.runs.get(context.runId);
    // A coordinator's planning wake can overlap its newly dispatched step; Bot identity alone
    // must not let that wake consume the step's completion or publish its planning reply as output.
    if (run?.taskId !== task.id || run.kind === "wake")
      throw new GroupToolError(
        "finish_step_run_required: 只能在执行该步骤任务的运行里完成它；当前是唤醒、规划或其他任务的运行。请结束本轮，让步骤运行交付，不要重试 finish_task / Complete a step only from the run executing that task. This is a wake, planning or another task's run. End this turn and let the step run deliver; do not retry finish_task.",
      );
  }
  completeRun(
    context: ToolRunContext,
    finalText: string,
    stopReason: string,
    calledTools?: readonly string[],
  ) {
    if (!context.groupId || stopReason !== "stop") return;
    const { service } = this;
    const run = service.runs.get(context.runId);
    // Admission binds task replies to a task. Taskless planning/wake runs must never adopt work
    // dispatched while they were running, even when the coordinator is also its assignee.
    if (
      !run?.taskId ||
      run.status !== "done" ||
      run.stopReason !== "stop" ||
      (context.taskId && context.taskId !== run.taskId)
    )
      return;
    const task = service.tasks.get(run.taskId);
    if (
      context.todoRun?.paused?.question &&
      service.handoffs.repo.get(run.taskId)?.spec.workflowStep
    )
      return;
    if (
      task?.status !== "open" ||
      task.groupId !== context.groupId ||
      task.assigneeBotId !== context.botId ||
      (run.kind === "wake" && service.handoffs.repo.get(task.id)?.spec.workflowStep) ||
      (context.threadId && context.threadId !== task.threadConversationId) ||
      this.blocks(task.id)
    )
      return;
    const calls = service.deps.local.tools.forMessages([context.messageId]).get(context.messageId);
    // A refused, failed or stopped finish_task finished nothing; counting it left the step blocked
    // when the member ended its turn after the refusal. The model's call list includes
    // refused calls, so it is only a fallback when no tool records exist.
    const finishAttempted = calls
      ? calls.some(
          (call) =>
            call.tool === "finish_task" && !["blocked", "error", "aborted"].includes(call.status),
        )
      : calledTools?.includes("finish_task");
    if (
      finishAttempted ||
      service.deps.local.approvals.repo.blocksTaskCompletion(context.runId) ||
      service.deps.local.tasks.hasPendingChildren(context) ||
      service.tasks.hasPendingChildren(task.id) ||
      service.deps.chat.queue.pendingTaskReplies(task.id, context.runId)
    )
      return;
    // A reply that only answered closes its direct task quietly instead of showing progress.
    if (this.chattedOnly(context, task, run, calledTools)) return;
    const completed = this.complete(
      context,
      handBackSummary(finalText) ?? this.completedSummary(task, context.language),
      task.id,
      "done",
      undefined,
      finalText,
    );
    return () => {
      completed.notify();
    };
  }
  /**
   * A member that only answered a direct request did no work, so its task closes quietly and
   * the group shows no task progress for plain talk. A thread supplement continues an existing
   * task, an assignment or plan step is work, and a run that did not end cleanly never gets here.
   */
  private chattedOnly(
    context: ToolRunContext,
    task: GroupTask,
    run: Run,
    calledTools?: readonly string[],
  ): boolean {
    const { service } = this;
    if (context.threadId || task.source?.kind !== "user") return false;
    // A wake only relays a child's completion or the final summary; it is bookkeeping, not the
    // member answering, and closing here hid the parent task while its assignments still ran.
    if (run.kind === "wake") return false;
    // Dispatched work is in flight, so the parent has to stay visible until it lands.
    if (service.tasks.hasPendingChildren(task.id)) return false;
    // A question the user still has to answer must stay reachable.
    if (context.todoRun?.paused?.question) return false;
    // Admission already established that this run replies for the assignee, which also owns the plan.
    const botId = task.assigneeBotId;
    const plan = new ExecutionRepo(service.deps.db).todo({
      botId,
      conversationId: run.conversationId,
    });
    // Starting a plan or replacing its goal is work; advancing the inherited plan is not.
    if (plan.goal && plan.goal !== (context.planAtStart?.goal ?? "")) return false;
    // The effect table decides, minus the bookkeeping above: only reads leave both this machine
    // and the plan untouched.
    if (
      (calledTools ?? []).some(
        (tool) => !BOOKKEEPING_TOOLS.has(tool) && toolEffectClass(tool, {}) !== "read",
      )
    )
      return false;
    // The close, the quiet mark on the reply and the audit commit together: a task closed without
    // its reply marked still shows "执行已暂停", and an audited close that never happened misleads
    // later investigation.
    const quiet = transaction(service.deps.db, () => {
      const closed = service.tasks.closeQuiet(task.id, botId);
      if (!closed) return undefined;
      new MessagesRepo(service.deps.db).markQuietChat(run.id, context.messageId);
      service.deps.local.approvals.audit.append({
        botId,
        runId: run.id,
        kind: "group.task.quiet",
        summary: "Group chat reply closed its task quietly / 普通对话未产生任务进展",
        detail: {
          reasonCode: "quiet_chat",
          groupId: closed.groupId,
          taskId: closed.id,
          targetBotId: closed.assigneeBotId,
        },
      });
      return closed;
    });
    if (!quiet) return false;
    service.taskChanged(quiet);
    return true;
  }
  complete(
    context: ToolRunContext,
    summary: string,
    taskId?: string,
    status: "done" | "cancelled" = "done",
    resultMessageId?: string,
    finalText?: string,
  ) {
    context.signal.throwIfAborted();
    const { service } = this;
    const group = service.active(context.groupId as string, context.botId, context.conversationId);
    const task = taskTarget(service, group, context.botId, taskId);
    if (status === "done") this.assertStepRun(context, task);
    if (status === "done" && service.tasks.hasPendingChildren(task.id))
      throw new GroupToolError(
        "成员任务或执行子任务仍在进行，请等待成果后再完成父任务 / Member assignments or execution subtasks are still active. Wait for their results before completing the parent task.",
      );
    const run = service.runs.get(context.runId);
    if (
      !run ||
      run.botId !== context.botId ||
      run.groupId !== group.id ||
      run.messageId !== context.messageId ||
      run.conversationId !== context.conversationId ||
      (run.status !== "running" && run.status !== "done")
    )
      throw new RpcError(-32602, "Wrong task completion identity");
    if (status === "cancelled" && context.botId !== group.coordinatorBotId)
      throw new GroupToolError(
        "只有本群统筹可以取消任务 / Only this group's coordinator may cancel a task.",
      );
    const message = new MessagesRepo(service.deps.db).get(context.messageId);
    const memberResult = status === "done" && context.botId === task.assigneeBotId;
    // Selecting another own task does not make this thread's reply belong to that task.
    const currentReplyApplies =
      (!context.threadId && run.conversationId === group.conversationId) ||
      (run.taskId === task.id &&
        run.conversationId === task.threadConversationId &&
        context.threadId === task.threadConversationId);
    const currentReply = currentReplyApplies
      ? [finalText, context.assistantReply].find((text) => text?.trim())
      : undefined;
    const storedReply =
      memberResult && !currentReply
        ? new MessagesRepo(service.deps.db).taskReplySource(task.id)
        : undefined;
    const resultText = memberResult
      ? this.resultText(
          currentReply ?? storedReply?.text,
          summary.trim() ? summary : this.completedSummary(task, context.language),
        )
      : undefined;
    const attachmentSourceMessageId =
      memberResult && !resultMessageId
        ? currentReply
          ? context.messageId
          : (storedReply?.messageId ?? (currentReplyApplies ? context.messageId : undefined))
        : undefined;
    const reuseCurrent =
      context.botId === task.assigneeBotId &&
      context.conversationId === group.conversationId &&
      // A fallback thread reply must carry its own attachments, not the current group's files.
      attachmentSourceMessageId === context.messageId &&
      (!message?.taskResult || message.taskResult.taskId === task.id) &&
      !resultMessageId;
    return this.settle(task, summary, status, {
      botId: context.botId,
      runId: run.id,
      // The run state distinguishes automatic delivery from a model's explicit completion.
      automatic: run.status === "done",
      sourceMessageId: resultMessageId ?? (reuseCurrent ? context.messageId : undefined),
      replaceContent: reuseCurrent,
      resultText,
      attachmentSourceMessageId,
    });
  }
  private completedSummary(task: GroupTask, language: "zh" | "en") {
    return language === "zh" ? `完成了「${task.title}」` : `Completed “${task.title}”`;
  }
  private resultText(reply: string | undefined, fallback: string) {
    return this.service.deps.redactor
      .redact(reply?.trim() ? reply : fallback)
      .slice(0, 16_000)
      .replace(/[\uD800-\uDBFF]$/u, "");
  }
  resolve(params: KernelMethodParams["groups.tasks.resolve"]) {
    const pending = this.resolveNow(params);
    this.requests.add(pending);
    void pending
      .finally(() => this.requests.delete(pending))
      .catch(() => {
        // The RPC wrapper owns the rejection; shutdown only waits for accepted operations.
      });
    return pending;
  }
  closeStale(params: { groupId: string; taskId: string; summary: string }) {
    const pending = this.closeStaleNow(params);
    this.requests.add(pending);
    void pending
      .finally(() => this.requests.delete(pending))
      .catch(() => {
        // The repair caller owns the rejection; shutdown only waits for accepted operations.
      });
    return pending;
  }
  async stop() {
    await Promise.allSettled([...this.requests]);
  }
  private async closeStaleNow(raw: { groupId: string; taskId: string; summary: string }) {
    const params = StaleTaskCloseSchema.parse(raw);
    const group = this.service.active(params.groupId, undefined, undefined, true);
    const task = staleTaskTarget(this.service, group, params.taskId);
    await this.drain(task);
    try {
      const result = this.settle(task, params.summary, "cancelled", {
        botId: task.assigneeBotId,
        user: true,
        staleCleanup: true,
      });
      result.notify();
      return result.task;
    } finally {
      this.release(task.id);
    }
  }
  private async resolveNow(params: KernelMethodParams["groups.tasks.resolve"]) {
    const group = this.service.active(params.groupId);
    const task = taskTarget(this.service, group, group.coordinatorBotId, params.taskId);
    if (task.status !== "open") return task;
    if (params.status === "done" && this.service.tasks.hasPendingChildren(task.id))
      throw new GroupToolError(
        "子任务仍在进行，请等待后再完成父任务 / Subtasks are still active. Wait before completing the parent task.",
      );
    if (params.resultMessageId) this.validateResult(task, params.resultMessageId);
    await this.drain(task);
    try {
      const result = this.settle(task, params.summary, params.status, {
        botId: task.assigneeBotId,
        user: true,
        sourceMessageId: params.resultMessageId,
      });
      if (params.status === "done") this.service.handoffs.userResolved(task.id);
      result.notify();
      return result.task;
    } finally {
      this.release(task.id);
    }
  }
  async drain(task: GroupTask) {
    if (this.service.changing(task.groupId) || this.closing.has(task.id))
      throw new RpcError(-32011, "Task busy");
    this.closing.set(task.id, task.groupId);
    try {
      const preparing = this.service.cancelTaskSends(task);
      try {
        await this.service.deps.chat.queue.cancel(
          (r) =>
            r.taskId === task.id ||
            (r.groupId === task.groupId &&
              r.botId === task.assigneeBotId &&
              r.conversationId === task.threadConversationId),
          "aborted",
        );
      } finally {
        await preparing;
      }
    } catch (error) {
      this.release(task.id);
      throw error;
    }
  }
  release(taskId: string) {
    this.closing.delete(taskId);
    this.service.deps.chat.queue.resume();
    this.service.wakes.schedule();
  }
  /** Whether `messageId` is a reply this task's member delivered in the group. */
  isResult(task: GroupTask, messageId: string, replaceContent = false) {
    const message = new MessagesRepo(this.service.deps.db).get(messageId);
    const group = this.service.active(task.groupId);
    return !(
      !message ||
      message.conversationId !== group.conversationId ||
      message.botId !== task.assigneeBotId ||
      message.role !== "assistant" ||
      (message.status !== "done" && !(replaceContent && message.status === "streaming"))
    );
  }
  validateResult(task: GroupTask, messageId: string, replaceContent = false) {
    if (!this.isResult(task, messageId, replaceContent))
      throw new GroupToolError(
        "请选择该成员已在本群发出的回复 / Select a reply delivered by this member in this group.",
      );
  }
  private settle(
    task: GroupTask,
    summary: string,
    status: "done" | "cancelled",
    actor: CompletionActor,
  ) {
    const { service } = this;
    const committed = transaction(service.deps.db, () => {
      const group = service.active(task.groupId, undefined, undefined, !!actor.staleCleanup);
      const current = actor.staleCleanup
        ? staleTaskTarget(service, group, task.id)
        : service.tasks.get(task.id);
      if (!current || current.groupId !== task.groupId)
        throw new GroupToolError("这个群里没有该任务 / The task is not in this group.");
      if (current.status !== "open") return { task: current, created: false };
      if (status === "done" && service.tasks.hasPendingChildren(current.id))
        throw new GroupToolError(
          "子任务仍在进行，请等待后再完成父任务 / Subtasks are still active. Wait before completing the parent task.",
        );
      if (actor.sourceMessageId)
        this.validateResult(task, actor.sourceMessageId, actor.replaceContent);
      const completed = service.tasks.finish(current.id, current.assigneeBotId, status, summary);
      if (status === "done") {
        const origin = service.cycles.origin(task.id);
        const runId = actor.runId ?? origin?.sourceRunId;
        if (runId) service.cycles.recordFinish(task.id, runId);
        const published = new MessagesRepo(service.deps.db).publishTaskResult(
          task.id,
          actor.sourceMessageId,
          actor.replaceContent,
          actor.resultText,
          actor.attachmentSourceMessageId ?? null,
        );
        annotateResearchResult(service, published, runId, task.id);
      }
      service.deps.local.approvals.audit.append({
        botId: actor.botId,
        runId: actor.runId,
        kind: "collaboration.completed",
        summary:
          status === "done"
            ? "Group task completed / 群任务已完成"
            : "Group task cancelled / 群任务已取消",
        detail: {
          ...collaborationAuditFields({
            action: status === "done" ? "complete" : "cancel",
            botName: new BotsRepo(service.deps.db).get(actor.botId)?.name,
            targetBotName: new BotsRepo(service.deps.db).get(task.assigneeBotId)?.name,
            taskTitle: current.title,
            actor: actor.user ? "user" : actor.automatic ? "system" : "automatic",
            botRole: actor.botId === group.coordinatorBotId ? "coordinator" : "assignee",
            redactor: service.deps.redactor,
          }),
          groupId: task.groupId,
          taskId: task.id,
          targetBotId: task.assigneeBotId,
          taskSummary: auditText(completed.summary ?? "", service.deps.redactor) || undefined,
        },
      });
      return { task: completed, created: true };
    });
    let published = false;
    return {
      task: committed.task,
      notify: (): { runId?: string; reason?: string } => {
        if (published) return {};
        published = true;
        if (committed.created) {
          try {
            service.taskChanged(committed.task);
          } catch {
            service.deps.logger.warn(
              JSON.stringify({
                module: "group",
                event: "completion-notification-deferred",
                botId: actor.botId,
                runId: actor.runId,
                taskId: task.id,
              }),
            );
          }
        }
        if (committed.task.status !== "done") return {};
        try {
          return service.wakes.enqueue(task.id);
        } catch {
          service.deps.logger.warn(
            JSON.stringify({
              module: "group",
              event: "completion-wake-deferred",
              botId: actor.botId,
              runId: actor.runId,
              taskId: task.id,
            }),
          );
          return { reason: "deferred" };
        } finally {
          service.wakes.schedule();
        }
      },
    };
  }
}

/** External agents may provide a bounded structured hand-back for later plan steps. */
function handBackSummary(text: string | undefined) {
  if (!text) return undefined;
  const match = text.match(/(?:^|\n)#{2,3}\s*(?:交回|Hand-back)\s*\n([\s\S]*)/i);
  return match?.[1]?.trim().slice(0, 3000) || undefined;
}
