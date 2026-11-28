import { appendReplyDelta, type LiveRunActivity, preserveLiveReply } from "@pibot/client-core";
import type { ChatDependencyNotice, EventPayloads, Message } from "@pibot/protocol";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useLinkState, useMobileSelector, useRuntime } from "../../runtime/context.tsx";
import { useAction } from "../../runtime/use-action.ts";
import type { ChatTarget } from "../../transport/link-port.ts";
import { HISTORY_PAGE, readHistoryDelta } from "./history-sync.ts";

const DEPENDENCY_NOTICE_LIMIT = 30;

export interface RunStatus {
  runId: string | null;
  state: "queued" | "running" | "idle";
  compacting?: boolean;
}
/** History, streaming and run status of one topic; the target comes from the route + topic. */
export function useChat(target: ChatTarget | undefined) {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const key = JSON.stringify(target ?? null);
  const dependencyKey = JSON.stringify([mobile.selectedId, target?.topicId]);
  const [dependencies, setDependencies] = useState<{
    key: string;
    notices: ChatDependencyNotice[];
  }>();
  // Proposal 10: a topic this process already read opens with its copy in the first frame.
  const [messages, setMessages] = useState<Message[]>(() =>
    mobile.selectedId ? (runtime.storage.store.peekHistory(mobile.selectedId, key) ?? []) : [],
  );
  const [hasMore, setHasMore] = useState(() => messages.length >= HISTORY_PAGE);
  const [status, setStatus] = useState<RunStatus>({ runId: null, state: "idle" });
  const [activities, setActivities] = useState<Record<string, LiveRunActivity>>({});
  const action = useAction(`${mobile.selectedId}:${key}`, mobile.peer);
  const stopAction = useAction(`${mobile.selectedId}:${key}`, mobile.peer);
  const historyVersion = useRef(0),
    messagesRef = useRef(messages),
    shownFor = useRef<string | undefined>(
      messages.length ? `${mobile.selectedId}:${key}` : undefined,
    );
  messagesRef.current = messages;
  const load = (more = false, replace = false, checkImported = false) =>
    action.read(async (signal) => {
      const id = mobile.selectedId;
      if (!id || !target) return;
      const version = ++historyVersion.current;
      // Opening a chat shows what this phone already has at once; the computer's answer is then
      // applied in place instead of after a blank screen.
      if (!replace && !more && !messagesRef.current.length && mobile.status === "online") {
        const cached = await runtime.storage.history(id, key).catch(() => []);
        signal.throwIfAborted();
        if (version === historyVersion.current && !messagesRef.current.length && cached.length) {
          messagesRef.current = cached;
          setMessages(cached);
          setHasMore(cached.length >= HISTORY_PAGE);
        }
      }
      if (mobile.status !== "online") {
        const rows = await runtime.storage.history(id, key);
        signal.throwIfAborted();
        // The cache can trail what arrived live just before the link dropped; never show less.
        if (version === historyVersion.current && rows.length >= messagesRef.current.length)
          setMessages(rows);
        return;
      }
      let page: Message[];
      let older = false;
      let tail = false;
      if (more) {
        page = await runtime.call(
          "chat.history",
          { ...target, before: messagesRef.current[0]?.id, limit: HISTORY_PAGE },
          signal,
        );
        older = page.length === HISTORY_PAGE;
      } else {
        // Proposal 4: only what changed since the copy on screen (usually one small tail read).
        // A streaming reply is not a stable anchor: it is re-read with the tail anyway.
        const delta = await readHistoryDelta(
          runtime,
          target,
          replace || (checkImported && messagesRef.current.some((m) => m.imported))
            ? []
            : messagesRef.current.filter((m) => m.status !== "streaming"),
          signal,
        );
        page = delta.messages;
        older = delta.hasMore;
        tail = delta.tail;
      }
      signal.throwIfAborted();
      if (version !== historyVersion.current) return;
      const live = new Map(messagesRef.current.map((m) => [m.id, m]));
      const rows = page.map((m) => {
        const existing = live.get(m.id);
        return m.status === "streaming" &&
          existing?.status === "streaming" &&
          existing.content.length > m.content.length
          ? preserveLiveReply(m, existing)
          : m;
      });
      const ids = new Set(rows.map((m) => m.id));
      const merged = more
        ? [...rows, ...messagesRef.current.filter((m) => !ids.has(m.id))]
        : [
            ...rows,
            ...messagesRef.current.filter((m) => !ids.has(m.id) && m.status === "streaming"),
          ];
      messagesRef.current = more ? merged.slice(0, 200) : merged.slice(-200);
      setMessages(messagesRef.current);
      // A tail read says nothing about older messages: what was known stays.
      if (!tail) setHasMore(older);
      await runtime.storage.cacheHistory(id, key, merged);
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: effects own the canonical device/peer/route, not transient request state.
  useEffect(() => {
    historyVersion.current++;
    // Maintainers 2026-11-12: messages vanished while the link was reconnecting. Only another chat
    // starts empty; a reconnect keeps what is on screen and the load below refreshes it in place.
    const identity = `${mobile.selectedId}:${key}`;
    if (shownFor.current !== identity) {
      shownFor.current = identity;
      const copy = mobile.selectedId
        ? runtime.storage.store.peekHistory(mobile.selectedId, key)
        : undefined;
      messagesRef.current = copy ?? [];
      setMessages(messagesRef.current);
      setHasMore(messagesRef.current.length >= HISTORY_PAGE);
    }
    setStatus({ runId: null, state: "idle" });
    setActivities({});
    void load(false, false, true);
    const peer = mobile.peer;
    if (!peer || !target) return;
    const matches = (e: { conversationId?: string; groupId?: string; botId?: string }) =>
      e.conversationId === target.topicId &&
      (target.groupId ? e.groupId === target.groupId : !e.groupId && e.botId === target.botId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let replaceHistory = false;
    const refresh = (replace = false) => {
      replaceHistory ||= replace;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const replace = replaceHistory;
        replaceHistory = false;
        void load(false, replace);
      }, 150);
    };
    // Reading here clears the unread mark on the computer and every other client too; a reply
    // that lands while this chat is on screen counts as read.
    const conversationKey = target.groupId ? `group:${target.groupId}` : `dm:${target.botId}`;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const markRead = () => {
      clearTimeout(readTimer);
      readTimer = setTimeout(() => {
        if (AppState.currentState !== "active") return;
        runtime.call("sidebar.read", { conversationKey }).catch(() => {
          // Best effort: the next open or reply marks it again; nothing to show the user.
        });
      }, 400);
    };
    markRead();
    // Back from the background with this chat still open: what arrived meanwhile is now seen.
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") markRead();
    });
    let deltaTimer: ReturnType<typeof setTimeout> | undefined;
    let startedRun: string | undefined;
    let pending: EventPayloads["chat.delta"][] = [];
    let pendingSize = 0;
    const flushDeltas = () => {
      clearTimeout(deltaTimer);
      deltaTimer = undefined;
      const batch = pending;
      pending = [];
      pendingSize = 0;
      // B12: the reply showed only its tail. A history read finishing right after a flush set the
      // list from `messagesRef`, which a queued state update had not reached yet, so the reply's
      // first words were dropped and later deltas started it again. The ref is the one source.
      const rows = new Map(messagesRef.current.map((message) => [message.id, message]));
      for (const event of batch) {
        const now = new Date().toISOString();
        const message: Message = rows.get(event.messageId) ?? {
          id: event.messageId,
          botId: event.botId,
          conversationId: target.topicId,
          runId: event.runId,
          role: "assistant",
          content: "",
          status: "streaming",
          errorCode: null,
          usage: null,
          createdAt: now,
          updatedAt: now,
        };
        rows.set(message.id, appendReplyDelta(message, event));
      }
      messagesRef.current = [...rows.values()].slice(-200);
      setMessages(messagesRef.current);
    };
    const delta = (event: EventPayloads["chat.delta"]) => {
      if (!matches(event)) return;
      pending.push(event);
      pendingSize += event.text.length;
      if (pending.length > 256 || pendingSize > 500_000) {
        pending = [];
        pendingSize = 0;
        refresh();
        return;
      }
      deltaTimer ??= setTimeout(flushDeltas, 50);
    };
    const off = [
      peer.on("chat.delta", delta),
      // Writes that are not a run send no chat.* event, only this one. Phone test 2026-11-16:
      // the phone's offline chat was uploaded a second after this screen had read the topic on
      // reconnect, and the turns stayed missing until the topic was opened again.
      peer.on("sidebar.changed", (e) => {
        if (e.conversationKey === conversationKey) refresh(e.resetHistory);
      }),
      peer.on("chat.message", (e) => {
        if (matches(e)) refresh();
      }),
      peer.on("chat.done", (e) => {
        if (!matches(e)) return;
        setActivities((current) =>
          Object.fromEntries(Object.entries(current).filter(([, item]) => item.runId !== e.runId)),
        );
        refresh();
        markRead();
      }),
      peer.on("chat.error", (e) => {
        if (matches(e)) {
          setActivities((current) =>
            Object.fromEntries(
              Object.entries(current).filter(([, item]) => item.runId !== e.runId),
            ),
          );
          refresh();
        }
      }),
      peer.on("chat.tool", (e) => {
        if (matches(e)) refresh();
      }),
      peer.on("chat.status", (e) => {
        if (!matches(e) || e.threadId) return;
        if (e.state === "idle" && e.runId)
          setActivities((current) =>
            Object.fromEntries(
              Object.entries(current).filter(([, item]) => item.runId !== e.runId),
            ),
          );
        setStatus({ runId: e.runId, state: e.state, compacting: e.compacting });
        // Maintainers 2026-11-12: a message sent on the computer showed here only when the reply
        // finished — the computer's own window adds the user's message locally, so the phone
        // learns of it only from the run starting. Load it (and the streaming reply) now.
        if (e.state !== "idle" && e.runId && e.runId !== startedRun) {
          startedRun = e.runId;
          refresh();
        }
      }),
      peer.on("chat.activity", (e) => {
        if (!matches(e)) return;
        setActivities((current) => {
          const previous = current[e.messageId];
          if (e.phase === "clear") {
            if (previous?.runId !== e.runId) return current;
            const next = { ...current };
            delete next[e.messageId];
            return next;
          }
          const samePhase =
            previous?.runId === e.runId &&
            previous.phase === e.phase &&
            (e.phase === "waiting_model" ||
              (previous.phase !== "waiting_model" && previous.tool === e.tool));
          return {
            ...current,
            [e.messageId]: { ...e, startedAt: samePhase ? previous.startedAt : Date.now() },
          };
        });
      }),
    ];
    return () => {
      historyVersion.current++;
      clearTimeout(timer);
      clearTimeout(readTimer);
      appState.remove();
      clearTimeout(deltaTimer);
      pending = [];
      for (const fn of off) fn();
    };
  }, [mobile.selectedId, mobile.peer, key, mobile.refreshVersion]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a resumed link may have missed notices.
  useEffect(() => {
    const peer = mobile.peer;
    const conversationId = target?.topicId;
    if (!peer || !conversationId) return;
    const abort = new AbortController();
    const merge = (incoming: ChatDependencyNotice[]) => {
      if (abort.signal.aborted) return;
      setDependencies((current) => {
        const rows = new Map(
          (current?.key === dependencyKey ? current.notices : []).map((notice) => [
            notice.id,
            notice,
          ]),
        );
        for (const notice of incoming) rows.set(notice.id, notice);
        return {
          key: dependencyKey,
          notices: [...rows.values()]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
            .slice(0, DEPENDENCY_NOTICE_LIMIT),
        };
      });
    };
    const off = peer.on("chat.dependencyNotice", (notice) => {
      if (notice.conversationId === conversationId) merge([notice]);
    });
    void runtime
      .call(
        "chat.dependencyNotices",
        { conversationId, limit: DEPENDENCY_NOTICE_LIMIT },
        abort.signal,
      )
      .then(merge, () => {
        // A reconnect retries history. Older desktop versions do not serve dependency notices.
      });
    return () => {
      abort.abort();
      off();
    };
  }, [runtime, mobile.peer, mobile.refreshVersion, target?.topicId, dependencyKey]);
  // Proposal 5: a send the computer accepted is stored with its receipt; when no event brought
  // it here (they can be lost with a path switch), the thread reads it so 已送达 hands over to it.
  // Its own selector: only a change in the delivered list re-renders, not every link patch.
  const delivered = useMobileSelector((s) => s.delivered);
  const unseen = delivered
    .filter(
      (row) =>
        !!target &&
        row.target.topicId === target.topicId &&
        row.target.threadId === target.threadId &&
        (target.groupId
          ? row.target.groupId === target.groupId
          : row.target.botId === target.botId) &&
        !messages.some((m) => m.id === row.userMessageId),
    )
    .map((row) => row.userMessageId)
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a newly accepted send reads again.
  useEffect(() => {
    if (!unseen || mobile.status !== "online") return;
    const timer = setTimeout(() => void load(), 600);
    return () => clearTimeout(timer);
  }, [unseen, mobile.status]);
  const streaming = messages.findLast((m) => m.status === "streaming" && m.runId);
  const runId = status.state !== "idle" && status.runId ? status.runId : streaming?.runId;
  return {
    messages,
    dependencyNotices: dependencies?.key === dependencyKey ? dependencies.notices : [],
    hasMore,
    load,
    action,
    status,
    activities,
    /** The run a stop or steer applies to; offline replies are never treated as live. */
    runId: mobile.status === "online" ? (runId ?? undefined) : undefined,
    stopAction,
    stop: (id: string) =>
      stopAction.run((signal) => runtime.call("chat.abort", { runId: id }, signal)),
  };
}
