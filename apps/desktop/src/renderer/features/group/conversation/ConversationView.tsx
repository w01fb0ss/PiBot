import type { ChatPeer } from "@pibot/client-core";
import { GroupConversation, type GroupTarget, groupTimeline, replyCards } from "@pibot/client-core";
import { useNavigation, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import {
  Fragment,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { useDisplayConversation } from "../../../app/startup-display.tsx";
import chatStyles from "../../chat/chat.module.css";
import { JumpLatest } from "../../chat/messages/JumpLatest.tsx";
import { useTimelineDay } from "../../chat/messages/MessageTime.tsx";
import { useMessageFocus } from "../../chat/messages/use-message-focus.ts";
import { useMessageScroll } from "../../chat/messages/use-message-scroll.ts";
import { userBubbleStyle } from "../../chat/messages/user-bubble.ts";
import { ChatNoticeLines, usePlacedNotices } from "../../chat/status/ChatNotices.tsx";
import { SandboxNoticesProvider } from "../../chat/status/SandboxNotices.tsx";
import { AgentStepsContext, agentStepDetails } from "../../chat/tools/agent-steps.ts";
import { MessageExecutionCards } from "../../execution/MessageExecutionCards.tsx";
import { useExecution } from "../../execution/workspace.tsx";
import { ContinuationPrompt } from "../../runtime/ContinuationPrompt.tsx";
import { useGroupSessionCache } from "../../workspace/data.tsx";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";
import { useTaskBatches } from "../tasks/use-task-list.ts";
import { GroupComposer } from "./Composer.tsx";
import { groupFocusController } from "./focus.ts";
import { GroupApprovalRow } from "./GroupApprovalRow.tsx";
import { GroupMessageRow } from "./GroupMessageRow.tsx";
import { GroupRuns } from "./RunList.tsx";
import { useGroupActivities } from "./use-activities.ts";
import { useGroupApprovals } from "./use-group-approvals.ts";

export function GroupConversationView({
  peer,
  target,
  data,
  images,
  refresh,
  openTask,
  openTasks,
  sendRef,
  draftFeedbackRef,
  layoutKey,
  openWorkplace,
  readonly = false,
  linkedHistory = false,
  draftFolders,
  statusBar,
}: {
  peer: ChatPeer;
  target: GroupTarget;
  data: GroupSnapshot;
  images: boolean;
  refresh(): Promise<void>;
  openTask?: (threadId: string) => void;
  openTasks?: () => void;
  /** Changes sidebar sends comments and review requests as ordinary group messages. */
  sendRef?: MutableRefObject<((text: string) => Promise<boolean>) | undefined>;
  draftFeedbackRef?: MutableRefObject<((conversationId: string, text: string) => void) | undefined>;
  /** Changes when the sidebar resizes this column, so the newest messages stay in view. */
  layoutKey?: string;
  /** The group's working-folder settings (offered on a `workplace_unavailable` reply). */
  openWorkplace?: () => void;
  readonly?: boolean;
  linkedHistory?: boolean;
  draftFolders?: ReactNode;
  statusBar?: ReactNode;
}) {
  const t = useT();
  const { openSettings, view, consumeChatFocus, navigate } = useNavigation();
  const key = JSON.stringify(target);
  const groupCache = useGroupSessionCache();
  const controller = useMemo(
    () => new GroupConversation(peer, JSON.parse(key) as GroupTarget, groupCache),
    [peer, key, groupCache],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useDisplayConversation({
    groupId: target.groupId,
    topicId: target.conversationId,
    name: data.group?.name ?? "Pi Bot",
    bots: data.bots,
    messages: state.messages,
    ready: state.confirmed && !state.loading,
    failed: state.error,
    visible:
      !target.threadId &&
      view.groupId === target.groupId &&
      target.conversationId === data.group?.conversationId,
  });
  const execution = useExecution();
  const executionReplies = useMemo(
    () =>
      replyCards(
        execution?.topics ?? [],
        target.conversationId === execution?.conversationId ? target.conversationId : undefined,
        state.messages,
      ),
    [execution?.topics, execution?.conversationId, target.conversationId, state.messages],
  );
  useEffect(() => controller.start(), [controller]);
  useEffect(() => {
    if (!sendRef) return;
    sendRef.current = readonly
      ? undefined
      : (text) => {
          const active = data.runs.filter(
            (run) =>
              run.status === "running" &&
              run.groupId === target.groupId &&
              (!data.cycle?.cycleId || run.cycleId === data.cycle.cycleId) &&
              (target.threadId
                ? run.conversationId === target.conversationId
                : run.botId === data.group?.coordinatorBotId &&
                  run.conversationId === target.conversationId),
          );
          if (active.length)
            return active.length === 1 && active[0]
              ? controller.append(
                  text,
                  [],
                  active[0],
                  "followUp",
                  target.threadId ? active[0].botId : undefined,
                  () => controller.send(text, []),
                )
              : Promise.resolve(false);
          return controller.send(text, []);
        };
    return () => {
      sendRef.current = undefined;
    };
  }, [
    sendRef,
    controller,
    readonly,
    data.runs,
    data.cycle?.cycleId,
    data.group?.coordinatorBotId,
    target.groupId,
    target.threadId,
    target.conversationId,
  ]);
  const activities = useGroupActivities(
    peer,
    data.bots.map((b) => b.id),
  );
  const groupApprovals = useGroupApprovals(
    peer,
    target.groupId,
    target.threadId || target.draftId || (state.loading && !state.messages.length)
      ? undefined
      : target.conversationId,
    state.messages[0]?.createdAt,
  );
  const timeline = useMemo(
    () => groupTimeline(state.messages, groupApprovals.approvals ?? []),
    [state.messages, groupApprovals.approvals],
  );
  const pendingByRun = new Map<string, string>();
  for (const { approval } of timeline)
    if (approval?.status === "pending" && !pendingByRun.has(approval.runId))
      pendingByRun.set(approval.runId, approval.id);
  const sendPlanChanges = useCallback(
    (text: string) => {
      if (readonly || !data.group || target.threadId) return Promise.resolve(false);
      // GroupSession owns submission, its deadline and uncertain-send protection across row unmounts.
      return controller.send(text, [], [data.group.coordinatorBotId]);
    },
    [controller, readonly, data.group, target.threadId],
  );
  // The composer registers how to fill its draft; rows get one stable callback (memoized rows).
  const composerFill = useRef<((text: string) => void) | undefined>(undefined);
  const fillComposer = useCallback((text: string) => composerFill.current?.(text), []);
  const assignmentTasks = useMemo(() => {
    const result = new Map<string, GroupSnapshot["tasks"]>();
    for (const task of data.tasks) {
      const id = task.source?.batchMessageId;
      if (!id || task.status !== "open") continue;
      const list = result.get(id) ?? [];
      list.push(task);
      result.set(id, list);
    }
    return result;
  }, [data.tasks]);
  const { batches, collaborations } = useTaskBatches(
    peer,
    target.groupId,
    state.messages.map((message) => message.id),
  );
  const today = useTimelineDay();
  const notices = usePlacedNotices(
    peer,
    target.draftId ? undefined : target.conversationId,
    state.messages,
    !state.hasMore,
  );
  const scroll = useRef<HTMLDivElement>(null);
  const messageContent = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<{ top: number; height: number } | undefined>(undefined);
  const focusController = useMemo(() => groupFocusController(controller), [controller]);
  const focus =
    view.name === "chat" && view.groupId === target.groupId && view.threadId === target.threadId
      ? view.focus
      : undefined;
  const messageFocus = useMessageFocus({
    controller: focusController,
    focus,
    consume: consumeChatFocus,
    scroll,
    atBottom,
    anchor,
  });
  const messageScroll = useMessageScroll({
    identity: controller,
    pending: messageFocus.pending,
    holdPosition: messageFocus.holdPosition,
    scroll,
    content: messageContent,
    atBottom,
    anchor,
    messageIds: state.messages.map((message) => message.id),
    cancelFocus: messageFocus.cancel,
  });
  const openApproval = useCallback((id: string) => {
    const node = messageContent.current?.querySelector<HTMLElement>(
      `[data-group-approval-id="${CSS.escape(id)}"]`,
    );
    if (!node) return;
    atBottom.current = false;
    anchor.current = undefined;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: "center" });
  }, []);
  const approvalFocus = !target.threadId && view.groupId === target.groupId && view.approvalFocus;
  const usedApprovalFocus = useRef<typeof view.approvalFocus>(undefined);
  useLayoutEffect(() => {
    if (
      !approvalFocus ||
      usedApprovalFocus.current === approvalFocus ||
      state.loading ||
      !groupApprovals.approvals?.some((approval) => approval.id === approvalFocus.id)
    )
      return;
    usedApprovalFocus.current = approvalFocus;
    openApproval(approvalFocus.id);
  }, [approvalFocus, groupApprovals.approvals, openApproval, state.loading]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore scroll only after message/paging DOM changes
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || messageFocus.pending) return;
    if (anchor.current && !state.paging) {
      node.scrollTop = anchor.current.top + node.scrollHeight - anchor.current.height;
      anchor.current = undefined;
    } else if (!anchor.current && atBottom.current) node.scrollTop = node.scrollHeight;
  }, [state.messages, state.paging, notices, messageFocus.pending]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin after sidebar layout changes
  useLayoutEffect(() => {
    const node = scroll.current;
    if (node && !messageFocus.pending && atBottom.current) node.scrollTop = node.scrollHeight;
  }, [layoutKey]);
  const earlier = async () => {
    if (state.paging) return;
    if (scroll.current)
      anchor.current = { top: scroll.current.scrollTop, height: scroll.current.scrollHeight };
    await controller.more();
  };
  const models = useCallback(() => openSettings("models"), [openSettings]);
  const ignoreRetry = useCallback(() => {}, []);
  // Stable per snapshot so memoized message rows only re-render when their own inputs change.
  const bots = useMemo(() => new Map(data.bots.map((bot) => [bot.id, bot])), [data.bots]);
  const agentNames = useMemo(
    () => new Map(data.bots.filter((bot) => bot.kind === "agent").map((bot) => [bot.id, bot.name])),
    [data.bots],
  );
  const agentSteps = useMemo(
    () => ({ agentNames, details: agentStepDetails(state.messages) }),
    [agentNames, state.messages],
  );
  const runs = useMemo(() => new Map(data.runs.map((run) => [run.id, run])), [data.runs]);
  const mentionNames = useMemo(() => data.bots.map((bot) => bot.name), [data.bots]);
  // Callers pass inline handlers; rows need stable ones or every snapshot re-renders all of them.
  const handlers = useRef({ openTask, openTasks });
  useLayoutEffect(() => {
    handlers.current = { openTask, openTasks };
  });
  const stableOpenTask = useCallback((id: string) => handlers.current.openTask?.(id), []);
  const stableOpenTasks = useCallback(() => handlers.current.openTasks?.(), []);
  const noticeBotName = useCallback((botId: string) => bots.get(botId)?.name, [bots]);
  const threadTask = target.threadId
    ? data.tasks.find((task) => task.threadConversationId === target.threadId)
    : undefined;
  let messageIndex = 0;
  const content = (
    <div
      data-sandbox-scope
      className={target.threadId ? styles.threadConversation : chatStyles.chatColumn}
      style={userBubbleStyle(undefined, "group")}
    >
      {messageFocus.notice && (
        <p className={chatStyles.focusNotice} role="status">
          {t(`chat.focus.${messageFocus.notice}`)}
        </p>
      )}
      {!target.threadId && (
        <ContinuationPrompt conversationId={target.draftId ? undefined : target.conversationId} />
      )}
      <div className={chatStyles.scrollViewport}>
        <JumpLatest {...messageScroll} />
        <div ref={scroll} className={chatStyles.scroll} onScroll={messageScroll.onScroll}>
          <div
            ref={messageContent}
            className={target.threadId ? styles.threadMessages : chatStyles.messages}
            style={userBubbleStyle(undefined, "group")}
          >
            {target.threadId && (
              // The thread opens with its title card.
              <div className={styles.threadCard}>
                <b>
                  {threadTask
                    ? t("group.threadHeading", { title: threadTask.title })
                    : t("group.threadHeadingPlain")}
                </b>
                <span>{t("group.threadNote")}</span>
              </div>
            )}
            {state.loading && (
              <p role="status" className={styles.note}>
                {t("chat.loadingHistory")}
              </p>
            )}
            {state.error && (
              <div role="alert" className={styles.error}>
                {t("chat.historyError")}{" "}
                <Button variant="ghost" onClick={() => void controller.refresh()}>
                  {t("common.retry")}
                </Button>
              </div>
            )}
            {state.hasMore && (
              <Button variant="ghost" loading={state.paging} onClick={() => void earlier()}>
                {t("chat.loadEarlier")}
              </Button>
            )}
            {!state.loading && !state.error && !timeline.length && !target.threadId && (
              <p className={styles.note}>{t("group.empty")}</p>
            )}
            {timeline.map(({ id, message, approval }) => {
              if (approval)
                return (
                  <GroupApprovalRow
                    key={id}
                    peer={peer}
                    approval={approval}
                    bot={bots.get(approval.botId)}
                    groupName={data.group?.name ?? ""}
                    refresh={groupApprovals.refresh}
                  />
                );
              const index = messageIndex++;
              const activity = activities.forMessage(message);
              const candidate = message.runId ? runs.get(message.runId) : undefined;
              const highlighted = messageFocus.highlighted?.messageId === message.id;
              return (
                <Fragment key={message.id}>
                  <ChatNoticeLines
                    notices={notices.before.get(message.id)}
                    botName={noticeBotName}
                  />
                  <GroupMessageRow
                    message={message}
                    previousAt={state.messages[index - 1]?.createdAt}
                    first={index === 0 && !state.hasMore}
                    today={today}
                    bot={message.botId ? bots.get(message.botId) : undefined}
                    activity={activity.state}
                    refreshApprovals={activity.refresh}
                    decideApproval={activity.decide}
                    inlineApprovals={groupApprovals.approvals !== undefined}
                    run={
                      candidate?.botId === message.botId &&
                      candidate?.messageId === message.id &&
                      candidate?.conversationId === target.conversationId
                        ? candidate
                        : undefined
                    }
                    batch={batches.get(message.id)}
                    assignmentTasks={assignmentTasks.get(message.id)}
                    collaborations={collaborations.get(message.id)}
                    highlighted={highlighted}
                    focusToolCallId={highlighted ? messageFocus.highlighted?.toolCallId : undefined}
                    group={data.group}
                    bots={data.bots}
                    mentionNames={mentionNames}
                    peer={peer}
                    refresh={refresh}
                    sendPlanChanges={readonly ? undefined : sendPlanChanges}
                    fillComposer={readonly ? undefined : fillComposer}
                    openTask={openTask ? stableOpenTask : undefined}
                    openTasks={openTasks ? stableOpenTasks : undefined}
                    thread={!!target.threadId}
                    confirmed={state.confirmed}
                    // Only a streaming row shows progress; settled rows must not re-render on run reads.
                    loading={message.status === "streaming" && (data.loading || data.partialRuns)}
                    onRetry={ignoreRetry}
                    onModelsSettings={models}
                    onWorkplaceSettings={openWorkplace}
                    executionFooter={
                      <MessageExecutionCards
                        message={message}
                        cards={executionReplies.get(message.id)}
                      />
                    }
                  />
                </Fragment>
              );
            })}
            <ChatNoticeLines notices={notices.tail} botName={noticeBotName} />
            {!readonly && !target.draftId && (
              <GroupRuns
                peer={peer}
                data={data}
                conversationId={target.conversationId}
                refresh={refresh}
                messages={state.messages}
                openTask={openTask}
                openApproval={openApproval}
                pendingByRun={pendingByRun}
              />
            )}
          </div>
        </div>
      </div>
      {state.requestError && (
        <p role="alert" className={chatStyles.composerNotice}>
          {t(
            state.appendUncertain
              ? "chat.appendUncertain"
              : state.requestError === "append_target_required"
                ? "chat.groupAdditionTarget"
                : state.requestError === "append_unavailable"
                  ? "chat.appendUnavailable"
                  : state.requestError === "append_full"
                    ? "chat.appendFull"
                    : state.requestError === "append_duplicate"
                      ? "chat.appendDuplicate"
                      : state.requestError === "busy"
                        ? "group.sendBusy"
                        : state.requestError === "uncertain"
                          ? "group.uncertain"
                          : state.requestError === "quote_unavailable"
                            ? "chat.quoteUnavailable"
                            : `errors.${state.requestError}`,
          )}
        </p>
      )}
      {(activities.error || groupApprovals.error) && (
        <p role="alert" className={chatStyles.composerNotice}>
          {t("approval.loadError")}{" "}
          <Button
            variant="ghost"
            onClick={() => void Promise.all([activities.refresh(), groupApprovals.refresh()])}
          >
            {t("common.retry")}
          </Button>
        </p>
      )}
      {readonly ? (
        <p role="status" className={`${chatStyles.composerArea} ${styles.note}`}>
          {t(linkedHistory ? "group.topicLinkedHistory" : "group.topicReadonly")}
        </p>
      ) : (
        <GroupComposer
          conversationId={target.draftId ? undefined : target.conversationId}
          draftFolders={draftFolders}
          statusBar={statusBar}
          draft={!!target.draftId}
          draftFeedbackRef={draftFeedbackRef}
          fillRef={composerFill}
          controller={controller}
          runs={data.runs}
          cycleId={data.cycle?.cycleId}
          coordinatorBotId={data.group?.coordinatorBotId}
          threadBotId={threadTask?.assigneeBotId}
          messages={state.messages}
          waiting={state.messages.some((message) =>
            activities
              .forMessage(message)
              .state.approvals.some((approval) => approval.status === "pending"),
          )}
          notices={notices.all}
          members={data.bots}
          images={images}
          disabled={
            state.loading ||
            !state.confirmed ||
            !data.identityReady ||
            !data.membersReady ||
            state.error ||
            state.sending ||
            state.requestError === "uncertain" ||
            data.error ||
            data.bots.length !== data.group?.members.length
          }
          thread={!!target.threadId}
          beforeSend={messageFocus.cancel}
          accepted={() => {
            messageFocus.cancel();
            atBottom.current = true;
            if (target.draftId && controller.getSnapshot().acceptedConversationId)
              navigate({ name: "chat", groupId: target.groupId });
            void refresh();
          }}
          models={models}
        />
      )}
    </div>
  );
  return (
    <SandboxNoticesProvider notices={notices.all} approvals={activities.approvals}>
      <AgentStepsContext.Provider value={agentSteps}>{content}</AgentStepsContext.Provider>
    </SandboxNoticesProvider>
  );
}
