import type { ChatPeer } from "@pibot/client-core";
import { ComputerHandoffCard } from "@pibot/computer-use/ui";
import type { ChatNotice, Message } from "@pibot/protocol";
import { approvalStyles, useNavigation, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { GitInstallCard } from "@pibot/workspaces/ui";
import { memo, useEffect, useMemo, useState } from "react";
import { AutoCheckProposal, AutoCheckResult } from "../../autocheck/AutoCheckNotices.tsx";
import { RunnerMoveCard } from "../../folders/RunnerMoveCard.tsx";
import { CommandProtectionCard } from "../../settings/permissions/CommandProtectionCard.tsx";
import styles from "../chat.module.css";
import { BrowserExtensionInstallCard } from "./BrowserExtensionInstallCard.tsx";
import { ConnectionNeeded } from "./ConnectionNeeded.tsx";
import { type BlockWarning, SandboxBlockLine } from "./SandboxNotices.tsx";

// The newest records are what a chat shows; older ones only matter once history reaches them.
const NOTICE_PAGE = 50;

/**
 * Chat system records (e.g. browser hand-back) of one conversation, oldest first. They are
 * display-only facts kept outside the message list, so the chat controllers stay untouched.
 */
export function useChatNotices(peer: ChatPeer | null, conversationId: string | undefined) {
  const [state, setState] = useState<{ key?: string; notices: ChatNotice[] }>({ notices: [] });
  useEffect(() => {
    if (!peer || !conversationId) return;
    let live = true;
    const seen = new Map<string, ChatNotice>();
    const publish = () => {
      if (!live) return;
      const notices = [...seen.values()].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      setState({ key: conversationId, notices: notices.slice(-NOTICE_PAGE) });
    };
    const off = peer.on("chat.notice", (notice) => {
      if (notice.conversationId !== conversationId) return;
      seen.set(notice.id, notice);
      publish();
    });
    peer.call("chat.notices", { conversationId, limit: NOTICE_PAGE }).then(
      (rows) => {
        // A live update (e.g. the matching approval link) can arrive while this read is pending.
        // Its newer record must not be replaced by the earlier snapshot response.
        for (const notice of rows) if (!seen.has(notice.id)) seen.set(notice.id, notice);
        publish();
      },
      () => {
        // Records are a side note; a failed read just leaves the chat without them.
      },
    );
    return () => {
      live = false;
      off();
    };
  }, [peer, conversationId]);
  return state.key === conversationId ? state.notices : [];
}

/**
 * Places each record just before the first message created after it; records newer than every
 * message go to `tail`. Records older than the loaded window wait until earlier history (or its
 * start) is loaded, so they never jump to the top of a partial page. One merge pass, O(n + m).
 */
export function placeNotices(messages: Message[], notices: ChatNotice[], complete: boolean) {
  const before = new Map<string, ChatNotice[]>();
  const tail: ChatNotice[] = [];
  let i = 0;
  const first = messages[0]?.createdAt;
  for (const notice of notices) {
    // Warnings belong under their command step, not a second line in the timeline.
    if (notice.kind === "agent_warning" && notice.sandbox?.toolCallId) continue;
    if (first && notice.createdAt < first && !complete) continue;
    while (i < messages.length && (messages[i]?.createdAt ?? "") <= notice.createdAt) i++;
    const next = messages[i];
    if (!next) tail.push(notice);
    else before.set(next.id, [...(before.get(next.id) ?? []), notice]);
  }
  return { before, tail };
}

export function usePlacedNotices(
  peer: ChatPeer | null,
  conversationId: string | undefined,
  messages: Message[],
  complete: boolean,
) {
  const notices = useChatNotices(peer, conversationId);
  return useMemo(
    () => ({
      all: notices,
      ...placeNotices(messages, notices, complete),
      // Runs stopped on an open "come help" card show "waiting for you" while it is open.
      waitingRuns: new Set(
        notices.flatMap((notice) =>
          notice.kind === "computer_handoff" && notice.status === "pending" ? [notice.runId] : [],
        ),
      ),
    }),
    [messages, notices, complete],
  );
}

// The verb travels with the duration: Chinese spacing differs for "不到 1 分钟" and "2 分钟".
function took(ms: number, t: ReturnType<typeof useT>) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t("botBrowser.notice.tookUnderMinute");
  if (minutes < 60) return t("botBrowser.notice.tookMinutes", { minutes });
  return t("botBrowser.notice.tookHours", {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

/**
 * One record: a centered line, an automatic check result / proposal card, or a card
 * asking the person to fix a connection (nothing when there is nothing for them to do).
 */
export const ChatNoticeLine = memo(function ChatNoticeLine({
  notice,
  botName,
}: {
  notice: ChatNotice;
  botName: string | undefined;
}) {
  const t = useT();
  const navigation = useNavigation();
  if (notice.kind === "dispatch_model_switch")
    return (
      <p className={styles.systemLine} role="note">
        {t("dispatch.modelSwitch", {
          from: notice.from,
          to: notice.to,
          reason: t(`dispatch.modelReason.${notice.reason}`),
        })}
      </p>
    );
  if (notice.kind === "connection_needed") return <ConnectionNeeded notice={notice} />;
  if (notice.kind === "auto_check")
    return <AutoCheckResult notice={notice} botName={botName ?? t("botBrowser.notice.someone")} />;
  if (notice.kind === "auto_check_proposal")
    return (
      <AutoCheckProposal notice={notice} botName={botName ?? t("botBrowser.notice.someone")} />
    );
  if (notice.kind === "workplace_move_proposal")
    return <RunnerMoveCard notice={notice} botName={botName ?? t("botBrowser.notice.someone")} />;
  if (notice.kind === "computer_handoff")
    return (
      <ComputerHandoffCard notice={notice} botName={botName ?? t("botBrowser.notice.someone")} />
    );
  // Same centered system line as a hand-back; the reason is a fixed sentence per code.
  if (notice.kind === "continuation_stopped")
    return (
      <p className={styles.systemLine} role="note">
        {t(`runtime.continuationStopped.${notice.reasonCode}`)}
      </p>
    );
  if (notice.kind === "attachment_delivery_missing")
    return (
      <p className={styles.systemLine} role="note">
        {t("runtime.attachmentDeliveryMissing")}
      </p>
    );
  if (notice.kind === "group_verification")
    return (
      <p className={styles.systemLine} role="note">
        {t(`runtime.groupVerification.${notice.reason}`)}
      </p>
    );
  if (notice.kind === "browser_extension") return <BrowserExtensionInstallCard notice={notice} />;
  if (notice.kind === "agent_warning" && notice.dependency) {
    const reason = notice.dependency;
    if (reason === "git") return <GitInstallCard context="command" />;
    if (
      reason === "linux_bubblewrap_missing" ||
      reason === "linux_socat_missing" ||
      reason === "linux_userns_restricted"
    )
      return <CommandProtectionCard reason={reason} />;
    return (
      <section className={approvalStyles.approval} aria-label={t("office.convertHelp.title")}>
        <header>
          <strong>{t("office.convertHelp.title")}</strong>
        </header>
        <p>{t(`office.convertHelp.${reason}`)}</p>
        {reason === "libreoffice_isolation_unavailable" && (
          <Button variant="secondary" onClick={() => navigation.openSettings("permissions")}>
            {t("settings.permissions")}
          </Button>
        )}
        {reason === "libreoffice_missing" && (
          <a href="https://www.libreoffice.org/download/" target="_blank" rel="noreferrer">
            {t("office.convertHelp.download")}
          </a>
        )}
        {(reason === "libreoffice_timeout" || reason === "libreoffice_failed") && (
          <details>
            <summary>{t("office.convertHelp.recovery")}</summary>
            <p>{t("office.convertHelp.recoverySteps")}</p>
          </details>
        )}
      </section>
    );
  }
  // The agent's own text, only ever as a React text child (never markdown or HTML).
  if (notice.kind === "agent_warning" && notice.skillRuntime)
    return <SkillRuntimeNotice notice={notice} skill={notice.skillRuntime} />;
  if (notice.kind === "agent_warning")
    if (notice.sandbox) return <SandboxBlockLine notices={[notice as BlockWarning]} />;
  if (notice.kind === "agent_warning")
    return (
      <p className={styles.systemLine} role="note">
        {t("externalAgents.startupNotice", {
          agent: notice.agent ?? botName ?? t("botBrowser.notice.someone"),
          text: notice.text,
        })}
      </p>
    );
  return <HandBackLine notice={notice} botName={botName} />;
});

function SkillRuntimeNotice({
  notice,
  skill,
}: {
  notice: Extract<ChatNotice, { kind: "agent_warning" }>;
  skill: NonNullable<Extract<ChatNotice, { kind: "agent_warning" }>["skillRuntime"]>;
}) {
  const t = useT();
  const navigation = useNavigation();
  return (
    <div className={styles.systemLine} role="note">
      {t("skills.runtime.chatNeeds", { name: skill.name })}{" "}
      <button
        type="button"
        className={styles.sandboxLink}
        onClick={() => {
          navigation.openPage("connectors");
          navigation.navigate({
            name: "connectors",
            skillConnection: { ...skill, botId: notice.botId, prepareRuntime: true },
          });
        }}
      >
        {t("skills.runtime.prepareNow")}
      </button>
    </div>
  );
}

/** Styled like the time separator (design「Bot 浏览器 · 交还后」). */
const HandBackLine = memo(function HandBackLine({
  notice,
  botName,
}: {
  notice: Extract<ChatNotice, { kind: "browser_handback" }>;
  botName: string | undefined;
}) {
  const t = useT();
  const name = botName ?? t("botBrowser.notice.someone");
  const time = took(notice.durationMs, t);
  const separator = t("botBrowser.notice.siteSeparator");
  // "Signed in to" only when a login form submit was detected; otherwise "visited".
  const text = notice.signedIn?.length
    ? t("botBrowser.notice.handBackSignedIn", {
        took: time,
        sites: notice.signedIn.join(separator),
        name,
      })
    : notice.domains.length
      ? t("botBrowser.notice.handBackSites", {
          took: time,
          sites: notice.domains.join(separator),
          name,
        })
      : t("botBrowser.notice.handBack", { took: time, name });
  return (
    <p className={styles.systemLine} role="note">
      {text}
    </p>
  );
});

export function ChatNoticeLines({
  notices,
  botName,
}: {
  notices: ChatNotice[] | undefined;
  botName(botId: string): string | undefined;
}) {
  if (!notices?.length) return null;
  return notices.map((notice) => (
    <ChatNoticeLine key={notice.id} notice={notice} botName={botName(notice.botId)} />
  ));
}
