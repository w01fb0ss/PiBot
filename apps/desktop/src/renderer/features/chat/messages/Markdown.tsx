import type { TranslationKey } from "@pibot/i18n";
import { RpcError } from "@pibot/protocol";
import { useAction, useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import { useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTopicReference } from "../../../app/topic-reference.tsx";
import styles from "../chat.module.css";
import { ExternalImage } from "./ExternalImage.tsx";
import { remarkCjkStrong } from "./markdown-cjk-strong.ts";
import { remarkMentions } from "./markdown-mentions.tsx";

export function externalUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replies can point at a topic with `pibot://topic/<conversationId>?message=<id>`.
 * Only that exact shape becomes in-app navigation; anything else stays untrusted text.
 */
export function topicReference(href: string | undefined) {
  if (!href?.startsWith("pibot://topic/")) return undefined;
  try {
    const url = new URL(href);
    if (url.protocol !== "pibot:" || url.hostname !== "topic") return undefined;
    const conversationId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!conversationId) return undefined;
    const messageId = url.searchParams.get("message");
    return { conversationId, messageId: messageId || undefined };
  } catch {
    return undefined;
  }
}

/**
 * `obsidian://open?vault=…&file=…` is the only shape that becomes a note button. The
 * strictness matters because the brain re-derives the note from the stored reply: a second `file`,
 * a userinfo, a port or a hash here could name a different note than the one the reply shows.
 */
export function obsidianReference(href: string | undefined) {
  if (!href || href.length > 8192) return undefined;
  try {
    const url = new URL(href);
    if (url.protocol !== "obsidian:" || url.hostname !== "open") return undefined;
    if (url.pathname !== "" && url.pathname !== "/") return undefined;
    if (url.username || url.password || url.port || url.hash) return undefined;
    const keys = [...url.searchParams.keys()];
    const vaultCount = keys.filter((key) => key === "vault").length;
    const fileCount = keys.filter((key) => key === "file").length;
    const sourceCount = keys.filter((key) => key === "source").length;
    if (
      vaultCount !== 1 ||
      fileCount !== 1 ||
      sourceCount > 1 ||
      keys.length !== vaultCount + fileCount + sourceCount
    )
      return undefined;
    const vault = url.searchParams.get("vault");
    const file = url.searchParams.get("file");
    const source = sourceCount === 1 ? url.searchParams.get("source") : undefined;
    if (sourceCount === 1 && !source) return undefined;
    return vault && file ? { href } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * React-markdown erases every URL whose scheme is not http(s)/mailto/…, which would empty
 * the very href the note button needs before it is rendered. Only the exact Obsidian open shape is
 * handed back unchanged; every other URL still goes through the default filter, so this neither
 * widens the global external-link allow-list nor gives the renderer a host capability.
 */
function referenceUrl(url: string) {
  return obsidianReference(url)?.href ?? defaultUrlTransform(url);
}

export function Markdown({
  text,
  mentionNames,
  botId,
  messageId,
  settled,
}: {
  text: string;
  mentionNames?: readonly string[];
  botId?: string;
  messageId?: string;
  settled?: boolean;
}) {
  const t = useT();
  return (
    <ReactMarkdown
      remarkPlugins={
        mentionNames
          ? [remarkGfm, remarkCjkStrong, remarkMentions(mentionNames, styles.mentionText ?? "")]
          : [remarkGfm, remarkCjkStrong]
      }
      remarkRehypeOptions={{
        footnoteLabel: t("chat.footnotes"),
        footnoteBackLabel: (index, occurrence) =>
          t("chat.footnoteBack", {
            reference: `${index + 1}${occurrence > 1 ? `-${occurrence}` : ""}`,
          }),
      }}
      skipHtml
      urlTransform={referenceUrl}
      components={{
        a: ({ href, children, node, ...props }) => {
          // Generated footnote anchors stay in this message and keep their localized ARIA labels.
          if (
            href?.startsWith("#") &&
            node &&
            (Object.hasOwn(node.properties, "dataFootnoteRef") ||
              Object.hasOwn(node.properties, "dataFootnoteBackref"))
          ) {
            return (
              <a {...props} href={href}>
                {children}
              </a>
            );
          }
          const topic = topicReference(href);
          if (topic) return <TopicReference target={topic}>{children}</TopicReference>;
          // A note link only works once the reply is stored and settled: the brain proves the
          // reference against that message, so a streaming or identity-less message has no button.
          const note = settled && messageId ? obsidianReference(href) : undefined;
          if (note && messageId)
            return (
              <NoteReference href={note.href} messageId={messageId}>
                {children}
              </NoteReference>
            );
          const url = externalUrl(href);
          return url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                // main validates http(s) and opens the system browser; renderer gets no host capability.
                window.open(url, "_blank", "noopener,noreferrer");
              }}
            >
              {children}
            </a>
          ) : (
            <span>{children}</span>
          );
        },
        // Remote Markdown must not initiate background image requests to arbitrary hosts.
        img: ({ alt, src }) => (
          <ExternalImage
            key={String(src)}
            src={typeof src === "string" ? src : undefined}
            alt={alt}
            botId={botId}
            messageId={messageId}
            settled={settled}
          />
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/**
 * The brain answers with why this click cannot open, and each of those reasons has its
 * own sentence; anything else stays the generic failure so no server text reaches the UI.
 */
function referenceError(error: unknown): TranslationKey {
  const reason = error instanceof RpcError ? error.message : "";
  switch (reason) {
    case "knowledge_reference_missing":
      return "knowledge.error.reference_missing";
    case "knowledge_reference_invalid":
      return "knowledge.error.reference_invalid";
    case "knowledge_reference_ambiguous":
      return "knowledge.error.reference_ambiguous";
    case "knowledge_reference_changed":
      return "knowledge.error.reference_changed";
    case "knowledge_vault_changed":
      return "knowledge.error.vault_changed";
    case "knowledge_reference_reselect":
      return "knowledge.error.reference_reselect";
    case "knowledge_reference_unsupported":
      return "knowledge.error.reference_unsupported";
    case "knowledge_reference_denied":
      return "knowledge.error.reference_denied";
    case "knowledge_reference_unknown":
      return "knowledge.error.reference_unknown";
    default:
      return "workspace.failed";
  }
}

/**
 * The click sends only the message id and the href the reply rendered; the brain derives the Bot,
 * the vault and the note itself. `useAction` keeps a second click from sending a second request
 * while the host is still reading Obsidian's configuration.
 */
function NoteReference({
  href,
  messageId,
  children,
}: {
  href: string;
  messageId: string;
  children: React.ReactNode;
}) {
  const t = useT();
  const { peer } = useRpc();
  const { openPage, navigate } = useNavigation();
  const action = useAction();
  const [revealNote, setRevealNote] = useState<TranslationKey>();
  const needsRepoint =
    action.error === "knowledge.error.vault_changed" ||
    action.error === "knowledge.error.reference_reselect";
  return (
    <>
      <button
        type="button"
        className={styles.noteReference}
        title={t("knowledge.openNote")}
        disabled={action.busy || !peer}
        onClick={() => {
          if (!peer) return;
          setRevealNote(undefined);
          void action
            .run(
              (signal) =>
                peer.call(
                  "knowledge.openReference",
                  { messageId, href },
                  { signal, timeoutMs: 30_000 },
                ),
              referenceError,
            )
            .then((result) => {
              if (result?.method === "revealed" && result.fallbackReason) {
                setRevealNote(`knowledge.revealed.${result.fallbackReason}` as TranslationKey);
              }
            });
        }}
      >
        {children}
        <span className={styles.noteAction}>
          {t(action.busy ? "knowledge.openingNote" : "knowledge.openNote")}
        </span>
      </button>
      {action.error ? (
        <span className={styles.noteError}>
          {t(action.error)}
          {needsRepoint && peer && (
            <>
              {" "}
              <button
                type="button"
                className={styles.noteReference}
                disabled={action.busy}
                onClick={() => {
                  setRevealNote(undefined);
                  void action
                    .run(
                      (signal) =>
                        peer.call("knowledge.repointReference", { messageId, href }, { signal }),
                      referenceError,
                    )
                    .then((result) => {
                      if (!result) return;
                      openPage("connectors");
                      navigate({ name: "connectors", knowledgeSourceId: result.sourceId });
                    });
                }}
              >
                {t("knowledge.openKnowledge")}
              </button>
            </>
          )}
        </span>
      ) : revealNote ? (
        <span className={styles.noteAction}>{t(revealNote)}</span>
      ) : null}
    </>
  );
}

/** Hooks live here so messages without topic references (and tests) never need a workspace. */
function TopicReference({
  target,
  children,
}: {
  target: { conversationId: string; messageId?: string };
  children: React.ReactNode;
}) {
  const t = useT();
  const { open, busy } = useTopicReference();
  return (
    <button
      type="button"
      className={styles.topicReference}
      title={t("chat.openTopicReference")}
      disabled={busy}
      onClick={() => open(target.conversationId, target.messageId)}
    >
      {children}
    </button>
  );
}
