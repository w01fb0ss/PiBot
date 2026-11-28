import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildSectionOffsets,
  computeInitialSlices,
  computeSectionSlice,
  DEFAULT_VIEWPORT_HEIGHT,
  ESTIMATED_ROW_HEIGHT,
  findStartIndex,
  OVERSCAN_PX,
  ROW_GAP,
  type SectionSlice,
  sectionTotalHeight,
  slicesEqual,
} from "./topic-virtual.ts";

export interface VirtualSectionInput {
  key: string;
  ids: readonly string[];
}

export type ScrollToRowResult = "unavailable" | "pending" | "settled";

const MAX_CACHED_HEIGHTS = 10_000;

function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Windows topic sections against the nearest scrollable ancestor (`TopicPopover` or side panel),
 * measuring mounted rows with a single shared ResizeObserver and anchoring scroll when rows above
 * the viewport change height.
 */
export function useTopicVirtualizer({
  sections,
  listRef,
  filterKey,
}: {
  sections: readonly VirtualSectionInput[];
  listRef: RefObject<HTMLDivElement | null>;
  filterKey: string;
}) {
  const heightsRef = useRef<Map<string, number>>(new Map());
  const [heightVersion, setHeightVersion] = useState(0);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardCallbacksRef = useRef<Map<string, (node: HTMLDivElement | null) => void>>(new Map());
  const rowObserverRef = useRef<ResizeObserver | null>(null);
  const observedIdRef = useRef<WeakMap<Element, string>>(new WeakMap());
  const observedNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const viewportHeightRef = useRef(DEFAULT_VIEWPORT_HEIGHT);
  const anchorRef = useRef<{ id: string; top: number } | undefined>(undefined);
  const previousLayout = useRef({ sections, filterKey });
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `heightVersion` invalidates prefix sums when ResizeObserver updates `heightsRef`.
  const offsets = useMemo(() => {
    if (heightsRef.current.size > MAX_CACHED_HEIGHTS) {
      const liveIds = new Set<string>();
      for (const section of sections) {
        for (const id of section.ids) liveIds.add(id);
      }
      for (const key of heightsRef.current.keys()) {
        if (!liveIds.has(key)) heightsRef.current.delete(key);
      }
    }
    return sections.map((section) => buildSectionOffsets(section.ids, heightsRef.current));
  }, [sections, heightVersion]);

  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  const [slices, setSlices] = useState<SectionSlice[]>(() => computeInitialSlices(offsets));

  // Clamp/project cached slices onto the latest offsets during render so paging or filtering
  // never flashes stale paddingBottom or out-of-range indices before useLayoutEffect runs.
  const resolvedSlices = useMemo(() => {
    if (slices.length !== offsets.length) {
      return computeInitialSlices(offsets, viewportHeightRef.current);
    }
    return slices.map((slice, index) => {
      const sectionOffsets = offsets[index] ?? new Float64Array(1);
      const count = Math.max(0, sectionOffsets.length - 1);
      const totalHeight = sectionTotalHeight(sectionOffsets, ROW_GAP);
      const start = Math.min(slice.start, count);
      const end = Math.min(Math.max(slice.end, start), count);
      if (start >= end) {
        return { start: 0, end: 0, paddingTop: totalHeight, paddingBottom: 0, totalHeight };
      }
      const paddingTop = sectionOffsets[start] ?? 0;
      const paddingBottom = Math.max(0, (sectionOffsets[count] ?? 0) - (sectionOffsets[end] ?? 0));
      return { start, end, paddingTop, paddingBottom, totalHeight };
    });
  }, [slices, offsets]);

  // Tracks the exact slices committed to the DOM so programmatic reveals can verify normal-flow
  // mount state and detect whether recompute queued a new slice commit.
  const committedSlicesRef = useRef<SectionSlice[]>(resolvedSlices);
  useLayoutEffect(() => {
    committedSlicesRef.current = resolvedSlices;
  }, [resolvedSlices]);

  const getScroller = useCallback(() => {
    if (scrollerRef.current?.isConnected) return scrollerRef.current;
    const found = findScrollContainer(listRef.current);
    scrollerRef.current = found;
    return found;
  }, [listRef]);

  const recompute = useCallback((): boolean => {
    const currentOffsets = offsetsRef.current;
    const currentSections = sectionsRef.current;
    const scroller = getScroller();

    if (!scroller || scroller.clientHeight <= 0) {
      const fallback = computeInitialSlices(currentOffsets, viewportHeightRef.current);
      const changed = !slicesEqual(committedSlicesRef.current, fallback);
      setSlices((previous) => (slicesEqual(previous, fallback) ? previous : fallback));
      return changed;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const clientHeight = scroller.clientHeight;
    viewportHeightRef.current = clientHeight;
    const viewportTop = scrollerRect.top + scroller.clientTop;
    const viewportBottom = viewportTop + clientHeight;

    const nextSlices: SectionSlice[] = [];
    let anchor: typeof anchorRef.current;
    let fallbackCursorY = 0;
    for (let index = 0; index < currentOffsets.length; index++) {
      const sectionOffsets = currentOffsets[index] ?? new Float64Array(1);
      const sectionKey = currentSections[index]?.key;
      const card = sectionKey !== undefined ? cardRefs.current.get(sectionKey) : undefined;
      if (card) {
        const cardRect = card.getBoundingClientRect();
        const top = viewportTop - cardRect.top;
        if (!anchor && scroller.scrollTop > 0 && cardRect.top < viewportBottom) {
          const rowIndex = findStartIndex(sectionOffsets, top);
          const id = currentSections[index]?.ids[rowIndex];
          const offset = sectionOffsets[rowIndex];
          if (id && offset !== undefined) anchor = { id, top: offset - top };
        }
        nextSlices.push(
          computeSectionSlice(
            sectionOffsets,
            top,
            viewportBottom - cardRect.top,
            OVERSCAN_PX,
            ROW_GAP,
          ),
        );
      } else {
        const slice = computeSectionSlice(
          sectionOffsets,
          -fallbackCursorY,
          clientHeight - fallbackCursorY,
          OVERSCAN_PX,
          ROW_GAP,
        );
        fallbackCursorY += slice.totalHeight + 40;
        nextSlices.push(slice);
      }
    }

    anchorRef.current = anchor;
    const changed = !slicesEqual(committedSlicesRef.current, nextSlices);
    setSlices((previous) => (slicesEqual(previous, nextSlices) ? previous : nextSlices));
    return changed;
  }, [getScroller]);

  useLayoutEffect(() => {
    const previous = previousLayout.current;
    previousLayout.current = { sections, filterKey };
    const anchor = anchorRef.current;
    // An inserted or reordered head can move a retained row even when scrollTop is unchanged.
    if (anchor && previous.sections !== sections && previous.filterKey === filterKey) {
      const scroller = getScroller();
      if (scroller) {
        for (const [index, section] of sections.entries()) {
          const rowIndex = section.ids.indexOf(anchor.id);
          if (rowIndex < 0) continue;
          const card = cardRefs.current.get(section.key);
          const offset = offsets[index]?.[rowIndex];
          if (card && offset !== undefined) {
            const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop;
            const shift = card.getBoundingClientRect().top + offset - viewportTop - anchor.top;
            if (Math.abs(shift) >= 0.5) scroller.scrollTop += shift;
          }
          break;
        }
      }
    }
    recompute();
  }, [filterKey, getScroller, offsets, recompute, sections]);

  // Shared ResizeObserver for mounted rows, with upward-scroll height compensation.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const scroller = getScroller();
      const viewportTop =
        scroller && scroller.clientHeight > 0
          ? scroller.getBoundingClientRect().top + scroller.clientTop
          : undefined;

      const changes: {
        previous: number;
        delta: number;
        top: number;
        pinned: boolean;
      }[] = [];

      for (const entry of entries) {
        if (entry.target.isConnected === false) continue;
        const id = observedIdRef.current.get(entry.target);
        if (!id) continue;
        const rect = entry.target.getBoundingClientRect();
        const measured = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? rect.height);
        if (measured <= 0) continue;
        const previous = heightsRef.current.get(id) ?? ESTIMATED_ROW_HEIGHT;
        const delta = measured - previous;
        if (Math.abs(delta) < 1) continue;
        heightsRef.current.set(id, measured);
        changes.push({
          previous,
          delta,
          top: rect.top,
          pinned: entry.target instanceof HTMLElement && entry.target.dataset.pinnedRow === "true",
        });
      }

      if (changes.length === 0) return;

      if (scroller && scroller.scrollTop > 0 && viewportTop !== undefined) {
        // Evaluate resized rows top-to-bottom using each row's pre-resize bottom edge so a row
        // wholly above the viewport that grows across `viewportTop` is still compensated, while a
        // partly visible first row never shifts its own top edge.
        changes.sort((a, b) => a.top - b.top);
        let priorFlowDelta = 0;
        let scrollCompensation = 0;
        for (const change of changes) {
          const preTop = change.pinned ? change.top : change.top - priorFlowDelta;
          const preBottom = preTop + change.previous;
          if (preBottom <= viewportTop + 1) {
            scrollCompensation += change.delta;
          }
          if (!change.pinned) {
            priorFlowDelta += change.delta;
          }
        }
        if (scrollCompensation !== 0) {
          scroller.scrollTop = Math.max(0, scroller.scrollTop + scrollCompensation);
        }
      }
      setHeightVersion((value) => value + 1);
    });

    rowObserverRef.current = observer;
    for (const node of observedNodesRef.current.values()) {
      observer.observe(node);
    }
    return () => {
      observer.disconnect();
      rowObserverRef.current = null;
    };
  }, [getScroller]);

  // Listen to scroll and container/sibling layout changes.
  useEffect(() => {
    const list = listRef.current;
    const scroller = findScrollContainer(list);
    scrollerRef.current = scroller;
    if (!scroller) return;

    recompute();
    scroller.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute, { passive: true });

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(recompute);
      resizeObserver.observe(scroller);
      if (list) resizeObserver.observe(list);
      if (list?.parentElement && list.parentElement !== scroller) {
        resizeObserver.observe(list.parentElement);
      }
    }

    return () => {
      scroller.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
      resizeObserver?.disconnect();
    };
  }, [listRef, recompute]);

  // Return a stable ref callback per section key so React does not detach/reattach on every render.
  const getCardRef = useCallback((sectionKey: string) => {
    let callback = cardCallbacksRef.current.get(sectionKey);
    if (!callback) {
      const refCallback = (node: HTMLDivElement | null) => {
        if (node) {
          cardRefs.current.set(sectionKey, node);
          cardCallbacksRef.current.set(sectionKey, refCallback);
        } else {
          cardRefs.current.delete(sectionKey);
          if (cardCallbacksRef.current.get(sectionKey) === refCallback) {
            cardCallbacksRef.current.delete(sectionKey);
          }
        }
      };
      callback = refCallback;
      cardCallbacksRef.current.set(sectionKey, refCallback);
    }
    return callback;
  }, []);

  const setRowRef = useCallback((id: string, node: HTMLDivElement | null) => {
    const previous = observedNodesRef.current.get(id);
    if (previous && previous !== node) {
      rowObserverRef.current?.unobserve(previous);
      observedNodesRef.current.delete(id);
    }
    if (!node) return;
    observedIdRef.current.set(node, id);
    if (previous !== node) {
      observedNodesRef.current.set(id, node);
      rowObserverRef.current?.observe(node);
    }
  }, []);

  const syncMountedHeights = useCallback((): boolean => {
    let changed = false;
    for (const [id, node] of observedNodesRef.current) {
      if (!node.isConnected) continue;
      const measured = Math.round(node.getBoundingClientRect().height);
      if (measured <= 0) continue;
      const previous = heightsRef.current.get(id) ?? ESTIMATED_ROW_HEIGHT;
      if (Math.abs(measured - previous) < 1) continue;
      heightsRef.current.set(id, measured);
      changed = true;
    }
    if (changed) {
      offsetsRef.current = sectionsRef.current.map((section) =>
        buildSectionOffsets(section.ids, heightsRef.current),
      );
      setHeightVersion((value) => value + 1);
    }
    return changed;
  }, []);

  const scrollToRow = useCallback(
    (
      sectionIndex: number,
      rowIndex: number,
      align: "nearest" | "center" = "nearest",
    ): ScrollToRowResult => {
      const scroller = getScroller();
      const section = sectionsRef.current[sectionIndex];
      const sectionKey = section?.key;
      const card = sectionKey !== undefined ? cardRefs.current.get(sectionKey) : undefined;
      const initialOffsets = offsetsRef.current[sectionIndex];
      if (
        !scroller ||
        !card ||
        !section ||
        !initialOffsets ||
        rowIndex < 0 ||
        rowIndex >= initialOffsets.length - 1
      ) {
        return "unavailable";
      }

      const scrollerRect = scroller.getBoundingClientRect();
      const viewportTop = scrollerRect.top + scroller.clientTop;
      const clientHeight = scroller.clientHeight;
      if (clientHeight <= 0) return "unavailable";

      // Record heights of currently mounted rows synchronously so ResizeObserver does not apply
      // stale upward-scroll compensation after a programmatic jump and recompute uses real heights.
      const heightsChanged = syncMountedHeights();
      const sectionOffsets = offsetsRef.current[sectionIndex] ?? initialOffsets;
      const committedSlice = committedSlicesRef.current[sectionIndex];
      const rowId = section.ids[rowIndex];
      const node = rowId !== undefined ? observedNodesRef.current.get(rowId) : undefined;
      const mountedInFlow =
        !!node &&
        node.isConnected &&
        !!committedSlice &&
        rowIndex >= committedSlice.start &&
        rowIndex < committedSlice.end;

      let rowTopInViewport: number;
      let rowBottomInViewport: number;
      let measuredTarget = false;
      if (mountedInFlow) {
        const rect = node.getBoundingClientRect();
        if (rect.height > 0) {
          rowTopInViewport = rect.top - viewportTop;
          rowBottomInViewport = rect.bottom - viewportTop;
          measuredTarget = true;
        } else {
          return "unavailable";
        }
      } else {
        const cardRect = card.getBoundingClientRect();
        const rowTopInCard = sectionOffsets[rowIndex] ?? 0;
        const rowBottomInCard = (sectionOffsets[rowIndex + 1] ?? rowTopInCard) - ROW_GAP;
        rowTopInViewport = cardRect.top + rowTopInCard - viewportTop;
        rowBottomInViewport = cardRect.top + rowBottomInCard - viewportTop;
      }

      const margin = 8;
      const tolerance = 0.5;
      const rowHeight = rowBottomInViewport - rowTopInViewport;
      const fitsViewport =
        rowHeight <= clientHeight
          ? rowTopInViewport >= -tolerance && rowBottomInViewport <= clientHeight + tolerance
          : rowTopInViewport >= -tolerance && rowTopInViewport <= margin + tolerance;

      if (align === "nearest" && fitsViewport) {
        if (!measuredTarget) {
          recompute();
          return "pending";
        }
        return heightsChanged ? "pending" : "settled";
      }

      let targetScrollTop: number;
      if (align === "center") {
        const rowMid = (rowTopInViewport + rowBottomInViewport) / 2;
        targetScrollTop = scroller.scrollTop + rowMid - clientHeight / 2;
      } else if (rowHeight > clientHeight || rowTopInViewport < 0) {
        targetScrollTop = scroller.scrollTop + rowTopInViewport - margin;
      } else {
        targetScrollTop = scroller.scrollTop + rowBottomInViewport - clientHeight + margin;
      }

      scroller.scrollTop = Math.max(0, targetScrollTop);
      const slicesChanged = recompute();
      if (!measuredTarget || heightsChanged || slicesChanged) {
        return "pending";
      }
      return "settled";
    },
    [getScroller, recompute, syncMountedHeights],
  );

  const scrollToTop = useCallback(() => {
    const list = listRef.current;
    const scroller = getScroller();
    if (!scroller || !list) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const viewportTop = scrollerRect.top + scroller.clientTop;
    if (listRect.top < viewportTop) {
      // Preserve any top padding inside the scroll container (e.g. TopicPopover's 12px padding).
      const paddingTop = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      scroller.scrollTop = Math.max(
        0,
        scroller.scrollTop + listRect.top - viewportTop - paddingTop,
      );
      recompute();
    }
  }, [listRef, getScroller, recompute]);

  const getViewportHeight = useCallback(() => viewportHeightRef.current, []);

  return {
    slices: resolvedSlices,
    offsets,
    getCardRef,
    setRowRef,
    scrollToRow,
    scrollToTop,
    recompute,
    getViewportHeight,
  };
}
