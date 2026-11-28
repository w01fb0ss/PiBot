import type { createTranslator } from "@pibot/i18n";
import {
  type Message,
  type MessageForward,
  messageForward,
  messageQuestionAnswerText,
} from "@pibot/protocol";
import { planSystemText } from "./plan-system-text.ts";
import { routineTriggerText } from "./routine-trigger-text.ts";
import { displayTopicTitle } from "./topic-title.ts";

type Translate = ReturnType<typeof createTranslator>;

export interface ForwardCardItem {
  key: string;
  sender: string;
  time: string;
  quote?: string;
  /** Plain text: forwarded messages are untrusted and never rendered as Markdown. */
  body: string;
}
export interface ForwardCard {
  title: string;
  items: ForwardCardItem[];
  /** Markdown for the safe renderer, labelled as reference by `summaryLabel`. */
  summary?: string;
  summaryLabel: string;
  truncatedNote?: string;
}

/**
 * Model input can contain a routine's trigger instructions or the context of a choice card.
 * The bubble uses the display facts so that those instructions are not attributed to the user.
 */
export function messageBubbleText(
  message: Pick<Message, "content" | "usage"> &
    Partial<Pick<Message, "role" | "runId" | "routineTrigger">>,
  t: Translate,
) {
  if (message.routineTrigger) return routineTriggerText(message.routineTrigger, t);
  if (message.role === "user") {
    const answer = messageQuestionAnswerText(message);
    if (answer !== undefined) return answer;
  }
  const forward = messageForward(message);
  if (!forward) return planSystemText(message, t);
  return forward.note || t("messages.forwardedCount", { count: forward.messageCount });
}

/** The collapsed card under a forwarded message; desktop and phone render the same parts. */
export function forwardCard(
  forward: MessageForward,
  t: Translate,
  formatTime: (iso: string) => string,
): ForwardCard {
  const from = forward.source.topic
    ? t("messages.forwardedFromTopic", {
        chat: forward.source.chat,
        topic: displayTopicTitle(forward.source.topic, t("messages.forwardedTitle")),
      })
    : t("messages.forwardedFrom", { chat: forward.source.chat });
  return {
    title: `${t("messages.forwardedCount", { count: forward.messageCount })} · ${from}`,
    items: forward.messages.map((record, index) => {
      const files = record.attachments.map((a) => a.name).join(", ");
      const body = [record.text, files && t("messages.forwardedAttachments", { names: files })]
        .filter(Boolean)
        .join("\n");
      return {
        key: `${index}:${record.at}`,
        sender: record.role === "user" ? t("chat.you") : record.sender,
        time: formatTime(record.at),
        // A quoted user message has no author name in its snapshot.
        ...(record.quoted
          ? {
              quote: record.quoted.sender
                ? `${record.quoted.sender}: ${record.quoted.text}`
                : record.quoted.text,
            }
          : {}),
        body,
      };
    }),
    ...(forward.summary ? { summary: forward.summary } : {}),
    summaryLabel: t("messages.forwardedSummary"),
    ...(forward.truncated ? { truncatedNote: t("messages.forwardedTruncated") } : {}),
  };
}

/**
 * C7: a routine confirmation carries display facts beside the model's fixed notice. Desktop and
 * phone show the same quiet line; the phone showed the raw bilingual notice as the user's bubble
 * (video rehearsal 2026-11-20). Anything malformed returns undefined and keeps the ordinary bubble.
 */
export function routineNoticeText(
  message: Pick<Message, "usage"> & Partial<Pick<Message, "role">>,
  t: Translate,
  formatTime: (iso: string) => string,
): string | undefined {
  const usage = message.usage;
  if (message.role !== "user" || !usage || typeof usage !== "object" || Array.isArray(usage))
    return undefined;
  const notice = (usage as Record<string, unknown>).routineNotice;
  if (!notice || typeof notice !== "object" || Array.isArray(notice)) return undefined;
  const fields = notice as Record<string, unknown>;
  const name = typeof fields.name === "string" ? fields.name : t("routineProposal.untitled");
  const label = t(
    fields.kind === "updated" ? "routines.notice.updated" : "routines.notice.created",
    {
      name,
    },
  );
  const at = typeof fields.at === "string" ? fields.at : undefined;
  return at && !Number.isNaN(Date.parse(at))
    ? `${label} · ${t("routines.next")} ${formatTime(at)}`
    : label;
}
