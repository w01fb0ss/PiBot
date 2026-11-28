/**
 * Pure prefix-sum geometry and binary-search windowing for the virtualized topic list.
 * Kept DOM-free so layout math can be reasoned about and benchmarked in plain Node.
 */

export const ESTIMATED_ROW_HEIGHT = 74;
export const ROW_GAP = 2;
export const OVERSCAN_PX = 300;
export const DEFAULT_VIEWPORT_HEIGHT = 480;
/** Group heading (~30px) + card vertical padding (8px) + inter-section gap (2px). */
export const ESTIMATED_SECTION_CHROME_HEIGHT = 40;

export interface SectionSlice {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
  totalHeight: number;
}

/**
 * Prefix sums where `offsets[i]` is the top of row `i` inside its section card,
 * `offsets[i + 1] - gap` is the bottom of row `i`, and `offsets[n] - gap` is total height.
 */
export function buildSectionOffsets(
  ids: readonly string[],
  heights: ReadonlyMap<string, number>,
  estimatedHeight = ESTIMATED_ROW_HEIGHT,
  gap = ROW_GAP,
): Float64Array {
  const offsets = new Float64Array(ids.length + 1);
  let y = 0;
  for (let index = 0; index < ids.length; index++) {
    offsets[index] = y;
    const id = ids[index];
    const height = (id !== undefined ? heights.get(id) : undefined) ?? estimatedHeight;
    y += height + gap;
  }
  offsets[ids.length] = y;
  return offsets;
}

export function sectionTotalHeight(offsets: Float64Array, gap = ROW_GAP): number {
  if (offsets.length <= 1) return 0;
  return Math.max(0, (offsets[offsets.length - 1] ?? 0) - gap);
}

/** First row index whose bottom edge extends past `targetY`. */
export function findStartIndex(offsets: Float64Array, targetY: number, gap = ROW_GAP): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const bottom = (offsets[mid + 1] ?? 0) - gap;
    if (bottom <= targetY) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Exclusive end index: first row whose top edge is at or past `targetBottom`. */
export function findEndIndex(offsets: Float64Array, targetBottom: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((offsets[mid] ?? 0) < targetBottom) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function computeSectionSlice(
  offsets: Float64Array,
  visibleTop: number,
  visibleBottom: number,
  overscanPx = OVERSCAN_PX,
  gap = ROW_GAP,
): SectionSlice {
  const count = offsets.length - 1;
  if (count <= 0) {
    return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0 };
  }
  const totalHeight = sectionTotalHeight(offsets, gap);
  const windowTop = visibleTop - overscanPx;
  const windowBottom = visibleBottom + overscanPx;
  if (windowBottom <= 0 || windowTop >= totalHeight) {
    return { start: 0, end: 0, paddingTop: totalHeight, paddingBottom: 0, totalHeight };
  }
  const start = findStartIndex(offsets, Math.max(0, windowTop), gap);
  const end = findEndIndex(offsets, Math.min(totalHeight, windowBottom));
  if (start >= end) {
    return { start: 0, end: 0, paddingTop: totalHeight, paddingBottom: 0, totalHeight };
  }
  const paddingTop = offsets[start] ?? 0;
  const paddingBottom = Math.max(0, (offsets[count] ?? 0) - (offsets[end] ?? 0));
  return { start, end, paddingTop, paddingBottom, totalHeight };
}

/** Fallback window used before DOM layout measurement (initial render / SSR / headless tests). */
export function computeInitialSlices(
  sectionOffsets: readonly Float64Array[],
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
  overscanPx = OVERSCAN_PX,
  gap = ROW_GAP,
): SectionSlice[] {
  let cursorY = 0;
  return sectionOffsets.map((offsets) => {
    const slice = computeSectionSlice(offsets, -cursorY, viewportHeight - cursorY, overscanPx, gap);
    cursorY += slice.totalHeight + ESTIMATED_SECTION_CHROME_HEIGHT;
    return slice;
  });
}

export function slicesEqual(a: readonly SectionSlice[], b: readonly SectionSlice[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index];
    const right = b[index];
    if (!left || !right) return false;
    if (
      left.start !== right.start ||
      left.end !== right.end ||
      Math.abs(left.paddingTop - right.paddingTop) >= 0.5 ||
      Math.abs(left.paddingBottom - right.paddingBottom) >= 0.5 ||
      Math.abs(left.totalHeight - right.totalHeight) >= 0.5
    ) {
      return false;
    }
  }
  return true;
}
