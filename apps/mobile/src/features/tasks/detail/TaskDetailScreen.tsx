import { runErrorText } from "@pibot/client-core";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSharedText, useStatusText, useText } from "../../../runtime/context.tsx";
import { radius, type } from "../../../theme/scale.ts";
import { GROUP_TINT, TAB_TINT } from "../../../theme/tint.ts";
import { useColors } from "../../../theme/use-theme.ts";
import { BotAvatar } from "../../../ui/avatar.tsx";
import {
  Banner,
  EmptyState,
  ErrorLine,
  FootNote,
  ListCard,
  SectionTitle,
  Separator,
  StateTag,
} from "../../../ui/controls.tsx";
import { NavBar } from "../../../ui/headers.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { MessageMarkdown } from "../../../ui/markdown.tsx";
import { OptionRow } from "../../../ui/sheet.tsx";
import { useTimeText } from "../../../ui/time.ts";
import { runChangesHref, runTarget } from "../../changes/calls.ts";
import { RunReceiptCard } from "../../chat/messages/RunReceiptCard.tsx";
import { ToolSteps } from "../../chat/messages/ToolSteps.tsx";
import { useConversations } from "../../conversations/conversations-context.tsx";
import { Attachments } from "../../files/Attachments.tsx";
import { runState } from "../TaskRows.tsx";
import { type TaskItemRef, TaskParamsSchema, useTaskDetail } from "./use-task-detail.ts";

export function TaskDetailScreen() {
  const params = TaskParamsSchema.safeParse(useLocalSearchParams());
  const router = useRouter(),
    t = useText();
  if (!params.success)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title="" onBack={() => router.back()} />
        <EmptyState icon="clock" title={t("stale")} />
      </View>
    );
  return <TaskDetail item={params.data} />;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View>
      <SectionTitle title={title} />
      <View style={{ paddingHorizontal: 16, gap: 8, alignItems: "flex-start" }}>{children}</View>
    </View>
  );
}
/** Task detail, steps and result (read-only); opens offline from the phone cache. */
function TaskDetail({ item }: { item: TaskItemRef }) {
  const router = useRouter(),
    t = useText(),
    shared = useSharedText(),
    colors = useColors(),
    status = useStatusText(),
    time = useTimeText(),
    conversations = useConversations();
  const detail = useTaskDetail(item);
  const record = detail.record;
  if (record === null)
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <NavBar title={t("taskDetail")} onBack={() => router.back()} />
        <EmptyState icon="clock" title={t("taskGone")} hint={t("taskGoneHint")} />
      </View>
    );
  if (!record) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  const bot = conversations.find("bot", record.run.botId);
  const group =
    record.kind === "run" && record.run.groupId
      ? conversations.find("group", record.run.groupId)
      : undefined;
  const title =
    record.kind === "routine"
      ? (record.run.taskName ?? t("sectionRoutines"))
      : (group?.name ?? bot?.name ?? t("taskDetail"));
  const state =
    record.kind === "run"
      ? runState(record.run, t, status)
      : { kind: "done" as const, label: status(record.run.status) };
  const started = record.run.startedAt;
  const finished = record.run.finishedAt;
  const duration =
    started && finished ? time.duration(Date.parse(finished) - Date.parse(started)) : undefined;
  const { request, reply } = detail.messages.value ?? { request: null, reply: null };
  const files = detail.changes.value?.files.length ?? 0;
  const failed =
    record.kind === "run"
      ? record.run.status === "error"
      : record.run.status === "failed" || record.run.status === "timeout";
  const reason =
    runErrorText(record.run.errorCode, shared) ??
    (failed ? shared("errors.genericFailure") : undefined);
  const meta = [group ? bot?.name : undefined, reason].filter(Boolean);
  const lookState =
    state.kind === "run"
      ? "working"
      : state.kind === "wait"
        ? "waiting"
        : state.kind === "fail"
          ? "blocked"
          : state.kind === "done"
            ? "done"
            : "idle";
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar
        title={t("taskDetail")}
        subtitle={title}
        // The run's Bot colour (a group's run keeps the group colour).
        tint={group ? GROUP_TINT : (bot?.looks[0]?.color ?? TAB_TINT.tasks)}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {(detail.messages.stale || !detail.messages.online) && (
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Banner text={t("fileCachedCopy")} />
          </View>
        )}
        <View
          style={{
            flexDirection: "row",
            gap: 12,
            alignItems: "center",
            paddingTop: 16,
            paddingHorizontal: 16,
            paddingBottom: 12,
          }}
        >
          {bot?.looks[0] && <BotAvatar bot={bot.looks[0]} size={44} state={lookState} />}
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ fontSize: 17, lineHeight: 23, fontWeight: "600", color: colors.text }}>
              {title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <StateTag kind={state.kind} label={state.label} />
              {meta.length > 0 && (
                <Text style={[type.caption, { color: colors.text2 }]}>· {meta.join(" · ")}</Text>
              )}
            </View>
          </View>
        </View>
        {!!started && (
          <ListCard>
            <OptionRow title={t("taskStarted")} value={time.stamp(started)} />
            {!!duration && (
              <>
                <Separator />
                <OptionRow title={t("taskDuration")} value={duration} />
              </>
            )}
          </ListCard>
        )}
        {record.kind === "routine" && !!record.run.attentionReason && (
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Banner tone="warn" icon="warning" text={record.run.attentionReason} />
          </View>
        )}
        {record.kind === "routine" && !!record.run.summary && (
          <Section title={t("taskSummary")}>
            <Text selectable style={[type.body, { color: colors.text }]}>
              {record.run.summary}
            </Text>
          </Section>
        )}
        <ErrorLine text={detail.messages.error && t(detail.messages.error)} />
        {!!request?.content && (
          <Section title={t("taskRequest")}>
            <Text selectable style={[type.body, { color: colors.text }]}>
              {request.content}
            </Text>
          </Section>
        )}
        {!!reply?.tools?.length && (
          <>
            <SectionTitle title={t("taskSteps")} />
            <ListCard style={{ paddingTop: 4, paddingHorizontal: 10, paddingBottom: 8 }}>
              <ToolSteps tools={reply.tools} />
            </ListCard>
          </>
        )}
        {!!reply && (!!reply.content || !!reply.attachments?.length) && (
          <Section title={t("taskResult")}>
            {!!reply.content && (
              <View
                style={{
                  maxWidth: "100%",
                  borderRadius: radius.bubble,
                  borderBottomLeftRadius: radius.tail,
                  paddingVertical: 10,
                  paddingHorizontal: 14,
                  backgroundColor: colors.bubble,
                }}
              >
                <MessageMarkdown text={reply.content} color={colors.text} />
              </View>
            )}
            {!!reply.attachments?.length && (
              <Attachments messageId={reply.id} items={reply.attachments} />
            )}
          </Section>
        )}
        {(failed || !!record.run.errorCode) && (
          <View style={{ paddingTop: 12 }}>
            <ListCard>
              <OptionRow
                title={t("records")}
                lead={<Icon name="audit" color={colors.text} size={18} />}
                right={<Icon name="chevronRight" color={colors.text2} size={16} />}
                onPress={() => router.push("/records")}
              />
            </ListCard>
          </View>
        )}
        {files > 0 && detail.run && (
          <View style={{ paddingTop: 16 }}>
            <ListCard>
              <OptionRow
                title={t("changesCard", { count: detail.changes.value?.total ?? files })}
                lead={<Icon name="file" color={colors.text} size={18} />}
                right={<Icon name="chevronRight" color={colors.text2} size={16} />}
                onPress={() =>
                  detail.run && router.push(runChangesHref(detail.run.runId, runTarget(detail.run)))
                }
              />
            </ListCard>
          </View>
        )}
        {detail.run && (
          <View style={{ paddingTop: 16 }}>
            <RunReceiptCard runId={detail.run.runId} />
          </View>
        )}
        <FootNote text={t("taskReadOnly")} />
      </ScrollView>
    </View>
  );
}
