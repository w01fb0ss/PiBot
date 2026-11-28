import type { GroupTask } from "@pibot/protocol";
import { useMemo } from "react";
import { useRuntime } from "../../../runtime/context.tsx";
import {
  continuePlan,
  planView,
  readGroupPlan,
  readGroupTasks,
  retryStep,
  setGroupPaused,
} from "./group-plan.ts";
import { type ChatScope, scopeKey } from "./scope.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/**
 * The group's current plan with live step states, for the strip chip and the task progress
 * sheet. Retry and continue call the same methods as the desktop cards, so both stay identical.
 */
export function useGroupPlan(scope: ChatScope | undefined) {
  const runtime = useRuntime();
  const group = scope?.kind === "group" ? scope : undefined;
  const state = useRemoteValue(
    group ? `groupplan:${scopeKey(group)}` : undefined,
    (signal) => readGroupPlan(runtime, (group as ChatScope).id, signal),
    // A step settling changes its task (group.task); start, replan and stop change the card.
    ["groups.plan.changed", "groups.changed", "group.task"],
  );
  const value = state.value ?? undefined;
  const view = useMemo(() => (value ? planView(value) : undefined), [value]);
  const after = () => void state.load();
  return {
    ...state,
    view,
    retry: (stepId: string) =>
      state.write.run(async (signal) => {
        const workflowRunId = value?.progress?.workflowRunId;
        if (!group || !workflowRunId) return;
        await retryStep(runtime, group.id, workflowRunId, stepId, signal);
        signal.throwIfAborted();
        after();
        return true;
      }),
    continue: () =>
      state.write.run(async (signal) => {
        if (!group || !value) return;
        await continuePlan(runtime, group.id, value.messageId, signal);
        signal.throwIfAborted();
        after();
        return true;
      }),
    /** Maintainers 2026-11-20: the group's pause / continue, same as the desktop bar and header switch. */
    setPaused: (paused: boolean) =>
      state.write.run(async (signal) => {
        if (!group) return;
        await setGroupPaused(runtime, group.id, paused, signal);
        signal.throwIfAborted();
        after();
        return true;
      }),
  };
}
/**
 * Open tasks for the plan sheet's links to approvals, and for matching pending approvals
 * on older computers that do not publish the group approval timeline.
 */
export function useGroupThreads(scope: ChatScope | undefined) {
  const runtime = useRuntime();
  const group = scope?.kind === "group" ? scope : undefined;
  const state = useRemoteValue(
    group ? `groupthreads:${scopeKey(group)}` : undefined,
    async (signal) => {
      if (!group) return [];
      const tasks: GroupTask[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await readGroupTasks(runtime, group.id, "open", signal, before);
        tasks.push(...page);
        if (page.length < 30) return tasks;
        const next = page.at(-1)?.id;
        if (!next || next === before) throw new Error("Repeated group task cursor");
        before = next;
      }
    },
    ["group.task", "groups.changed", "approval.requested"],
  );
  return state.value ?? [];
}
