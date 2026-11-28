import { runErrorText } from "@pibot/client-core";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useSharedText, useStatusText, useText } from "../../runtime/context.tsx";
import { space, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { type AvatarLook, type AvatarState, BotAvatar } from "../../ui/avatar.tsx";
import { Button, ListCard, Separator, type StateKind, StateTag } from "../../ui/controls.tsx";
import { useTimeText } from "../../ui/time.ts";
import type { RoutineRun, Run } from "./pages.ts";

/** A rounded list of rows, or one muted line when it is empty. */
export function Rows<T>({
  rows,
  empty,
  keyOf,
  render,
}: {
  rows: T[];
  empty: string;
  keyOf: (row: T) => string;
  render: (row: T) => ReactNode;
}) {
  const colors = useColors();
  return (
    <ListCard>
      {rows.length ? (
        rows.map((row, index) => (
          <View key={keyOf(row)}>
            {index > 0 && <Separator />}
            {render(row)}
          </View>
        ))
      ) : (
        <Text
          style={{
            paddingTop: 12,
            paddingBottom: 12,
            paddingHorizontal: 16,
            fontSize: 12.5,
            lineHeight: 19,
            color: colors.text2,
          }}
        >
          {empty}
        </Text>
      )}
    </ListCard>
  );
}
export function TaskItem({
  look,
  lookState,
  title,
  state,
  meta,
  action,
  onPress,
}: {
  look?: AvatarLook;
  lookState?: AvatarState;
  title: string;
  state?: { kind: StateKind; label: string };
  meta: string;
  action?: ReactNode;
  /** Opens the task detail; the action button keeps its own press. */
  onPress?: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: space.settingsRow,
        paddingVertical: 10,
        paddingHorizontal: 16,
        backgroundColor: pressed ? colors.hover : "transparent",
      })}
    >
      {look ? <BotAvatar bot={look} size={32} state={lookState} /> : <View style={{ width: 32 }} />}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={[type.rowTitle, { color: colors.text }]}>
          {title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {state && <StateTag kind={state.kind} label={state.label} />}
          {!!meta && (
            <Text style={[type.caption, { color: colors.text2, flexShrink: 1 }]}>
              {state ? `· ${meta}` : meta}
            </Text>
          )}
        </View>
      </View>
      {action}
    </Pressable>
  );
}
export function runState(
  run: Run,
  t: ReturnType<typeof useText>,
  status: ReturnType<typeof useStatusText>,
) {
  const kind: StateKind =
    run.status === "waiting"
      ? "wait"
      : run.status === "done"
        ? "done"
        : run.status === "error"
          ? "fail"
          : run.status === "aborted"
            ? "paused"
            : "run";
  return { kind, label: run.status === "waiting" ? t("summaryWaiting") : status(run.status) };
}
export function RunRow({
  run,
  look,
  title,
  who,
  disabled,
  onStop,
  onRetry,
  onApprove,
  onOpen,
}: {
  onOpen?: () => void;
  run: Run;
  look?: AvatarLook;
  title: string;
  who?: string;
  disabled: boolean;
  onStop: () => void;
  onRetry: () => void;
  onApprove: () => void;
}) {
  const t = useText(),
    shared = useSharedText(),
    status = useStatusText(),
    time = useTimeText();
  const finished = run.finishedAt && run.startedAt;
  const when = finished
    ? `${time.list(run.finishedAt as string)} · ${t("took", { time: time.duration(Date.parse(run.finishedAt as string) - Date.parse(run.startedAt as string)) })}`
    : time.ago(run.startedAt ?? run.createdAt);
  const action =
    run.status === "waiting" ? (
      <Button size="small" variant="prim" title={t("goApprove")} onPress={onApprove} />
    ) : run.status === "queued" || run.status === "running" ? (
      <Button variant="danger" title={t("stop")} disabled={disabled} onPress={onStop} />
    ) : run.status === "aborted" || run.status === "error" ? (
      <Button
        size="small"
        title={t(run.status === "error" ? "retry" : "continue")}
        disabled={disabled}
        onPress={onRetry}
      />
    ) : undefined;
  const state = runState(run, t, status);
  return (
    <TaskItem
      look={look}
      lookState={
        state.kind === "run"
          ? "working"
          : state.kind === "wait"
            ? "waiting"
            : state.kind === "fail"
              ? "blocked"
              : "idle"
      }
      title={title}
      state={state}
      meta={[
        who,
        when,
        runErrorText(run.errorCode, shared) ??
          (run.status === "error" ? shared("errors.genericFailure") : undefined),
      ]
        .filter(Boolean)
        .join(" · ")}
      action={action}
      onPress={onOpen}
    />
  );
}
export function RoutineRow({
  run,
  disabled,
  onRunNow,
  onOpen,
}: {
  run: RoutineRun;
  disabled: boolean;
  onRunNow: () => void;
  onOpen?: () => void;
}) {
  const t = useText(),
    status = useStatusText(),
    time = useTimeText();
  const look = run.bot
    ? {
        name: run.bot.name,
        shape: run.bot.avatarShape,
        color: run.bot.avatarColor,
        eyes: run.bot.avatarEyes,
      }
    : undefined;
  const at = run.finishedAt ?? run.startedAt ?? run.scheduledFor;
  return (
    <TaskItem
      look={look}
      title={run.taskName ?? t("sectionRoutines")}
      meta={[run.bot?.name, t("lastRun", { time: time.list(at), status: status(run.status) })]
        .filter(Boolean)
        .join(" · ")}
      action={
        <Button
          size="small"
          title={t("runNow")}
          disabled={disabled || !run.routineId || run.taskDeleted}
          onPress={onRunNow}
        />
      }
      onPress={onOpen}
    />
  );
}
