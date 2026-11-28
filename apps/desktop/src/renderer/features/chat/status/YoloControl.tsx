// Show the conversation's YOLO switch and its confirmation.
import { type ChatPeer, isolationReasonText } from "@pibot/client-core";
import { useAction, useSettings, useT } from "@pibot/renderer-kit";
import { Button, Icon, IconButton, IconTile } from "@pibot/ui";
import { useRef, useState } from "react";
import { menuKeys, useMenuPopover } from "../../workspace/profile/use-menu-popover.ts";
import { useGroupTopicArchive, useTopicArchive } from "../topics/use-topic-archive.ts";
import { useConversationYolo } from "./use-conversation-yolo.ts";
import { YoloConfirmation } from "./YoloConfirmation.tsx";
import styles from "./yolo.module.css";

/**
 * The conversation header's "more" menu with the YOLO switch, and while it is on a
 * persistent badge with one-click off. Turning it on always goes through the confirm dialog.
 */
export function YoloControl({
  peer,
  conversationId,
  group = false,
  topicBotId,
  topicGroupId,
}: {
  peer: ChatPeer | null | undefined;
  /** The DM topic or group conversation; a new-topic draft has none (and starts off). */
  conversationId?: string;
  group?: boolean;
  /** Topic archival preserves the Bot or group itself and enters a fresh draft. */
  topicBotId?: string;
  topicGroupId?: string;
}) {
  const { t, settings } = useSettings();
  const { state, set } = useConversationYolo(peer, conversationId);
  const notice =
    state?.isolation.reason === "windows_unisolated"
      ? isolationReasonText(
          state.isolation.reason,
          t,
          settings?.yoloUnisolatedCommands ?? state.isolation.windowsYoloConsent,
        )
      : t("yolo.badgeHint");
  const dmArchive = useTopicArchive(peer, topicBotId, conversationId);
  const groupArchive = useGroupTopicArchive(peer, topicGroupId, conversationId);
  const archive = topicGroupId ? groupArchive : dmArchive;
  const action = useAction();
  const [menu, setMenu] = useState<{ opener: HTMLElement; x: number; y: number }>();
  const [confirmingId, setConfirmingId] = useState<string>();
  const confirming = confirmingId !== undefined && confirmingId === conversationId;
  if (!state && !archive.available && !confirming) return null;
  const change = (enabled: boolean) =>
    action.run(
      (signal) => set(enabled, signal),
      () => "yolo.failed",
    );
  return (
    <span className={styles.control}>
      {state?.enabled && (
        <span className={styles.badge} role="status" title={notice}>
          <span className={styles.badgeLabel}>{t("yolo.badge")}</span>
          <button
            type="button"
            className={styles.badgeOff}
            aria-label={t("yolo.turnOff")}
            title={`${t("yolo.badgeHint")} · ${t("yolo.turnOff")}`}
            disabled={action.busy}
            onClick={() => void change(false)}
          >
            <Icon name="close" size={12} className={styles.badgeClose} />
            <Icon name="warning" size={15} className={styles.badgeCompactIcon} />
          </button>
        </span>
      )}
      <IconButton
        variant="circle"
        label={t("yolo.menu")}
        title={t("yolo.menu")}
        className={styles.more}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(event) => {
          if (menu) return setMenu(undefined);
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ opener: event.currentTarget, x: rect.right - 260, y: rect.bottom + 6 });
        }}
      >
        <Icon name="more" size={17} />
      </IconButton>
      {menu && (
        <YoloMenu
          {...menu}
          enabled={state ? state.enabled : undefined}
          close={() => setMenu(undefined)}
          toggle={() => {
            setMenu(undefined);
            if (state?.enabled) void change(false);
            else setConfirmingId(state?.conversationId);
          }}
          archive={
            archive.available
              ? () => {
                  setMenu(undefined);
                  void archive.run();
                }
              : undefined
          }
          busy={action.busy || archive.busy}
        />
      )}
      {(action.error || archive.error) && !confirming && (
        <span role="alert" className={styles.error}>
          {t(action.error ?? archive.error ?? "yolo.failed")}
        </span>
      )}
      {confirming && peer && (
        <YoloConfirmation
          key={confirmingId}
          peer={peer}
          conversationId={confirmingId}
          group={group}
          close={() => setConfirmingId(undefined)}
          enable={(signal, acknowledged) => set(true, signal, acknowledged)}
        />
      )}
    </span>
  );
}

function YoloMenu({
  opener,
  x,
  y,
  enabled,
  close,
  toggle,
  archive,
  busy,
}: {
  opener: HTMLElement;
  x: number;
  y: number;
  /** Undefined when this conversation cannot have YOLO (a draft, a routine's topic). */
  enabled: boolean | undefined;
  close(): void;
  toggle(): void;
  archive?: () => void;
  busy: boolean;
}) {
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  useMenuPopover(menu, opener, x, y, close);
  return (
    <div
      ref={menu}
      popover="manual"
      role="menu"
      aria-label={t("yolo.menu")}
      className={styles.menu}
      // The menu combines a checkbox switch with the archive action.
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="menuitemcheckbox"]:not(:disabled), [role="menuitem"]:not(:disabled)',
            ),
          ];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : event.key === "ArrowDown"
                  ? index + 1
                  : index - 1;
          items[(next + items.length) % items.length]?.focus();
          event.preventDefault();
          return;
        }
        menuKeys(event, close);
      }}
    >
      {enabled !== undefined && (
        <Button
          variant="ghost"
          role="menuitemcheckbox"
          aria-checked={enabled}
          disabled={busy}
          onClick={toggle}
        >
          <IconTile icon="bolt" tone="orange" size="sm" />
          <span className={styles.menuText}>
            <strong>{t("yolo.menuItem")}</strong>
            <span>{t(enabled ? "yolo.menuOn" : "yolo.menuOff")}</span>
          </span>
          <span className={enabled ? styles.switchOn : styles.switchOff} aria-hidden="true" />
        </Button>
      )}
      {archive && (
        <Button variant="ghost" role="menuitem" disabled={busy} onClick={archive}>
          <IconTile icon="box" tone="amber" size="sm" />
          <span className={styles.menuText}>
            <strong>{t("topic.archive")}</strong>
            <span>{t("topic.archiveHint")}</span>
          </span>
        </Button>
      )}
    </div>
  );
}
