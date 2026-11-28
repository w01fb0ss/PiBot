import type { Bot } from "@pibot/protocol";
import { BotAvatar, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { type ReactNode, useRef } from "react";
import styles from "./chat.module.css";

export function ChatHeader({
  name,
  bot,
  onProfile,
  state,
  folders,
  agentBadge,
  modelOverride,
  panelOpen,
  onNewTopic,
  newTopicDisabled,
  changes,
  yolo,
  topics,
  avatar,
  profileLabel,
  profileId = "bot-panel",
  profileDisabled,
}: {
  name: string;
  bot?: Bot;
  onProfile(): void;
  state: "waiting" | "working" | "idle";
  /** The conversation's folder picker. */
  folders: ReactNode;
  /** An external agent's persistent marker (Windows: runs without sandbox), after the folder. */
  agentBadge?: ReactNode;
  modelOverride?: ReactNode;
  panelOpen: boolean;
  onNewTopic(): void;
  newTopicDisabled: boolean;
  /** Stable task, changes and browser navigation in the chat header. */
  changes?: ReactNode;
  /** The conversation's YOLO badge and "more" menu. */
  yolo?: ReactNode;
  topics?: ReactNode;
  avatar?: ReactNode;
  profileLabel?: string;
  profileId?: string;
  profileDisabled?: boolean;
}) {
  const t = useT();
  const profileButton = useRef<HTMLButtonElement>(null);
  return (
    <header className={styles.header} data-chat-header>
      <div className={styles.headerLead}>
        {/* The avatar opens the same profile as the name (maintainers 2026-10-29). It stays out of the
            tab order and accessibility tree: the name button is the one labelled control. */}
        <button
          type="button"
          className={`${styles.headerAvatar} ${styles.headerAvatarButton}`}
          tabIndex={-1}
          aria-hidden="true"
          disabled={profileDisabled ?? !bot}
          onClick={() => {
            // The panel returns focus to whatever opened it; that must be the labelled name button.
            const focusOptions: FocusOptions & { focusVisible: boolean } = {
              preventScroll: true,
              focusVisible: false,
            };
            profileButton.current?.focus(focusOptions);
            onProfile();
          }}
        >
          {avatar ?? <BotAvatar bot={bot} size={36} label={name} state={state} />}
        </button>
        <div className={styles.headerIdentity}>
          <button
            ref={profileButton}
            type="button"
            data-bot-panel-trigger
            className={styles.profileTrigger}
            aria-label={profileLabel ?? t("workspace.profile")}
            aria-expanded={panelOpen}
            aria-controls={profileId}
            disabled={profileDisabled ?? !bot}
            onClick={onProfile}
            title={name}
          >
            <strong>{name}</strong>
          </button>
          <div className={`${styles.headerSubtitle} ${styles.headerSubline}`}>
            {topics && <div className={styles.headerTopic}>{topics}</div>}
            {topics && (
              <span className={styles.headerSeparator} aria-hidden="true">
                ·
              </span>
            )}
            <div className={styles.headerFolder}>{folders}</div>
            {modelOverride && (
              <>
                <span className={styles.headerSeparator} aria-hidden="true">
                  ·
                </span>
                {modelOverride}
              </>
            )}
            {agentBadge && (
              <>
                <span className={styles.headerSeparator} aria-hidden="true">
                  ·
                </span>
                {agentBadge}
              </>
            )}
          </div>
        </div>
      </div>
      {changes}
      {yolo}
      <Button
        variant="pill"
        className={styles.newTopic}
        aria-label={t("workspace.newTopic")}
        title={t("workspace.newTopic")}
        disabled={(profileDisabled ?? !bot) || newTopicDisabled}
        onClick={onNewTopic}
      >
        <Icon name="plus" size={14} />
        <span className={styles.newTopicLabel}>{t("workspace.newTopic")}</span>
      </Button>
    </header>
  );
}
