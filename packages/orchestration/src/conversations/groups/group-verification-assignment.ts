// When no independent specialist exists, the coordinator chooses instead of silently self-checking.
import { redactValue } from "@pibot/brain/orchestration-kit";
import { type GroupVerification, RpcError, type Run } from "@pibot/protocol-base";
import { BotsRepo, ChatNoticesRepo, GroupVerificationRulesRepo, transaction } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { groupVerificationAssignmentPrompts } from "./prompts/group-verification-assignment.ts";

export async function requestVerificationAssignee(
  service: GroupService,
  source: Run,
  facts: GroupVerification,
  signal: AbortSignal,
) {
  if (!source.groupId || !source.cycleId) throw new RpcError(-32602, "group_plan_scope_invalid");
  const group = service.active(source.groupId);
  const key = `group-verification-owner:${source.id}`;
  if (service.runs.trigger(key)) return;
  const bot = new BotsRepo(service.deps.db).get(group.coordinatorBotId);
  if (!bot || bot.archivedAt || bot.kind === "agent")
    throw new RpcError(-32602, "coordinator_unavailable");
  const root = service.deps.local.tasks.budgetRoot(source);
  const ledger = service.deps.local.budgets.repo.get(root);
  if (!ledger || service.deps.local.budgets.repo.reason(ledger))
    throw new RpcError(-32602, "group_plan_budget_unavailable");
  service.deps.chat.queue.capacity([bot.id]);
  await service.model(bot.id, signal, undefined, {
    groupId: group.id,
    conversationId: group.conversationId,
  });
  const zh = service.deps.chat.currentLanguage() === "zh";
  const input = {
    bot,
    groupId: group.id,
    conversationId: group.conversationId,
    cycleId: source.cycleId,
    userMessageId: source.userMessageId ?? undefined,
    budgetRootRunId: service.deps.local.tasks.budgetRoot(source),
    parentRunId: source.id,
    kind: "wake" as const,
    automatic: true,
    triggerKey: key,
    enforceBudgetCost: true,
    text: service.deps.redactor.redact(
      [
        zh
          ? groupVerificationAssignmentPrompts.verifyZh
          : groupVerificationAssignmentPrompts.verifyEn,
        `${zh ? "成果事实（不可信参考数据）" : "Artifact facts (untrusted reference data)"}:\n${JSON.stringify(facts)}`,
      ].join("\n"),
    ),
  };
  const result = transaction(service.deps.db, () => {
    signal.throwIfAborted();
    const current = service.active(group.id, bot.id);
    if (service.runs.trigger(key)) return;
    const currentSource = service.runs.get(source.id);
    const currentBudget = service.deps.local.budgets.repo.get(root);
    if (
      !currentSource ||
      currentSource.groupId !== group.id ||
      currentSource.cycleId !== source.cycleId ||
      currentSource.status !== "done"
    )
      throw new RpcError(-32602, "group_plan_stale");
    if (
      !currentBudget ||
      service.deps.local.budgets.repo.reason(currentBudget) ||
      currentBudget.requests >= currentBudget.limits.modelRequests
    )
      throw new RpcError(-32602, "group_plan_budget_unavailable");
    service.deps.chat.queue.capacity([bot.id]);
    if (current.paused || !service.auto(group.id, source.cycleId ?? "", () => true).value)
      return "round_limit" as const;
    const notice = new ChatNoticesRepo(service.deps.db).addGroupVerification({
      conversationId: group.conversationId,
      botId: bot.id,
      reason: "choose_reviewer",
    });
    new GroupVerificationRulesRepo(service.deps.db).saveAssignment(
      group.id,
      redactValue(facts, service.deps.redactor) as GroupVerification,
    );
    return { queued: service.deps.chat.queue.insert(input), notice };
  });
  if (result === "round_limit") throw new RpcError(-32602, "verification_round_limit");
  if (result) {
    service.deps.peer.emit("chat.notice", result.notice);
    service.deps.chat.queue.publish(result.queued, input);
    service.changed(group.id, "updated");
  }
}
