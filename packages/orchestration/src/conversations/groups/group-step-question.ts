import type {
  ChatConfirmation,
  QueueInput,
  UserMessageDisplay,
} from "@pibot/brain/orchestration-kit";
import { abortable, restoreWorkflow, userMessageUsage } from "@pibot/brain/orchestration-kit";
import { RpcError, type Run, UserQuestionPauseSchema } from "@pibot/protocol-base";
import { MessagesRepo, RunRecoveryRepo, transaction } from "@pibot/storage";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import { stepExecution } from "./group-workflow-execution.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

/** A done model turn can still be waiting for input, not for handoff verification. */
export function pendingStepQuestion(service: GroupService, run: Run | undefined) {
  if (run?.status !== "done") return false;
  const usage = new MessagesRepo(service.deps.db).get(run.messageId)?.usage;
  const pause = UserQuestionPauseSchema.safeParse(
    usage && typeof usage === "object" && !Array.isArray(usage) ? usage.executionPause : undefined,
  );
  return pause.success && !pause.data.answer && !pause.data.sourceMessageId;
}

/** No main-topic send: the task, cycle, contract and cost ledger remain the step's own. */
export async function answerStepQuestion(
  service: GroupService,
  sourceMessageId: string,
  text: string,
  confirmation: ChatConfirmation,
  display: UserMessageDisplay,
) {
  const messages = new MessagesRepo(service.deps.db);
  const message = messages.get(sourceMessageId);
  const source = message?.runId ? service.runs.get(message.runId) : undefined;
  const step = source?.taskId ? service.workflows.repo.byTask(source.taskId) : undefined;
  if (!step || !source || !message) {
    // A replaced step must never fall through to ordinary send and create unrelated work.
    if (source?.taskId && service.handoffs.repo.get(source.taskId)?.spec.workflowStep)
      throw new RpcError(-32602, "question_changed");
    return false;
  }
  const signal = AbortSignal.any([confirmation.signal, service.signal]);
  // A requested replan waits for running steps; their questions must remain answerable meanwhile.
  const assertCurrent = () => {
    signal.throwIfAborted();
    const current = service.workflows.repo.byTask(source?.taskId ?? "");
    const plan = current && service.workflows.repo.get(current.workflowRunId);
    const task = source?.taskId ? service.tasks.get(source.taskId) : undefined;
    if (
      !source ||
      !message ||
      !current ||
      !plan ||
      !task ||
      service.workflows.closed ||
      service.changing(plan.groupId) ||
      !["running", "waiting"].includes(plan.status) ||
      current.status !== "running" ||
      progressOf(plan).stoppedReason ||
      source.messageId !== message.id ||
      source.botId !== current.ownerBotId ||
      source.kind !== "group_task" ||
      source.groupId !== plan.groupId ||
      source.cycleId !== plan.cycleId ||
      source.conversationId !== task.threadConversationId ||
      task.status !== "open" ||
      task.assigneeBotId !== source.botId ||
      task.groupId !== plan.groupId ||
      service.completion.blocks(task.id) ||
      service.cycles.get(plan.groupId).cycleId !== plan.cycleId ||
      service.cycles.get(plan.groupId).limited ||
      !plan.budgetRootRunId ||
      service.deps.local.tasks.budgetRoot(source) !== plan.budgetRootRunId ||
      stepExecution(service, plan, current)?.run?.id !== source.id ||
      !pendingStepQuestion(service, source)
    )
      throw new RpcError(-32602, "question_changed");
    service.active(plan.groupId, source.botId, source.conversationId);
    assertPlanWorkplace(service, plan.id);
    if (!service.deps.chat.queue.acceptingContinuations)
      throw new RpcError(-32011, "question_busy");
    service.deps.chat.queue.capacity([source.botId]);
    return { current, plan, task, budgetRootRunId: plan.budgetRootRunId };
  };
  assertCurrent();
  const { bot } = await service.model(source.botId, signal, undefined, {
    groupId: source.groupId,
    conversationId: source.conversationId,
    taskId: source.taskId,
  });
  const identity = new RunRecoveryRepo(service.deps.db).get(source.id)?.workflow;
  const workflow = identity
    ? await abortable(
        restoreWorkflow(service.deps.local.skills, bot.id, source.groupId ?? undefined, identity),
        signal,
      )
    : undefined;
  if (identity && !workflow) throw new RpcError(-32602, "question_unavailable");
  await confirmation.beforeCommit();
  const admitted = transaction(service.deps.db, () => {
    const { current, plan, task, budgetRootRunId } = assertCurrent();
    const input: QueueInput = {
      bot,
      conversationId: source.conversationId,
      groupId: plan.groupId,
      threadId: task.threadConversationId,
      taskId: task.id,
      cycleId: plan.cycleId,
      kind: "group_task",
      userInitiated: true,
      parentRunId: source.id,
      afterRunId: source.id,
      triggerKey: `question:${sourceMessageId}`,
      budgetRootRunId,
      budgetWorkflow: workflowOf(plan),
      enforceBudgetCost: true,
      ...(workflow ? { workflow } : {}),
      text: service.deps.redactor.redact(
        `${task.instructions}\n\n用户回答了本步骤的选择卡，请据此继续本步骤 / The user answered this step's question. Continue this step using the answer:\n${text}`,
      ),
    };
    // Card state and run binding commit together; an uncertain RPC response can be retried.
    confirmation.commit();
    const user = messages.create({
      conversationId: source.conversationId,
      role: "user",
      content: service.deps.redactor.redact(text),
      ...userMessageUsage(undefined, display),
      status: "done",
      markUnread: false,
    });
    input.userMessageId = user.id;
    const run = service.deps.chat.queue.insert(input);
    service.workflows.repo.updateStep(plan.id, current.stepId, { executionRunId: run.id });
    service.deps.local.approvals.audit.append({
      botId: bot.id,
      runId: run.id,
      kind: "execution.todo.changed",
      summary: "Plan step question answered / 计划步骤选择卡已回答",
      detail: {
        actor: "user",
        reasonCode: "step_question_answered",
        groupId: plan.groupId,
        workflowRunId: plan.id,
        taskId: task.id,
        target: sourceMessageId,
        childRunId: run.id,
      },
    });
    return { run, input, groupId: plan.groupId };
  });
  service.deps.chat.queue.publish(admitted.run, admitted.input);
  service.changed(admitted.groupId, "updated");
  return true;
}
