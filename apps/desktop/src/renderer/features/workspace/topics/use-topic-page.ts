import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

export const TOPIC_PAGE_SIZE = 50;
// The list RPCs accept at most 200 rows, including the lookahead.
const TOPIC_REVEAL_PAGE_SIZE = 199;
const MAX_TOPIC_REVEAL_PAGES = 25;
export const TOPIC_READ_TIMEOUT_MS = 30_000;

type Topic = { id: string; updatedAt: string };

interface TopicPage<T> {
  topics: T[];
  more: boolean;
  appendedCurrentId?: string;
}

type TopicReader<T> = (
  before: string | undefined,
  limit: number,
  signal: AbortSignal,
) => Promise<T[]>;

export class TopicScopeMismatchError extends Error {
  constructor() {
    super("Topic target mismatch");
    this.name = "TopicScopeMismatchError";
  }
}

export function isTransientRevealError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof DOMException)
    return error.name === "AbortError" || error.name === "TimeoutError";
  return (
    error instanceof RpcError &&
    (error.code === RpcErrorCodes.timeout ||
      error.code === RpcErrorCodes.closed ||
      error.code === RpcErrorCodes.busy ||
      error.code === RpcErrorCodes.cancelled)
  );
}

export function useTopicPage<T extends Topic>(scope: object) {
  const [rendered, setRendered] = useState<{ scope: object; page: TopicPage<T> }>();
  const committed = useRef(rendered);
  const active = useRef<{ scope: object; controller: AbortController }>(null);
  const appending = useRef<object>(null);
  const refreshing = useRef<{ scope: object; promise: Promise<void> }>(null);
  const empty = useRef<TopicPage<T>>({ topics: [], more: false });

  useLayoutEffect(() => {
    const controller = new AbortController();
    active.current = { scope, controller };
    return () => {
      controller.abort();
      active.current = null;
      committed.current = undefined;
    };
  }, [scope]);

  const read = useCallback(
    () => (committed.current?.scope === scope ? committed.current.page : empty.current),
    [scope],
  );
  const update = useCallback(
    (change: (page: TopicPage<T>) => TopicPage<T>) => {
      if (active.current?.scope !== scope) return;
      const previous = read();
      const page = change(previous);
      if (page === previous) return;
      committed.current = { scope, page };
      setRendered(committed.current);
    },
    [scope, read],
  );
  const refresh = useCallback(
    async (fetch: TopicReader<T>, signal: AbortSignal, revalidateLoaded: boolean) => {
      const promise = refreshTopicPage(
        fetch,
        read,
        (page) => update(() => page),
        signal,
        revalidateLoaded,
      );
      refreshing.current = { scope, promise };
      try {
        await promise;
      } finally {
        if (refreshing.current?.promise === promise) refreshing.current = null;
      }
    },
    [scope, read, update],
  );
  const append = useCallback(
    async (
      fetch: TopicReader<T>,
      actionSignal: AbortSignal,
      findCurrent?: (topics: T[]) => string | undefined,
    ) => {
      if (active.current?.scope !== scope) return;
      const signal = AbortSignal.any([
        active.current.controller.signal,
        actionSignal,
        AbortSignal.timeout(TOPIC_READ_TIMEOUT_MS),
      ]);
      appending.current = scope;
      try {
        let revalidated = false;
        for (;;) {
          signal.throwIfAborted();
          const previous = read();
          const cursor = previous.topics.at(-1);
          if (!previous.more || !cursor) return;
          const rows = await fetch(cursor.id, TOPIC_PAGE_SIZE + 1, signal);
          signal.throwIfAborted();
          const latest = read();
          const tail = latest.topics.at(-1);
          // A revalidated prefix can move the boundary while the click is in flight. Read
          // from the new boundary under the same action and deadline.
          if (!latest.more) return;
          if (tail?.id !== cursor.id || tail.updatedAt !== cursor.updatedAt) continue;

          const ids = new Set(latest.topics.map((topic) => topic.id));
          // The server resolves the cursor by ID at read time. A topic moved to the head can
          // return already loaded rows, and a group topic moved out of the tab returns none.
          if (!rows.length || rows.some((topic) => ids.has(topic.id))) {
            const pending = refreshing.current;
            if (pending?.scope === scope) {
              try {
                await pending.promise;
              } catch {
                // The refresh owns its error UI. The append can still revalidate its boundary.
              }
              signal.throwIfAborted();
              if (read() !== latest) continue;
            }
            if (revalidated) throw new Error("Topic append cursor stalled");
            revalidated = true;
            await refresh(fetch, signal, true);
            continue;
          }

          const added = rows.slice(0, TOPIC_PAGE_SIZE);
          update(() => ({
            topics: [...latest.topics, ...added],
            more: rows.length > TOPIC_PAGE_SIZE,
            appendedCurrentId: findCurrent?.(added),
          }));
          return;
        }
      } catch (error) {
        // Leaving a filter or closing the view cancels the action without showing a stale error.
        if (active.current?.scope === scope && !actionSignal.aborted) throw error;
      } finally {
        if (appending.current === scope) appending.current = null;
      }
    },
    [scope, read, refresh, update],
  );

  const reveal = useCallback(
    async (fetch: TopicReader<T>, matches: (topic: T) => boolean, signal: AbortSignal) => {
      const start = read();
      let cursor = start.topics.at(-1);
      const seen = new Set(start.topics.map((topic) => topic.id));
      const added: T[] = [];
      for (let i = 0; cursor && i < MAX_TOPIC_REVEAL_PAGES; i++) {
        signal.throwIfAborted();
        const rows = await fetch(cursor.id, TOPIC_REVEAL_PAGE_SIZE + 1, signal);
        signal.throwIfAborted();
        const previous = cursor;
        const firstAdded = added.length;
        for (const topic of rows.slice(0, TOPIC_REVEAL_PAGE_SIZE)) {
          if (seen.has(topic.id)) continue;
          seen.add(topic.id);
          added.push(topic);
          cursor = topic;
        }
        const more = rows.length > TOPIC_REVEAL_PAGE_SIZE && cursor !== previous;
        if (added.slice(firstAdded).some(matches)) {
          update((current) =>
            current.topics.at(-1)?.id === start.topics.at(-1)?.id
              ? { topics: [...current.topics, ...added], more }
              : current,
          );
          return;
        }
        if (!more) return;
      }
    },
    [read, update],
  );
  const isAppending = useCallback(() => appending.current === scope, [scope]);
  return {
    page: rendered?.scope === scope ? rendered.page : empty.current,
    read,
    update,
    refresh,
    append,
    reveal,
    isAppending,
  };
}

/**
 * The extra row lets an unchanged head join the cached continuation in one read. If the boundary
 * has moved beyond the loaded range, read toward the previous depth to find a join or a new tail.
 */
async function refreshTopicPage<T extends Topic>(
  fetch: TopicReader<T>,
  read: () => TopicPage<T>,
  publish: (page: TopicPage<T>) => void,
  signal: AbortSignal,
  revalidateLoaded = false,
): Promise<void> {
  const first = await fetch(undefined, TOPIC_PAGE_SIZE + 1, signal);
  const refreshed: T[] = [];
  let rows = first;
  let limit = TOPIC_PAGE_SIZE;
  const seen = new Set<string>();
  for (;;) {
    signal.throwIfAborted();
    const current = read();
    const previousLength = refreshed.length;
    for (const topic of rows.slice(0, limit)) {
      if (seen.has(topic.id)) continue;
      seen.add(topic.id);
      refreshed.push(topic);
    }
    const next = rows[limit];
    if (!next) {
      publish({ topics: refreshed, more: false, appendedCurrentId: current.appendedCurrentId });
      return;
    }

    const overlap = revalidateLoaded
      ? -1
      : current.topics.findIndex(
          (topic) => topic.id === next.id && topic.updatedAt === next.updatedAt,
        );
    if (overlap >= 0) {
      if (!seen.has(next.id)) {
        refreshed.push(next);
        seen.add(next.id);
      }
      publish({
        topics: [
          ...refreshed,
          ...current.topics.slice(overlap + 1).filter((topic) => !seen.has(topic.id)),
        ],
        more: current.more,
        appendedCurrentId: current.appendedCurrentId,
      });
      return;
    }
    if (refreshed.length >= current.topics.length) {
      publish({ topics: refreshed, more: true, appendedCurrentId: current.appendedCurrentId });
      return;
    }

    const cursor = refreshed.at(-1);
    if (!cursor || refreshed.length === previousLength)
      throw new Error("Topic refresh cursor stalled");
    limit = Math.min(TOPIC_REVEAL_PAGE_SIZE, current.topics.length - refreshed.length);
    rows = await fetch(cursor.id, limit + 1, signal);
  }
}
