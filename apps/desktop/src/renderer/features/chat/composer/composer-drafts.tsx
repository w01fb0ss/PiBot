import type { ChatPeer } from "@pibot/client-core";
import type { Attachment } from "@pibot/protocol";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

const noAttachments: Attachment[] = [];

export function createComposerDrafts() {
  const peers = new WeakMap<ChatPeer, Map<string, string>>();
  const retries = new WeakMap<ChatPeer, Map<string, Attachment[]>>();
  const listeners = new Set<() => void>();
  return {
    attachments: (peer: ChatPeer, key: string) => retries.get(peer)?.get(key) ?? noAttachments,
    seeded: (peer: ChatPeer, key: string) => retries.get(peer)?.has(key) ?? false,
    seed(peer: ChatPeer, key: string, items: Attachment[]) {
      let entries = retries.get(peer);
      if (!entries) {
        entries = new Map();
        retries.set(peer, entries);
      }
      entries.set(key, items);
      for (const notify of listeners) notify();
    },
    read: (peer: ChatPeer, key: string) => peers.get(peer)?.get(key) ?? "",
    write(peer: ChatPeer, key: string, change: SetStateAction<string>) {
      let entries = peers.get(peer);
      const before = entries?.get(key) ?? "";
      const text = typeof change === "function" ? change(before) : change;
      if (text === before) return;
      if (!entries) {
        entries = new Map();
        peers.set(peer, entries);
      }
      if (text) entries.set(key, text);
      else entries.delete(key);
      for (const notify of listeners) notify();
    },
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
}
export function useRetryDraft(
  peer: ChatPeer,
  botId: string | undefined,
  conversationId: string | undefined,
) {
  const drafts = useContext(Drafts);
  if (!drafts) throw new Error("Composer draft provider unavailable");
  const key = JSON.stringify(["dm", botId, conversationId]);
  const attachments = useSyncExternalStore(
    drafts.subscribe,
    () => drafts.attachments(peer, key),
    () => noAttachments,
  );
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<string>();
  const seeded = drafts.seeded(peer, key);
  // A user retry deliberately repeats the same bounded read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reloads a failed draft
  useEffect(() => {
    if (!botId || !conversationId || drafts.seeded(peer, key)) return;
    const controller = new AbortController();
    setFailed(undefined);
    void peer
      .call(
        "chat.retryDraft",
        { botId, conversationId },
        { signal: controller.signal, timeoutMs: 10000 },
      )
      .then(
        (result) => {
          if (controller.signal.aborted || drafts.seeded(peer, key)) return;
          if (result) drafts.write(peer, key, (current) => current || result.text);
          drafts.seed(peer, key, result?.attachments ?? []);
        },
        () => {
          if (!controller.signal.aborted) setFailed(key);
        },
      );
    return () => controller.abort();
  }, [peer, botId, conversationId, drafts, key, attempt]);
  return {
    attachments,
    ready: !botId || !conversationId || seeded,
    failed: failed === key,
    reload: () => setAttempt((value) => value + 1),
    remove: (id: string) =>
      drafts.seed(
        peer,
        key,
        attachments.filter((item) => item.id !== id),
      ),
    clear: () => drafts.seed(peer, key, []),
    /** Adds attachments that already exist (a message put back into the composer). */
    add: (items: Attachment[]) =>
      drafts.seed(peer, key, [
        ...attachments,
        ...items.filter((item) => !attachments.some((old) => old.id === item.id)),
      ]),
  };
}
const Drafts = createContext<ReturnType<typeof createComposerDrafts> | null>(null);

/** Unsent text belongs to the renderer/connection, never localStorage, model history or logs. */
export function ComposerDraftProvider({ children }: { children: ReactNode }) {
  const [drafts] = useState(createComposerDrafts);
  return <Drafts.Provider value={drafts}>{children}</Drafts.Provider>;
}

/** The group composer's draft key: a topic draft, else the conversation, plus an open thread. */
export function groupDraftKey(groupId: string, conversationOrDraftId?: string, threadId?: string) {
  return JSON.stringify(["group", groupId, conversationOrDraftId, threadId]);
}

/**
 * Fills a composer that may not be on screen (the inbox or the Tasks panel opening a group chat):
 * the text joins any unsent draft rather than replacing it, as the composer's own fill does.
 */
export function useDraftFill() {
  const drafts = useContext(Drafts);
  return useCallback(
    (peer: ChatPeer, key: string, text: string) =>
      drafts?.write(peer, key, (current) => (current.trim() ? `${current}\n\n${text}` : text)),
    [drafts],
  );
}

export function useComposerDraft(peer: ChatPeer, key: string, pendingText = "") {
  const drafts = useContext(Drafts);
  if (!drafts) throw new Error("Composer draft provider unavailable");
  const text = useSyncExternalStore(
    drafts.subscribe,
    () => drafts.read(peer, key),
    () => "",
  );
  useLayoutEffect(() => {
    if (pendingText) drafts.write(peer, key, (current) => current || pendingText);
  }, [drafts, peer, key, pendingText]);
  // The closure owns its original key: a late send receipt must never clear another chat.
  const setText: Dispatch<SetStateAction<string>> = useCallback(
    (change) => drafts.write(peer, key, change),
    [drafts, peer, key],
  );
  return [text, setText] as const;
}
