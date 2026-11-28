import type { Bot, FolderSelection } from "@pibot/protocol";
import { append, confirmAppend } from "./additions.ts";
import { checkContextHint, dismissContextHint } from "./context-hint.ts";
import { applyEvent, receive } from "./events.ts";
import {
  flushHistoryRefresh,
  loadMore,
  readHistory,
  readOlder,
  refreshHistory,
  reload,
  retryHistory,
} from "./history.ts";
import { dispose, start, updateBot } from "./lifecycle.ts";
import { readBot, refreshMetadata } from "./metadata.ts";
import { type ChatReadCache, chatReadCache } from "./read-cache.ts";
import { abort, send } from "./send.ts";
import type { ChatEvent, ChatPeer, ChatState, ChatTarget, PendingChatAddition } from "./types.ts";

/** Internal state shared by operations; callers use the public controller facade. */
export class ChatSession {
  state: ChatState = {
    models: [],
    imageModels: [],
    messages: [],
    loading: true,
    historyReady: false,
    historyError: false,
    metadataError: false,
    metadataLoading: false,
    loadingMore: false,
    hasMore: false,
    pending: false,
    stopping: false,
    stopError: false,
  };

  listeners = new Set<() => void>();

  subscriptions: (() => void)[] = [];

  earlyEvents: ChatEvent[] = [];

  earlySize = 0;

  started = false;

  initialization?: Promise<void>;

  disposed = false;

  detached = false;

  lifetime = new AbortController();

  identityRead?: Promise<Bot | undefined>;

  historyRead?: Promise<void>;

  pageRead?: Promise<void>;

  metadataVersion = 0;

  metadataRead?: AbortController;

  botVersion = 0;

  /** Bumped per hint read so a slow estimate never overwrites a newer model's answer. */
  hintVersion = 0;

  historyVersion = 0;

  historyRefreshPending = false;
  historyReplacePending = false;

  failedPage = false;

  topicRouting = false;

  historyRouteReady = false;

  uncertainAppend?: PendingChatAddition;

  submittingAppend?: PendingChatAddition;

  constructor(
    readonly peer: ChatPeer,
    readonly target: ChatTarget = {},
    readonly reads: ChatReadCache = chatReadCache(peer),
    readonly retire?: () => void,
  ) {
    if (target.draftId) this.state.draftWorkplace = { primary: "home", readonly: [] };
  }

  /** The draft's folder choice; ignored once the draft became a topic. */
  setDraftWorkplace(selection: FolderSelection) {
    if (!this.target.draftId || this.state.conversationId) return;
    this.patch({ draftWorkplace: selection });
  }

  route() {
    const draft = !!this.target.draftId && !this.state.conversationId;
    return {
      botId: (this.state.bot?.id ?? this.target.botId) as string,
      ...(draft ? { newTopic: true as const } : {}),
      ...(draft && this.state.draftWorkplace ? { workplace: this.state.draftWorkplace } : {}),
      ...((this.target.topicId ?? (this.topicRouting ? this.state.conversationId : undefined))
        ? { topicId: this.target.topicId ?? this.state.conversationId }
        : {}),
    };
  }

  matches(event: {
    botId?: string;
    conversationId?: string;
    groupId?: string;
    threadId?: string;
    runId?: string | null;
  }) {
    if (event.groupId || event.threadId) return false;
    if (event.botId && event.botId !== (this.state.bot?.id ?? this.target.botId)) return false;
    if (this.target.draftId && !this.state.conversationId && !this.state.pending) return false;
    const conversationId = this.target.topicId ?? this.state.conversationId;
    if (conversationId)
      return event.conversationId
        ? event.conversationId === conversationId
        : !!event.runId && this.state.messages.some((message) => message.runId === event.runId);
    // Before a new-topic receipt arrives we can buffer same-Bot events, but no event may
    // mutate this draft until the receipt binds its exact conversation (and legacy run id).
    return (
      this.state.pending ||
      (!!event.runId && this.state.messages.some((message) => message.runId === event.runId))
    );
  }

  getSnapshot = () => this.state;

  canEvict() {
    return (
      !this.listeners.size &&
      !this.state.pending &&
      !this.state.appendUncertain &&
      !this.state.messages.some((message) => message.status === "streaming")
    );
  }

  subscribe = (listener: () => void) => {
    this.detached = false;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.detached = !this.listeners.size;
      // A detached idle viewport owns no event subscriptions or background reads.
      queueMicrotask(() => {
        if (!this.disposed && this.canEvict()) this.dispose();
      });
    };
  };

  frame?: ReturnType<typeof setTimeout>;

  patch(patch: Partial<ChatState>, deferred = false) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    // Streaming deltas arrive per token; render them at most once per frame so a long answer
    // cannot monopolize the UI thread. Any other change flushes immediately with the latest state.
    if (deferred) {
      this.frame ??= setTimeout(() => this.notify(), 16);
      return;
    }
    this.notify();
  }

  notify() {
    clearTimeout(this.frame);
    this.frame = undefined;
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
    if (this.detached && this.canEvict())
      queueMicrotask(() => {
        if (this.detached && this.canEvict()) this.dispose();
      });
  }

  pendingAddition() {
    return this.uncertainAppend ?? this.submittingAppend;
  }

  restoreAddition(request: PendingChatAddition) {
    if (
      (this.target.botId && this.target.botId !== request.botId) ||
      (this.target.topicId && this.target.topicId !== request.topicId) ||
      this.target.draftId
    )
      return;
    this.uncertainAppend = request;
    this.topicRouting = true;
    this.patch({
      conversationId: request.topicId,
      appendUncertain: true,
      requestError: "uncertain",
    });
  }
  start = start.bind(this);
  dispose = dispose.bind(this);
  updateBot = updateBot.bind(this);
  checkContextHint = checkContextHint.bind(this);
  dismissContextHint = dismissContextHint.bind(this);
  readBot = readBot.bind(this);
  refreshMetadata = refreshMetadata.bind(this);
  reload = reload.bind(this);
  flushHistoryRefresh = flushHistoryRefresh.bind(this);
  refreshHistory = refreshHistory.bind(this);
  readHistory = readHistory.bind(this);
  retryHistory = retryHistory.bind(this);
  loadMore = loadMore.bind(this);
  readOlder = readOlder.bind(this);
  receive = receive.bind(this);
  applyEvent = applyEvent.bind(this);
  send = send.bind(this);
  abort = abort.bind(this);
  append = append.bind(this);
  confirmAppend = confirmAppend.bind(this);
}
