import type { GroupPlanCard, GroupPlanProgress, MethodParams } from "@pibot/protocol";
import { useRuntime } from "../../runtime/context.tsx";
import type { Caller } from "../chat/controls/scope.ts";
import { useRemoteValue } from "../chat/controls/use-remote-value.ts";

export interface HeldPlan {
  groupId: string;
  card: GroupPlanCard;
  progress: GroupPlanProgress & { choice: NonNullable<GroupPlanProgress["choice"]> };
}
const live = (progress: GroupPlanProgress) =>
  progress.status === "running" || progress.status === "waiting";

/**
 * Started plans the computer's inbox lists because they wait for the user's choice (no replans
 * left, or a skipped repair). The inbox carries the card; its live progress says which choice.
 */
async function readHeldPlans(c: Caller, signal: AbortSignal): Promise<HeldPlan[]> {
  const items = await c.call("inbox.list", { kind: "group_plan", limit: 20 }, signal);
  const started = items.flatMap((item) =>
    item.kind === "group_plan" && item.card.status === "started" ? [item] : [],
  );
  const read = await Promise.all(
    started.map(async (item) => {
      const progress = await c.call(
        "groups.plan.progress",
        { groupId: item.groupId, workflowRunId: item.card.id },
        signal,
        15_000,
      );
      return progress.choice && live(progress)
        ? {
            groupId: item.groupId,
            card: item.card,
            progress: { ...progress, choice: progress.choice },
          }
        : undefined;
    }),
  );
  return read.filter((plan): plan is HeldPlan => !!plan);
}

export type HeldChoice = MethodParams["groups.plan.choose"]["choice"];

/**
 * Held plans for the approvals tab and its badge (ApprovalsProvider shares one copy). A choice
 * goes through the same `groups.plan.choose` as the desktop card; the brain checks it against
 * the plan's current state and refuses a stale one.
 */
export function useHeldPlansState() {
  const runtime = useRuntime();
  const state = useRemoteValue("heldplans", (signal) => readHeldPlans(runtime, signal), [
    "inbox.changed",
    "groups.changed",
    "groups.plan.changed",
  ]);
  return {
    plans: state.value ?? [],
    load: state.load,
    write: state.write,
    /** Resolves to the new plan's starting text for `new_plan`, "" otherwise; undefined on failure. */
    choose: (plan: HeldPlan, choice: HeldChoice) =>
      state.write.run(async (signal) => {
        const result = await runtime.call(
          "groups.plan.choose",
          {
            groupId: plan.groupId,
            workflowRunId: plan.progress.workflowRunId,
            choice,
            confirmed: true,
          },
          signal,
          15_000,
        );
        signal.throwIfAborted();
        void state.load();
        return result.newPlanGoal ?? "";
      }),
  };
}
