import { displayTopicTitle } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import { botPanelStyles as styles, useSettings } from "@pibot/renderer-kit";
import { Button, Icon, IconTile, SegmentedControl, type Tone } from "@pibot/ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import virtualStyles from "./topic-list.module.css";
import { ESTIMATED_ROW_HEIGHT } from "./topic-virtual.ts";
import { useTopicVirtualizer } from "./use-topic-virtualizer.ts";

export interface TopicRow {
  id: string;
  title?: string;
  updatedAt: string;
  messageCount?: number;
}
export type TopicRunState = "running" | "queued" | "waiting";
type TopicPeriod = "today" | "week" | "earlier";
const PERIODS: readonly TopicPeriod[] = ["today", "week", "earlier"];

const runStateLabel = {
  running: "agentWork.running",
  queued: "agentWork.queued",
  waiting: "agentWork.waiting",
} as const satisfies Record<TopicRunState, TranslationKey>;
/** Each topic leads with a chat tile; its colour repeats the run state at a glance. */
const runStateTone = {
  running: "blue",
  queued: "neutral",
  waiting: "amber",
} as const satisfies Record<TopicRunState, Tone>;
const topicTone = (archived: boolean, state?: TopicRunState): Tone =>
  archived ? "neutral" : state ? runStateTone[state] : "teal";

type FocusEdge = "primary" | "first" | "last";

const ROW_TABBABLE_SELECTOR = "button:not(:disabled), input:not(:disabled)";
const MAX_SCROLL_REVEAL_ATTEMPTS = 6;

function getRowTabbables(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(ROW_TABBABLE_SELECTOR)];
}

function focusTopicRowElement(row: HTMLDivElement, edge: FocusEdge = "primary"): boolean {
  const target =
    edge === "primary"
      ? (row.querySelector<HTMLElement>("button[data-topic-action]:not(:disabled)") ??
        row.querySelector<HTMLElement>(ROW_TABBABLE_SELECTOR))
      : edge === "first"
        ? getRowTabbables(row)[0]
        : getRowTabbables(row).at(-1);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

/** DM and group topics share their list, filtering, row actions, typography and icons. */
export function TopicListView<T extends TopicRow>({
  topics,
  currentId,
  appendedCurrentId,
  archived,
  setArchived,
  imported,
  query,
  setQuery,
  loading,
  error,
  retry,
  editing,
  title,
  setTitle,
  rename,
  startRename,
  displayTitle,
  canRename,
  cancelRename,
  busy,
  restoring,
  available,
  open,
  restore,
  folderName,
  status,
  extra,
  more,
  loadMore,
}: {
  topics: T[];
  currentId?: string;
  /** An implicit current topic first found by a manual page should keep the viewport in place. */
  appendedCurrentId?: string;
  archived: boolean;
  setArchived(value: boolean): void;
  imported?: { active: boolean; setActive(value: boolean): void };
  query: string;
  setQuery(value: string): void;
  loading: boolean;
  error?: TranslationKey;
  retry(): void;
  editing?: string;
  title: string;
  setTitle(value: string): void;
  rename(id: string): void;
  startRename(topic: T): void;
  /** Title as shown (a scheduled task's topic is named after the task). */
  displayTitle?(topic: T): string;
  /** Topics whose title follows something else (a task's name) are not renamed here. */
  canRename?(topic: T): boolean;
  cancelRename(): void;
  busy: boolean;
  restoring: boolean;
  available: boolean;
  open(topic: T): void;
  restore(id: string): void;
  folderName(topic: T): string;
  /** Shown as an icon after the title (maintainers 2026-11-05: an icon, no text); the label is its tooltip. */
  status?(topic: T): TopicRunState | undefined;
  extra?(topic: T): ReactNode;
  more: boolean;
  loadMore(): void;
}) {
  const { t, language } = useSettings(),
    input = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const groupsRef = useRef<HTMLDivElement>(null);
  const rowElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const rowCallbacksRef = useRef<Map<string, (node: HTMLDivElement | null) => void>>(new Map());
  const pendingFocusRef = useRef<{ id: string; edge: FocusEdge; attempts: number } | undefined>(
    undefined,
  );
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const showImported = imported?.active;
  const scrolled = useRef(false);
  const hasTopics = topics.length > 0;
  const filterKey = `${archived ? 1 : 0}:${showImported ? 1 : 0}:${query}`;

  // Cache one Intl.DateTimeFormat per period instead of re-instantiating per rendered row.
  const timeFormatters = useMemo(
    () => ({
      today: new Intl.DateTimeFormat(language, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
      week: new Intl.DateTimeFormat(language, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
      earlier: new Intl.DateTimeFormat(language, {
        month: "short",
        day: "numeric",
      }),
    }),
    [language],
  );

  // Re-bucket only when `topics` or the local calendar day changes, not on scroll/typing/busy updates.
  const now = new Date();
  const dayYear = now.getFullYear();
  const dayMonth = now.getMonth();
  const dayDate = now.getDate();
  const { sections, virtualSections, locationById, totalCount } = useMemo(() => {
    const today = new Date(dayYear, dayMonth, dayDate);
    const todayMs = today.getTime();
    const week = new Date(dayYear, dayMonth, dayDate);
    week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
    const weekMs = week.getTime();

    const buckets: Record<TopicPeriod, T[]> = { today: [], week: [], earlier: [] };
    for (const topic of topics) {
      const timestamp = Date.parse(topic.updatedAt);
      if (timestamp >= todayMs) buckets.today.push(topic);
      else if (timestamp >= weekMs) buckets.week.push(topic);
      else buckets.earlier.push(topic);
    }

    const ordered: {
      period: TopicPeriod;
      items: T[];
      ids: string[];
      startGlobalIndex: number;
    }[] = [];
    const locations = new Map<
      string,
      { sectionIndex: number; rowIndex: number; globalIndex: number }
    >();
    let offset = 0;
    for (const period of PERIODS) {
      const items = buckets[period];
      if (items.length === 0) continue;
      const sectionIndex = ordered.length;
      const ids = new Array<string>(items.length);
      for (let rowIndex = 0; rowIndex < items.length; rowIndex++) {
        const item = items[rowIndex];
        if (!item) continue;
        ids[rowIndex] = item.id;
        locations.set(item.id, { sectionIndex, rowIndex, globalIndex: offset + rowIndex });
      }
      ordered.push({ period, items, ids, startGlobalIndex: offset });
      offset += items.length;
    }

    return {
      sections: ordered,
      virtualSections: ordered.map((section) => ({ key: section.period, ids: section.ids })),
      locationById: locations,
      totalCount: offset,
    };
  }, [topics, dayYear, dayMonth, dayDate]);

  const {
    slices,
    offsets,
    getCardRef,
    setRowRef,
    scrollToRow,
    scrollToTop,
    recompute,
    getViewportHeight,
  } = useTopicVirtualizer({
    sections: virtualSections,
    listRef: list,
    filterKey,
  });

  useLayoutEffect(() => {
    if (!showImported) scrolled.current = false;
    else if (!loading && hasTopics && !scrolled.current) {
      list.current?.scrollIntoView({ block: "start", inline: "nearest" });
      scrolled.current = true;
      recompute();
    }
  }, [showImported, loading, hasTopics, recompute]);

  // Reset scroll to the top of the list when switching tabs or changing the search query,
  // but never when loading more pages.
  const selectionKey = `${filterKey}:${currentId ?? ""}`;
  const previousFilterKeyRef = useRef(filterKey);
  const previousTopicsRef = useRef(topics);
  const staleFilterTopicsRef = useRef<readonly T[] | undefined>(undefined);
  const selectionRevealAttemptsRef = useRef<{ key: string; count: number }>({ key: "", count: 0 });
  const scrolledSelectionKeyRef = useRef<string | undefined>(undefined);
  const settledSelectionPresentRef = useRef<string | undefined>(undefined);
  const pendingLoadMoreRef = useRef<
    { filterKey: string; count: number; restoreFocus: boolean } | undefined
  >(undefined);
  const [retainedFooter, setRetainedFooter] = useState<
    { filterKey: string; count: number } | undefined
  >(undefined);
  useLayoutEffect(() => {
    if (previousFilterKeyRef.current !== filterKey) {
      previousFilterKeyRef.current = filterKey;
      pendingFocusRef.current = undefined;
      pendingLoadMoreRef.current = undefined;
      setRetainedFooter(undefined);
      selectionRevealAttemptsRef.current = { key: "", count: 0 };
      scrolledSelectionKeyRef.current = undefined;
      settledSelectionPresentRef.current = undefined;
      // Clearing a search query updates `query` one effect tick before the parent marks
      // `loading` or replaces `topics`. Track the pre-change list so a reveal settling on stale
      // search results does not suppress revealing the selected row once fresh data arrives.
      staleFilterTopicsRef.current = topics === previousTopicsRef.current ? topics : undefined;
      scrollToTop();
    }
    previousTopicsRef.current = topics;
  }, [filterKey, topics, scrollToTop]);

  // Scroll the selected topic into view on initial load (including imported batches), when
  // returning to a filter, or when `currentId` changes, confirming alignment against the mounted
  // row's measured geometry before settling. Clicking "More topics" settles the key immediately
  // so routine pagination never jumps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-verify after `slices` or measured `offsets` update until the mounted row is aligned in view.
  useLayoutEffect(() => {
    if (
      staleFilterTopicsRef.current !== undefined &&
      (loading || topics !== staleFilterTopicsRef.current)
    ) {
      staleFilterTopicsRef.current = undefined;
      scrolledSelectionKeyRef.current = undefined;
      settledSelectionPresentRef.current = undefined;
      selectionRevealAttemptsRef.current = { key: "", count: 0 };
    }
    const pending = pendingLoadMoreRef.current;
    if (currentId && currentId === appendedCurrentId && pending?.filterKey === filterKey) {
      scrolledSelectionKeyRef.current = selectionKey;
      settledSelectionPresentRef.current = undefined;
    }
    // Clear the settled marker if the selected row leaves this filter so it can be revealed
    // again when it returns. Manual pagination clears the marker in its click handler.
    if (
      currentId &&
      scrolledSelectionKeyRef.current === selectionKey &&
      settledSelectionPresentRef.current === selectionKey &&
      !locationById.has(currentId)
    ) {
      scrolledSelectionKeyRef.current = undefined;
      settledSelectionPresentRef.current = undefined;
      selectionRevealAttemptsRef.current = { key: "", count: 0 };
    }
    if (loading || !hasTopics || editing) return;
    if (scrolledSelectionKeyRef.current === selectionKey) return;
    if (!currentId || query) return;
    const loc = locationById.get(currentId);
    if (!loc) return;
    const result = scrollToRow(loc.sectionIndex, loc.rowIndex, "nearest");
    if (result === "unavailable") return;
    if (selectionRevealAttemptsRef.current.key !== selectionKey) {
      selectionRevealAttemptsRef.current = { key: selectionKey, count: 0 };
    }
    selectionRevealAttemptsRef.current.count += 1;
    if (
      result === "settled" ||
      selectionRevealAttemptsRef.current.count >= MAX_SCROLL_REVEAL_ATTEMPTS
    ) {
      scrolledSelectionKeyRef.current = selectionKey;
      settledSelectionPresentRef.current = selectionKey;
    }
  }, [
    loading,
    hasTopics,
    editing,
    topics,
    filterKey,
    selectionKey,
    currentId,
    appendedCurrentId,
    query,
    locationById,
    scrollToRow,
    slices,
    offsets,
  ]);

  const locationByIdRef = useRef(locationById);
  locationByIdRef.current = locationById;

  useEffect(() => {
    if (!editing) return;
    const loc = locationByIdRef.current.get(editing);
    if (loc) scrollToRow(loc.sectionIndex, loc.rowIndex, "nearest");
    input.current?.focus();
  }, [editing, scrollToRow]);

  const topicAtGlobalIndex = useCallback(
    (
      targetGlobalIndex: number,
    ): { sectionIndex: number; localIndex: number; topic: T } | undefined => {
      if (targetGlobalIndex < 0 || targetGlobalIndex >= totalCount) return undefined;
      for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
        const section = sections[sectionIndex];
        if (!section) continue;
        const localIndex = targetGlobalIndex - section.startGlobalIndex;
        if (localIndex >= 0 && localIndex < section.items.length) {
          const topic = section.items[localIndex];
          if (topic) return { sectionIndex, localIndex, topic };
        }
      }
      return undefined;
    },
    [sections, totalCount],
  );

  const rowHasTabbable = useCallback(
    (topic: T): boolean => {
      if (editing === topic.id) return !busy;
      if (archived) return !(busy || restoring || !available);
      return !(busy || restoring || !available) || (!busy && canRename?.(topic) !== false);
    },
    [editing, archived, busy, restoring, available, canRename],
  );

  const findNextTabbableGlobalIndex = useCallback(
    (fromIndex: number, direction: 1 | -1): number | undefined => {
      for (
        let index = fromIndex + direction;
        index >= 0 && index < totalCount;
        index += direction
      ) {
        const entry = topicAtGlobalIndex(index);
        if (entry && rowHasTabbable(entry.topic)) return index;
      }
      return undefined;
    },
    [totalCount, topicAtGlobalIndex, rowHasTabbable],
  );

  const findTabbablePageTarget = useCallback(
    (fromIndex: number, step: number, direction: 1 | -1): number | undefined => {
      const rawTarget =
        direction === 1
          ? Math.min(totalCount - 1, fromIndex + step)
          : Math.max(0, fromIndex - step);
      const atOrBeyond = findNextTabbableGlobalIndex(rawTarget - direction, direction);
      if (atOrBeyond !== undefined) return atOrBeyond;
      const beforeTarget = findNextTabbableGlobalIndex(rawTarget, -direction as 1 | -1);
      if (
        beforeTarget !== undefined &&
        (direction === 1 ? beforeTarget > fromIndex : beforeTarget < fromIndex)
      ) {
        return beforeTarget;
      }
      return undefined;
    },
    [totalCount, findNextTabbableGlobalIndex],
  );

  const focusGlobalIndex = useCallback(
    (targetGlobalIndex: number, edge: FocusEdge = "primary") => {
      if (totalCount <= 0) return;
      const clamped = Math.max(0, Math.min(totalCount - 1, targetGlobalIndex));
      const entry = topicAtGlobalIndex(clamped);
      if (!entry || !rowHasTabbable(entry.topic)) return;
      const { sectionIndex, localIndex, topic } = entry;
      setFocusedId(topic.id);
      const result = scrollToRow(sectionIndex, localIndex, "nearest");
      const node = rowElementsRef.current.get(topic.id);
      const focused = !!node && focusTopicRowElement(node, edge);
      if (focused && result === "settled") {
        pendingFocusRef.current = undefined;
      } else {
        pendingFocusRef.current = { id: topic.id, edge, attempts: 0 };
      }
    },
    [totalCount, topicAtGlobalIndex, rowHasTabbable, scrollToRow],
  );

  // Complete deferred keyboard focus and confirm measured scroll alignment once mounted in flow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-check after virtual slice, measured offsets, or focus pinning updates.
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const loc = locationById.get(pending.id);
    const entry = loc ? topicAtGlobalIndex(loc.globalIndex) : undefined;
    if (!loc || !entry || !rowHasTabbable(entry.topic)) {
      pendingFocusRef.current = undefined;
      return;
    }
    const result = scrollToRow(loc.sectionIndex, loc.rowIndex, "nearest");
    const node = rowElementsRef.current.get(pending.id);
    const focused =
      !!node && (node.contains(document.activeElement) || focusTopicRowElement(node, pending.edge));
    if (result !== "unavailable") pending.attempts += 1;
    if ((focused && result === "settled") || pending.attempts >= MAX_SCROLL_REVEAL_ATTEMPTS) {
      pendingFocusRef.current = undefined;
    }
  }, [slices, offsets, focusedId, locationById, topicAtGlobalIndex, rowHasTabbable, scrollToRow]);

  // Allow enclosing focus-trapped panels (e.g. narrow BotPanelFrame) to wrap Tab/Shift+Tab to the
  // first or last logical tabbable row even when that row is outside the mounted window.
  useEffect(() => {
    const node = groupsRef.current;
    if (!node) return;
    const handleVirtualEdge = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const edge = (event.detail as { edge?: "first" | "last" } | null)?.edge;
      if (edge !== "first" && edge !== "last") return;
      const targetIndex =
        edge === "first"
          ? findNextTabbableGlobalIndex(-1, 1)
          : findNextTabbableGlobalIndex(totalCount, -1);
      if (targetIndex === undefined) return;
      event.preventDefault();
      focusGlobalIndex(targetIndex, edge);
    };
    node.addEventListener("pibot:focus-virtual-edge", handleVirtualEdge);
    return () => node.removeEventListener("pibot:focus-virtual-edge", handleVirtualEdge);
  }, [totalCount, findNextTabbableGlobalIndex, focusGlobalIndex]);

  const handleListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        totalCount <= 0
      ) {
        return;
      }
      const targetRow =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-topic-index]")
          : null;
      const rawIndex = targetRow?.dataset.topicIndex;
      const current = rawIndex !== undefined ? Number.parseInt(rawIndex, 10) : Number.NaN;
      if (!targetRow || Number.isNaN(current)) return;

      if (event.key === "Tab") {
        const tabbables = getRowTabbables(targetRow);
        const targetIndex =
          event.target instanceof HTMLElement ? tabbables.indexOf(event.target) : -1;
        if (targetIndex < 0) return;
        if (!event.shiftKey && targetIndex === tabbables.length - 1) {
          const nextIndex = findNextTabbableGlobalIndex(current, 1);
          if (nextIndex !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            focusGlobalIndex(nextIndex, "first");
          }
        } else if (event.shiftKey && targetIndex === 0) {
          const prevIndex = findNextTabbableGlobalIndex(current, -1);
          if (prevIndex !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            focusGlobalIndex(prevIndex, "last");
          }
        }
        return;
      }

      const pageStep = Math.max(1, Math.floor(getViewportHeight() / ESTIMATED_ROW_HEIGHT));
      switch (event.key) {
        case "ArrowDown": {
          const next = findNextTabbableGlobalIndex(current, 1);
          if (next !== undefined) {
            event.preventDefault();
            focusGlobalIndex(next);
          }
          break;
        }
        case "ArrowUp": {
          const prev = findNextTabbableGlobalIndex(current, -1);
          if (prev !== undefined) {
            event.preventDefault();
            focusGlobalIndex(prev);
          } else if (searchInput.current) {
            event.preventDefault();
            searchInput.current.focus();
          }
          break;
        }
        case "Home": {
          const first = findNextTabbableGlobalIndex(-1, 1);
          if (first !== undefined) {
            event.preventDefault();
            focusGlobalIndex(first);
          }
          break;
        }
        case "End": {
          const last = findNextTabbableGlobalIndex(totalCount, -1);
          if (last !== undefined) {
            event.preventDefault();
            focusGlobalIndex(last);
          }
          break;
        }
        case "PageDown": {
          const next = findTabbablePageTarget(current, pageStep, 1);
          if (next !== undefined) {
            event.preventDefault();
            focusGlobalIndex(next);
          }
          break;
        }
        case "PageUp": {
          const prev = findTabbablePageTarget(current, pageStep, -1);
          if (prev !== undefined) {
            event.preventDefault();
            focusGlobalIndex(prev);
          }
          break;
        }
      }
    },
    [
      totalCount,
      getViewportHeight,
      findNextTabbableGlobalIndex,
      findTabbablePageTarget,
      focusGlobalIndex,
    ],
  );

  const handleEnterFirstRowTab = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Tab" || event.shiftKey || totalCount <= 0) return;
      const firstIndex = findNextTabbableGlobalIndex(-1, 1);
      if (firstIndex === undefined) return;
      const first = topicAtGlobalIndex(firstIndex);
      if (first && !rowElementsRef.current.has(first.topic.id)) {
        event.preventDefault();
        event.stopPropagation();
        focusGlobalIndex(firstIndex, "first");
      }
    },
    [totalCount, findNextTabbableGlobalIndex, topicAtGlobalIndex, focusGlobalIndex],
  );

  // Return a stable ref callback per topic id so React does not unobserve/re-observe rows on every render.
  const getRowRef = useCallback(
    (id: string) => {
      let callback = rowCallbacksRef.current.get(id);
      if (!callback) {
        const refCallback = (node: HTMLDivElement | null) => {
          setRowRef(id, node);
          if (node) {
            rowElementsRef.current.set(id, node);
            rowCallbacksRef.current.set(id, refCallback);
          } else {
            rowElementsRef.current.delete(id);
            if (rowCallbacksRef.current.get(id) === refCallback) {
              rowCallbacksRef.current.delete(id);
            }
          }
        };
        callback = refCallback;
        rowCallbacksRef.current.set(id, refCallback);
      }
      return callback;
    },
    [setRowRef],
  );

  const renderTopicRow = (
    topic: T,
    period: TopicPeriod,
    globalIndex: number,
    pinnedTop?: number,
  ) => {
    const runState = status?.(topic);
    return (
      <div
        key={topic.id}
        ref={getRowRef(topic.id)}
        data-topic-index={globalIndex}
        data-pinned-row={pinnedTop !== undefined ? "true" : undefined}
        className={pinnedTop !== undefined ? virtualStyles.pinnedRow : undefined}
        style={pinnedTop !== undefined ? { top: pinnedTop } : undefined}
        onFocusCapture={() => setFocusedId(topic.id)}
      >
        <div className={styles.topic} data-current={topic.id === currentId}>
          <IconTile
            icon={archived ? "archive" : "message"}
            tone={topicTone(archived, runState)}
            className={styles.topicMark}
          />
          {editing === topic.id ? (
            <input
              ref={input}
              className={styles.renameInput}
              aria-label={t("workspace.rename")}
              value={title}
              maxLength={200}
              disabled={busy}
              onChange={(event) => setTitle(event.currentTarget.value)}
              onBlur={() => rename(topic.id)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  rename(topic.id);
                }
                if (event.key === "Escape") {
                  event.stopPropagation();
                  cancelRename();
                }
                if (event.key === "Tab") {
                  const targetRow = event.currentTarget.closest<HTMLElement>("[data-topic-index]");
                  const tabbables = targetRow ? getRowTabbables(targetRow) : [];
                  const targetIndex = tabbables.indexOf(event.currentTarget);
                  if (event.shiftKey && targetIndex <= 0) {
                    const prevIndex = findNextTabbableGlobalIndex(globalIndex, -1);
                    if (prevIndex !== undefined) {
                      event.preventDefault();
                      event.stopPropagation();
                      focusGlobalIndex(prevIndex, "last");
                    }
                  } else if (
                    !event.shiftKey &&
                    targetIndex >= 0 &&
                    targetIndex === tabbables.length - 1
                  ) {
                    const nextIndex = findNextTabbableGlobalIndex(globalIndex, 1);
                    if (nextIndex !== undefined) {
                      event.preventDefault();
                      event.stopPropagation();
                      focusGlobalIndex(nextIndex, "first");
                    }
                  }
                }
              }}
            />
          ) : (
            <button
              type="button"
              data-topic-action={archived ? undefined : "true"}
              className={styles.topicButton}
              aria-current={topic.id === currentId || undefined}
              disabled={busy || restoring || !available || archived}
              onClick={() => open(topic)}
              onKeyDown={handleListKeyDown}
            >
              <span className={styles.topicTitleRow}>
                <span className={styles.topicTitle}>
                  {displayTopicTitle(
                    displayTitle?.(topic) ?? (topic.title || t("workspace.untitled")),
                    t("messages.forwardedTitle"),
                  )}
                </span>
                {showImported && (
                  <span className={styles.current}>{t("conversationImport.importedBadge")}</span>
                )}
                {runState && <TopicRunMark state={runState} label={t(runStateLabel[runState])} />}
              </span>
              {extra?.(topic)}
              <span className={styles.topicMeta}>{folderName(topic)}</span>
              <span className={styles.topicMeta}>
                <time dateTime={topic.updatedAt}>
                  {timeFormatters[period].format(new Date(topic.updatedAt))}
                </time>{" "}
                · {t("workspace.topicMessages", { count: topic.messageCount ?? 0 })}
              </span>
            </button>
          )}
          {topic.id === currentId && (
            <span className={styles.current}>{t("workspace.currentTopic")}</span>
          )}
          {archived ? (
            <Button
              variant="pill"
              data-topic-action="true"
              disabled={busy || restoring || !available}
              onClick={() => restore(topic.id)}
              onKeyDown={handleListKeyDown}
            >
              {t("topic.restore")}
            </Button>
          ) : canRename?.(topic) === false ? null : (
            <Button
              variant="circle"
              className={styles.rename}
              aria-label={t("workspace.renameTopic", {
                title: topic.title || t("workspace.untitled"),
              })}
              disabled={busy}
              onClick={() => startRename(topic)}
              onKeyDown={handleListKeyDown}
            >
              <Icon name="edit" size={14} />
            </Button>
          )}
        </div>
      </div>
    );
  };

  // Detect an empty terminal "More topics" page synchronously during render so the 30px footer
  // spacer commits in the exact same DOM update as removing the button (avoiding scroll clamping).
  const pendingLoadMore = pendingLoadMoreRef.current;
  const emptyTerminalPage =
    !more &&
    !loading &&
    topics.length > 0 &&
    pendingLoadMore !== undefined &&
    pendingLoadMore.filterKey === filterKey &&
    topics.length <= pendingLoadMore.count;
  const showEmptyFooterSpacer =
    !more &&
    !loading &&
    topics.length > 0 &&
    (emptyTerminalPage ||
      (retainedFooter !== undefined &&
        retainedFooter.filterKey === filterKey &&
        topics.length <= retainedFooter.count));

  useLayoutEffect(() => {
    const pending = pendingLoadMoreRef.current;
    if (
      pending &&
      !busy &&
      (pending.filterKey !== filterKey || !more || topics.length > pending.count)
    ) {
      if (!more && pending.filterKey === filterKey && !loading && topics.length > 0) {
        if (topics.length <= pending.count) {
          setRetainedFooter({ filterKey, count: topics.length });
        }
        if (
          pending.restoreFocus &&
          (!document.activeElement || document.activeElement === document.body)
        ) {
          const preferredIndex =
            topics.length > pending.count ? pending.count : Math.max(0, totalCount - 1);
          let focused = false;
          for (const candidate of [
            preferredIndex,
            Math.max(0, pending.count - 1),
            Math.max(0, totalCount - 1),
          ]) {
            const entry = topicAtGlobalIndex(candidate);
            const node = entry ? rowElementsRef.current.get(entry.topic.id) : undefined;
            if (entry && node && rowHasTabbable(entry.topic) && focusTopicRowElement(node)) {
              setFocusedId(entry.topic.id);
              focused = true;
              break;
            }
          }
          if (!focused) searchInput.current?.focus({ preventScroll: true });
        }
      }
      pendingLoadMoreRef.current = undefined;
    }
    if (
      retainedFooter &&
      (more ||
        loading ||
        retainedFooter.filterKey !== filterKey ||
        topics.length === 0 ||
        topics.length > retainedFooter.count)
    ) {
      setRetainedFooter(undefined);
    }
  }, [
    busy,
    more,
    loading,
    filterKey,
    topics.length,
    totalCount,
    retainedFooter,
    topicAtGlobalIndex,
    rowHasTabbable,
  ]);

  return (
    <div ref={list} className={`${styles.stack} ${virtualStyles.listRoot}`}>
      <SegmentedControl<"active" | "archived" | "imported">
        label={t("workspace.topics")}
        value={showImported ? "imported" : archived ? "archived" : "active"}
        options={[
          { value: "active", label: t("topic.active") },
          { value: "archived", label: t("topic.archived") },
          ...(imported
            ? [{ value: "imported" as const, label: t("conversationImport.importedBadge") }]
            : []),
        ]}
        onValueChange={(value) => {
          cancelRename();
          setArchived(value === "archived");
          imported?.setActive(value === "imported");
        }}
      />
      {archived && <p className={styles.note}>{t("topic.archivedHint")}</p>}
      <div className={styles.search}>
        <Icon name="search" size={14} />
        <input
          ref={searchInput}
          type="search"
          aria-label={t("workspace.topicSearch")}
          placeholder={t("workspace.topicSearch")}
          maxLength={200}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "ArrowDown" && totalCount > 0) {
              const first = findNextTabbableGlobalIndex(-1, 1);
              if (first !== undefined) {
                event.preventDefault();
                focusGlobalIndex(first);
              }
            } else if (!error) {
              handleEnterFirstRowTab(event);
            }
          }}
        />
      </div>
      {loading && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}{" "}
          <Button variant="pill" onClick={retry} onKeyDown={handleEnterFirstRowTab}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      <div
        ref={groupsRef}
        data-virtual-focus-region="true"
        className={`${styles.topicGroups} ${virtualStyles.groups}`}
        onBlurCapture={(event) => {
          if (pendingFocusRef.current) return;
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setFocusedId(undefined);
        }}
      >
        {sections.map((section, sectionIndex) => {
          const slice = slices[sectionIndex] ?? {
            start: 0,
            end: 0,
            paddingTop: 0,
            paddingBottom: 0,
            totalHeight: 0,
          };
          const sectionOffsets = offsets[sectionIndex] ?? new Float64Array(1);
          const pinnedBefore: number[] = [];
          const pinnedAfter: number[] = [];
          for (const pinnedId of [editing, focusedId]) {
            if (!pinnedId) continue;
            const loc = locationById.get(pinnedId);
            if (!loc || loc.sectionIndex !== sectionIndex) continue;
            if (loc.rowIndex < slice.start && !pinnedBefore.includes(loc.rowIndex)) {
              pinnedBefore.push(loc.rowIndex);
            } else if (loc.rowIndex >= slice.end && !pinnedAfter.includes(loc.rowIndex)) {
              pinnedAfter.push(loc.rowIndex);
            }
          }
          pinnedBefore.sort((a, b) => a - b);
          pinnedAfter.sort((a, b) => a - b);

          const visibleRows: ReactNode[] = [];
          for (const rowIndex of pinnedBefore) {
            const topic = section.items[rowIndex];
            if (!topic) continue;
            visibleRows.push(
              renderTopicRow(
                topic,
                section.period,
                section.startGlobalIndex + rowIndex,
                sectionOffsets[rowIndex] ?? 0,
              ),
            );
          }
          for (let rowIndex = slice.start; rowIndex < slice.end; rowIndex++) {
            const topic = section.items[rowIndex];
            if (!topic) continue;
            visibleRows.push(
              renderTopicRow(topic, section.period, section.startGlobalIndex + rowIndex),
            );
          }
          for (const rowIndex of pinnedAfter) {
            const topic = section.items[rowIndex];
            if (!topic) continue;
            visibleRows.push(
              renderTopicRow(
                topic,
                section.period,
                section.startGlobalIndex + rowIndex,
                sectionOffsets[rowIndex] ?? 0,
              ),
            );
          }

          return (
            <section key={section.period}>
              <div className={styles.groupTitle}>{t(`workspace.topicGroup.${section.period}`)}</div>
              <div className={styles.topicCard}>
                <div
                  ref={getCardRef(section.period)}
                  className={virtualStyles.cardInner}
                  style={{ paddingTop: slice.paddingTop, paddingBottom: slice.paddingBottom }}
                >
                  {visibleRows}
                </div>
              </div>
            </section>
          );
        })}
      </div>
      {!loading && !error && !topics.length && (
        <p className={styles.note}>{t("workspace.empty")}</p>
      )}
      {more ? (
        <Button
          variant="pill"
          className={styles.more}
          disabled={busy || loading}
          onClick={(event) => {
            // Routine pagination must keep the viewport anchored instead of jumping to a
            // newly appended current topic.
            staleFilterTopicsRef.current = undefined;
            scrolledSelectionKeyRef.current = selectionKey;
            settledSelectionPresentRef.current = undefined;
            pendingFocusRef.current = undefined;
            pendingLoadMoreRef.current = {
              filterKey,
              count: topics.length,
              restoreFocus: document.activeElement === event.currentTarget,
            };
            loadMore();
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab" && event.shiftKey && totalCount > 0) {
              const lastIndex = findNextTabbableGlobalIndex(totalCount, -1);
              if (lastIndex === undefined) return;
              const last = topicAtGlobalIndex(lastIndex);
              if (last && !rowElementsRef.current.has(last.topic.id)) {
                event.preventDefault();
                event.stopPropagation();
                focusGlobalIndex(lastIndex, "last");
              }
            }
          }}
        >
          {t("workspace.moreTopics")}
        </Button>
      ) : showEmptyFooterSpacer ? (
        <div className={virtualStyles.footerSpacer} aria-hidden="true" />
      ) : null}
    </div>
  );
}

function TopicRunMark({ state, label }: { state: TopicRunState; label: string }) {
  return (
    <span
      className={styles.topicRunMark}
      data-state={state}
      role="img"
      aria-label={label}
      title={label}
    >
      {state === "running" ? (
        <span className={styles.topicRunSpinner} />
      ) : (
        <Icon name={state === "queued" ? "clock" : "hand"} size={13} />
      )}
    </span>
  );
}
