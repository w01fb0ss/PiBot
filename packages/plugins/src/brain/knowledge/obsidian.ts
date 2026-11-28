import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { abortable } from "@pibot/brain/kit";
import {
  createFileTools,
  ExecError,
  type FileIdentity,
  fileIdentity,
  matchesFileIdentity,
  samePathSpelling,
} from "@pibot/execution";
import { type KnowledgeConfig, RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import { extractLocalDocument, searchIndexedVault } from "./local-index.ts";

// Local knowledge sources support Obsidian vaults and plain document folders (.md, .txt, .pdf,
// .docx). Searches use a local-only SQLite FTS5 + BM25 index synced on demand, while per-path
// checks keep every read inside its approved folder.

const NOTE_EXTENSION = ".md";
const MAX_SNIPPET_CHARS = 300;
// A note's title is the first `# ` line, which in a vault sits at the top of the file. Scanning
// whole notes for a late heading would turn one search into a read of every matched note.
const MAX_TITLE_LINES = 120;
// A common word can appear hundreds of times in one note; without this cap it fills the result
// page and hides notes further down the vault whose titles match.
const MAX_HITS_PER_NOTE = 5;

export type LocalDocumentKind = "markdown" | "text" | "pdf" | "word";

const EXTENSION_KIND: Record<string, LocalDocumentKind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".pdf": "pdf",
  ".docx": "word",
};

/** Maps a file name or extension to its supported local document kind, or null if unsupported. */
export function localDocumentKind(filePath: string): LocalDocumentKind | null {
  return EXTENSION_KIND[extname(filePath).toLowerCase()] ?? null;
}

/** A stored local knowledge source (Obsidian vault or document folder) reduced to what reading needs. */
export interface ObsidianVault {
  /** Canonical folder path as recorded when the person added the source. */
  path: string;
  /** Null only for records added before the app started storing identities. */
  identity: FileIdentity | null;
  /** Whether this source was added as an Obsidian vault or a general local document folder. */
  kind?: "obsidian" | "folder";
}

/**
 * What the caller brings per query. `authorizePath` is the Bot's policy decision for one path
 * under the vault: only the caller knows the Bot, the run and the approval it runs under, so it is
 * injected rather than guessed here.
 */
export interface VaultAccess {
  signal: AbortSignal;
  authorizePath(path: string, kind: "directory" | "file", signal: AbortSignal): Promise<boolean>;
}

export interface VaultHit {
  /** Vault-relative path, with the `.md` extension. */
  path: string;
  /** First `# ` heading, or the note's file name when it has none. */
  title: string;
  line: number;
  /** The matching line, cut to 300 characters. */
  snippet: string;
  /** `obsidian://open` link that opens the note in the person's own vault. */
  url: string;
}

export interface VaultSearch {
  query: string;
  hits: VaultHit[];
  /** Exact root verified by the index. */
  root?: VaultRoot;
  /**
   * Set when execution stopped early; the caller says so instead of presenting a full result.
   * "time_limit" comes from the search's own deadline, which now yields partial results.
   */
  truncated?: "results" | "scan_limit" | "byte_limit" | "time_limit";
  skippedLarge: number;
  skippedUnreadable: number;
  scannedPdf?: number;
}

export interface VaultNote {
  path: string;
  title: string;
  text: string;
  size: number;
  /** The note is longer than one read returns (2000 lines / 256 KiB). */
  truncated: boolean;
  version?: string;
  scanned?: boolean;
}

export interface VaultRoot {
  path: string;
  identity: FileIdentity;
}

interface NoteTitle {
  title: string;
  /** The heading line itself, so the caller can tell whether the query hit the title. */
  heading: string | null;
}

/** Maps the stored configuration to the reader's input; the only place that interpretation lives. */
export function obsidianVault(
  config: Extract<KnowledgeConfig, { kind: "obsidian" | "folder" }>,
): ObsidianVault {
  const { device, inode } = config;
  return {
    path: config.path,
    identity: device && inode ? { device, inode } : null,
    kind: config.kind,
  };
}

export async function searchVault(
  vault: ObsidianVault,
  query: string,
  access: VaultAccess,
  options?: {
    db?: DatabaseSync;
    sourceId?: string;
    limit?: number;
    redact?: (text: string) => string;
  },
): Promise<VaultSearch> {
  const text = query.trim();
  if (!text) throw new ExecError("invalid_input");
  if (options?.db && options.sourceId) {
    return searchIndexedVault(
      options.db,
      options.sourceId,
      vault,
      text,
      access,
      options.limit ?? 20,
      options.redact,
    );
  }
  const root = await vaultRoot(vault, access.signal);
  const files = createFileTools();
  // A phrase like "project plan" should also find a note that says both words apart. Searching
  // each word and keeping notes where every word is present is the cheapest way to do that with
  // the line-search execution already exposes.
  const needles = [...new Set(text.toLowerCase().split(/\s+/).filter(Boolean))];
  const byFile = new Map<string, Map<string, { line: number; text: string }[]>>();
  // A person looks for a note by its name, so a name that contains the query has to be findable
  // even when the body never repeats it; per word, so a multi-word query can be met by name.
  const named = new Map<string, Set<string>>();
  const truncations = new Set<NonNullable<VaultSearch["truncated"]>>();
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  for (const needle of needles) {
    const found = await files.searchText({
      ...fileContext(root, access.signal),
      path: root.path,
      query: needle,
      include: `**/*${NOTE_EXTENSION}`,
      authorizePath: access.authorizePath,
      // The walk already visits every note, so the name match costs no second pass and no extra
      // body read.
      matchNames: true,
      // A vault can contain hard-linked notes (backup tools do this); one of them must not fail
      // the whole search, so the walk counts it as skipped like an unreadable note.
      skipHardLinks: true,
    });
    // matchNames keeps this search on the JS walk, which always counts large files.
    skippedLarge += found.skippedLarge ?? 0;
    skippedUnreadable += found.skippedUnreadable;
    if (found.truncated) truncations.add(found.truncated);
    for (const match of found.matches) {
      if (match.name) {
        const words = named.get(match.file);
        if (words) words.add(needle);
        else named.set(match.file, new Set([needle]));
        continue;
      }
      let perNeedle = byFile.get(match.file);
      if (!perNeedle) {
        perNeedle = new Map();
        byFile.set(match.file, perNeedle);
      }
      const lines = perNeedle.get(needle);
      if (lines) lines.push({ line: match.line, text: match.text });
      else perNeedle.set(needle, [{ line: match.line, text: match.text }]);
    }
  }
  const ranked: { rank: number; hit: VaultHit }[] = [];
  for (const [file, words] of named) {
    // A note that also matches in its body keeps its body hits, so one note is not listed twice.
    if (byFile.has(file) || !needles.every((needle) => words.has(needle))) continue;
    const title = titleFromPath(file);
    ranked.push({
      rank: -1,
      hit: {
        path: file,
        title,
        line: 1,
        snippet: title,
        url: openUrl(vault.path, file, options?.sourceId),
      },
    });
  }
  for (const [file, perNeedle] of byFile) {
    const note = await noteTitle(files, root, file, access);
    if (!note) continue;
    // The note's own name, not its relative path. Otherwise a query for a folder name
    // ("Projects", "2024") marks every note under it as a title hit.
    const stem = basename(file, extname(file)).toLowerCase();
    const titleText = `${stem} ${note.heading?.toLowerCase() ?? ""} ${note.title.toLowerCase()}`;
    if (
      !needles.every(
        (needle) =>
          perNeedle.has(needle) || named.get(file)?.has(needle) || titleText.includes(needle),
      )
    )
      continue;
    // One note repeating a common word must not consume the page; the per-note cap leaves room
    // for later notes whose titles match.
    const byLine = new Map<number, string>();
    for (const lines of perNeedle.values())
      for (const line of lines) if (!byLine.has(line.line)) byLine.set(line.line, line.text);
    const rank = needles.some(
      (needle) => stem.includes(needle) || note.heading?.toLowerCase().includes(needle),
    )
      ? 0
      : 1;
    for (const [line, value] of [...byLine]
      .sort((a, b) => a[0] - b[0])
      .slice(0, MAX_HITS_PER_NOTE)) {
      ranked.push({
        rank,
        hit: {
          path: file,
          title: note.title,
          line,
          snippet: snippetOf(value),
          url: openUrl(vault.path, file, options?.sourceId),
        },
      });
    }
  }
  // Array#sort is stable, so hits inside one rank keep the walk order (note by note, line by line).
  ranked.sort((a, b) => a.rank - b.rank);
  const truncated = (["results", "scan_limit", "byte_limit", "time_limit"] as const).find((kind) =>
    truncations.has(kind),
  );
  return {
    query: text,
    hits: ranked.map((entry) => entry.hit),
    ...(truncated ? { truncated } : {}),
    skippedLarge,
    skippedUnreadable,
    scannedPdf: 0,
  };
}

export async function readNote(
  vault: ObsidianVault,
  path: string,
  access: VaultAccess,
): Promise<VaultNote> {
  const root = await vaultRoot(vault, access.signal);
  const notePath = notePathIn(root.path, path);
  if (!(await access.authorizePath(notePath, "file", access.signal)))
    throw new ExecError("outside_workplace");
  const rel = relative(root.path, notePath).split(sep).join("/");
  const docKind = localDocumentKind(rel);
  if (docKind === "pdf" || docKind === "word") {
    const doc = await extractLocalDocument(root, notePath, rel, access.signal);
    if (doc === "too_large" || doc === "unreadable") throw new ExecError("file_failed");
    const emptyScanned = doc.scanned && !doc.text.trim();
    return {
      path: rel,
      title: doc.title,
      text: emptyScanned
        ? "[该 PDF 为纯图片或扫描件，未提取到可搜索文字 / This PDF appears to be image-only (scanned) with no extractable text.]"
        : doc.text,
      size: doc.size,
      truncated: doc.truncated,
      ...(doc.scanned ? { scanned: true } : {}),
    };
  }
  const files = createFileTools();
  const read = await files.readFile({
    ...fileContext(root, access.signal),
    path: notePath,
    expectedPath: notePath,
    versioned: true,
  });
  if (read.type !== "text") throw new ExecError("file_failed");
  return {
    path: rel,
    title: (docKind === "markdown" ? firstHeading(read.text) : null) ?? titleFromPath(rel),
    text: read.text,
    size: read.size,
    truncated: read.truncated,
    version: read.version,
  };
}

/**
 * The recorded identity is the vault's identity: the person chose one folder, and a different
 * folder (moved, restored from a backup, or a different volume now mounted at that path) must not
 * become readable just because it has the same name.
 */
export async function vaultRoot(vault: ObsidianVault, signal: AbortSignal): Promise<VaultRoot> {
  if (!vault.identity) throw vaultChanged();
  const path = resolve(vault.path);
  // A disconnected network volume can hang lstat/realpath; the query's signal is not enough on
  // its own because the file system calls do not observe it.
  const operation = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  let info: BigIntStats;
  let canonical: string;
  try {
    info = await abortable(lstat(path, { bigint: true }), operation);
    canonical = await abortable(realpath(path), operation);
  } catch (error) {
    operation.throwIfAborted();
    // Privacy denials and I/O failures are not evidence that the folder changed; saying "choose
    // it again" would hide a permission problem the person can fix without touching the source.
    if (unreadable(error)) throw vaultUnreadable();
    throw vaultChanged();
  }
  signal.throwIfAborted();
  if (!info.isDirectory() || info.isSymbolicLink() || !samePathSpelling(canonical, path))
    throw vaultChanged();
  if (!matchesFileIdentity(info, vault.identity)) throw vaultChanged();
  return { path: canonical, identity: fileIdentity(info) };
}

function vaultChanged(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_changed");
}

function unreadable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EIO";
}

function vaultUnreadable(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_unreadable");
}

/** Boundary facts execution re-verifies before and after it reads, same shape as a read root. */
export function fileContext(root: VaultRoot, signal: AbortSignal) {
  return {
    cwd: root.path,
    writeRoots: [],
    rootIdentities: [
      {
        canonicalPath: root.path,
        device: root.identity.device,
        inode: root.identity.inode,
        role: "readonly" as const,
      },
    ],
    signal,
  };
}

async function noteTitle(
  files: ReturnType<typeof createFileTools>,
  root: VaultRoot,
  file: string,
  access: VaultAccess,
): Promise<NoteTitle | null> {
  const path = join(root.path, ...file.split("/"));
  // Already authorized for search, but the title costs another read; a denial now drops the note.
  if (!(await access.authorizePath(path, "file", access.signal))) return null;
  const title = titleFromPath(file);
  try {
    const head = await files.readFile({
      ...fileContext(root, access.signal),
      path,
      expectedPath: path,
      limit: MAX_TITLE_LINES,
    });
    if (head.type !== "text") return { title, heading: null };
    const heading = firstHeading(head.text);
    return { title: heading ?? title, heading };
  } catch {
    access.signal.throwIfAborted();
    // The note passed execution's identity checks during the walk, so a failure here means it
    // changed underneath the search. Its matched lines are still true; keep them under the name.
    return { title, heading: null };
  }
}

/** Vault-relative `.md` path to a file under the vault; everything else is a usage error. */
function notePathIn(root: string, input: string): string {
  const raw = input.trim().replace(/^\.\//, "");
  if (!raw || raw.includes("\0") || /[\p{Cc}\p{Cf}]/u.test(raw) || isAbsolute(raw))
    throw new ExecError("invalid_input");
  const target = resolve(root, raw);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new ExecError("outside_workplace");
  const note = withNoteExtension(rel);
  // `.obsidian/` holds Obsidian's settings and `.trash/` its deleted notes; neither is a note the
  // person mounted as knowledge, and the search walk skips every dot directory for the same reason.
  if (
    note
      .split(sep)
      .slice(0, -1)
      .some((part) => part.startsWith("."))
  )
    throw new ExecError("invalid_input");
  return join(root, note);
}

function withNoteExtension(rel: string): string {
  const ext = extname(rel);
  if (!ext) return `${rel}${NOTE_EXTENSION}`;
  if (!localDocumentKind(rel)) throw new ExecError("invalid_input");
  return rel;
}

export function firstHeading(text: string): string | null {
  for (const line of text.split("\n")) {
    const heading = /^#\s+(.*\S)\s*$/.exec(line)?.[1];
    if (heading) return heading;
  }
  return null;
}

export function titleFromPath(file: string): string {
  const name = basename(file);
  return name.slice(0, name.length - extname(name).length);
}

function snippetOf(line: string): string {
  const text = line.trim();
  return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS - 1)}…` : text;
}

/** Shared with `knowledge_read` so a read result links the same way a search hit does. */
export function openUrl(vaultPath: string, file: string, sourceId?: string): string {
  const ext = extname(file);
  const stripped = ext === NOTE_EXTENSION ? file.slice(0, file.length - ext.length) : file;
  // Obsidian omits `.md` in its own URIs, except when the remaining stem contains a dot (for
  // example `report.pdf.md` or `v1.2.md`), where dropping `.md` would be ambiguous with a
  // different file extension.
  const target =
    !sourceId && ext === NOTE_EXTENSION && !basename(stripped).includes(".") ? stripped : file;
  const sourceParam = sourceId ? `&source=${encodeURIComponent(sourceId)}` : "";
  return `obsidian://open?vault=${encodeURIComponent(basename(vaultPath))}&file=${encodeURIComponent(target)}${sourceParam}`;
}
