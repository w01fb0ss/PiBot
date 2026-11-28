import type { ChatPeer } from "@pibot/client-core";
import { type GroupTopic, HANDOFF_LIMIT, nextGroupRoundLimit, RpcError } from "@pibot/protocol";
import {
  BotAvatar,
  FolderPicker,
  folderLabel,
  useAction,
  useNavigation,
  useRpc,
  useT,
  waitRpc,
} from "@pibot/renderer-kit";
import { Button, GroupAvatar, Icon, IconButton, Switch } from "@pibot/ui";
import { ChangesLinkContext, ChangesPane, useChatChanges } from "@pibot/workspaces/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDisplayConversation } from "../../app/startup-display.tsx";
import { AutoCheckFolderMenu } from "../autocheck/AutoCheckFolderMenu.tsx";
import { ChatHeader } from "../chat/ChatHeader.tsx";
import chatStyles from "../chat/chat.module.css";
import { MessageReplyProvider } from "../chat/messages/MessageReply.tsx";
import { YoloControl } from "../chat/status/YoloControl.tsx";
import { ModelOverrideControl } from "../chat/topics/ModelOverrideControl.tsx";
import { TasksPane } from "../execution/TasksPane.tsx";
import { ExecutionContext, useExecutionWorkspace } from "../execution/workspace.tsx";
import { useGroupFolders } from "../folders/use-group-folders.ts";
import { OfficePreviewContext, useOfficePreview } from "../office/preview-context.tsx";
import { BrowserSlot, useGroupBrowserSlot } from "../side-pane/BrowserSlot.tsx";
import { SidePane } from "../side-pane/SidePane.tsx";
import { SidePaneActions } from "../side-pane/SidePaneActions.tsx";
import sidePaneStyles from "../side-pane/side-pane.module.css";
import { useSidePane } from "../side-pane/use-side-pane.ts";
import { useGroupSessionCache } from "../workspace/data.tsx";
import { ProjectMemoryFolderMenu } from "../workspace/memory/project/ProjectMemory.tsx";
import { useCatalog } from "../workspace/profile/catalog.ts";
import { GroupConversationView } from "./conversation/ConversationView.tsx";
import { GroupRunBar } from "./conversation/GroupRunBar.tsx";
import { useThread } from "./conversation/use-thread.ts";
import { GroupData } from "./data.ts";
import styles from "./group.module.css";
import { GroupPanel, type GroupTab } from "./Panel.tsx";
import { useGroupWorkplaces } from "./resources/use-group-workplaces.ts";
import { GroupTaskWorkspace } from "./tasks/GroupTaskWorkspace.tsx";
import { groupTaskIsChild } from "./tasks/group-task-tree.ts";
import { useTaskSummary } from "./tasks/use-task-summary.ts";
import { GroupTopics } from "./topics/GroupTopics.tsx";
import { useGroupTopicDraft } from "./topics/use-group-topic-draft.ts";

const EMPTY_DISPLAY_MESSAGES = [] as const;

function dismissedUsage() {
  try {
    return localStorage.getItem("pibot.group.usage.dismissed") === "true";
  } catch {
    return false;
  } // A blocked preference store should leave the notice visible.
}
export function GroupChat({
  peer,
  groupId,
  threadId,
}: {
  peer: ChatPeer;
  groupId: string;
  threadId?: string;
}) {
  const t = useT();
  const { navigate, view } = useNavigation();
  const groupCache = useGroupSessionCache();
  const controller = useMemo(
    () => new GroupData(peer, groupId, groupCache),
    [peer, groupId, groupCache],
  );
  const data = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => controller.start(), [controller]);
  useDisplayConversation({
    groupId,
    name: "Pi Bot",
    messages: EMPTY_DISPLAY_MESSAGES,
    ready: false,
    failed: !data.loading && !data.group,
    visible: view.groupId === groupId,
  });
  const [panel, setPanel] = useState<GroupTab>();
  const taskSummary = useTaskSummary(peer, groupId, "all", data.group?.conversationId);
  useEffect(() => {
    if (groupId) {
      setPanel(undefined);
    }
  }, [groupId]);

  useEffect(() => {
    if (view.groupId === groupId && view.groupPanel) setPanel(view.groupPanel);
  }, [groupId, view]);

  const [usage, setUsage] = useState(() => !dismissedUsage());
  const action = useAction();
  const catalog = useCatalog();
  const workplaces = useGroupWorkplaces(peer, data);
  const places = workplaces.snapshot;
  const thread = useThread(peer, groupId, threadId, data.tasks);
  const group = data.group;
  const [historyTopic, setSelectedTopic] = useState<GroupTopic>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: selections never cross groups
  useEffect(() => setSelectedTopic(undefined), [groupId]);
  const groupView = view.name === "chat" && view.groupId === groupId ? view : undefined;
  const draftId = groupView?.draftId;
  const linkedTopicId = groupView?.topicId;
  const selectedTopic = linkedTopicId ? undefined : historyTopic;
  const linkedHistory = !!linkedTopicId && linkedTopicId !== group?.conversationId;
  useEffect(() => {
    // Explicit history selections and message-location requests retain their read-only route.
    if (
      group?.topicArchivedAt &&
      !draftId &&
      !threadId &&
      !selectedTopic &&
      !linkedTopicId &&
      !view.focus
    )
      navigate({ name: "chat", groupId, draftId: crypto.randomUUID() });
  }, [
    group?.topicArchivedAt,
    draftId,
    threadId,
    selectedTopic,
    linkedTopicId,
    view.focus,
    navigate,
    groupId,
  ]);
  const isDraft = !!draftId;
  const draftFolders = useGroupTopicDraft(peer, group, draftId);
  const readonly = !isDraft && (linkedHistory || !!selectedTopic || !!group?.topicArchivedAt);
  const viewConversationId = draftId ?? linkedTopicId ?? selectedTopic?.id ?? group?.conversationId;
  const chooseTopic = (topic?: GroupTopic) => {
    setSelectedTopic(topic);
    navigate({ name: "chat", groupId });
  };
  // The brain validates actual @ recipients; other members need not block image attachment entry.
  const images =
    !!group &&
    data.bots.length === group.members.length &&
    data.bots.some((bot) =>
      catalog.models.some(
        (m) =>
          m.id === bot.modelId && m.provider === bot.modelProvider && m.input.includes("image"),
      ),
    );
  const openThread = (id?: string) => {
    setPanel(undefined);
    setSelectedExecutionTask(undefined);
    sidePane.show("tasks");
    navigate({ name: "chat", groupId, threadId: id });
  };
  const close = () => {
    setPanel(undefined);
    if (threadId) navigate({ name: "chat", groupId });
  };
  // Folder problems are fixed in the header's folder picker (same as a DM chat).
  const [folderRequest, setFolderRequest] = useState(0);
  const openWorkplace = useCallback(() => setFolderRequest((value) => value + 1), []);
  const pause = async () => {
    if (!group || !data.identityReady) return;
    const updated = await action.run(
      (signal) =>
        waitRpc(
          () => peer.call("groups.update", { groupId, paused: !group.paused }),
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        ),
      () => "group.saveFailed",
    );
    if (updated?.id === groupId) await controller.refresh();
  };
  const roundLimitId = !group?.paused && data.cycle?.limited ? data.cycle.roundLimitId : undefined;
  const raiseTo = group && roundLimitId ? nextGroupRoundLimit(group.autoRoundLimit) : undefined;
  const continueRounds = async (autoRoundLimit?: number) => {
    if (!group || !roundLimitId || !data.identityReady || action.busy) return;
    await action.run(
      (signal) =>
        waitRpc(
          () =>
            peer.call("groups.rounds.continue", {
              groupId,
              roundLimitId,
              expectedLimit: group.autoRoundLimit,
              autoRoundLimit,
            }),
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        ),
      (error) =>
        error instanceof RpcError && error.message === "group_rounds_stale"
          ? "group.roundsContinueStale"
          : "group.saveFailed",
    );
    await controller.refresh();
  };
  // Changes sidebar: a group uses its primary folder; the coordinator acts for it.
  const baseSidePane = useSidePane(true);
  const closeSidePane = useCallback(() => {
    baseSidePane.close();
    if (threadId) navigate({ name: "chat", groupId });
  }, [baseSidePane.close, threadId, navigate, groupId]);
  const sidePane = { ...baseSidePane, close: closeSidePane };
  const officePreview = useOfficePreview(viewConversationId, sidePane, close);
  useEffect(() => {
    if (threadId) {
      setPanel(undefined);
      sidePane.show("tasks");
    }
  }, [threadId, sidePane.show]);
  const [selectedExecutionTask, setSelectedExecutionTask] = useState<{
    botId: string;
    taskId: string;
  }>();
  const topicIdentity = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = topicIdentity.current;
    topicIdentity.current = group?.conversationId;
    if (previous && previous !== group?.conversationId) {
      setSelectedExecutionTask(undefined);
      setSelectedTopic(undefined);
      sidePane.close();
    }
  }, [group?.conversationId, sidePane.close]);
  const execution = useExecutionWorkspace(
    data.identityReady && data.membersReady ? data.bots : [],
    isDraft ? undefined : group?.conversationId,
    (botId, taskId) => {
      setSelectedExecutionTask(botId && taskId ? { botId, taskId } : undefined);
      setPanel(undefined);
      sidePane.show("tasks");
    },
    groupId,
  );
  const changes = useChatChanges({
    peer,
    conversationKey: group ? `group:${groupId}` : undefined,
    active: !!group && data.identityReady && !isDraft,
    pane: sidePane,
    otherPanelOpen: !!panel,
    closeOtherPanel: close,
    preview: officePreview.open,
  });
  const paneSend = useRef<((text: string) => Promise<boolean>) | undefined>(undefined);
  const draftFeedback = useRef<((conversationId: string, text: string) => void) | undefined>(
    undefined,
  );
  const sendFromPane = useCallback(
    async (text: string) => (paneSend.current ? paneSend.current(text) : false),
    [],
  );
  const running = data.runs.some((run) => run.status === "queued" || run.status === "running");
  const working = data.runs.filter((run) => run.status === "running");
  const runningNames = [
    ...new Set(
      (working.length ? working : data.runs.filter((run) => run.status === "queued")).map(
        (run) => data.bots.find((bot) => bot.id === run.botId)?.name ?? t("group.member"),
      ),
    ),
  ].join(" · ");
  const coordinator = data.bots.find((bot) => bot.id === group?.coordinatorBotId);
  // The frame port and takeover need the full RPC peer, not the chat's call/on subset.
  const { peer: rpcPeer } = useRpc();
  const memberIds = useMemo(() => data.bots.map((bot) => bot.id), [data.bots]);
  const browser = useGroupBrowserSlot(memberIds, {
    groupId: group?.id,
    peer: rpcPeer,
    running,
    pane: sidePane,
    otherPanelOpen: !!panel,
  });
  const browserBot = data.bots.find((bot) => bot.id === browser.botId);
  const refreshGroup = controller.refresh;
  const groupChanged = useCallback(() => void refreshGroup(), [refreshGroup]);
  const activeFolderModel = useGroupFolders({
    peer: data.identityReady ? peer : null,
    group,
    running,
    changed: groupChanged,
  });
  const folderModel = isDraft ? draftFolders.model : activeFolderModel;
  const historicalFolder = selectedTopic?.folders.find(
    (folder) => folder.id === selectedTopic.primaryFolderId,
  );
  const folderText = selectedTopic
    ? (historicalFolder?.displayPath ?? t("folders.groupHome"))
    : !linkedHistory && folderModel
      ? folderLabel(folderModel, t)
      : "";
  // Reply cards read the sidebar link from context; `body` keeps the chat markup unindented.
  const body = (
    <main className={chatStyles.main}>
      <ChatHeader
        name={group?.name ?? t("group.title")}
        state={running ? "working" : "idle"}
        profileLabel={t("group.panel")}
        profileId="group-panel"
        profileDisabled={!group || !data.identityReady}
        onProfile={() => (panel ? close() : setPanel("details"))}
        panelOpen={!!panel}
        avatar={
          <GroupAvatar size={36}>
            {data.bots.map((bot) => (
              <BotAvatar key={bot.id} bot={bot} label={bot.name} size={22} />
            ))}
          </GroupAvatar>
        }
        topics={
          group && (
            <GroupTopics
              peer={peer}
              group={group}
              selected={selectedTopic}
              conversationId={isDraft ? undefined : viewConversationId}
              linkedTitle={linkedHistory ? (groupView?.topicTitle ?? t("group.topics")) : undefined}
              select={chooseTopic}
              draft={isDraft}
              refresh={controller.refresh}
              running={running}
            />
          )
        }
        modelOverride={
          group &&
          !readonly &&
          !isDraft &&
          coordinator &&
          coordinator.kind !== "agent" && (
            <ModelOverrideControl
              key={group.conversationId}
              peer={peer}
              kind="topic"
              category={coordinator.category ?? "chat"}
              override={group.topicModelOverride}
              disabled={!data.identityReady}
              save={(override) =>
                peer.call("chat.topicModel.set", { conversationId: group.conversationId, override })
              }
            />
          )
        }
        folders={
          <>
            {!readonly && folderModel && (
              <FolderPicker
                model={folderModel}
                disabled={!group || !data.identityReady}
                openRequest={folderRequest}
                footer={
                  !isDraft ? (
                    <>
                      <ProjectMemoryFolderMenu model={folderModel} />
                      <AutoCheckFolderMenu
                        botIds={memberIds}
                        conversationId={group?.conversationId}
                        nameOf={(id) =>
                          data.bots.find((bot) => bot.id === id)?.name ?? t("group.member")
                        }
                      />
                    </>
                  ) : undefined
                }
              />
            )}
            {readonly && folderText && (
              <span className={chatStyles.subtitleText} title={folderText}>
                {folderText}
              </span>
            )}
          </>
        }
        changes={
          !readonly && (
            <div className={sidePaneStyles.pills}>
              <SidePaneActions
                pane={sidePane}
                changes={changes.state}
                previewCount={officePreview.count}
                hasDirectory={!!(selectedTopic ? historicalFolder : folderModel)}
                browserActive={!!browserBot}
                disabled={!group || !data.identityReady || isDraft}
                openTasks={execution.open}
                openChanges={changes.togglePill}
                taskFailures={
                  data.tasks.filter(
                    (task) =>
                      task.status === "open" &&
                      task.activity?.failure &&
                      groupTaskIsChild(task, group?.coordinatorBotId ?? ""),
                  ).length
                }
              />
            </div>
          )
        }
        yolo={
          !readonly && (
            <YoloControl
              peer={data.identityReady ? peer : null}
              conversationId={isDraft ? undefined : group?.conversationId}
              topicGroupId={groupId}
              group
            />
          )
        }
        newTopicDisabled={!group || !data.identityReady}
        onNewTopic={() => {
          setSelectedTopic(undefined);
          setPanel(undefined);
          baseSidePane.close();
          navigate({ name: "chat", groupId, draftId: crypto.randomUUID() });
        }}
      />
      {usage && (
        <div className={styles.notice}>
          <span>{t("group.usage")}</span>
          <IconButton
            variant="ghost"
            label={t("group.dismissUsage")}
            onClick={() => {
              setUsage(false);
              try {
                localStorage.setItem("pibot.group.usage.dismissed", "true");
              } catch {
                /* Keep this session’s dismissal when storage is unavailable. */
              }
            }}
          >
            <Icon name="close" size={14} />
          </IconButton>
        </div>
      )}
      {group && !readonly && !isDraft && (
        <div
          className={styles.rounds}
          data-paused={group.paused || undefined}
          data-limited={!!roundLimitId || undefined}
        >
          <span className={styles.roundsText} role="status">
            {t(
              !data.identityReady || !data.cycle
                ? "group.roundsUnknown"
                : group.paused
                  ? "group.paused"
                  : roundLimitId
                    ? "group.roundsReached"
                    : data.cycle.limited
                      ? "group.limited"
                      : "group.rounds",
              { rounds: data.cycle?.rounds ?? t("network.unknown"), limit: group.autoRoundLimit },
            )}
            {!group.paused &&
              !!data.cycle?.handoffs &&
              t("group.handoffs", { count: data.cycle.handoffs, limit: HANDOFF_LIMIT })}
          </span>
          {/* How far the automatic back-and-forth has gone toward its limit. */}
          {!group.paused && data.cycle && group.autoRoundLimit > 0 && (
            <span className={styles.roundsBar} aria-hidden="true">
              <i
                style={{
                  width: `${Math.min(100, (100 * data.cycle.rounds) / group.autoRoundLimit)}%`,
                }}
              />
            </span>
          )}
          {roundLimitId && (
            <div className={styles.roundActions}>
              <Button
                variant="pill"
                disabled={action.busy || data.error || !data.identityReady}
                onClick={() => void continueRounds()}
              >
                {t("group.roundsReset")}
              </Button>
              {raiseTo !== undefined && (
                <Button
                  variant="pill"
                  disabled={action.busy || data.error || !data.identityReady}
                  onClick={() => void continueRounds(raiseTo)}
                >
                  {t("group.roundsRaise", { limit: raiseTo })}
                </Button>
              )}
            </div>
          )}
          <div className={styles.toggle}>
            <span>{t("group.pause")}</span>
            <Switch
              label={t("group.pause")}
              checked={group.paused}
              disabled={action.busy || data.error || !data.identityReady}
              onCheckedChange={() => void pause()}
            />
          </div>
        </div>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
      {data.error && (
        <p role="alert" className={styles.error}>
          {t("group.loadError")}{" "}
          <Button variant="ghost" onClick={() => void controller.refresh()}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {group && !data.identityReady && (
        <div role="status" className={styles.notice}>
          {t("group.cachedPreview")}
        </div>
      )}
      {data.detailsError && (
        <p role="alert" className={styles.error}>
          {t("group.loadError")}{" "}
          <Button variant="ghost" onClick={() => void controller.refresh()}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      <div
        className={`${chatStyles.body} ${sidePane.open ? (sidePane.full ? sidePaneStyles.fullBody : sidePane.wide ? sidePaneStyles.wideBody : "") : ""}`}
      >
        {group ? (
          // Reset message drafts without remounting the group's sidebar on task navigation.
          <MessageReplyProvider key={JSON.stringify([viewConversationId, threadId])}>
            <GroupConversationView
              peer={peer}
              target={{
                groupId,
                conversationId: viewConversationId ?? group.conversationId,
                ...(draftId ? { draftId, draftSelection: draftFolders.selection } : {}),
              }}
              draftFolders={
                isDraft ? (
                  <div className={chatStyles.draftFolders}>
                    {t("folders.draftLine", { folder: "\u0000" }).split("\u0000")[0]}
                    <FolderPicker
                      model={draftFolders.model}
                      variant="draft"
                      inherit={draftFolders.inherit}
                      placement="above"
                    />
                    {t("folders.draftLine", { folder: "\u0000" }).split("\u0000")[1]}
                    <span className={chatStyles.draftFoldersNote}>· {t("folders.draftNote")}</span>
                  </div>
                ) : undefined
              }
              statusBar={
                !readonly && !isDraft && data.identityReady ? (
                  <GroupRunBar
                    group={group}
                    bots={data.bots}
                    runs={data.runs}
                    busy={action.busy || data.error}
                    toggle={() => void pause()}
                  />
                ) : undefined
              }
              readonly={readonly}
              linkedHistory={linkedHistory}
              data={data}
              images={images}
              refresh={controller.refresh}
              openTask={readonly ? undefined : openThread}
              openTasks={readonly ? undefined : () => openThread()}
              sendRef={paneSend}
              draftFeedbackRef={draftFeedback}
              layoutKey={`${sidePane.open}|${sidePane.wide}|${sidePane.full}|${!!panel}`}
              openWorkplace={openWorkplace}
            />
          </MessageReplyProvider>
        ) : (
          <p role="status" className={styles.note}>
            {t(data.loading ? "common.loading" : "group.deleted")}
          </p>
        )}
        {browser.watchers}
        {group && !isDraft && (!readonly || sidePane.tab === "preview") && (
          <SidePane
            pane={sidePane}
            slots={[
              officePreview.slot,
              {
                id: "tasks",
                content: (
                  <GroupTaskWorkspace
                    key={group.conversationId}
                    selectedExecutionTask={selectedExecutionTask}
                    peer={peer}
                    data={data}
                    task={thread.task}
                    threadId={threadId}
                    threadError={thread.error}
                    retryThread={thread.retry}
                    openThread={openThread}
                    refresh={controller.refresh}
                    taskSummary={taskSummary}
                  >
                    <TasksPane
                      selected={selectedExecutionTask}
                      back={() => setSelectedExecutionTask(undefined)}
                    />
                  </GroupTaskWorkspace>
                ),
              },
              {
                id: "changes",
                content: changes.target ? (
                  <ChangesPane
                    key={changes.target.conversationKey}
                    peer={peer}
                    conversationKey={changes.target.conversationKey}
                    ownerBotId={group.coordinatorBotId}
                    botName={coordinator?.name ?? t("group.member")}
                    runningName={runningNames || t("group.member")}
                    running={running}
                    wide={sidePane.wide}
                    active
                    request={changes.request}
                    send={sendFromPane}
                  />
                ) : null,
              },
              {
                id: "browser",
                content: browserBot ? (
                  <BrowserSlot
                    key={`${group.id}:${browserBot.id}`}
                    groupId={group.id}
                    botId={browserBot.id}
                    botName={browserBot.name}
                    peer={rpcPeer}
                    pane={sidePane}
                    running={running}
                    conversationId={group?.conversationId}
                    onFeedback={(conversationId, text) =>
                      draftFeedback.current?.(conversationId, text)
                    }
                  />
                ) : null,
              },
            ]}
          />
        )}
        {group && panel && (
          <GroupPanel
            peer={peer}
            data={{ ...data, error: data.error || !data.identityReady || !data.membersReady }}
            tab={panel}
            changeTab={(tab) => {
              if (tab === "details") workplaces.refresh();
              setPanel(tab);
            }}
            close={close}
            places={places?.places}
            refresh={controller.refresh}
            conversationId={isDraft ? undefined : viewConversationId}
            selectedTopic={selectedTopic}
            draft={isDraft}
            selectTopic={(topic) => {
              chooseTopic(topic);
              close();
            }}
          />
        )}
      </div>
    </main>
  );
  return (
    <OfficePreviewContext.Provider value={officePreview.open}>
      <ExecutionContext.Provider value={execution}>
        <ChangesLinkContext.Provider value={changes.link}>{body}</ChangesLinkContext.Provider>
      </ExecutionContext.Provider>
    </OfficePreviewContext.Provider>
  );
}
