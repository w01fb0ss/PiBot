import { mentionOptions, mentionQuery, pickedMentions } from "@pibot/client-core";
import { type Bot, type ChatAdditionMode, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useEffect, useState } from "react";
import { useMobileSelector, useRuntime } from "../../runtime/context.tsx";
import { useAction } from "../../runtime/use-action.ts";
import type { PendingMessage } from "../../transport/link-port.ts";
import { useAttachments } from "../compose/use-attachments.ts";
import { appendToRun } from "./controls/calls.ts";
import { type ChatScope, isDm, scopeKey, scopeTarget } from "./controls/scope.ts";

const sameTarget = (message: PendingMessage, scope: ChatScope) =>
  message.target.topicId === scope.topicId &&
  (scope.kind === "bot" ? message.target.botId === scope.id : message.target.groupId === scope.id);
/**
 * Draft and delivery. Idle or offline: the durable outbox (sent once online, same client ID).
 * While a DM reply runs: steer or queue on that run, online only, never queued on the phone.
 * Attachments always go through the outbox: `chat.append` carries text only, so a
 * message with files sent during a reply becomes the next turn instead of a steer.
 */
export function useComposer(
  scope: ChatScope | undefined,
  runId: string | undefined,
  busyMode: ChatAdditionMode,
  /** Group members offered by the @ list; empty in a DM. */
  members: readonly Bot[] = [],
) {
  const runtime = useRuntime(),
    mobile = useMobileSelector((s) => ({
      selectedId: s.selectedId,
      peer: s.peer,
      status: s.status,
      pending: s.pending,
      delivered: s.delivered,
    }));
  const key = scopeKey(scope);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [picks, setPicks] = useState<{ id: string; name: string }[]>([]);
  const [queued, setQueued] = useState<PendingMessage[]>([]);
  const action = useAction(`${mobile.selectedId}:compose:${key}`, mobile.peer);
  const attachments = useAttachments(`${mobile.selectedId}:${key}`);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a draft belongs to the device and topic, not its socket.
  useEffect(() => {
    setText("");
    setPicks([]);
  }, [mobile.selectedId, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pending count changes whenever this outbox does.
  useEffect(() => {
    let live = true;
    const id = mobile.selectedId;
    if (!id || !scope) {
      setQueued([]);
      return;
    }
    void runtime.storage.outbox(id).then(
      (rows) => live && setQueued(rows.filter((row) => sameTarget(row, scope))),
      () => live && setQueued([]),
    );
    return () => {
      live = false;
    };
  }, [mobile.selectedId, mobile.pending, key]);
  // Accepted sends stay listed until the thread's history has their stored message.
  const outbox: (PendingMessage & { userMessageId?: string; runIds?: string[] })[] = [
    ...mobile.delivered.filter(
      (row) =>
        !!scope && sameTarget(row, scope) && !queued.some((q) => q.clientId === row.clientId),
    ),
    ...queued,
  ];
  // Selection events can trail the text change by one render; never read past the text.
  const query =
    scope?.kind === "group" ? mentionQuery(text, Math.min(caret, text.length)) : undefined;
  const options = query === undefined ? [] : mentionOptions(query, members).slice(0, 6);
  const steering = !!runId && !!scope && isDm(scope) && mobile.status === "online";
  return {
    text,
    setText,
    setCaret,
    mentionOptions: options,
    /** Replaces the typed `@query` with `@name ` and remembers the pick's ID for the send. */
    pickMention: (bot: Bot) => {
      if (query === undefined) return;
      const end = Math.min(caret, text.length);
      const start = end - query.length - 1;
      const prefix = `${text.slice(0, start)}@${bot.name} `;
      setText(prefix + text.slice(end));
      setCaret(prefix.length);
      setPicks((current) => [...current, { id: bot.id, name: bot.name }]);
    },
    outbox,
    action,
    steering,
    attachments,
    /** Steering is text only; files picked before the reply started still send (as a new turn). */
    canAttach: !steering && !attachments.full && !attachments.preparing,
    /** `topic` is the just-created first topic of a Bot that had none yet. */
    send: (topic?: ChatScope) =>
      action.run(async (signal): Promise<"sent" | ChatAdditionMode | undefined> => {
        const submitted = text.trim();
        const files = attachments.files;
        const into = topic ?? scope;
        if ((!submitted && !files.length) || attachments.preparing || !into) return;
        let outcome: "sent" | ChatAdditionMode = "sent";
        if (steering && runId && !topic && !files.length) {
          try {
            await appendToRun(runtime, into, runId, busyMode, submitted, signal);
            outcome = busyMode;
          } catch (error) {
            // When the live run cannot accept an append in this phase (waiting on approval,
            // between tool calls, or just finished), queue as the next turn of the same topic.
            if (
              error instanceof RpcError &&
              error.code === RpcErrorCodes.busy &&
              error.message === "append_unavailable"
            ) {
              await runtime.send(
                scopeTarget(into),
                submitted,
                pickedMentions(submitted, picks, members),
                [],
              );
              outcome = "sent";
            } else {
              throw error;
            }
          }
        } else {
          const taken = attachments.take();
          try {
            await runtime.send(
              scopeTarget(into),
              submitted,
              pickedMentions(submitted, picks, members),
              taken.files,
            );
          } catch (error) {
            attachments.restore(taken);
            throw error;
          }
        }
        signal.throwIfAborted();
        setText((value) => (value.trim() === submitted ? "" : value));
        setPicks([]);
        return outcome;
      }),
  };
}
