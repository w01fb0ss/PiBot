import {
  type KernelMethodParams,
  type KernelMethodResults,
  RpcError,
  RpcErrorCodes,
  type Run,
  recoverableChatRun,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationsRepo,
  GroupHandoffsRepo,
  MessagesRepo,
  RunEventsRepo,
  transaction,
} from "@pibot/storage";
import { inspectChatRecovery } from "../../conversations/chat/chat-recovery.ts";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import { continuationKey } from "../continuation/continuation-keys.ts";
import {
  groupTaskRetryPrompt,
  modelRetryPrompt,
  savedGoalPrompt,
} from "../continuation/continuation-prompts.ts";
import type { WorkflowRun } from "../workflows/workflow-prepare.ts";
import type { QueueInput } from "./run-queue.ts";

/**
 * What turns a retry into a resume of an interrupted run (`runs.resume`). Same guards and
 * receipts as a retry; the new run keeps the interrupted run's budget / journal root, carries the
 * trusted runtime note and, for a workflow run, the restored workflow.
 */
export interface ResumePlan {
  inserted?: (runId: string) => void;
  root: string;
  note: string;
  text: string;
  workflow?: WorkflowRun;
  /**
   * Raises the root's cost cap, inside the transaction that inserts the new run (so a
   * refused insert spends no raise). Undefined result: the ledger moved on, and the insert fails.
   */
  raise?: () => { costUsd: number; amountUsd: number; used: number } | undefined;
}

/** The queue fields a resume adds; the retry key kinds stay apart so a retry never blocks it. */
function resumeInput(plan: ResumePlan, failedRunId: string): Partial<QueueInput> {
  return {
    budgetRootRunId: plan.root,
    resume: { fromRunId: failedRunId, note: plan.note },
    ...(plan.workflow ? { workflow: plan.workflow } : {}),
  };
}

/**
 * Facts only: which run was resumed by which new run, and how many calls were in doubt. A budget
 * raise is applied here, in the insert transaction, and its amounts go on the same audit entry.
 */
function auditResume(
  service: GroupOrchestrationPort,
  plan: ResumePlan,
  failed: Run,
  record: Run,
  conversationId: string,
) {
  const raised = plan.raise?.();
  if (plan.raise && !raised) throw new RpcError(RpcErrorCodes.busy, "Recovery source changed");
  plan.inserted?.(record.id);
  service.deps.local.approvals.audit.append({
    botId: record.botId,
    runId: record.id,
    kind: "run.resumed",
    summary: "Interrupted run resumed / 继续被中断的运行",
    detail: {
      actor: "user",
      conversationId,
      target: failed.id,
      reasonCode: raised ? "budget_raised" : "user_resumed",
      entryCount: service.deps.local.toolJournal.repo.uncertainCount(failed.id),
      ...(raised
        ? { costUsd: raised.costUsd, amountUsd: raised.amountUsd, used: raised.used }
        : {}),
    },
  });
}

type DmRetryInput = Omit<Extract<KernelMethodParams["runs.retry"], { source: "dm" }>, "source">;
/**
 * The task already names its Bot and thread. They stay optional for the delegation from a private
 * retry of a task-thread run, and are cross-checked whenever they are given.
 */
type GroupRetryInput = Omit<
  Extract<KernelMethodParams["runs.retry"], { source: "group" }>,
  "source" | "botId" | "conversationId"
> & { botId?: string; conversationId?: string };

/**
 * The run every retry resumes: it must exist, belong to this Bot and conversation, and be terminal
 * in a way a continuation may resume. Callers pass their own refusal, because the two legacy
 * methods answered the same situation with different error codes and those must not change.
 */
export function eventBackedRun(
  service: GroupOrchestrationPort,
  failedRunId: string,
  botId: string,
  conversationId: string,
) {
  const state = new RunEventsRepo(service.deps.db).state(failedRunId);
  if (!state?.created || state.conversationId !== conversationId || !state.terminal)
    return undefined;
  const failed = service.runs.get(failedRunId);
  if (
    !failed ||
    failed.botId !== botId ||
    failed.conversationId !== conversationId ||
    failed.status !== state.terminal.status ||
    (failed.stopReason ?? null) !== state.terminal.stopReason ||
    (failed.errorCode ?? null) !== state.terminal.errorCode
  )
    return undefined;
  return failed;
}

function retryableRun(
  service: GroupOrchestrationPort,
  failedRunId: string,
  botId: string,
  conversationId: string,
  refuse: () => RpcError,
) {
  const failed = eventBackedRun(service, failedRunId, botId, conversationId);
  if (!failed || !recoverableChatRun(failed)) throw refuse();
  return failed;
}

/** An archived Bot gets no new run; both sources refused this deeper in their own checks before. */
function liveBot(service: GroupOrchestrationPort, botId: string) {
  const bot = new BotsRepo(service.deps.db).get(botId);
  if (!bot || bot.archivedAt)
    throw new RpcError(RpcErrorCodes.invalidParams, "retry_bot_unavailable");
}

/**
 * One retry inserts at most one run per trigger key: another window can retry while credentials are
 * being resolved and must receive the same receipt instead of a duplicate run. `check` runs again
 * inside the transaction so a change during that await is still refused.
 */
function insertRetry<T>(
  service: GroupOrchestrationPort,
  key: string,
  check: () => T,
  build: (state: T) => QueueInput,
  inserted?: (state: T, record: Run) => void,
): { record: Run; input?: QueueInput } {
  return transaction(service.deps.db, () => {
    const duplicate = service.runs.trigger(key);
    if (duplicate) return { record: duplicate };
    const state = check();
    const input = build(state);
    const record = service.deps.chat.queue.insert(input);
    inserted?.(state, record);
    return { input, record };
  });
}

/**
 * Retry of one assigned task. Kept as its own entry point because a private retry of a task-thread
 * run delegates here, so the stronger task/cycle guards apply either way.
 */
export async function retryGroupTaskRun(
  service: GroupOrchestrationPort,
  params: GroupRetryInput,
  resume?: ResumePlan,
): Promise<{ runId: string; threadId: string }> {
  const { groupId, taskId, failedRunId } = params;
  const validate = () => {
    const task = service.tasks.get(taskId);
    if (
      !task ||
      task.groupId !== groupId ||
      (params.botId && params.botId !== task.assigneeBotId) ||
      (params.conversationId && params.conversationId !== task.threadConversationId)
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "group_task_missing");
    liveBot(service, task.assigneeBotId);
    const group = service.active(groupId, task.assigneeBotId, task.threadConversationId);
    const failed = retryableRun(
      service,
      failedRunId,
      task.assigneeBotId,
      task.threadConversationId,
      () => new RpcError(RpcErrorCodes.invalidParams, "group_task_failure_stale"),
    );
    if (failed.groupId !== groupId || failed.taskId !== taskId)
      throw new RpcError(RpcErrorCodes.invalidParams, "group_task_failure_stale");
    return { task, group, failed };
  };
  const initial = validate();
  const expectedCycle = service.cycles.get(groupId).cycleId;
  // A retry resumes the failed run's chain, so its dedupe key hangs off that chain's root.
  const key = continuationKey(
    resume ? "group-task-resume" : "group-task-retry",
    service.deps.local.tasks.budgetRoot(initial.failed),
    failedRunId,
  );
  const existing = service.runs.trigger(key);
  if (existing) return { runId: existing.id, threadId: initial.task.threadConversationId };
  const check = () => {
    const state = validate();
    if (
      state.task.status !== "open" ||
      state.group.paused ||
      service.changing(groupId) ||
      service.cycles.get(groupId).cycleId !== expectedCycle ||
      (state.task.activity?.failure?.runId !== failedRunId &&
        !(
          (state.failed.status === "aborted" ||
            (state.failed.status === "done" && state.failed.stopReason === "length")) &&
          state.failed.cycleId === expectedCycle &&
          !service.runs.hasRunAfter(failedRunId)
        )) ||
      service.tasks.hasPendingChildren(taskId) ||
      service.deps.chat.topicBusy(state.task.assigneeBotId, state.task.threadConversationId)
    )
      throw new RpcError(RpcErrorCodes.busy, "group_task_failure_stale");
    return state;
  };
  check();
  // The group path deliberately does not follow the brain's shutdown signal; a retry that started
  // only has its own deadline.
  const signal = AbortSignal.timeout(25_000);
  const { bot } = await service.model(initial.task.assigneeBotId, signal, params, {
    groupId,
    taskId,
    conversationId: initial.task.threadConversationId,
  });
  signal.throwIfAborted();
  const result = insertRetry(
    service,
    key,
    check,
    (state) => {
      const cycleId = service.cycles.get(groupId).cycleId ?? service.cycles.reset(groupId);
      service.cycles.continueTask(taskId, cycleId);
      // The retry has its own session. Recover the brief and check facts, not the old transcript.
      const failedChecks = new GroupHandoffsRepo(service.deps.db)
        .get(taskId)
        ?.result?.items.filter((item) => item.status === "fail")
        .map(({ id, check, deliverable, reason }) => ({ id, check, path: deliverable, reason }));
      const text = service.deps.redactor.redact(
        [
          resume ? resume.text : groupTaskRetryPrompt(),
          `原步骤说明 / Original step brief:\n${state.task.instructions}`,
          state.failed.errorCode ? `上次错误码 / Previous error: ${state.failed.errorCode}` : "",
          failedChecks?.length
            ? `未通过检查 / Failed checks:\n${JSON.stringify(failedChecks)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      return {
        bot,
        conversationId: state.task.threadConversationId,
        groupId,
        threadId: state.task.threadConversationId,
        taskId,
        kind: "group_task",
        cycleId,
        parentRunId: state.failed.parentRunId ?? undefined,
        ancestry: state.failed.ancestry,
        // A person asked for this run, so it never draws on the automatic round budget.
        userInitiated: true,
        triggerKey: key,
        text,
        ...service.planStepRetryInput?.(state.failed.id),
        ...(resume ? resumeInput(resume, failedRunId) : {}),
      };
    },
    (state, record) => {
      if (resume)
        auditResume(service, resume, state.failed, record, state.task.threadConversationId);
      service.planStepRetried?.(state.failed.id, record.id);
    },
  );
  if (result.input) {
    service.deps.chat.queue.publish(result.record, result.input);
    service.taskChanged(service.tasks.get(taskId) ?? initial.task);
    service.deps.logger.info(
      JSON.stringify({
        module: "group",
        event: resume ? "task_resume" : "task_retry",
        audit: true,
        groupId,
        taskId,
        failedRunId,
        runId: result.record.id,
        provider: bot.modelProvider,
        model: bot.modelId,
      }),
    );
  }
  return { runId: result.record.id, threadId: initial.task.threadConversationId };
}

/** Retry of one private-chat run, optionally with a model the user picked for this attempt. */
export async function retryDmRun(
  service: GroupOrchestrationPort,
  params: DmRetryInput,
  resume?: ResumePlan,
): Promise<KernelMethodResults["runs.retry"]> {
  const { failedRunId, conversationId, botId } = params;
  const conversations = new ConversationsRepo(service.deps.db);
  const validate = () => {
    const failed = retryableRun(
      service,
      failedRunId,
      botId,
      conversationId,
      () => new RpcError(RpcErrorCodes.invalidParams, "Recovery source unavailable"),
    );
    liveBot(service, botId);
    const conversation = conversations.get(conversationId);
    const message = new MessagesRepo(service.deps.db).get(failed.messageId);
    if (
      !conversation ||
      conversation.archivedAt ||
      conversations.isInternal(conversationId) ||
      !message ||
      message.runId !== failed.id ||
      message.botId !== botId ||
      message.conversationId !== conversationId
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "Recovery source unavailable");
    if (failed.groupId) {
      const group = service.active(failed.groupId, botId, conversationId);
      if (group.paused || service.changing(group.id))
        throw new RpcError(RpcErrorCodes.busy, "Group unavailable");
    } else if (conversation.kind !== "dm" || conversation.botId !== botId || failed.kind !== "chat")
      throw new RpcError(RpcErrorCodes.invalidParams, "Invalid recovery conversation");
    return failed;
  };
  const initial = validate();
  // Same key shape as the group retry: the failed run's chain root plus the run being retried.
  const key = continuationKey(
    resume ? "chat-resume" : "chat-model-recovery",
    service.deps.local.tasks.budgetRoot(initial),
    failedRunId,
  );
  // A second click returns the first receipt; the recovery view below already counts the run it
  // started as "busy" or "newer", and only knows the retry key.
  const existing = service.runs.trigger(key);
  if (existing) return { runId: existing.id };
  const recovery = await inspectChatRecovery(service, {
    botId,
    conversationId,
    runId: failedRunId,
  });
  if (!["ready", "already_requested"].includes(recovery.continuation))
    throw new RpcError(RpcErrorCodes.busy, "Recovery source changed");
  // Assigned task threads already have stronger task/cycle guards and their own duplicate receipt.
  if (
    initial.groupId &&
    initial.taskId &&
    service.tasks.get(initial.taskId)?.threadConversationId === conversationId
  ) {
    const result = await retryGroupTaskRun(
      service,
      {
        groupId: initial.groupId,
        taskId: initial.taskId,
        failedRunId,
        model: params.model,
        thinkingLevel: params.thinkingLevel,
      },
      resume,
    );
    return { runId: result.runId };
  }
  const expectedCycle = initial.groupId ? service.cycles.get(initial.groupId).cycleId : undefined;
  if (initial.groupId && expectedCycle !== initial.cycleId)
    throw new RpcError(RpcErrorCodes.busy, "Recovery cycle changed");
  const check = () => {
    const failed = validate();
    if (
      service.runs.hasRunAfter(failedRunId) ||
      service.deps.chat.topicBusy(botId, conversationId) ||
      (failed.groupId && service.cycles.get(failed.groupId).cycleId !== expectedCycle)
    )
      throw new RpcError(RpcErrorCodes.busy, "Recovery source changed");
    if (failed.taskId && service.tasks.get(failed.taskId)?.status !== "open")
      throw new RpcError(RpcErrorCodes.busy, "Task no longer open");
    return failed;
  };
  check();
  const signal = AbortSignal.any([service.signal, AbortSignal.timeout(25_000)]);
  const { bot } = await service.model(botId, signal, params, {
    conversationId,
    groupId: initial.groupId,
    taskId: initial.taskId,
  });
  signal.throwIfAborted();
  const savedGoal =
    recovery.session.state === "missing" && initial.userMessageId
      ? new MessagesRepo(service.deps.db).get(initial.userMessageId)
      : undefined;
  const goalContext =
    savedGoal?.role === "user" &&
    savedGoal.conversationId === conversationId &&
    savedGoal.content.length <= 16_000
      ? savedGoalPrompt(service.deps.redactor.redact(savedGoal.content))
      : "";
  const result = insertRetry(
    service,
    key,
    check,
    (failed) => {
      const cycleId = failed.groupId
        ? (expectedCycle ?? service.cycles.reset(failed.groupId))
        : undefined;
      if (cycleId && failed.taskId) service.cycles.continueTask(failed.taskId, cycleId);
      return {
        bot,
        conversationId,
        userInitiated: true,
        triggerKey: key,
        ...(failed.groupId ? { groupId: failed.groupId, cycleId } : {}),
        ...(failed.taskId ? { taskId: failed.taskId } : {}),
        kind: failed.kind,
        ...(failed.parentRunId ? { parentRunId: failed.parentRunId } : {}),
        ancestry: failed.ancestry,
        text: resume ? resume.text : modelRetryPrompt(goalContext),
        ...(resume ? resumeInput(resume, failedRunId) : {}),
      };
    },
    resume
      ? (failed, record) => auditResume(service, resume, failed, record, conversationId)
      : undefined,
  );
  if (result.input) {
    service.deps.chat.queue.publish(result.record, result.input);
    if (initial.groupId) service.changed(initial.groupId, "updated");
    service.deps.logger.info(
      JSON.stringify({
        module: "chat",
        event: resume ? "run_resume" : "model_recovery",
        audit: true,
        botId,
        conversationId,
        failedRunId,
        runId: result.record.id,
      }),
    );
  }
  return { runId: result.record.id };
}

/**
 * The single retry entry: pick the source, then let it own its own guards and error codes.
 * Every manual retry is user-initiated and never draws on the root's 32 automatic rounds.
 */
export async function retryRun(
  service: GroupOrchestrationPort,
  params: KernelMethodParams["runs.retry"],
): Promise<KernelMethodResults["runs.retry"]> {
  if (params.source === "subtask") {
    if (!eventBackedRun(service, params.failedRunId, params.botId, params.conversationId))
      throw new RpcError(RpcErrorCodes.invalidParams, "task_version_changed");
    return retrySubtask(service, params);
  }
  if (params.source === "group") return retryGroupTaskRun(service, params);
  return retryDmRun(service, params);
}

/**
 * Q-B: an interrupted subtask resumes through the task service, which re-verifies the frozen
 * source and side-effect confirmation exactly as the former `execution.tasks.resume` did. The run
 * named by the caller must still be the task's run, so a stale view cannot resume a newer attempt.
 */
async function retrySubtask(
  service: GroupOrchestrationPort,
  params: Extract<KernelMethodParams["runs.retry"], { source: "subtask" }>,
): Promise<KernelMethodResults["runs.retry"]> {
  const tasks = service.deps.local.tasks;
  if (tasks.tasks.get(params.taskId)?.runId !== params.failedRunId)
    throw new RpcError(RpcErrorCodes.invalidParams, "task_version_changed");
  const task = await tasks.resume(
    { botId: params.botId, conversationId: params.conversationId },
    params.taskId,
    params.expectedVersion,
    params.verifiedSideEffects ?? false,
    AbortSignal.any([service.deps.local.shutdown.signal, AbortSignal.timeout(20_000)]),
  );
  if (!task.runId) throw new RpcError(RpcErrorCodes.internal, "task_resume_without_run");
  return { runId: task.runId };
}
