import type { QueueInput, ToolRunContext } from "@pibot/brain/orchestration-kit";
import {
  GroupPlanLimitSchema,
  type KernelMethodParams,
  RpcError,
  UserQuestionPauseSchema,
} from "@pibot/protocol-base";
import { BotsRepo, MessagesRepo, transaction } from "@pibot/storage";
import { waitPlanLimitSource } from "./group-plan-limit-wait.ts";
import type { GroupService } from "./group-service.ts";
import { progressOf } from "./group-workflow-progress.ts";

/** An explicit user answer atomically releases one gate and admits at most one continuation. */
export async function resolvePlanLimit(
  service: GroupService,
  messageId: string,
  reply: KernelMethodParams["execution.question.answer"]["reply"],
  signal: AbortSignal,
  answering: Set<string>,
  audit: (context: Pick<ToolRunContext, "botId" | "runId" | "groupId">, reasonCode: string) => void,
): Promise<boolean> {
  const messages = new MessagesRepo(service.deps.db);
  const message = messages.get(messageId);
  const usage = message?.usage;
  if (
    !message ||
    !usage ||
    typeof usage !== "object" ||
    Array.isArray(usage) ||
    !usage.groupPlanLimit
  )
    return false;
  if (answering.has(messageId)) throw new RpcError(-32011, "question_busy");
  answering.add(messageId);
  try {
    const metadata = GroupPlanLimitSchema.parse(usage.groupPlanLimit);
    const group = service.active(
      metadata.groupId,
      message.botId ?? undefined,
      message.conversationId,
    );
    const state = service.plans.repo.attemptState(group.id, metadata.cycleId);
    const pause = UserQuestionPauseSchema.parse(usage.executionPause);
    if (!("optionId" in reply) || !["extend", "solo", "end"].includes(reply.optionId))
      throw new RpcError(-32602, "question_unavailable");
    if (state?.messageId === messageId && pause.answer?.optionId === reply.optionId) {
      if (reply.optionId === "end") await finishPlanLimit(service, group.id, state.cycleId, "end");
      return true;
    }
    if (
      !state ||
      state.messageId !== messageId ||
      state.status !== "waiting" ||
      pause.answer ||
      service.cycles.get(group.id).cycleId !== state.cycleId
    )
      throw new RpcError(-32602, "question_changed");
    const source = await waitPlanLimitSource(service, state.sourceRunId, signal);
    if (source.groupId !== group.id || source.cycleId !== state.cycleId)
      throw new RpcError(-32602, "question_changed");
    const option = pause.question.options.find((option) => option.id === reply.optionId);
    if (!option) throw new RpcError(-32602, "question_unavailable");
    const bot = new BotsRepo(service.deps.db).get(source.botId);
    if (!bot || bot.archivedAt || group.coordinatorBotId !== bot.id)
      throw new RpcError(-32602, "question_unavailable");
    const budgetRootRunId = service.deps.local.tasks.budgetRoot(source);
    const controller = AbortSignal.any([signal, service.signal, AbortSignal.timeout(30_000)]);
    if (reply.optionId !== "end") {
      service.deps.chat.queue.capacity([bot.id]);
      const ledger = service.deps.local.budgets.repo.get(budgetRootRunId);
      if (!ledger || service.deps.local.budgets.repo.reason(ledger))
        throw new RpcError(-32602, "group_plan_budget_unavailable");
      await service.model(bot.id, controller, undefined, {
        groupId: group.id,
        conversationId: source.conversationId,
      });
    }
    // The answer itself never becomes a group message on this path (the choice is stored in the
    // card's pause), so the continuation prompt has to carry it; otherwise the coordinator's next
    // turn only sees a generic instruction and reports that the card was never answered.
    const answered = `用户对上一张选择卡选择了「${option.label}」 / The user answered your last choice card with "${option.label}".`;
    const input: QueueInput = {
      bot,
      groupId: group.id,
      conversationId: source.conversationId,
      cycleId: state.cycleId,
      userMessageId: source.userMessageId ?? undefined,
      budgetRootRunId: budgetRootRunId,
      parentRunId: source.id,
      userInitiated: true,
      kind: "chat",
      triggerKey: `group-plan-choice:${messageId}`,
      text: `${answered}\n${
        reply.optionId === "extend"
          ? "用户延长一次计划提交机会。沿原请求继续提交 group_plan，不能自行执行 / The user allowed one more plan submission. Continue the original request with group_plan; do not execute it yourself."
          : "用户选择由统筹自行完成原请求。仍遵守当前权限和预算，明确未分工 / The user chose solo execution of the original request by the coordinator. Keep current permissions and budget; report that no work was delegated."
      }`,
    };
    // Drain before committing the solo choice: a failed drain must leave a retryable card,
    // never a chosen card with a durable but unpublished continuation.
    if (reply.optionId === "solo") await finishPlanLimit(service, group.id, state.cycleId, "solo");
    const queued = transaction(service.deps.db, () => {
      controller.throwIfAborted();
      service.active(group.id, bot.id, source.conversationId);
      const current = service.plans.repo.attemptState(group.id, state.cycleId);
      if (
        service.cycles.get(group.id).cycleId !== state.cycleId ||
        current?.status !== "waiting" ||
        current.messageId !== messageId ||
        !service.deps.chat.queue.canContinue(bot.id, source.conversationId)
      )
        throw new RpcError(-32602, "question_changed");
      const decision = reply.optionId;
      const queued = decision === "end" ? undefined : service.deps.chat.queue.insert(input);
      service.plans.repo.saveAttemptState(group.id, {
        ...current,
        extensions: current.extensions + (decision === "extend" ? 1 : 0),
        status: decision === "extend" ? "open" : decision === "solo" ? "solo" : "ended",
        planningOnly: decision === "extend",
        ...(queued ? { continuationRunId: queued.id } : {}),
      });
      messages.update(messageId, {
        usage: {
          ...usage,
          executionPause: {
            ...pause,
            answer: {
              text: option.label,
              optionId: decision,
              answeredAt: new Date().toISOString(),
            },
          },
        },
      });
      audit({ botId: bot.id, runId: source.id, groupId: group.id }, `group_plan_limit_${decision}`);
      const replan = service.workflows.repo.replanning(source.id);
      if (queued && decision === "extend" && replan)
        service.workflows.progress.save(replan, { ...progressOf(replan), replanRunId: queued.id });
      return queued;
    });
    if (reply.optionId === "end") await finishPlanLimit(service, group.id, state.cycleId, "end");
    if (queued) service.deps.chat.queue.publish(queued, input);
    service.changed(group.id, "updated");
    service.deps.peer.emit("execution.question.answered", {
      botId: bot.id,
      conversationIds: [source.conversationId],
    });
    return true;
  } finally {
    answering.delete(messageId);
  }
}

/** Drain the old DAG before publishing a solo continuation under its original budget root. */
async function finishPlanLimit(
  service: GroupService,
  groupId: string,
  cycleId: string,
  choice: "end" | "solo",
) {
  const active = service.workflows.repo.activePlan(groupId, cycleId);
  if (active) {
    service.workflows.progress.stop(active, "user_stopped", "user");
  }
  await service.workflows.progress.settled();
  if (choice === "end")
    await service.deps.chat.queue.cancel(
      (run) => run.groupId === groupId && run.cycleId === cycleId,
      "cancelled",
    );
}
