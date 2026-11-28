import {
  type KernelMethodParams,
  nextGroupRoundLimit,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { transaction } from "@pibot/storage";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import { progressOf } from "./group-workflow-progress.ts";

/** Both the group's button and Pi's confirmed repair lift exactly one recorded admission hold. */
export function continueGroupRounds(
  service: GroupService,
  params: KernelMethodParams["groups.rounds.continue"],
) {
  const scheduled = transaction(service.deps.db, () => {
    const group = service.active(params.groupId);
    const cycle = service.cycles.get(group.id);
    if (
      service.changing(group.id) ||
      service.pausedFor(group.id) ||
      !cycle.cycleId ||
      !cycle.limited ||
      cycle.roundLimitId !== params.roundLimitId ||
      group.autoRoundLimit !== params.expectedLimit ||
      (params.autoRoundLimit !== undefined &&
        params.autoRoundLimit !== nextGroupRoundLimit(group.autoRoundLimit))
    )
      throw new RpcError(RpcErrorCodes.busy, "group_rounds_stale");
    const plans = service.workflows.repo.activeForGroup(group.id, 100, cycle.cycleId);
    const held = plans.flatMap((record) => {
      const progress = progressOf(record);
      if (progress.stoppedReason !== "round_limit") return [];
      const root = record.budgetRootRunId ? service.runs.get(record.budgetRootRunId) : undefined;
      if (
        (progress.roundHold && progress.roundHold.limitId !== params.roundLimitId) ||
        root?.status === "aborted"
      )
        throw new RpcError(RpcErrorCodes.busy, "group_rounds_stale");
      assertPlanWorkplace(service, record.id);
      return [{ record, progress }];
    });
    if (!service.cycles.continueRounds(group.id, params.roundLimitId))
      throw new RpcError(RpcErrorCodes.busy, "group_rounds_stale");
    if (params.autoRoundLimit !== undefined)
      service.groups.update(group.id, { autoRoundLimit: params.autoRoundLimit });
    for (const { record, progress } of held) {
      service.workflows.progress.save(record, {
        ...progress,
        stoppedReason: undefined,
        roundHold: undefined,
      });
      service.workflows.repo.updateRun(
        record.id,
        progress.roundHold?.status ?? (progress.hold ? "waiting" : "running"),
      );
    }
    service.deps.local.approvals.audit.append({
      botId: group.coordinatorBotId,
      kind: "group.workflow.disposition",
      summary: "Group automatic rounds continued / 群自动回合已继续",
      detail: {
        groupId: group.id,
        actor: "user",
        reasonCode: params.autoRoundLimit === undefined ? "round_limit_reset" : "round_limit_raise",
        groupRoundLimit: {
          before: params.expectedLimit,
          after: params.autoRoundLimit ?? params.expectedLimit,
        },
      },
    });
    return plans.map((record) => record.id);
  });
  for (const id of scheduled) service.workflows.schedule(id);
  service.wakes.schedule();
  service.deps.chat.queue.resume();
  service.changed(params.groupId, "updated");
  return { ok: true as const };
}
