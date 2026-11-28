import type { DatabaseSync } from "node:sqlite";
import type { ExecutionLimits } from "@pibot/protocol-base";
import {
  GroupCyclesRepo,
  GroupExecutionLimitsRepo,
  GroupsRepo,
  MessagesRepo,
  RunsRepo,
  transaction,
} from "@pibot/storage";

/** The durable root, not model arguments or the last member to run, owns the cycle identity. */
export class GroupBudgetGuard {
  constructor(private readonly db: DatabaseSync) {}

  private scope(root: string) {
    const run = new RunsRepo(this.db).get(root);
    if (!run?.groupId || !run.cycleId) return undefined;
    const group = new GroupsRepo(this.db).get(run.groupId);
    return group ? { run, group, cycleId: run.cycleId } : undefined;
  }

  key(root: string) {
    const scope = this.scope(root);
    return scope ? `${scope.group.id}:${scope.cycleId}` : undefined;
  }

  limits(root: string, limits: ExecutionLimits): ExecutionLimits {
    const scope = this.scope(root);
    if (!scope) return limits;
    const group = new GroupExecutionLimitsRepo(this.db).get(scope.group.id).limits;
    return Object.fromEntries(
      Object.entries(limits).map(([key, value]) => {
        const cap = group[key as keyof ExecutionLimits];
        return [key, value === null ? cap : cap === null ? value : Math.min(value, cap)];
      }),
    ) as ExecutionLimits;
  }

  costRemaining(root: string): number | undefined {
    const scope = this.scope(root);
    if (!scope) return;
    const repo = new GroupExecutionLimitsRepo(this.db);
    const limit = repo.get(scope.group.id).limits.costUsd;
    if (limit === null) return;
    const { totals } = repo.usage(scope.group.id, scope.group.conversationId, scope.cycleId, true);
    return limit - totals.knownCostUsd;
  }

  reason(root: string, modelAdmission = false, pricingKnown = true) {
    const scope = this.scope(root);
    if (!scope) return undefined;
    const repo = new GroupExecutionLimitsRepo(this.db);
    const limits = repo.get(scope.group.id).limits;
    const { totals } = repo.usage(scope.group.id, scope.group.conversationId, scope.cycleId, true);
    const cycle = new GroupCyclesRepo(this.db).get(scope.group.id);
    const reason =
      cycle.cycleId === scope.cycleId && cycle.limited
        ? "group_cycle_stopped"
        : repo.retryCount(scope.group.id, scope.cycleId) > 6
          ? "retry_limit"
          : modelAdmission && limits.costUsd !== null && !pricingKnown
            ? "price_unknown"
            : modelAdmission && totals.requests >= limits.modelRequests
              ? "model_requests"
              : limits.costUsd !== null && totals.knownCostUsd >= limits.costUsd
                ? "cost"
                : totals.activeMillis >= limits.activeSeconds * 1000
                  ? "active_time"
                  : undefined;
    return reason ? { ...scope, reason, totals, limits } : undefined;
  }

  /** One notice per cycle; stopping and its explanation commit together, before cancellation. */
  stop(root: string, reason: string, runId = root, language: "zh" | "en" = "en") {
    const scope = this.scope(root);
    if (!scope) return undefined;
    return transaction(this.db, () => {
      const cycles = new GroupCyclesRepo(this.db);
      const cycle = cycles.get(scope.group.id);
      if (cycle.cycleId !== scope.cycleId) return undefined;
      if (cycle.limited) return undefined;
      new GroupExecutionLimitsRepo(this.db).exhaustCycle(scope.group.id, scope.cycleId, reason);
      cycles.limit(scope.group.id, scope.cycleId);
      const zh = language === "zh";
      const labels: Record<string, [string, string]> = {
        model_requests: ["群总请求次数已到上限", "Group request limit reached"],
        cost: ["群总费用已到上限", "Group cost limit reached"],
        active_time: ["群活跃执行时间已到上限", "Group active time limit reached"],
        retry_limit: ["群修复与重规划次数已到上限", "Group repair and replan limit reached"],
        repeated_operation: [
          "重复操作或无效参数重试已停止",
          "Repeated operations or invalid input retries stopped",
        ],
        price_unknown: [
          "无法确认模型单价，群预算已停止",
          "Unknown model price; group budget stopped",
        ],
      };
      const summary =
        labels[reason]?.[zh ? 0 : 1] ?? (zh ? "群预算已停止" : "Group budget stopped");
      new MessagesRepo(this.db).create({
        conversationId: scope.group.conversationId,
        botId: scope.group.coordinatorBotId,
        role: "assistant",
        status: "done",
        // IDs identify the stopped work without copying a prompt, path, or member-provided title.
        content: `${summary}\nReason: ${reason}\nRun: ${runId}\nBudget root: ${root}\n${zh ? "请检查该运行的收据与未完成步骤后再继续；已完成文件保留。" : "Review this run's receipt and unfinished steps before continuing; completed files are kept."}`,
        usage: { executionPause: { reason: "checkpoint", summary }, systemEvent: true },
      });
      return scope.group.id;
    });
  }

  sameCycle(left: string, right: string) {
    const a = this.scope(left),
      b = this.scope(right);
    return !!a && !!b && a.group.id === b.group.id && a.cycleId === b.cycleId;
  }
}
