import type { TranslationKey } from "@pibot/i18n";
import {
  type Bot,
  type Group,
  type Message,
  RpcError,
  RpcErrorCodes,
  type SidebarEntry,
} from "@pibot/protocol";
import {
  locateConversation,
  optional,
  type Peer,
  type Summary,
  type View,
  waitRpc,
} from "@pibot/renderer-kit";

interface Source {
  query: string;
  view: View;
  bots: Bot[];
  groups: Group[];
  entries: SidebarEntry[];
  summaries: Record<string, Summary>;
}
interface Snapshot {
  busy: boolean;
  slow?: boolean;
  error?: TranslationKey;
}
type Intent =
  | { key: string; focusApproval: boolean }
  | { message: Pick<Message, "id" | "conversationId" | "botId"> };
const sourceKey = ({ query, view }: Source) =>
  JSON.stringify([
    query,
    view.name,
    view.botId,
    view.topicId,
    view.draftId,
    view.groupId,
    view.threadId,
  ]);

export function navigationError(error?: TranslationKey) {
  return (
    error === "workspace.sidebarOpenFailed" ||
    error === "workspace.sidebarOpenUncertain" ||
    error === "workspace.sidebarLookupFailed"
  );
}

/** Local cancellation never revokes an accepted open; only its current owner may publish. */
export class ConversationNavigation {
  private state: Snapshot = { busy: false };
  private listeners = new Set<() => void>();
  private active = false;
  private version = 0;
  private source?: string;
  private lookup = new AbortController();
  private openPending?: Promise<void>;
  private retryIntent?: Intent;
  constructor(
    private readonly peer: Peer | null,
    private readonly ports: { current(): Source; navigate(view: View): void; refresh(): void },
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: Snapshot) {
    if (!this.active) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  updateSource() {
    const key = sourceKey(this.ports.current());
    if (this.source === key) return;
    this.source = key;
    this.version++;
    this.lookup.abort();
    this.retryIntent = undefined;
    // Called during render; getSnapshot exposes the new owner without a render-time notification.
    this.state = { busy: false };
  }
  start() {
    this.active = true;
    this.publish({ busy: false });
    return () => {
      this.active = false;
      this.version++;
      this.lookup.abort();
      this.retryIntent = undefined;
    };
  }
  private navigate(view: View) {
    this.source = sourceKey({ ...this.ports.current(), view });
    this.ports.navigate(view);
  }
  private async confirm(key: string, signal: AbortSignal, dispatched: () => void) {
    const peer = this.peer;
    if (!peer) throw new RpcError(RpcErrorCodes.closed, "Sidebar offline");
    // Keep one accepted open and one replaceable user intent, even during rapid switching.
    const pending = this.openPending;
    if (pending) await waitRpc(() => pending, signal);
    signal.throwIfAborted();
    let changed = false;
    const off = peer.on("sidebar.changed", (event) => {
      if (event.conversationKey === key) changed = true;
    });
    try {
      const request = peer.call("sidebar.open", { conversationKey: key });
      dispatched();
      const settled = request.then(
        () => undefined,
        () => undefined,
      );
      this.openPending = settled;
      void settled.then(() => {
        if (this.openPending === settled) this.openPending = undefined;
      });
      const entry = await waitRpc(() => request, signal);
      if (entry.conversationKey !== key) throw new Error("Sidebar confirmation mismatch");
      return { changed, entry };
    } finally {
      off();
    }
  }
  private async perform(intent: Intent) {
    if (!this.active) return;
    const version = ++this.version;
    this.lookup.abort();
    const read = new AbortController();
    this.lookup = read;
    const signal = read.signal;
    const current = () => this.active && version === this.version;
    let phase: "lookup" | "open" = "lookup";
    let dispatched = false;
    const timer = setTimeout(
      () => read.abort(new RpcError(RpcErrorCodes.timeout, "Sidebar wait timed out")),
      30_000,
    );
    this.retryIntent = intent;
    this.publish({ busy: true });
    const slow = setTimeout(() => {
      if (current() && !signal.aborted) this.publish({ busy: true, slow: true });
      // A note under the list for every sub-second open read as a stall; only real waits get one.
    }, 1_000);
    try {
      const peer = this.peer;
      if (!peer) throw new RpcError(RpcErrorCodes.closed, "Sidebar offline");
      const data = this.ports.current();
      let target: View;
      let key: string;
      let navigateAfterConfirmation = false;
      if ("message" in intent) {
        target = await waitRpc(
          () =>
            locateConversation(
              peer,
              intent.message.conversationId,
              signal,
              data.bots,
              data.groups,
              intent.message.botId ?? undefined,
            ),
          signal,
        );
        target = { ...target, focus: { messageId: intent.message.id } };
        key = target.groupId ? `group:${target.groupId}` : `dm:${target.botId}`;
      } else {
        key = intent.key;
        const [kind, id] = key.split(":");
        if (!id || (kind !== "dm" && kind !== "group")) throw new Error("Invalid target");
        // The preview's topic is the most recently updated one, often a routine topic after a run;
        // opening it would send the user's next message into that task. Always go to the current.
        let topicId: string | undefined;
        let draftId: string | undefined;
        if (kind === "dm") {
          // Only the current marker is a route; the brain answers it directly instead of the
          // sidebar paging the whole topic list (slow on Bots with many topics, maintainers 2026-11-14).
          const topics = await waitRpc(
            () =>
              optional(
                peer.call("topics.list", { botId: id, currentOnly: true, limit: 1 }, { signal }),
              ),
            signal,
          );
          if (!topics) navigateAfterConfirmation = true;
          else {
            if (
              topics.some(
                (topic) =>
                  topic.botId !== id || topic.kind !== "dm" || topic.archivedAt || !topic.isCurrent,
              )
            )
              throw new Error("Topic mismatch");
            topicId = topics[0]?.id;
            if (!topicId) draftId = crypto.randomUUID();
          }
        }
        const approval =
          kind === "group" && intent.focusApproval
            ? await peer
                .call(
                  "approvals.groupFocus",
                  { groupId: id },
                  { signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]) },
                )
                .catch(() => {
                  // An unavailable focus hint must not prevent the user from opening the group.
                  signal.throwIfAborted();
                  return undefined;
                })
            : undefined;
        target =
          kind === "group"
            ? {
                name: "chat",
                groupId: id,
                ...(approval
                  ? { topicId: approval.topicId, approvalFocus: { id: approval.approvalId } }
                  : {}),
              }
            : { name: "chat", botId: id, topicId, draftId };
      }
      signal.throwIfAborted();
      if (!current()) return;
      if (!navigateAfterConfirmation) this.navigate(target);
      phase = "open";
      const { changed, entry } = await this.confirm(key, signal, () => {
        dispatched = true;
      });
      signal.throwIfAborted();
      if (!current()) return;
      if (navigateAfterConfirmation) this.navigate(target);
      this.retryIntent = undefined;
      this.publish({ busy: false });
      // WorkspaceProvider already schedules authoritative refresh for the matching change event.
      // The brain sends none when opening changed nothing; refresh only if the row we show
      // disagrees with the acknowledged one (a peer that never delivers the event).
      const shown = this.ports.current().entries.find((row) => row.conversationKey === key);
      if (
        !changed &&
        (!shown || shown.unread !== entry.unread || shown.hiddenAt !== entry.hiddenAt)
      )
        this.ports.refresh();
    } catch (error) {
      if (!current()) return;
      this.publish({
        busy: false,
        error:
          phase === "lookup"
            ? "workspace.sidebarLookupFailed"
            : dispatched && error instanceof RpcError && error.code === RpcErrorCodes.timeout
              ? "workspace.sidebarOpenUncertain"
              : "workspace.sidebarOpenFailed",
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(slow);
    }
  }
  open = (key: string, focusApproval = false) => {
    void this.perform({ key, focusApproval });
  };
  openMessage = (message: Message) => {
    void this.perform({
      message: { id: message.id, conversationId: message.conversationId, botId: message.botId },
    });
  };
  retry = () => {
    if (this.retryIntent) void this.perform(this.retryIntent);
  };
}
