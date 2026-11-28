import { replyCards } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import { useChatChanges } from "@pibot/workspaces/ui";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { useExecutionWorkspace } from "../../execution/workspace.tsx";
import { useOfficePreview } from "../../office/preview-context.tsx";
import { useBrowserSlot } from "../../side-pane/BrowserSlot.tsx";
import { useSidePane } from "../../side-pane/use-side-pane.ts";
import { useAgentCommandMenu } from "../composer/AgentCommandMenu.tsx";
import { useNextReplySuggestion } from "../composer/NextReplySuggestion.tsx";
import { useSkillCommands } from "../composer/SkillCommands.tsx";
import type { ConnectedChatProps } from "./chat-screen-model.ts";
import type { useChatMessages } from "./use-chat-messages.tsx";
import type { useChatState } from "./use-chat-state.tsx";

export function useChatWorkspace({
  peer,
  visible,
  disconnected,
  closeBotPanel,
  controller,
  state,
  text,
  retryDraft,
  reply,
  panelOpen,
  actualTopicId,
  isDraft,
  draftMode,
  agentCommands,
  textarea,
  editText,
  scroll,
  atBottom,
  anchor,
  notices,
  waiting,
  runId,
  busy,
  sendingBlocked,
  attachments,
  messageFocus,
}: ConnectedChatProps & ReturnType<typeof useChatState> & ReturnType<typeof useChatMessages>) {
  // Right sidebar: changes and the Bot browser share it with the profile panel.
  const sidePane = useSidePane(visible);
  const officePreview = useOfficePreview(state.conversationId, sidePane, closeBotPanel, visible);
  const [selectedExecutionTask, setSelectedExecutionTask] = useState<{
    botId: string;
    taskId: string;
  }>();
  const execution = useExecutionWorkspace(
    state.bot ? [state.bot] : [],
    state.conversationId,
    (botId, taskId) => {
      setSelectedExecutionTask(botId && taskId ? { botId, taskId } : undefined);
      closeBotPanel();
      sidePane.show("tasks");
    },
  );
  const agentBot = state.bot?.kind === "agent";
  const composerDisabled = disconnected || state.pending || state.loading || attachments.reading;
  const owners = state.bot && state.bot.category !== "image" && !agentBot ? [state.bot] : [];
  const skillMenu = useSkillCommands({
    owners,
    connectionOwners: owners,
    readOnly: (isDraft ? draftMode : execution.topics[0]?.settings?.mode) === "plan",
    text,
    edit: editText,
    textarea,
    disabled: composerDisabled,
  });
  const agentMenu = useAgentCommandMenu({
    enabled: agentBot,
    agentName: state.bot?.name ?? "",
    commands: agentCommands,
    text,
    edit: editText,
    textarea,
    disabled: composerDisabled,
  });
  const skillCommands = agentBot ? agentMenu : skillMenu;
  // Opening, widening or leaving the sidebar re-wraps the messages without a message commit;
  // keep the newest ones in view when the reader was at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin after sidebar layout changes
  useLayoutEffect(() => {
    const container = scroll.current;
    if (container && visible && !messageFocus.pending && atBottom.current)
      container.scrollTop = container.scrollHeight;
  }, [sidePane.open, sidePane.wide, sidePane.full, panelOpen, visible]);
  const executionReplies = useMemo(
    () => replyCards(execution.topics, execution.conversationId, state.messages),
    [execution.topics, execution.conversationId, state.messages],
  );
  const nextReply = useNextReplySuggestion({
    conversationId: state.conversationId,
    messages: state.messages,
    topics: execution.topics,
    notices: notices.all,
    completion: skillMenu.helpCompletion,
    completionHidden:
      !visible ||
      sendingBlocked ||
      attachments.reading ||
      !!attachments.drafts.length ||
      !!retryDraft.attachments.length,
    hidden:
      !visible ||
      sendingBlocked ||
      busy ||
      attachments.reading ||
      !!attachments.drafts.length ||
      !!retryDraft.attachments.length ||
      !!reply?.draft ||
      execution.topics.some((topic) =>
        topic.tasks.some((task) => ["queued", "running", "stopping"].includes(task.status)),
      ),
    text,
    edit: editText,
    textarea,
  });
  const changes = useChatChanges({
    peer,
    conversationKey: state.bot && !isDraft ? `dm:${state.bot.id}` : undefined,
    topicId: actualTopicId,
    active: visible && !disconnected && !isDraft,
    pane: sidePane,
    otherPanelOpen: panelOpen,
    closeOtherPanel: closeBotPanel,
    preview: officePreview.open,
  });
  const browserActive = useBrowserSlot(state.bot?.id, {
    peer: disconnected ? null : peer,
    running: busy,
    pane: sidePane,
    otherPanelOpen: panelOpen,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: The ref is owned by useChatMessages and retains its original stable identity.
  const sendFromPane = useCallback(
    async (value: string) => {
      if (sendingBlocked) return false;
      messageFocus.cancel();
      atBottom.current = true;
      // While a reply runs, sidebar messages wait for it instead of steering it; when waiting on
      // an approval card, queue directly as the next turn.
      return controller.send(value, [], [], waiting ? "queue" : runId ? "followUp" : undefined);
    },
    [sendingBlocked, controller, waiting, runId, messageFocus.cancel],
  );
  const captureScroll = () => {
    const container = scroll.current;
    if (container) anchor.current = { height: container.scrollHeight, top: container.scrollTop };
  };
  const loadMore = async () => {
    if (state.loadingMore || !state.hasMore || state.loading) return;
    captureScroll();
    await controller.loadMore();
  };
  const requestKey: TranslationKey | undefined = state.appendUncertain
    ? "chat.appendUncertain"
    : state.requestError === "image_steer_unsupported"
      ? "media.steerUnsupported"
      : state.requestError === "append_unavailable"
        ? "chat.appendUnavailable"
        : state.requestError === "append_full"
          ? "chat.appendFull"
          : state.requestError === "append_duplicate"
            ? "chat.appendDuplicate"
            : state.requestError === "busy"
              ? "chat.busy"
              : state.requestError === "uncertain"
                ? "chat.sendUncertain"
                : state.requestError === "quote_unavailable"
                  ? "chat.quoteUnavailable"
                  : state.requestError
                    ? `errors.${state.requestError}`
                    : undefined;
  return {
    sidePane,
    officePreview,
    selectedExecutionTask,
    setSelectedExecutionTask,
    execution,
    executionReplies,
    skillCommands,
    nextReply,
    changes,
    browserActive,
    sendFromPane,
    captureScroll,
    loadMore,
    requestKey,
  };
}
