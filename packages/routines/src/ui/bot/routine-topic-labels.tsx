import { type Peer, useRpc, useSettings, waitRpc } from "@pibot/renderer-kit";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useRemote, useRoutineRefresh } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";

interface RoutineLabelEntry {
  deleted: boolean;
  stale: boolean;
  /** Terminal owner/id invariant mismatch (do not auto-retry until `routines.changed` invalidates). */
  mismatch: boolean;
  /** Consecutive transient failures and earliest retry time (0 when healthy). */
  failures: number;
  retryAt: number;
}

class RoutineOwnerMismatchError extends Error {
  constructor() {
    super("Routine owner mismatch");
    this.name = "RoutineOwnerMismatchError";
  }
}

const MAX_CONCURRENT_READS = 4;
const MAX_CACHED_ROUTINES = 4096;
const REFRESH_DEBOUNCE_MS = 250;
const FAILURE_RETRY_BASE_MS = 2_000;
const FAILURE_RETRY_MAX_MS = 30_000;
const MAX_AUTO_RETRIES = 3;

/**
 * List-scoped cache and deduplicated reader for routine topic badges. Keeps routine labels warm
 * across virtualized row unmounts/remounts, shares a single `routines.changed` subscription per
 * list, bounds concurrent RPCs, and aborts in-flight reads if all consumers unmount.
 */
class RoutineTopicLabelStore {
  readonly botId: string;
  private readonly peer: Peer | null;
  private readonly entries = new Map<string, RoutineLabelEntry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly activeCounts = new Map<string, number>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly queue = new Set<string>();
  private readonly pendingRefresh = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeChanged: (() => void) | undefined;
  private active = false;

  constructor(peer: Peer | null, botId: string) {
    this.peer = peer;
    this.botId = botId;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.unsubscribeChanged = this.peer?.on("routines.changed", (event) => {
      this.handleChanged(event.botId, event.id);
    });
    for (const [id, count] of this.activeCounts) {
      if (count > 0) this.ensureScheduled(id);
    }
    this.pump();
    this.scheduleRetryFlush();
  }

  stop() {
    this.active = false;
    this.unsubscribeChanged?.();
    this.unsubscribeChanged = undefined;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.pendingRefresh.clear();
    this.queue.clear();
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
  }

  isDeleted(id: string): boolean {
    return this.entries.get(id)?.deleted ?? false;
  }

  subscribe(id: string, listener: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  acquire(id: string): () => void {
    const next = (this.activeCounts.get(id) ?? 0) + 1;
    this.activeCounts.set(id, next);
    if (next === 1) {
      this.ensureScheduled(id);
      this.pump();
      this.scheduleRetryFlush();
    }
    return () => {
      const remaining = (this.activeCounts.get(id) ?? 0) - 1;
      if (remaining > 0) {
        this.activeCounts.set(id, remaining);
        return;
      }
      this.activeCounts.delete(id);
      this.queue.delete(id);
      this.pendingRefresh.delete(id);
      const controller = this.inFlight.get(id);
      if (controller) {
        this.inFlight.delete(id);
        controller.abort();
        this.pump();
      }
      if (this.activeCounts.size === 0 && this.retryTimer !== undefined) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
    };
  }

  private handleChanged(eventBotId?: string, eventId?: string | null) {
    const relevantId =
      eventId && (this.entries.has(eventId) || (this.activeCounts.get(eventId) ?? 0) > 0);
    if (eventBotId && eventBotId !== this.botId && !relevantId) return;

    if (eventId) {
      this.invalidateId(eventId);
    } else {
      for (const id of this.entries.keys()) {
        this.invalidateId(id);
      }
      for (const id of this.activeCounts.keys()) {
        this.invalidateId(id);
      }
    }
    this.scheduleRefreshFlush();
  }

  private invalidateId(id: string) {
    const entry = this.entries.get(id);
    if (entry) {
      // Preserve the last known `deleted` boolean while revalidating so badges do not flicker.
      entry.stale = true;
      entry.mismatch = false;
      entry.failures = 0;
      entry.retryAt = 0;
    }
    const controller = this.inFlight.get(id);
    if (controller) {
      this.inFlight.delete(id);
      controller.abort();
    }
    this.queue.delete(id);
    if ((this.activeCounts.get(id) ?? 0) > 0) {
      this.pendingRefresh.add(id);
    }
  }

  private scheduleRefreshFlush() {
    if (!this.active || this.pendingRefresh.size === 0 || this.refreshTimer !== undefined) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.active) return;
      const ids = [...this.pendingRefresh];
      this.pendingRefresh.clear();
      for (const id of ids) {
        if ((this.activeCounts.get(id) ?? 0) > 0) this.ensureScheduled(id);
      }
      this.pump();
      this.scheduleRetryFlush();
    }, REFRESH_DEBOUNCE_MS);
  }

  private needsRead(entry: RoutineLabelEntry | undefined, now = Date.now()): boolean {
    if (!entry) return true;
    if (entry.stale) return true;
    if (entry.mismatch) return false;
    return entry.failures > 0 && now >= entry.retryAt;
  }

  private scheduleRetryFlush() {
    if (!this.active || !this.peer) return;
    let nextRetryAt = Number.POSITIVE_INFINITY;
    for (const [id, count] of this.activeCounts) {
      if (count <= 0 || this.inFlight.has(id) || this.queue.has(id)) continue;
      const entry = this.entries.get(id);
      if (
        !entry ||
        entry.stale ||
        entry.mismatch ||
        entry.failures === 0 ||
        entry.failures > MAX_AUTO_RETRIES
      ) {
        continue;
      }
      if (entry.retryAt < nextRetryAt) nextRetryAt = entry.retryAt;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!Number.isFinite(nextRetryAt)) return;
    const delay = Math.max(0, nextRetryAt - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.active) return;
      for (const [id, count] of this.activeCounts) {
        if (count > 0) this.ensureScheduled(id);
      }
      this.pump();
      this.scheduleRetryFlush();
    }, delay);
  }

  private ensureScheduled(id: string) {
    if (!this.peer) return;
    if (this.inFlight.has(id) || this.queue.has(id)) return;
    if (!this.needsRead(this.entries.get(id))) return;
    this.queue.add(id);
  }

  private pump() {
    if (!this.active || !this.peer) return;
    while (this.inFlight.size < MAX_CONCURRENT_READS && this.queue.size > 0) {
      const next = this.queue.values().next();
      if (next.done) break;
      const id = next.value;
      this.queue.delete(id);
      if ((this.activeCounts.get(id) ?? 0) <= 0 || this.inFlight.has(id)) continue;
      if (!this.needsRead(this.entries.get(id))) continue;
      this.startRead(this.peer, id);
    }
  }

  private startRead(peer: Peer, id: string) {
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    void waitRpc(() => peer.call("routines.get", { id }, { signal }), signal)
      .then((routine) => {
        if (controller.signal.aborted || this.inFlight.get(id) !== controller) return;
        if (routine.botId !== this.botId || routine.id !== id) {
          throw new RoutineOwnerMismatchError();
        }
        const deleted = !!routine.deletedAt;
        const previous = this.entries.get(id)?.deleted ?? false;
        this.setEntry(id, { deleted, stale: false, mismatch: false, failures: 0, retryAt: 0 });
        if (deleted !== previous) this.notify(id);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.inFlight.get(id) !== controller) return;
        const existing = this.entries.get(id);
        const previous = existing?.deleted ?? false;
        if (error instanceof RoutineOwnerMismatchError) {
          console.warn(
            JSON.stringify({
              module: "routine-topic-labels",
              event: "routine_owner_mismatch",
              botId: this.botId,
              routineId: id,
            }),
          );
          // Do not treat an explicit owner/id invariant mismatch as a transient read; retain a
          // safe non-deleted default and wait for a `routines.changed` invalidation before re-reading.
          this.setEntry(id, {
            deleted: false,
            stale: false,
            mismatch: true,
            failures: 0,
            retryAt: 0,
          });
          if (previous) this.notify(id);
          return;
        }
        const failures = Math.min((existing?.failures ?? 0) + 1, 10);
        // Back off after transient failures so scroll bounces do not spam RPCs while still
        // allowing automatic recovery (and later remount retries) once the cooldown elapses.
        const delay = Math.min(FAILURE_RETRY_MAX_MS, FAILURE_RETRY_BASE_MS * 2 ** (failures - 1));
        this.setEntry(id, {
          deleted: previous,
          stale: false,
          mismatch: false,
          failures,
          retryAt: Date.now() + delay,
        });
      })
      .finally(() => {
        if (this.inFlight.get(id) === controller) {
          this.inFlight.delete(id);
        }
        this.pump();
        this.scheduleRetryFlush();
      });
  }

  private setEntry(id: string, entry: RoutineLabelEntry) {
    // Refresh Map insertion order so recently used entries survive eviction.
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (this.entries.size <= MAX_CACHED_ROUTINES) return;
    for (const key of this.entries.keys()) {
      if (this.entries.size <= MAX_CACHED_ROUTINES) break;
      if ((this.activeCounts.get(key) ?? 0) === 0) {
        this.entries.delete(key);
      }
    }
  }

  private notify(id: string) {
    const set = this.listeners.get(id);
    if (!set) return;
    for (const listener of set) listener();
  }
}

const RoutineTopicLabelContext = createContext<RoutineTopicLabelStore | null>(null);

/** Shares routine badge lookups and invalidation across rows in a virtualized topic list. */
export function RoutineTopicLabelProvider({
  botId,
  children,
}: {
  botId: string;
  children: ReactNode;
}) {
  const { peer } = useRpc();
  const store = useMemo(() => new RoutineTopicLabelStore(peer, botId), [peer, botId]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  return (
    <RoutineTopicLabelContext.Provider value={store}>{children}</RoutineTopicLabelContext.Provider>
  );
}

function CachedRoutineTopicLabel({ id, store }: { id: string; store: RoutineTopicLabelStore }) {
  const { t } = useSettings();
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(id, listener),
    [store, id],
  );
  const getSnapshot = useCallback(() => store.isDeleted(id), [store, id]);
  const deleted = useSyncExternalStore(subscribe, getSnapshot, () => false);
  useEffect(() => store.acquire(id), [store, id]);
  return (
    <span className={styles.tag}>{deleted ? t("routines.deleted") : t("routines.title")}</span>
  );
}

function StandaloneRoutineTopicLabel({ id, botId }: { id: string; botId: string }) {
  const { t } = useSettings();
  const load = useCallback(
    async (peer: Peer, signal: AbortSignal) => {
      const routine = await peer.call("routines.get", { id }, { signal });
      if (routine.botId !== botId || routine.id !== id) throw new Error("Routine owner mismatch");
      return routine;
    },
    [id, botId],
  );
  const remote = useRemote(load);
  useRoutineRefresh(remote.refresh, botId, { routineId: id });
  return (
    <span className={styles.tag}>
      {remote.value?.deletedAt ? t("routines.deleted") : t("routines.title")}
    </span>
  );
}

export function RoutineTopicLabel({ id, botId }: { id: string; botId: string }) {
  const store = useContext(RoutineTopicLabelContext);
  if (store && store.botId === botId) {
    return <CachedRoutineTopicLabel id={id} store={store} />;
  }
  return <StandaloneRoutineTopicLabel id={id} botId={botId} />;
}
