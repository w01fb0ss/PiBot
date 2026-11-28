import { localizedPlanStepTitle } from "@pibot/i18n";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useLanguage, useRuntime, useSharedText, useText } from "../../../runtime/context.tsx";
import { onFill, useColors } from "../../../theme/use-theme.ts";
import { Button, ErrorLine, ListCard, Separator } from "../../../ui/controls.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { OptionRow, SheetLabel, SheetText, SheetTitle } from "../../../ui/sheet.tsx";
import { useToast } from "../../../ui/toast.tsx";
import {
  type PlanStepView,
  readGroupTasks,
  type StepMark,
  stepTask,
} from "../controls/group-plan.ts";
import { useRemoteValue } from "../controls/use-remote-value.ts";
import type { ChatPage } from "../use-chat-page.ts";
import { CloseButton, OfflineNote } from "./control-sheets.tsx";

/** Step events are not all broadcast; while the sheet shows a live plan it re-reads slowly. */
const POLL_MS = 4_000;

/** ✓ done, ● in progress, ○ waiting or skipped, ! waiting for the user or failed. */
function StepMarkView({ mark }: { mark: StepMark }) {
  const colors = useColors();
  const fill =
    mark === "done"
      ? colors.ok
      : mark === "running"
        ? colors.accent
        : mark === "attention"
          ? colors.warn
          : mark === "failed"
            ? colors.danger
            : undefined;
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: fill ? 0 : 2,
        borderColor: colors.b3,
        backgroundColor: fill ?? "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {mark === "done" && <Icon name="check" color={onFill(colors)} size={11} strokeWidth={3} />}
      {mark === "running" && (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: onFill(colors) }} />
      )}
      {(mark === "attention" || mark === "failed") && (
        <Text style={{ color: onFill(colors), fontSize: 12, lineHeight: 14, fontWeight: "700" }}>
          !
        </Text>
      )}
    </View>
  );
}
function statusLine(step: PlanStepView, t: ReturnType<typeof useText>) {
  const status = t(step.label);
  return step.mark === "running" && step.attempt > 0
    ? `${status} · ${t("gpAttempt", { n: step.attempt + 1 })}`
    : status;
}
/** The desktop task panel's current plan, read-only apart from its retry and continue. */
export function GroupPlanSheet({
  page,
  onClose,
  onApproval,
}: {
  page: ChatPage;
  onClose: () => void;
  onApproval: (id: string) => void;
}) {
  const t = useText(),
    toast = useToast();
  const language = useLanguage();
  const title = (step: PlanStepView) => localizedPlanStepTitle(step.title, language);
  const plan = page.groupPlan;
  const view = plan.view;
  const [selected, setSelected] = useState<string>();
  const live = !!view?.live && page.online;
  // A failed tap's message belongs to that attempt; reopening the sheet starts clean (phone test
  // 2026-11-20: 「记录已变化」 stayed until the app restarted).
  const clearWriteError = useRef(plan.write.setError);
  useEffect(() => {
    clearWriteError.current(undefined);
  }, []);
  // load is recreated each render (it closes over the scope and link state); poll the latest one.
  const load = useRef(plan.load);
  load.current = plan.load;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load.current(), POLL_MS);
    return () => clearInterval(timer);
  }, [live]);
  const name = (botId?: string) => page.lookFor(botId)?.name ?? t("gpMember");
  const step = view?.steps.find((item) => item.id === selected);
  const tasksByThread = new Map(page.groupTasks.map((task) => [task.threadConversationId, task]));
  const tasksById = new Map(page.groupTasks.map((task) => [task.id, task]));
  const approvalsByTask = new Map<string, string>();
  // A step may delegate the tool to a child Bot. The oldest request in that task tree leads.
  for (const approval of [...(page.timelineApprovals ?? [])].reverse()) {
    if (approval.status !== "pending" || !approval.conversationId) continue;
    let task = tasksByThread.get(approval.conversationId);
    while (task && !approvalsByTask.has(task.id)) {
      approvalsByTask.set(task.id, approval.id);
      task = tasksById.get(task.source?.parentTaskId ?? "");
    }
  }
  const stepApproval = (item: PlanStepView) => {
    const task = item.title ? stepTask(page.groupTasks, item.title, item.botId) : undefined;
    return task && approvalsByTask.get(task.id);
  };
  const openApproval = (id: string) => {
    onClose();
    onApproval(id);
  };
  // In a step's detail only that step can be retried; on the list, the first one waiting for you.
  const retryTarget = !view
    ? undefined
    : step
      ? view.retryable.has(step.id)
        ? step
        : undefined
      : view.steps.find((item) => view.retryable.has(item.id));
  const disabled = !page.online || plan.write.busy;
  const retry = async () => {
    if (!retryTarget || (await plan.retry(retryTarget.id)) === undefined) return;
    toast(t("gpRetried"));
  };
  const resume = async () => {
    if ((await plan.continue()) === undefined) return;
    toast(t("gpContinued"));
  };
  const togglePause = async () => {
    const pausing = !view?.paused;
    if ((await plan.setPaused(pausing)) === undefined) return;
    toast(t(pausing ? "gpGroupPausedToast" : "gpGroupResumedToast"));
  };
  if (!view)
    return (
      <>
        <SheetTitle text={t("gpTitle", { done: 0, total: 0 })} />
        <SheetText text={t(plan.action.busy ? "gpLoading" : "gpEmpty")} />
        <ErrorLine text={plan.action.error && t(plan.action.error)} />
        <CloseButton onClose={onClose} />
      </>
    );
  const actions = (
    <>
      <OfflineNote page={page} />
      <ErrorLine text={plan.write.error && t(plan.write.error)} />
      {retryTarget && (
        <>
          <SheetText
            text={t("gpNeedsYouHint", { title: title(retryTarget), name: name(retryTarget.botId) })}
          />
          <Button
            size="lg"
            variant="prim"
            title={t("gpRetry")}
            disabled={disabled}
            onPress={() => void retry()}
          />
        </>
      )}
      {(view.paused || view.live) && (
        <>
          {view.paused && <SheetText text={t("gpGroupPausedHint")} />}
          <Button
            size="lg"
            variant={view.paused ? "prim" : "default"}
            title={t(view.paused ? "gpGroupResume" : "gpGroupPause")}
            disabled={disabled}
            onPress={() => void togglePause()}
          />
        </>
      )}
      {view.continuable && (
        <>
          <SheetText text={t("gpContinueHint")} />
          <Button
            size="lg"
            variant="prim"
            title={t("gpContinue")}
            disabled={disabled}
            onPress={() => void resume()}
          />
        </>
      )}
      <SheetText small text={t("gpDesktopOnly")} />
    </>
  );
  const selectedApproval = step && stepApproval(step);
  if (step && page.scope)
    return (
      <>
        <SheetTitle text={title(step)} />
        <SheetText text={`${name(step.botId)} · ${statusLine(step, t)}`} />
        {selectedApproval && (
          <Button title={t("gpStepNeedsYou")} onPress={() => openApproval(selectedApproval)} />
        )}
        {!!step.task && (
          <>
            <SheetLabel text={t("gpStepTask")} />
            <ListCard flush style={{ padding: 14 }}>
              <BodyText text={step.task} />
            </ListCard>
          </>
        )}
        <StepResult groupId={page.scope.id} step={step} />
        {actions}
        <Button
          size="lg"
          variant="ghost"
          title={t("gpBack")}
          onPress={() => setSelected(undefined)}
        />
      </>
    );
  return (
    <>
      <SheetTitle text={t("gpTitle", { done: view.done, total: view.total })} />
      <SheetText text={t(view.status)} />
      <ErrorLine text={plan.action.error && t(plan.action.error)} />
      <ListCard flush>
        {view.steps.map((item, index) => {
          const approval = stepApproval(item);
          return (
            <View key={item.id}>
              {index > 0 && <Separator />}
              <OptionRow
                title={title(item)}
                subtitle={`${name(item.botId)} · ${approval ? t("gpStepNeedsYou") : statusLine(item, t)}`}
                lead={<StepMarkView mark={approval ? "attention" : item.mark} />}
                onPress={() => (approval ? openApproval(approval) : setSelected(item.id))}
              />
            </View>
          );
        })}
      </ListCard>
      {actions}
      <CloseButton onClose={onClose} />
    </>
  );
}
function BodyText({ text }: { text: string }) {
  const colors = useColors();
  return (
    <Text selectable style={{ fontSize: 14.5, lineHeight: 21, color: colors.text }}>
      {text}
    </Text>
  );
}
/** The member's result for the step (its group task's summary), or why its last run failed. */
function StepResult({ groupId, step }: { groupId: string; step: PlanStepView }) {
  const runtime = useRuntime(),
    t = useText(),
    shared = useSharedText();
  const result = useRemoteValue(
    `gpresult:${groupId}:${step.id}`,
    async (signal) => {
      const tasks = await readGroupTasks(runtime, groupId, undefined, signal);
      return step.title ? (stepTask(tasks, step.title, step.botId) ?? null) : null;
    },
    ["group.task"],
  );
  const task = result.value;
  const failure = task?.status === "open" ? task.activity?.failure : undefined;
  const text = task?.summary ?? (failure ? shared(`errors.${failure.code}`) : undefined);
  return (
    <>
      <SheetLabel text={t("gpStepResult")} />
      {text ? (
        <ListCard flush style={{ padding: 14 }}>
          <BodyText text={text} />
        </ListCard>
      ) : (
        <SheetText
          text={t(task === undefined && result.action.busy ? "gpResultLoading" : "gpNoResult")}
        />
      )}
      <ErrorLine text={result.action.error && t(result.action.error)} />
    </>
  );
}
