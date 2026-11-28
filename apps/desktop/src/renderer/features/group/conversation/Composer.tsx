import {
  type GroupConversation,
  mentionOptions,
  mentionQuery,
  pickedMentions,
} from "@pibot/client-core";
import {
  type Bot,
  type ChatAdditionMode,
  type ChatNotice,
  type Message,
  resolveGroupMentions,
  slashHelpRequest,
} from "@pibot/protocol";
import { BotAvatar, useT } from "@pibot/renderer-kit";
import { Button, Icon, IconButton } from "@pibot/ui";
import { type MutableRefObject, type ReactNode, useEffect, useId, useRef, useState } from "react";
import chatStyles from "../../chat/chat.module.css";
import {
  AttachmentButton,
  AttachmentDrafts,
  AttachmentDropOverlay,
  AttachmentIssues,
} from "../../chat/composer/Attachments.tsx";
import { groupDraftKey, useComposerDraft } from "../../chat/composer/composer-drafts.tsx";
import { shouldSend } from "../../chat/composer/input.ts";
import { ModeSwitch } from "../../chat/composer/ModeSwitch.tsx";
import {
  NextReplyField,
  useNextReplySuggestion,
} from "../../chat/composer/NextReplySuggestion.tsx";
import { SendOptions } from "../../chat/composer/SendOptions.tsx";
import { useSkillCommands } from "../../chat/composer/SkillCommands.tsx";
import { useAttachmentDrop } from "../../chat/composer/useAttachmentDrop.ts";
import { useAttachments } from "../../chat/composer/useAttachments.ts";
import { useInputHistory } from "../../chat/composer/useInputHistory.ts";
import { useTextareaHeight } from "../../chat/composer/useTextareaHeight.ts";
import { ReplyDraft, useMessageReply } from "../../chat/messages/MessageReply.tsx";
import { RunStatusNotice } from "../../chat/status/RunStatusNotice.tsx";
import { ExecutionPanel } from "../../execution/ExecutionPanel.tsx";
import { useExecution } from "../../execution/workspace.tsx";
import type { PublicRun } from "../data.ts";
import styles from "../group.module.css";
import { useGroupExecutionMode } from "../tasks/use-group-execution-mode.ts";
import { groupSendTarget } from "./send-target.ts";

export function GroupComposer({
  controller,
  messages,
  notices,
  members,
  images,
  disabled,
  waiting = false,
  thread,
  accepted,
  beforeSend,
  models,
  conversationId,
  draftFeedbackRef,
  fillRef,
  draftFolders,
  statusBar,
  draft = false,
  runs,
  cycleId,
  coordinatorBotId,
  threadBotId,
}: {
  controller: GroupConversation;
  runs: PublicRun[];
  cycleId?: string | null;
  coordinatorBotId?: string;
  threadBotId?: string;
  messages: Message[];
  notices: ChatNotice[];
  members: Bot[];
  images: boolean;
  disabled: boolean;
  waiting?: boolean;
  thread: boolean;
  accepted(): void;
  beforeSend(): void;
  models(): void;
  conversationId?: string;
  draftFolders?: ReactNode;
  /** Maintainers 2026-11-20: the plan's pause / continue bar, shown above the mode row. */
  statusBar?: ReactNode;
  draft?: boolean;
  draftFeedbackRef?: MutableRefObject<((conversationId: string, text: string) => void) | undefined>;
  /** Quick starts fill the draft (replacing an empty one, else added below it), never send. */
  fillRef?: MutableRefObject<((text: string) => void) | undefined>;
}) {
  const t = useT();
  const reply = useMessageReply();
  const groupMode = useGroupExecutionMode(controller.peer, controller.target.groupId);
  const [additionTargetError, setAdditionTargetError] = useState<"ambiguous" | "unavailable">();
  const pendingAddition = controller.getSnapshot().appendUncertain;
  const recipient = () => {
    const explicit = resolveGroupMentions(
      members,
      text,
      pickedMentions(text, picks.current, members),
    );
    return {
      ...groupSendTarget({
        runs,
        groupId: controller.target.groupId,
        conversationId: controller.target.conversationId,
        cycleId,
        coordinatorBotId,
        thread,
        explicit,
      }),
      explicit,
    };
  };
  const id = useId();
  const [text, setText] = useComposerDraft(
    controller.peer,
    groupDraftKey(
      controller.target.groupId,
      controller.target.draftId ?? controller.target.conversationId,
      controller.target.threadId,
    ),
  );
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!draftFeedbackRef || !conversationId) return;
    const append = (sourceId: string, feedback: string) => {
      if (sourceId !== conversationId) return;
      setText((current) => (current ? `${current}\n\n${feedback}` : feedback));
      textarea.current?.focus();
    };
    draftFeedbackRef.current = append;
    return () => {
      if (draftFeedbackRef.current === append) draftFeedbackRef.current = undefined;
    };
  }, [draftFeedbackRef, conversationId, setText]);
  useEffect(() => {
    if (!fillRef) return;
    const fill = (example: string) => {
      setText((current) => (current.trim() ? `${current}\n\n${example}` : example));
      textarea.current?.focus();
    };
    fillRef.current = fill;
    return () => {
      if (fillRef.current === fill) fillRef.current = undefined;
    };
  }, [fillRef, setText]);
  const composing = useRef(false);
  const picks = useRef<{ id: string; name: string }[]>([]);
  const frame = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );
  useTextareaHeight(textarea, text);
  const history = useInputHistory(
    controller.target.conversationId,
    messages,
    text,
    setText,
    textarea,
  );
  const attachments = useAttachments(images, disabled);
  const owners = members.filter((bot) => bot.category !== "image" && !bot.archivedAt);
  const fixedConnectionOwnerId = thread ? threadBotId : reply?.draft?.message.botId;
  const defaultConnectionOwnerId = fixedConnectionOwnerId ?? coordinatorBotId;
  const connectionOwners = owners
    .filter(
      (bot) =>
        bot.kind !== "agent" &&
        (thread || fixedConnectionOwnerId ? bot.id === fixedConnectionOwnerId : true),
    )
    .sort(
      (a, b) =>
        Number(b.id === defaultConnectionOwnerId) - Number(a.id === defaultConnectionOwnerId),
    );
  const skillCommands = useSkillCommands({
    owners: owners.filter(
      (bot) =>
        bot.kind !== "agent" && (!fixedConnectionOwnerId || bot.id === fixedConnectionOwnerId),
    ),
    connectionOwners,
    defaultConnectionOwnerId,
    readOnly: groupMode.mode === "plan",
    groupId: controller.target.groupId,
    text,
    edit: history.edit,
    textarea,
    disabled: disabled || attachments.reading,
  });
  const drop = useAttachmentDrop(attachments.add);
  const execution = useExecution();
  const scope =
    execution?.conversationId === controller.target.conversationId ? execution.topics : [];
  const nextReply = useNextReplySuggestion({
    conversationId: controller.target.conversationId,
    messages,
    topics: scope,
    notices,
    completion: skillCommands.helpCompletion,
    completionHidden: disabled || attachments.reading || !!attachments.drafts.length,
    hidden:
      disabled ||
      attachments.reading ||
      !!attachments.drafts.length ||
      !!reply?.draft ||
      messages.some((message) => message.status === "streaming") ||
      scope.some((topic) =>
        topic.tasks.some((task) => ["queued", "running", "stopping"].includes(task.status)),
      ),
    text,
    edit: history.edit,
    textarea,
  });
  const query = !thread && !dismissed && !composing.current ? mentionQuery(text, caret) : undefined;
  const options = query !== undefined && !disabled ? mentionOptions(query, members) : [];
  const activeOption = Math.min(selected, Math.max(0, options.length - 1));
  const pick = (bot: Bot) => {
    if (query === undefined) return;
    const start = caret - query.length - 1;
    // The token shows the name; the picked ID goes along with the message so the brain does not
    // have to guess between members (names are unique now, older data may still repeat one).
    picks.current = [...picks.current, { id: bot.id, name: bot.name }];
    const prefix = `${text.slice(0, start)}@${bot.name} `;
    history.edit(prefix + text.slice(caret));
    setCaret(prefix.length);
    setDismissed(true);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(prefix.length, prefix.length);
    });
  };
  const send = async (mode: ChatAdditionMode = "steer") => {
    if (disabled || attachments.reading || (!text.trim() && !attachments.drafts.length)) return;
    const value = text;
    let target: ReturnType<typeof recipient>;
    try {
      target = recipient();
    } catch {
      setAdditionTargetError("ambiguous");
      return;
    }
    if (target.ambiguous && !waiting) {
      setAdditionTargetError("ambiguous");
      return;
    }
    setAdditionTargetError(undefined);
    beforeSend();
    const sendQueued = () =>
      controller.send(
        value,
        attachments.drafts.map((d) => d.input),
        pickedMentions(value, picks.current, members),
        reply?.draft?.message.id,
      );
    if (
      await (target.run &&
      !waiting &&
      !reply?.draft &&
      (attachments.drafts.length || !slashHelpRequest(value))
        ? controller.append(
            value,
            attachments.drafts.map((d) => d.input),
            target.run,
            mode,
            thread ? target.run.botId : target.explicit[0],
            sendQueued,
          )
        : sendQueued())
    ) {
      picks.current = [];
      history.reset();
      attachments.clear();
      if (reply?.draft) reply.clear(reply.draft.message.id);
      setText((current) => (current === value ? "" : current));
      accepted();
    }
  };
  let busy = false;
  try {
    busy = !!recipient().run;
  } catch {
    /* The send handler shows an ambiguous-name error. */
  }
  return (
    <section
      ref={drop.root}
      {...drop.handlers}
      className={`${chatStyles.composerArea} ${styles.composerArea}`}
      aria-label={t("group.send")}
    >
      <AttachmentDropOverlay active={drop.dragging} />
      <RunStatusNotice peer={controller.peer} messages={messages} />
      {additionTargetError && (
        <p role="alert" className={chatStyles.notice}>
          {t(
            additionTargetError === "ambiguous"
              ? "chat.groupAdditionTarget"
              : "chat.appendUnavailable",
          )}
        </p>
      )}
      {groupMode.error && (
        <p role="alert" className={chatStyles.notice}>
          {t("execution.loadError")}{" "}
          <Button variant="pill" onClick={groupMode.retry}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      <ReplyDraft textarea={textarea} disabled={disabled} />
      <AttachmentIssues
        issues={attachments.issues}
        dismiss={attachments.dismissIssue}
        openModels={models}
      />
      {attachments.reading && <p role="status">{t("attachments.reading")}</p>}
      <AttachmentDrafts
        drafts={attachments.drafts}
        remove={attachments.remove}
        disabled={disabled || attachments.reading}
      />
      {!draft && <ExecutionPanel />}
      <div className={styles.mentionAnchor}>
        {skillCommands.popup}
        {options.length > 0 && (
          <div id={id} role="listbox" aria-label={t("group.mention")} className={styles.mentions}>
            <div className={styles.mentionHeading} aria-hidden="true">
              {t("group.mentionHeading")}
            </div>
            {options.map((bot, index) => (
              <button
                type="button"
                role="option"
                id={`${id}-${index}`}
                aria-selected={activeOption === index}
                tabIndex={-1}
                key={bot.id}
                className={styles.mention}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(bot)}
              >
                <span className={styles.mentionName}>
                  <span aria-hidden="true">
                    <BotAvatar bot={bot} size={22} label={bot.name} />
                  </span>
                  {bot.name}
                </span>
                {members.filter((b) => b.name === bot.name).length > 1 ? (
                  <small>{bot.id}</small>
                ) : (
                  bot.id === coordinatorBotId && <small>{t("group.coordinator")}</small>
                )}
              </button>
            ))}
          </div>
        )}
        {waiting && (!!text.trim() || attachments.drafts.length > 0) && (
          <p className={styles.note} role="status">
            {t("chat.additionWaiting")}
          </p>
        )}
        {statusBar}
        {/* Same row as a direct chat: mode switch and a draft's folder line side by side. */}
        <div className={chatStyles.composerControls}>
          <ModeSwitch
            modeControl={{
              mode: groupMode.mode,
              ready: groupMode.ready,
              change: (mode) => void groupMode.change(mode),
            }}
          />
          {draftFolders}
        </div>
        <form
          className={chatStyles.composer}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <AttachmentButton disabled={disabled || attachments.reading} add={attachments.add} />
          <NextReplyField suggestion={nextReply}>
            <textarea
              ref={textarea}
              className={chatStyles.input}
              rows={1}
              disabled={disabled}
              value={text}
              placeholder={
                nextReply.text ? "" : t(thread ? "group.threadPlaceholder" : "group.placeholder")
              }
              aria-describedby={nextReply.id}
              aria-label={t(thread ? "group.threadPlaceholder" : "group.placeholder")}
              aria-autocomplete="list"
              aria-controls={
                skillCommands.open ? skillCommands.id : options.length ? id : undefined
              }
              aria-activedescendant={
                skillCommands.open
                  ? skillCommands.activeId
                  : options.length
                    ? `${id}-${activeOption}`
                    : undefined
              }
              onChange={(e) => {
                nextReply.dismiss();
                history.edit(e.currentTarget.value);
                setCaret(e.currentTarget.selectionStart);
                setDismissed(false);
                setSelected(0);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onBlur={() => setDismissed(true)}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length) {
                  e.preventDefault();
                  void attachments.add(files);
                }
              }}
              onCompositionStart={() => {
                composing.current = true;
                nextReply.composition(true);
                setDismissed(true);
              }}
              onCompositionEnd={() => {
                composing.current = false;
                nextReply.composition(false);
                setDismissed(false);
              }}
              onKeyDown={(e) => {
                if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (skillCommands.onKeyDown(e, composing.current)) return;
                if (nextReply.onKeyDown(e, composing.current)) return;
                if (
                  options.length &&
                  ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key) &&
                  !e.shiftKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  !e.altKey
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === "Escape") setDismissed(true);
                  else if (e.key === "Enter") {
                    const bot = options[activeOption];
                    if (bot) pick(bot);
                  } else
                    setSelected(
                      (s) =>
                        (s + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length,
                    );
                  return;
                }
                if (history.onKeyDown(e, composing.current)) return;
                if (shouldSend(e.nativeEvent, composing.current)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </NextReplyField>
          <SendOptions
            disabled={disabled || attachments.reading}
            busy={busy}
            modeControl={{
              mode: groupMode.mode,
              ready: groupMode.ready,
              change: (mode) => void groupMode.change(mode),
            }}
            send={
              (!text.trim() && !attachments.drafts.length) || disabled
                ? undefined
                : (mode) => void send(mode)
            }
          />
          {pendingAddition ? (
            <IconButton
              type="button"
              variant="primary"
              className={chatStyles.composerButton}
              label={t("chat.appendConfirm")}
              disabled={controller.getSnapshot().sending}
              onClick={() =>
                void controller.confirmAppend().then((confirmedText) => {
                  if (typeof confirmedText === "string") {
                    history.reset();
                    attachments.clear();
                    setText((current) => (current === confirmedText ? "" : current));
                  }
                })
              }
            >
              <Icon name="check" />
            </IconButton>
          ) : (
            <IconButton
              type="submit"
              variant="primary"
              className={chatStyles.composerButton}
              label={t("group.send")}
              disabled={
                disabled || attachments.reading || (!text.trim() && !attachments.drafts.length)
              }
            >
              <Icon name="arrow" />
            </IconButton>
          )}
        </form>
      </div>
      <span className={chatStyles.hint}>{t("chat.inputHint")}</span>
    </section>
  );
}
