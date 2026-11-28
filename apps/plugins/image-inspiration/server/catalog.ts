import dataset from "../data/inspirations.json" with { type: "json" };

export interface InspirationSource {
  readonly name: string;
  readonly url: string;
  readonly commit: string;
  readonly license: string;
}

export interface InspirationEntry {
  readonly id: string;
  readonly kind: "template" | "prompt";
  readonly title: string;
  readonly titleZh?: string;
  readonly styles: readonly string[];
  readonly layouts: readonly string[];
  readonly themes: readonly string[];
  readonly tags: readonly string[];
  readonly summary: string;
  readonly prompt: string;
  readonly guidance?: readonly string[];
  readonly guidanceZh?: readonly string[];
  readonly pitfalls?: readonly string[];
  readonly sourceRepo: string;
  readonly sourceUrl: string;
  readonly commit: string;
  readonly license: string;
}

export interface InspirationDataset {
  readonly schemaVersion: number;
  readonly sources: readonly InspirationSource[];
  readonly items: readonly InspirationEntry[];
}

export interface InspirationSearchInput {
  readonly query?: string;
  readonly style?: string;
  readonly layout?: string;
  readonly theme?: string;
  readonly limit?: number;
}

export interface InspirationSearchHit {
  readonly id: string;
  readonly kind: "template" | "prompt";
  readonly title: string;
  readonly titleZh?: string;
  readonly styles: readonly string[];
  readonly layouts: readonly string[];
  readonly themes: readonly string[];
  readonly tags: readonly string[];
  readonly summary: string;
  readonly sourceUrl: string;
  readonly commit: string;
  readonly license: string;
}

export interface InspirationSearchResult {
  readonly totalCatalog: number;
  readonly totalMatched: number;
  readonly returned: number;
  readonly availableFacets: {
    readonly styles: readonly string[];
    readonly layouts: readonly string[];
    readonly themes: readonly string[];
  };
  readonly items: readonly InspirationSearchHit[];
}

const CATALOG = dataset as InspirationDataset;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

interface IndexedEntry {
  readonly entry: InspirationEntry;
  readonly titleLower: string;
  readonly facetsLower: string;
  readonly bodyLower: string;
  readonly stylesLower: readonly string[];
  readonly layoutsLower: readonly string[];
  readonly themesLower: readonly string[];
}

function collectFacets(
  items: readonly InspirationEntry[],
  pick: (e: InspirationEntry) => readonly string[],
) {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const value of pick(item)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}

const INDEX: readonly IndexedEntry[] = CATALOG.items.map((entry) => ({
  entry,
  titleLower: `${entry.title} ${entry.titleZh ?? ""}`.toLowerCase(),
  facetsLower: [...entry.styles, ...entry.layouts, ...entry.themes, ...entry.tags]
    .join(" ")
    .toLowerCase(),
  bodyLower: `${entry.summary} ${entry.prompt}`.toLowerCase(),
  stylesLower: entry.styles.map((s) => s.toLowerCase()),
  layoutsLower: entry.layouts.map((l) => l.toLowerCase()),
  themesLower: entry.themes.map((t) => t.toLowerCase()),
}));

const BY_ID = new Map<string, InspirationEntry>(CATALOG.items.map((entry) => [entry.id, entry]));

const AVAILABLE_FACETS = {
  styles: collectFacets(CATALOG.items, (item) => item.styles).slice(0, 30),
  layouts: collectFacets(CATALOG.items, (item) => item.layouts).slice(0, 30),
  themes: collectFacets(CATALOG.items, (item) => item.themes).slice(0, 30),
} as const;

function tokenize(text: string): string[] {
  const cleaned = text.trim().toLowerCase();
  if (!cleaned) return [];
  const tokens: string[] = [];
  for (const part of cleaned.split(/[\s,，、/|;；]+/)) {
    if (!part) continue;
    if (/[\u4e00-\u9fff]/.test(part)) {
      tokens.push(part);
      // CJK queries have no whitespace boundaries; add 2-char bigrams for recall.
      for (let i = 0; i < part.length - 1; i += 1) {
        const bigram = part.slice(i, i + 2);
        if (/^[\u4e00-\u9fff]{2}$/.test(bigram)) tokens.push(bigram);
      }
    } else if (part.length >= 2) {
      tokens.push(part);
    }
  }
  return [...new Set(tokens)];
}

function matchesFilter(values: readonly string[], filter: string | undefined): boolean {
  const needle = filter?.trim().toLowerCase();
  return !needle || values.some((value) => value.includes(needle));
}

function scoreEntry(item: IndexedEntry, query: string, tokens: readonly string[]): number {
  if (!query) return item.entry.kind === "template" ? 2 : 1;
  let score = 0;
  if (item.titleLower.includes(query)) score += 20;
  if (item.facetsLower.includes(query)) score += 14;
  if (item.bodyLower.includes(query)) score += 8;
  for (const token of tokens) {
    if (item.titleLower.includes(token)) score += 6;
    if (item.facetsLower.includes(token)) score += 5;
    if (item.bodyLower.includes(token)) score += 2;
  }
  if (score > 0 && item.entry.kind === "template") score += 3;
  return score;
}

export function searchInspirations(input: InspirationSearchInput = {}): InspirationSearchResult {
  const query = (input.query ?? "").trim().toLowerCase();
  const tokens = tokenize(query);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(input.limit ?? DEFAULT_LIMIT)));

  const scored: Array<{ entry: InspirationEntry; score: number }> = [];
  for (const item of INDEX) {
    if (!matchesFilter(item.stylesLower, input.style)) continue;
    if (!matchesFilter(item.layoutsLower, input.layout)) continue;
    if (!matchesFilter(item.themesLower, input.theme)) continue;
    const score = scoreEntry(item, query, tokens);
    if (query && score <= 0) continue;
    scored.push({ entry: item.entry, score });
  }

  scored.sort(
    (left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id),
  );

  const selected = scored.slice(0, limit).map(
    ({ entry }): InspirationSearchHit => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      ...(entry.titleZh ? { titleZh: entry.titleZh } : {}),
      styles: entry.styles,
      layouts: entry.layouts,
      themes: entry.themes,
      tags: entry.tags,
      summary: entry.summary,
      sourceUrl: entry.sourceUrl,
      commit: entry.commit,
      license: entry.license,
    }),
  );

  return {
    totalCatalog: CATALOG.items.length,
    totalMatched: scored.length,
    returned: selected.length,
    availableFacets: AVAILABLE_FACETS,
    items: selected,
  };
}

export function getInspiration(id: string): InspirationEntry | undefined {
  return BY_ID.get(id.trim());
}
