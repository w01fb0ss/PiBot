import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { abortable, extractAttachment } from "@pibot/brain/kit";
import { fileIdentity, readBinaryFile, sameFile, samePathSpelling } from "@pibot/execution";
import {
  KnowledgeConfigSchema,
  type KnowledgeFolderSummary,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { transaction } from "@pibot/storage";
import { z } from "zod";
import {
  fileContext,
  firstHeading,
  localDocumentKind,
  type ObsidianVault,
  openUrl,
  titleFromPath,
  type VaultAccess,
  type VaultHit,
  type VaultRoot,
  type VaultSearch,
  vaultRoot,
} from "./obsidian.ts";

const MAX_SCAN_ENTRIES = 10_000;
const MAX_INSPECT_MS = 5_000;
const MAX_INSPECT_DOCUMENT_PROBES = 25;
const MAX_INDEX_MS = 15_000;
const MAX_INDEX_READ_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const MAX_INDEXED_CHARS = 1024 * 1024;
const MAX_SNIPPET_CHARS = 300;
const MAX_HITS_PER_NOTE = 5;
const MAX_CJK_BIGRAMS_PER_RUN = 128;
const RETRY_UNREADABLE_MS = 5 * 60_000;

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const ASCII_PREFIX_TERM_RE = /^[a-z0-9_]{2,}$/u;
const ZH_STOP = new Set([
  "的",
  "了",
  "吗",
  "呢",
  "啊",
  "吧",
  "呀",
  "么",
  "着",
  "过",
  "是",
  "在",
  "有",
  "和",
  "与",
  "把",
  "被",
  "让",
  "给",
  "里",
  "中",
]);

let cachedSegmenter: Intl.Segmenter | undefined;
function wordSegmenter(): Intl.Segmenter {
  cachedSegmenter ??= new Intl.Segmenter("zh", { granularity: "word" });
  return cachedSegmenter;
}

/**
 * Turns arbitrary CJK + Latin text into space-separated tokens for SQLite FTS5 (`unicode61`).
 * Uses Node's built-in ICU `Intl.Segmenter` so Chinese phrases without spaces index as real words,
 * plus CJK bigrams so compound words ("项目预算表") still match shorter substrings ("预算").
 */
export function tokenizeForIndex(text: string): string {
  const out: string[] = [];
  const seg = wordSegmenter();
  for (const part of seg.segment(text)) {
    if (!part.isWordLike) continue;
    const token = part.segment.toLowerCase();
    if (!token) continue;
    out.push(token);
    if (CJK_RE.test(token)) {
      const chars = [...token];
      if (chars.length >= 3) {
        const limit = Math.min(chars.length - 1, MAX_CJK_BIGRAMS_PER_RUN);
        for (let i = 0; i < limit; i++) out.push(`${chars[i]}${chars[i + 1]}`);
      }
    }
  }
  // Also add cross-boundary CJK bigrams inside contiguous CJK runs so a query split differently
  // by the segmenter still matches with BM25.
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const chars = [...match[0]];
    if (chars.length < 3) continue;
    const limit = Math.min(chars.length - 1, MAX_CJK_BIGRAMS_PER_RUN);
    for (let i = 0; i < limit; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  }
  return out.join(" ");
}

/**
 * Splits a natural-language query (with or without spaces, CJK or English) into search terms.
 * Drops trivial single-character Chinese particles only when other meaningful terms remain.
 */
export function segmentQuery(query: string): string[] {
  const seg = wordSegmenter();
  const raw: string[] = [];
  for (const part of seg.segment(query)) {
    if (!part.isWordLike) continue;
    const token = part.segment.toLowerCase().trim();
    if (token) raw.push(token);
  }
  const unique = [...new Set(raw)];
  if (unique.length === 0) {
    const fallback = query.trim().toLowerCase();
    return fallback ? [fallback] : [];
  }
  const filtered = unique.filter((token) => !ZH_STOP.has(token));
  return filtered.length > 0 ? filtered : unique;
}

function cjkBigramsOf(text: string, maxBigrams = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const chars = [...match[0]];
    if (chars.length < 2) continue;
    for (let i = 0; i < chars.length - 1; i++) {
      const pair = `${chars[i]}${chars[i + 1]}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      out.push(pair);
      if (out.length >= maxBigrams) return out;
    }
  }
  return out;
}

/** Read-only summary of a local folder's recognized vs. unsupported/skipped files and vault health. */
export async function inspectLocalFolder(
  vault: ObsidianVault,
  access: VaultAccess,
  options?: { db?: DatabaseSync; sourceId?: string },
): Promise<KnowledgeFolderSummary> {
  const signal = access.signal;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(MAX_INSPECT_MS)]);
  let root: VaultRoot;
  try {
    root = await vaultRoot(vault, deadline);
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.aborted) return emptySummary("timeout");
    if (error instanceof RpcError && error.message === "knowledge_vault_unreadable") {
      return emptySummary("unreadable");
    }
    return emptySummary("changed");
  }
  const metadata = options?.db && options.sourceId ? indexMetadata(options.db) : undefined;
  const byKind = { markdown: 0, text: 0, pdf: 0, word: 0 };
  let supported = 0;
  let unsupported = 0;
  let scannedPdf = 0;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  let unexamined = 0;
  let visited = 0;
  let truncated = false;
  const queue: string[] = [root.path];
  // Enumerate before extracting so a slow document cannot hide the rest of the folder.
  const pendingProbes: { full: string; rel: string; kind: "pdf" | "word" }[] = [];
  while (queue.length > 0) {
    if (deadline.aborted) {
      signal.throwIfAborted();
      truncated = true;
      break;
    }
    const dir = queue.shift() as string;
    let dirAllowed: boolean;
    try {
      dirAllowed = await access.authorizePath(dir, "directory", deadline);
    } catch {
      signal.throwIfAborted();
      if (deadline.aborted) {
        if (dir === root.path) return emptySummary("timeout");
        truncated = true;
        break;
      }
      if (dir === root.path) return emptySummary("unreadable");
      skippedUnreadable++;
      continue;
    }
    if (!dirAllowed) {
      if (dir === root.path) return emptySummary("denied");
      skippedUnreadable++;
      continue;
    }
    let entries: Dirent[];
    try {
      const canonical = await abortable(realpath(dir), deadline);
      if (!samePathSpelling(canonical, dir)) {
        skippedUnreadable++;
        continue;
      }
      entries = await abortable(readdir(dir, { withFileTypes: true }), deadline);
    } catch {
      signal.throwIfAborted();
      if (deadline.aborted) {
        if (dir === root.path) return emptySummary("timeout");
        truncated = true;
        break;
      }
      if (dir === root.path) return emptySummary("unreadable");
      skippedUnreadable++;
      continue;
    }
    let offset = 0;
    for (; offset < entries.length; offset++) {
      const entry = entries[offset];
      if (!entry || entry.name.startsWith(".")) continue;
      if (deadline.aborted) {
        signal.throwIfAborted();
        truncated = true;
        break;
      }
      if (visited >= MAX_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      visited++;
      if (entry.isSymbolicLink()) {
        if (localDocumentKind(entry.name)) skippedUnreadable++;
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = localDocumentKind(entry.name);
      if (!kind) {
        unsupported++;
        continue;
      }
      const stat = await abortable(lstat(full, { bigint: true }), deadline).catch(() => null);
      if (deadline.aborted) {
        signal.throwIfAborted();
        truncated = true;
        break;
      }
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
        skippedUnreadable++;
        continue;
      }
      const maxBytes = kind === "markdown" || kind === "text" ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
      if (stat.size > BigInt(maxBytes)) {
        skippedLarge++;
        continue;
      }
      let fileAllowed: boolean;
      try {
        fileAllowed = await access.authorizePath(full, "file", deadline);
      } catch {
        signal.throwIfAborted();
        if (deadline.aborted) {
          truncated = true;
          break;
        }
        skippedUnreadable++;
        continue;
      }
      if (!fileAllowed) {
        skippedUnreadable++;
        continue;
      }
      const rel = relative(root.path, full).split(sep).join("/");
      const cached = metadata?.get(options?.sourceId ?? "", rel) as unknown as
        | StoredIndexMeta
        | undefined;
      if (cached && sameRoot(cached, root) && matchesStat(cached, stat)) {
        if (cached.unreadable === 1) skippedUnreadable++;
        else if (cached.scanned === 1) scannedPdf++;
        else {
          supported++;
          byKind[kind]++;
        }
        continue;
      }
      if (kind === "pdf" || kind === "word") {
        pendingProbes.push({ full, rel, kind });
        continue;
      }
      supported++;
      byKind[kind]++;
    }
    for (; offset < entries.length; offset++) {
      const entry = entries[offset];
      if (entry?.isFile() && !entry.name.startsWith(".")) unexamined++;
    }
    if (truncated) break;
  }
  unexamined += pendingProbes.length;
  for (const { full, rel, kind } of pendingProbes.slice(0, MAX_INSPECT_DOCUMENT_PROBES)) {
    if (deadline.aborted) {
      truncated = true;
      break;
    }
    const document = await extractLocalDocument(root, full, rel, deadline).catch(
      () => "unreadable" as const,
    );
    if (deadline.aborted) {
      truncated = true;
      break;
    }
    unexamined--;
    if (document === "too_large") skippedLarge++;
    else if (document === "unreadable") skippedUnreadable++;
    else if (document.scanned) scannedPdf++;
    else {
      supported++;
      byKind[kind]++;
    }
  }
  signal.throwIfAborted();
  return {
    status: "ok",
    supported,
    unsupported,
    scannedPdf,
    skippedLarge,
    skippedUnreadable,
    unexamined,
    byKind,
    truncated,
  };
}

function emptySummary(status: KnowledgeFolderSummary["status"]): KnowledgeFolderSummary {
  return {
    status,
    supported: 0,
    unsupported: 0,
    scannedPdf: 0,
    skippedLarge: 0,
    skippedUnreadable: 0,
    unexamined: 0,
    byKind: { markdown: 0, text: 0, pdf: 0, word: 0 },
    truncated: false,
  };
}

export interface ExtractedLocalDocument {
  title: string;
  text: string;
  size: number;
  device: string;
  inode: string;
  mtimeNs: string;
  ctimeNs: string;
  truncated: boolean;
  scanned: boolean;
}

/**
 * Extracts searchable text for any supported local document (.md, .markdown, .txt, .pdf, .docx)
 * using `@pibot/execution`'s protected exact-path, workspace-identity and descriptor-checked
 * readers (`createFileTools().readFile` and `readBinaryFile`).
 */
export async function extractLocalDocument(
  root: VaultRoot,
  absolutePath: string,
  relPath: string,
  signal: AbortSignal,
): Promise<ExtractedLocalDocument | "too_large" | "unreadable"> {
  const kind = localDocumentKind(relPath);
  if (!kind) return "unreadable";
  const maxBytes = kind === "markdown" || kind === "text" ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
  const info = await abortable(lstat(absolutePath, { bigint: true }), signal).catch(() => null);
  signal.throwIfAborted();
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return "unreadable";
  if (info.size > BigInt(maxBytes)) return "too_large";
  const id = fileIdentity(info);
  const mtimeNs = info.mtimeNs.toString();
  const ctimeNs = info.ctimeNs.toString();

  if (kind === "markdown" || kind === "text") {
    try {
      // Read the entire UTF-8 note up to MAX_TEXT_BYTES (1 MiB, matching the legacy scanner)
      // through `@pibot/execution`'s protected reader rather than `readFile`, which caps at 2,000
      // lines and 256 KiB and would silently drop content past line 2,000 from search.
      const read = await readBinaryFile({
        ...fileContext(root, signal),
        path: absolutePath,
        expectedPath: absolutePath,
        maxBytes: MAX_TEXT_BYTES,
      });
      // Re-verify metadata so the cached row matches the exact bytes read.
      const after = await abortable(lstat(absolutePath, { bigint: true }), signal).catch(
        () => null,
      );
      signal.throwIfAborted();
      if (
        !after ||
        !sameFile(info, after) ||
        after.mtimeNs !== info.mtimeNs ||
        after.ctimeNs !== info.ctimeNs ||
        after.size !== BigInt(read.bytes.byteLength)
      )
        return "unreadable";
      const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
      if (text.includes("\0")) return "unreadable";
      const title = (kind === "markdown" ? firstHeading(text) : null) ?? titleFromPath(relPath);
      return {
        title,
        text: text.slice(0, MAX_INDEXED_CHARS),
        size: read.bytes.byteLength,
        device: id.device,
        inode: id.inode,
        mtimeNs,
        ctimeNs,
        truncated: text.length > MAX_INDEXED_CHARS,
        scanned: false,
      };
    } catch {
      signal.throwIfAborted();
      return "unreadable";
    }
  }

  try {
    const read = await readBinaryFile({
      ...fileContext(root, signal),
      path: absolutePath,
      expectedPath: absolutePath,
      maxBytes: MAX_BINARY_BYTES,
    });
    const after = await abortable(lstat(absolutePath, { bigint: true }), signal).catch(() => null);
    signal.throwIfAborted();
    if (
      !after ||
      !sameFile(info, after) ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs ||
      after.size !== BigInt(read.bytes.byteLength)
    )
      return "unreadable";
    const extracted = await extractAttachment(read.bytes, kind === "pdf", signal);
    const scanned = kind === "pdf" && (extracted.scanned || extracted.text.trim().length === 0);
    const body = extracted.text.slice(0, MAX_INDEXED_CHARS);
    return {
      title: titleFromPath(relPath),
      text: body,
      size: read.bytes.byteLength,
      device: id.device,
      inode: id.inode,
      mtimeNs,
      ctimeNs,
      truncated: extracted.totalChars > body.length,
      scanned,
    };
  } catch {
    signal.throwIfAborted();
    return "unreadable";
  }
}

interface StoredIndexMeta {
  id: number;
  root_path: string;
  root_device: string;
  root_inode: string;
  rel_path: string;
  device: string;
  inode: string;
  mtime_ns: string;
  ctime_ns: string;
  size: number;
  scanned: number;
  unreadable: number;
  truncated: number;
  indexed_at: string;
}

function sameRoot(
  row: Pick<StoredIndexMeta, "root_path" | "root_device" | "root_inode">,
  root: VaultRoot,
): boolean {
  return (
    samePathSpelling(row.root_path, root.path) &&
    row.root_device === root.identity.device &&
    row.root_inode === root.identity.inode
  );
}

function matchesStat(
  row: Pick<StoredIndexMeta, "device" | "inode" | "mtime_ns" | "ctime_ns" | "size">,
  stat: { dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint; size: bigint },
): boolean {
  const id = fileIdentity(stat);
  return (
    row.device === id.device &&
    row.inode === id.inode &&
    row.mtime_ns === stat.mtimeNs.toString() &&
    row.ctime_ns === stat.ctimeNs.toString() &&
    row.size === Number(stat.size)
  );
}

function sourceMatchesRoot(db: DatabaseSync, sourceId: string, root: VaultRoot): boolean {
  const row = db.prepare("SELECT config_json FROM knowledge_sources WHERE id=?").get(sourceId) as
    | { config_json?: unknown }
    | undefined;
  if (typeof row?.config_json !== "string") return false;
  try {
    const config = KnowledgeConfigSchema.parse(JSON.parse(row.config_json));
    if (config.kind !== "obsidian" && config.kind !== "folder") return false;
    return (
      samePathSpelling(config.path, root.path) &&
      config.device === root.identity.device &&
      config.inode === root.identity.inode
    );
  } catch {
    return false;
  }
}

const cursorPart = z
  .string()
  .refine((part) => part.length > 0 && part !== "." && part !== ".." && !/[/\\\0]/u.test(part));
const walkPosition = z.array(
  z.strictObject({
    name: cursorPart.nullable(),
    after: z.string().nullable(),
  }),
);

interface WalkRow {
  root_path: string;
  root_device: string;
  root_inode: string;
  revision: string;
  scan_id: string;
  position_json: string;
  can_prune: number;
}

interface DirectoryFrame extends z.output<typeof walkPosition.element> {
  path: string;
  restored: boolean;
  entries?: Dirent[];
  offset: number;
}

function nextDirectoryOffset(entries: Dirent[], after: string | null): number {
  if (after === null) return 0;
  let start = 0;
  let end = entries.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const entry = entries[middle];
    if (entry && entry.name <= after) start = middle + 1;
    else end = middle;
  }
  return start;
}

function readWalkPosition(row: WalkRow, root: VaultRoot) {
  if (!sameRoot(row, root)) return undefined;
  try {
    const position = walkPosition.parse(JSON.parse(row.position_json));
    if (position[0]?.name === null && position.slice(1).every((part) => part.name !== null))
      return position;
  } catch {
    // A damaged cursor can be rebuilt from the chosen root.
  }
}

function indexMetadata(db: DatabaseSync) {
  return db.prepare(
    `SELECT id, root_path, root_device, root_inode, rel_path, device, inode, mtime_ns, ctime_ns,
            size, scanned, unreadable, truncated, indexed_at
     FROM knowledge_index_files WHERE source_id=? AND rel_path=?`,
  );
}

/** A bounded walk resumes at the last completed entry, independently of the search terms. */
async function syncLocalIndex(
  db: DatabaseSync,
  sourceId: string,
  root: VaultRoot,
  access: VaultAccess,
): Promise<{
  truncated?: VaultSearch["truncated"];
  skippedLarge: number;
  skippedUnreadable: number;
  scannedPdf: number;
}> {
  const deadline = AbortSignal.any([access.signal, AbortSignal.timeout(MAX_INDEX_MS)]);
  const walkRow = db.prepare("SELECT * FROM knowledge_index_walks WHERE source_id=?");
  const previous = walkRow.get(sourceId) as unknown as WalkRow | undefined;
  const saved = previous && readWalkPosition(previous, root);
  const scanId = saved && previous ? previous.scan_id : randomUUID();
  let directoryPath = root.path;
  const frames: DirectoryFrame[] = (saved ?? [{ name: null, after: null }]).map((frame) => {
    if (frame.name !== null) directoryPath = join(directoryPath, frame.name);
    return { ...frame, path: directoryPath, restored: saved !== undefined, offset: 0 };
  });
  const metadata = indexMetadata(db);
  const deleteIds = new Set<number>();
  const seenIds = new Set<number>();
  const documents: {
    rel: string;
    doc: ExtractedLocalDocument;
    unreadable: boolean;
    titleTokens: string;
    bodyTokens: string;
  }[] = [];
  let canPrune = !saved || previous?.can_prune === 1;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  let scannedPdf = 0;
  let hasTruncatedDocs = false;
  let readBytes = 0;
  let visited = 0;
  let truncated: VaultSearch["truncated"];

  while (frames.length > 0) {
    if (deadline.aborted) {
      access.signal.throwIfAborted();
      truncated = "time_limit";
      break;
    }
    const frame = frames.at(-1);
    if (!frame) break;
    const dir = frame.path;
    if (!frame.entries) {
      const directoryDeadline = AbortSignal.any([deadline, AbortSignal.timeout(5_000)]);
      try {
        // A resumed walk opens the same ancestors under this Bot's current directory policy.
        const paths = frame.restored ? frames : [frame];
        let allowed = true;
        for (const { path } of paths) {
          if (!(await access.authorizePath(path, "directory", directoryDeadline))) {
            allowed = false;
            break;
          }
        }
        if (!allowed) {
          canPrune = false;
          frames.pop();
          continue;
        }
        const canonical = await abortable(realpath(dir), directoryDeadline);
        if (!samePathSpelling(canonical, dir)) {
          canPrune = false;
          frames.pop();
          continue;
        }
        frame.entries = await abortable(readdir(dir, { withFileTypes: true }), directoryDeadline);
        frame.entries.sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
        frame.offset = nextDirectoryOffset(frame.entries, frame.after);
      } catch {
        access.signal.throwIfAborted();
        if (deadline.aborted) {
          truncated = "time_limit";
          break;
        }
        canPrune = false;
        frames.pop();
        skippedUnreadable++;
        continue;
      }
    }
    const entry = frame.entries[frame.offset++];
    if (!entry) {
      frames.pop();
      continue;
    }
    if (visited >= MAX_SCAN_ENTRIES) {
      truncated = "scan_limit";
      break;
    }
    visited++;
    const lastCompleted = frame.after;
    frame.after = entry.name;
    // Persist only path components we can safely restore on the next search.
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (cursorPart.safeParse(entry.name).success)
        frames.push({
          name: entry.name,
          after: null,
          path: join(dir, entry.name),
          restored: false,
          offset: 0,
        });
      continue;
    }
    const kind = localDocumentKind(entry.name);
    if (!kind) continue;
    const full = join(dir, entry.name);
    const rel = relative(root.path, full).split(sep).join("/");
    const row = metadata.get(sourceId, rel) as unknown as StoredIndexMeta | undefined;
    const cached = row && sameRoot(row, root) ? row : undefined;
    const documentDeadline = AbortSignal.any([deadline, AbortSignal.timeout(10_000)]);
    const stat = entry.isFile()
      ? await abortable(lstat(full, { bigint: true }), documentDeadline).catch(() => null)
      : null;
    if (deadline.aborted) {
      access.signal.throwIfAborted();
      frame.after = lastCompleted;
      truncated = "time_limit";
      break;
    }
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      if (cached) deleteIds.add(cached.id);
      skippedUnreadable++;
      continue;
    }
    let fileAllowed: boolean;
    try {
      fileAllowed = await access.authorizePath(full, "file", documentDeadline);
    } catch {
      access.signal.throwIfAborted();
      if (deadline.aborted) {
        frame.after = lastCompleted;
        truncated = "time_limit";
        break;
      }
      if (cached) seenIds.add(cached.id);
      skippedUnreadable++;
      continue;
    }
    if (!fileAllowed) {
      if (cached) seenIds.add(cached.id);
      continue;
    }
    if (
      cached &&
      matchesStat(cached, stat) &&
      (cached.unreadable === 0 || Date.now() - Date.parse(cached.indexed_at) < RETRY_UNREADABLE_MS)
    ) {
      seenIds.add(cached.id);
      if (cached.unreadable === 1) skippedUnreadable++;
      if (cached.scanned === 1) scannedPdf++;
      if (cached.truncated === 1) hasTruncatedDocs = true;
      continue;
    }
    const maxBytes = kind === "markdown" || kind === "text" ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
    const size = Number(stat.size);
    if (size > maxBytes) {
      if (cached) deleteIds.add(cached.id);
      skippedLarge++;
      continue;
    }
    if (readBytes + size > MAX_INDEX_READ_BYTES) {
      frame.after = lastCompleted;
      truncated = "byte_limit";
      break;
    }
    readBytes += size;
    const doc = await extractLocalDocument(root, full, rel, documentDeadline).catch(
      () => "unreadable" as const,
    );
    access.signal.throwIfAborted();
    if (deadline.aborted) {
      frame.after = lastCompleted;
      truncated = "time_limit";
      break;
    }
    if (doc === "too_large") {
      if (cached) deleteIds.add(cached.id);
      skippedLarge++;
      continue;
    }
    if (doc === "unreadable") {
      skippedUnreadable++;
      documents.push({
        rel,
        unreadable: true,
        titleTokens: "",
        bodyTokens: "",
        doc: {
          ...fileIdentity(stat),
          mtimeNs: stat.mtimeNs.toString(),
          ctimeNs: stat.ctimeNs.toString(),
          size,
          scanned: false,
          truncated: false,
          title: "",
          text: "",
        },
      });
      continue;
    }
    if (doc.scanned) scannedPdf++;
    if (doc.truncated) hasTruncatedDocs = true;
    documents.push({
      rel,
      doc,
      unreadable: false,
      titleTokens: doc.scanned ? "" : tokenizeForIndex(`${titleFromPath(rel)} ${doc.title} ${rel}`),
      bodyTokens: doc.scanned ? "" : tokenizeForIndex(doc.text),
    });
  }

  access.signal.throwIfAborted();
  const committed = transaction(db, () => {
    // A newer batch or repoint owns the checkpoint and rows. Discard this batch if it lost.
    if (
      !sourceMatchesRoot(db, sourceId, root) ||
      walkRow.get(sourceId)?.revision !== previous?.revision
    )
      return false;
    const del = db.prepare("DELETE FROM knowledge_index_files WHERE id=?");
    for (const id of deleteIds) del.run(id);
    const seen = db.prepare("UPDATE knowledge_index_files SET scan_id=? WHERE id=? AND scan_id<>?");
    for (const id of seenIds) seen.run(scanId, id, scanId);
    const upsert = db.prepare(
      `INSERT INTO knowledge_index_files(
        source_id, root_path, root_device, root_inode, rel_path, ext, device, inode, mtime_ns,
        ctime_ns, size, scanned, unreadable, truncated, title, body, title_tokens, body_tokens,
        indexed_at, scan_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id, rel_path) DO UPDATE SET
        root_path=excluded.root_path, root_device=excluded.root_device, root_inode=excluded.root_inode,
        ext=excluded.ext, device=excluded.device, inode=excluded.inode, mtime_ns=excluded.mtime_ns,
        ctime_ns=excluded.ctime_ns, size=excluded.size, scanned=excluded.scanned,
        unreadable=excluded.unreadable, truncated=excluded.truncated, title=excluded.title,
        body=excluded.body, title_tokens=excluded.title_tokens, body_tokens=excluded.body_tokens,
        indexed_at=excluded.indexed_at, scan_id=excluded.scan_id`,
    );
    const now = new Date().toISOString();
    for (const { rel, doc, unreadable, titleTokens, bodyTokens } of documents) {
      upsert.run(
        sourceId,
        root.path,
        root.identity.device,
        root.identity.inode,
        rel,
        extname(rel).toLowerCase(),
        doc.device,
        doc.inode,
        doc.mtimeNs,
        doc.ctimeNs,
        doc.size,
        Number(doc.scanned),
        Number(unreadable),
        Number(doc.truncated),
        doc.title,
        doc.scanned ? "" : doc.text,
        titleTokens,
        bodyTokens,
        now,
        scanId,
      );
    }
    if (frames.length === 0 && canPrune)
      db.prepare("DELETE FROM knowledge_index_files WHERE source_id=? AND scan_id<>?").run(
        sourceId,
        scanId,
      );
    db.prepare(`INSERT INTO knowledge_index_walks VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET root_path=excluded.root_path,
        root_device=excluded.root_device, root_inode=excluded.root_inode, revision=excluded.revision,
        scan_id=excluded.scan_id, position_json=excluded.position_json, can_prune=excluded.can_prune`).run(
      sourceId,
      root.path,
      root.identity.device,
      root.identity.inode,
      randomUUID(),
      scanId,
      JSON.stringify(frames.map(({ name, after }) => ({ name, after }))),
      Number(canPrune),
    );
    return true;
  });

  const effectiveTruncated =
    truncated ?? (!committed ? "scan_limit" : hasTruncatedDocs ? "byte_limit" : undefined);
  return {
    ...(effectiveTruncated ? { truncated: effectiveTruncated } : {}),
    skippedLarge,
    skippedUnreadable,
    scannedPdf,
  };
}

function ftsQuote(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function ftsTermExpression(term: string): string {
  if (ASCII_PREFIX_TERM_RE.test(term)) return `${ftsQuote(term)}*`;
  if (CJK_RE.test(term)) {
    const chars = [...term];
    if (chars.length >= 3) {
      const bigrams = cjkBigramsOf(term, 12);
      if (bigrams.length > 0) {
        return `(${ftsQuote(term)} OR (${bigrams.map(ftsQuote).join(" AND ")}))`;
      }
    }
  }
  return ftsQuote(term);
}

interface CandidateRow {
  id: number;
  rel_path: string;
  device: string;
  inode: string;
  mtime_ns: string;
  ctime_ns: string;
  size: number;
  title: string;
  body: string;
  score: number;
}

/**
 * Searches a local source using the synced SQLite FTS5 + BM25 index. Re-verifies `read_file`
 * policy, live file identity and vault identity on every returned candidate.
 */
export async function searchIndexedVault(
  db: DatabaseSync,
  sourceId: string,
  vault: ObsidianVault,
  query: string,
  access: VaultAccess,
  limit: number,
  redact = (text: string) => text,
): Promise<VaultSearch> {
  const text = query.trim();
  const root = await vaultRoot(vault, access.signal);
  const sync = await syncLocalIndex(db, sourceId, root, access);
  const terms = segmentQuery(text);
  const queryBigrams = cjkBigramsOf(text, 24);
  const candidateLimit = Math.max(limit * 4, 60);
  const byPath = new Map<string, { row: CandidateRow; coverage: number; bm25: number }>();

  const ftsTerms = terms.filter((term) => /[\p{L}\p{N}]/u.test(term)).slice(0, 16);
  const runFts = (expression: string, maxRows: number): CandidateRow[] => {
    try {
      return db
        .prepare(
          `SELECT f.id, f.rel_path, f.device, f.inode, f.mtime_ns, f.ctime_ns, f.size,
                  f.title, f.body, bm25(knowledge_index_fts, 4.0, 1.0) AS score
           FROM knowledge_index_fts
           JOIN knowledge_index_files f ON f.id = knowledge_index_fts.rowid
           WHERE f.source_id = ? AND f.root_path = ? AND f.root_device = ? AND f.root_inode = ?
             AND f.scanned = 0 AND f.unreadable = 0 AND knowledge_index_fts MATCH ?
           ORDER BY score ASC
           LIMIT ?`,
        )
        .all(
          sourceId,
          root.path,
          root.identity.device,
          root.identity.inode,
          expression,
          maxRows,
        ) as unknown as CandidateRow[];
    } catch {
      return [];
    }
  };

  if (ftsTerms.length > 0) {
    // Pass 1: all segmented terms present (using prefix matching for ASCII tokens and bigram
    // expansion for long CJK tokens).
    const allExpr = ftsTerms.map(ftsTermExpression).join(" AND ");
    for (const row of runFts(allExpr, candidateLimit)) {
      byPath.set(row.rel_path, { row, coverage: ftsTerms.length, bm25: Number(row.score) });
    }
    // Pass 2: broaden to OR over terms + cross-boundary CJK bigrams so natural-language Chinese
    // questions ("去年Q3项目预算超支了吗") or alternate segmentations still surface the best notes.
    if (byPath.size < limit && (ftsTerms.length > 1 || queryBigrams.length > 0)) {
      const clauses = [
        ...new Set([...ftsTerms.map(ftsTermExpression), ...queryBigrams.map(ftsQuote)]),
      ];
      const anyExpr = clauses.join(" OR ");
      const minTerms = Math.min(2, ftsTerms.length);
      const minBigrams = Math.min(2, queryBigrams.length);
      for (const row of runFts(anyExpr, candidateLimit)) {
        if (byPath.has(row.rel_path)) continue;
        const haystack = `${row.rel_path} ${row.title}\n${row.body}`.toLowerCase();
        const matchedTerms = ftsTerms.filter((term) => haystack.includes(term)).length;
        const matchedBigrams = queryBigrams.filter((pair) => haystack.includes(pair)).length;
        if (
          (ftsTerms.length > 1 && matchedTerms >= minTerms) ||
          (queryBigrams.length > 0 && matchedBigrams >= minBigrams)
        ) {
          const coverage = matchedTerms > 0 ? matchedTerms : matchedBigrams * 0.5;
          byPath.set(row.rel_path, { row, coverage, bm25: Number(row.score) });
        }
      }
    }
  }

  // Pass 3: multi-term substring fallback for non-prefix fragments (e.g. "ning 2026"), punctuation,
  // or short symbol queries ("C++", ".env") that FTS5 unicode61 strips.
  if (byPath.size === 0) {
    const subTerms = (terms.length > 0 ? terms : [text.toLowerCase()]).slice(0, 8);
    if (subTerms.length > 0) {
      const clauses = subTerms
        .map(
          () =>
            "(instr(lower(rel_path), ?) > 0 OR instr(lower(title), ?) > 0 OR instr(lower(body), ?) > 0)",
        )
        .join(" AND ");
      const params: (string | number)[] = [
        sourceId,
        root.path,
        root.identity.device,
        root.identity.inode,
      ];
      for (const term of subTerms) params.push(term, term, term);
      params.push(candidateLimit);
      const rows = db
        .prepare(
          `SELECT id, rel_path, device, inode, mtime_ns, ctime_ns, size, title, body, 0 AS score
           FROM knowledge_index_files
           WHERE source_id = ? AND root_path = ? AND root_device = ? AND root_inode = ?
             AND scanned = 0 AND unreadable = 0 AND ${clauses}
           LIMIT ?`,
        )
        .all(...params) as unknown as CandidateRow[];
      for (const row of rows) {
        byPath.set(row.rel_path, { row, coverage: subTerms.length, bm25: 0 });
      }
    }
  }

  const ordered = [...byPath.values()].sort((a, b) => {
    if (b.coverage !== a.coverage) return b.coverage - a.coverage;
    return a.bm25 - b.bm25;
  });

  const hits: VaultHit[] = [];
  const matchTerms =
    terms.length > 0 ? [...terms, ...queryBigrams] : [text.toLowerCase(), ...queryBigrams];
  for (const entry of ordered) {
    if (hits.length >= limit) break;
    access.signal.throwIfAborted();
    const parts = entry.row.rel_path.split("/");
    if (parts.some((part) => !cursorPart.safeParse(part).success || part.startsWith("."))) continue;
    // A resumed or denied walk can leave rows behind. Every hit needs the same list/read
    // decisions as a fresh walk before it can expose a path or any indexed text.
    if (!(await canListAncestors(root.path, parts.slice(0, -1), access))) continue;
    const fullPath = join(root.path, ...parts);
    if (!(await access.authorizePath(fullPath, "file", access.signal))) continue;
    const live = await verifyLiveCandidate(fullPath, entry.row, access.signal);
    if (!live) continue;
    const url = openUrl(vault.path, entry.row.rel_path, sourceId);
    const title = redact(entry.row.title || titleFromPath(entry.row.rel_path));
    // Mask complete credential values before any truncation can split a value the shared
    // tool-output redactor would otherwise recognize.
    const lines = extractBestLines(redact(entry.row.body), matchTerms, MAX_HITS_PER_NOTE);
    if (lines.length === 0) {
      hits.push({
        path: entry.row.rel_path,
        title,
        line: 1,
        snippet: title || redact(basename(entry.row.rel_path)),
        url,
      });
      continue;
    }
    for (const match of lines) {
      if (hits.length >= limit) break;
      hits.push({
        path: entry.row.rel_path,
        title,
        line: match.line,
        snippet: match.text,
        url,
      });
    }
  }

  // The path may still exist even though this source now points to a different folder.
  await vaultRoot({ ...vault, identity: root.identity }, access.signal);
  if (!sourceMatchesRoot(db, sourceId, root))
    throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_source_changed");

  return {
    query: text,
    root,
    hits,
    ...(sync.truncated ? { truncated: sync.truncated } : {}),
    skippedLarge: sync.skippedLarge,
    skippedUnreadable: sync.skippedUnreadable,
    scannedPdf: sync.scannedPdf,
  };
}

async function canListAncestors(root: string, parents: string[], access: VaultAccess) {
  if (!(await access.authorizePath(root, "directory", access.signal))) return false;
  let directory = root;
  for (const parent of parents) {
    directory = join(directory, parent);
    if (!(await access.authorizePath(directory, "directory", access.signal))) return false;
  }
  return true;
}

async function verifyLiveCandidate(
  fullPath: string,
  row: CandidateRow,
  signal: AbortSignal,
): Promise<boolean> {
  const stat = await abortable(lstat(fullPath, { bigint: true }), signal).catch(() => null);
  signal.throwIfAborted();
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return false;
  if (!matchesStat(row, stat)) return false;
  const real = await abortable(realpath(fullPath), signal).catch(() => null);
  signal.throwIfAborted();
  return real !== null && samePathSpelling(real, fullPath);
}

function extractBestLines(
  body: string,
  terms: readonly string[],
  maxLines: number,
): { line: number; text: string }[] {
  const scored: { line: number; text: string; hits: number; firstMatch: number }[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    let count = 0;
    let firstMatch = lower.length;
    for (const term of terms) {
      const position = lower.indexOf(term);
      if (position < 0) continue;
      count++;
      firstMatch = Math.min(firstMatch, position);
    }
    if (count > 0) scored.push({ line: i + 1, text: trimmed, hits: count, firstMatch });
  }
  scored.sort((a, b) => (b.hits !== a.hits ? b.hits - a.hits : a.line - b.line));
  return scored
    .slice(0, maxLines)
    .sort((a, b) => a.line - b.line)
    .map(({ line, text, firstMatch }) => ({ line, text: snippetOf(text, firstMatch) }));
}

function snippetOf(text: string, firstMatch: number): string {
  if (text.length <= MAX_SNIPPET_CHARS) return text;
  const start = Math.min(
    Math.max(0, firstMatch - Math.floor(MAX_SNIPPET_CHARS / 3)),
    text.length - MAX_SNIPPET_CHARS + 1,
  );
  const end = start + MAX_SNIPPET_CHARS - (start > 0 ? 2 : 1);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
