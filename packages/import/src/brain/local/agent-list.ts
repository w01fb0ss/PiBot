// Lists conversations and builds bounded, policy-checked batch inputs for all 5 local agents.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type CapabilityContext,
  EXTERNAL_AGENT_REPLAY_PORT,
  type ExternalAgentReplayPort,
  type ReplayAgentId,
  type ReplayedMessage,
} from "@pibot/brain/kit";
import {
  type CannotExportReason,
  type ImportConversationList,
  type ListedConversation,
  type LocalImportSource,
  MAX_IMPORT_SELECTION,
} from "@pibot/import-contract";
import { z } from "zod";
import {
  ImportFailure,
  type ImportInput,
  type ImportRecord,
  type PreviewRecord,
  type ProjectRef,
  previewMessage,
} from "../adapter.ts";
import type { Supplement } from "../exports/supplement.ts";
import { assertFolderAllowed } from "../folders.ts";
import { redactImportText } from "../records.ts";
import { authorizeRootedFile, type HostPaths, rootedLocalInput } from "../source.ts";
import { configRootFor, type LocalSource, pathApi, supportsLocalSources } from "./locations.ts";
import { hasLocalMemory, readLocalMemories } from "./memory-parse.ts";
import {
  listOpenCodeSessions,
  locateOpenCodeDb,
  normalizeTimestamp,
  openReadOnlySqlite,
  projectFromDirectory,
  readOpenCodeDb,
} from "./opencode.ts";
import { transcriptAdapter } from "./transcript.ts";

const IN_PROGRESS_MS = 2 * 60_000;
const DEFAULT_PAGE_LIMIT = 25;
const MAX_CLAUDE_FILES = 2000;
const MAX_CURSOR_CHATS = 2000;
const MAX_ANTIGRAVITY_ROWS = 5000;
const MAX_RULE_FILE_BYTES = 256 * 1024;
const MAX_RULE_WORKSPACES = 50;
const CLAUDE_HEADER_BYTES = 64 * 1024;

const CODEX_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const UUID_RE = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const CLAUDE_OPAQUE_ID_RE = /^([a-f0-9]{12}):([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i;
const CURSOR_OPAQUE_ID_RE = /^([A-Za-z0-9._-]{1,128}):([A-Za-z0-9._-]{1,128})$/;
const ANTIGRAVITY_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

const codexIndexLineSchema = z.looseObject({
  id: z.string().regex(CODEX_ID_RE),
  thread_name: z.string().max(1000).optional(),
  updated_at: z.string().optional(),
});

const cursorMetaSchema = z.looseObject({
  schemaVersion: z.number().optional(),
  createdAtMs: z.number().optional(),
  updatedAtMs: z.number().optional(),
  hasConversation: z.boolean().optional(),
  cwd: z.string().max(4096).optional(),
  title: z.string().max(500).optional(),
  name: z.string().max(500).optional(),
});

function externalAgentIdFor(source: LocalSource): ReplayAgentId {
  return source === "claude-code" ? "claude" : source;
}

function shortFolderName(dir: string | undefined, redactor: CapabilityContext["redactor"]) {
  if (!dir) return undefined;
  const base =
    dir
      .split(/[\\/]+/u)
      .filter(Boolean)
      .at(-1) ?? "";
  if (!base) return undefined;
  return redactImportText(redactor, base).slice(0, 200);
}

function cleanTitle(
  raw: string | undefined,
  fallback: string,
  redactor: CapabilityContext["redactor"],
) {
  const single = (raw ?? "").replace(/\s+/gu, " ").trim();
  const text = single || fallback;
  return redactImportText(redactor, text).slice(0, 200);
}

function dirHash(name: string) {
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
}

function decodeClaudeProjectName(encoded: string) {
  // Claude Code encodes `/Users/alice/my-app` as `-Users-alice-my-app`; show the trailing label.
  const cleaned = encoded.replace(/^-+/u, "").trim();
  return cleaned || encoded;
}

/**
 * Scans `<codexRoot>/sessions/YYYY/MM/DD/*` and `<codexRoot>/archived_sessions/*` filenames only
 * (never reading message content) and maps each requested session id whose filename ends with
 * `<id>.jsonl` or `<id>.jsonl.zst` to its path in O(files * distinctIdLengths).
 */
async function indexCodexSessionFiles(
  deps: HostPaths,
  targetIds: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<{ roots: string[]; byId: Map<string, string> }> {
  const api = pathApi(deps.platform as "darwin" | "linux" | "win32");
  const root = configRootFor(
    "codex",
    deps.platform as "darwin" | "linux" | "win32",
    deps.userHome,
    deps.env,
  );
  const sessionsDir = api.join(root, "sessions");
  const archivedDir = api.join(root, "archived_sessions");
  const byId = new Map<string, string>();
  if (!targetIds.size) return { roots: [sessionsDir, archivedDir], byId };
  const lengths = [...new Set([...targetIds].map((id) => id.length))];
  const register = (fileName: string, fullPath: string) => {
    const stem = fileName.replace(/\.jsonl(?:\.zst)?$/i, "");
    if (stem === fileName) return;
    for (const len of lengths) {
      if (stem.length < len) continue;
      if (stem.length > len) {
        const boundary = stem[stem.length - len - 1];
        if (boundary !== "-" && boundary !== "_") continue;
      }
      const candidate = stem.slice(stem.length - len);
      if (targetIds.has(candidate) && !byId.has(candidate)) {
        byId.set(candidate, fullPath);
        return;
      }
    }
  };
  const years = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const year of years) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    const yearDir = api.join(sessionsDir, year.name);
    const months = await readdir(yearDir, { withFileTypes: true }).catch(() => []);
    for (const month of months) {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
      const monthDir = api.join(yearDir, month.name);
      const days = await readdir(monthDir, { withFileTypes: true }).catch(() => []);
      for (const day of days) {
        signal.throwIfAborted();
        if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
        const dayDir = api.join(monthDir, day.name);
        const files = await readdir(dayDir, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (file.isFile() && /\.jsonl(?:\.zst)?$/i.test(file.name)) {
            register(file.name, api.join(dayDir, file.name));
          }
        }
      }
    }
  }
  const archived = await readdir(archivedDir, { withFileTypes: true }).catch(() => []);
  for (const file of archived) {
    signal.throwIfAborted();
    if (file.isFile() && /\.jsonl(?:\.zst)?$/i.test(file.name)) {
      register(file.name, api.join(archivedDir, file.name));
    }
  }
  return { roots: [sessionsDir, archivedDir], byId };
}

/** Reads ONLY `<codexRoot>/session_index.jsonl` (titles + times; never message content). */
async function readCodexIndex(
  deps: HostPaths,
  signal: AbortSignal,
): Promise<Array<{ id: string; title: string; updatedAt: string | null }>> {
  const api = pathApi(deps.platform as "darwin" | "linux" | "win32");
  const root = configRootFor(
    "codex",
    deps.platform as "darwin" | "linux" | "win32",
    deps.userHome,
    deps.env,
  );
  const indexPath = api.join(root, "session_index.jsonl");
  let resolved: string;
  try {
    const auth = await authorizeRootedFile(deps, "codex", [root], indexPath, signal);
    if (auth.selected.size > 64n * 1024n * 1024n) return [];
    resolved = auth.resolved;
  } catch {
    return [];
  }
  const raw = await readFile(resolved, { encoding: "utf8", signal }).catch(() => "");
  const map = new Map<string, { id: string; title: string; updatedAt: string | null }>();
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = codexIndexLineSchema.safeParse(parsedJson);
    if (!parsed.success) continue;
    const { id, thread_name, updated_at } = parsed.data;
    const updatedAt = normalizeTimestamp(updated_at);
    const prev = map.get(id);
    if (!prev || (updatedAt && (!prev.updatedAt || updatedAt > prev.updatedAt))) {
      map.set(id, { id, title: thread_name?.trim() || "Codex", updatedAt });
    }
  }
  return [...map.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** Extracts ONLY the first user message line (truncated) and `cwd` from the head of a Claude JSONL. */
async function readClaudeHeader(
  resolvedPath: string,
  signal: AbortSignal,
): Promise<{ title?: string; cwd?: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buf = Buffer.allocUnsafe(CLAUDE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, CLAUDE_HEADER_BYTES, 0);
    signal.throwIfAborted();
    if (!bytesRead) return {};
    const text = buf.subarray(0, bytesRead).toString("utf8");
    let title: string | undefined;
    let cwd: string | undefined;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const row = parsed as Record<string, unknown>;
      if (!cwd && typeof row.cwd === "string" && row.cwd.trim()) cwd = row.cwd.trim();
      if (row.isMeta === true || row.isSidechain === true) continue;
      if (!title && row.type === "user" && row.message && typeof row.message === "object") {
        const content = (row.message as Record<string, unknown>).content;
        let candidate = "";
        if (typeof content === "string") candidate = content;
        else if (Array.isArray(content)) {
          const textBlock = content.find(
            (b): b is { type: string; text: string } =>
              !!b &&
              typeof b === "object" &&
              (b as { type?: unknown }).type === "text" &&
              typeof (b as { text?: unknown }).text === "string",
          );
          if (textBlock) candidate = textBlock.text;
        }
        const firstLine = candidate
          .split(/\r?\n/u)
          .map((l) => l.trim())
          .find(Boolean);
        if (firstLine) title = firstLine.slice(0, 120);
      }
      if (title && cwd) break;
    }
    return { ...(title ? { title } : {}), ...(cwd ? { cwd } : {}) };
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface ClaudeSessionEntry {
  id: string;
  filePath: string;
  encodedProject: string;
  mtimeMs: number;
}

async function scanClaudeSessions(
  deps: HostPaths,
  signal: AbortSignal,
): Promise<{ projectsDir: string; entries: ClaudeSessionEntry[] }> {
  const api = pathApi(deps.platform as "darwin" | "linux" | "win32");
  const root = configRootFor(
    "claude-code",
    deps.platform as "darwin" | "linux" | "win32",
    deps.userHome,
    deps.env,
  );
  const projectsDir = api.join(root, "projects");
  const projectDirs = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const entries: ClaudeSessionEntry[] = [];
  for (const dir of projectDirs) {
    signal.throwIfAborted();
    if (!dir.isDirectory() || entries.length >= MAX_CLAUDE_FILES) continue;
    const hash = dirHash(dir.name);
    const fullDir = api.join(projectsDir, dir.name);
    const files = await readdir(fullDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      signal.throwIfAborted();
      if (entries.length >= MAX_CLAUDE_FILES) break;
      if (!file.isFile()) continue;
      const match = /^([\da-f-]+)\.jsonl$/i.exec(file.name);
      const uuid = match?.[1];
      if (!uuid || !UUID_RE.test(uuid)) continue;
      const filePath = api.join(fullDir, file.name);
      const info = await lstat(filePath).catch(() => undefined);
      if (!info?.isFile()) continue;
      entries.push({
        id: `${hash}:${uuid}`,
        filePath,
        encodedProject: dir.name,
        mtimeMs: info.mtimeMs,
      });
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { projectsDir, entries };
}

interface CursorChatEntry {
  id: string;
  chatId: string;
  title: string;
  cwd?: string;
  createdAt: string | null;
  updatedAt: string | null;
  inProgress: boolean;
}

async function scanCursorChats(deps: HostPaths, signal: AbortSignal): Promise<CursorChatEntry[]> {
  const api = pathApi(deps.platform as "darwin" | "linux" | "win32");
  const root = configRootFor(
    "cursor",
    deps.platform as "darwin" | "linux" | "win32",
    deps.userHome,
    deps.env,
  );
  const chatsDir = api.join(root, "chats");
  const workspaces = await readdir(chatsDir, { withFileTypes: true }).catch(() => []);
  const entries: CursorChatEntry[] = [];
  const now = Date.now();
  for (const ws of workspaces) {
    signal.throwIfAborted();
    if (!ws.isDirectory() || !/^[A-Za-z0-9._-]{1,128}$/.test(ws.name)) continue;
    const wsDir = api.join(chatsDir, ws.name);
    const chats = await readdir(wsDir, { withFileTypes: true }).catch(() => []);
    for (const chat of chats) {
      signal.throwIfAborted();
      if (entries.length >= MAX_CURSOR_CHATS) break;
      if (!chat.isDirectory() || !/^[A-Za-z0-9._-]{1,128}$/.test(chat.name)) continue;
      const chatDir = api.join(wsDir, chat.name);
      const metaPath = api.join(chatDir, "meta.json");
      let metaResolved: string;
      let metaMtimeMs: number;
      try {
        const auth = await authorizeRootedFile(deps, "cursor", [chatsDir], metaPath, signal);
        if (auth.selected.size > 1024n * 1024n) continue;
        metaResolved = auth.resolved;
        metaMtimeMs = Number(auth.selected.mtimeMs);
      } catch {
        continue;
      }
      const raw = await readFile(metaResolved, { encoding: "utf8", signal }).catch(() => "");
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        continue;
      }
      const parsed = cursorMetaSchema.safeParse(parsedJson);
      if (!parsed.success || parsed.data.hasConversation === false) continue;
      const { createdAtMs, updatedAtMs, cwd, title, name } = parsed.data;
      const storeMtimeMs = await lstat(api.join(chatDir, "store.db"))
        .then((s) => s.mtimeMs)
        .catch(() => 0);
      const latestMs = Math.max(updatedAtMs ?? 0, createdAtMs ?? 0, metaMtimeMs, storeMtimeMs);
      const createdAt = normalizeTimestamp(createdAtMs) ?? normalizeTimestamp(metaMtimeMs);
      const updatedAt =
        normalizeTimestamp(updatedAtMs) ?? normalizeTimestamp(latestMs) ?? createdAt;
      const dateStr = (updatedAt ?? "").slice(0, 10);
      const cwdBase = cwd
        ?.split(/[\\/]+/u)
        .filter(Boolean)
        .at(-1);
      const fallbackTitle = cwdBase
        ? dateStr
          ? `${cwdBase} (${dateStr})`
          : cwdBase
        : dateStr
          ? `Cursor (${dateStr})`
          : "Cursor";
      entries.push({
        id: `${ws.name}:${chat.name}`,
        chatId: chat.name,
        title: (title || name || fallbackTitle).trim(),
        ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
        createdAt,
        updatedAt,
        inProgress: latestMs > 0 && now - latestMs < IN_PROGRESS_MS,
      });
    }
  }
  entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return entries;
}

interface AntigravitySummaryEntry {
  id: string;
  title: string;
  workspace?: string;
  updatedAt: string | null;
  inProgress: boolean;
}

function parseWorkspaceUris(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        candidates = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      candidates = [trimmed];
    }
  } else {
    candidates = trimmed.split(/[\r\n,]+/u).map((s) => s.trim());
  }
  for (const uri of candidates) {
    if (!uri) continue;
    if (uri.startsWith("file://")) {
      try {
        return fileURLToPath(uri);
      } catch {
        continue;
      }
    }
    if (/^(?:\/|[A-Za-z]:[\\/])/u.test(uri)) return uri;
  }
  return undefined;
}

async function scanAntigravitySummaries(
  deps: HostPaths,
  signal: AbortSignal,
): Promise<AntigravitySummaryEntry[]> {
  if (!supportsLocalSources(deps.platform)) return [];
  const api = pathApi(deps.platform);
  const root = configRootFor("antigravity", deps.platform, deps.userHome, deps.env);
  const dbPath = api.join(root, "conversation_summaries.db");
  let resolved: string;
  try {
    const auth = await authorizeRootedFile(deps, "antigravity", [root], dbPath, signal);
    resolved = auth.resolved;
  } catch {
    return [];
  }
  let db: ReturnType<typeof openReadOnlySqlite> | undefined;
  try {
    db = openReadOnlySqlite(resolved);
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_summaries'")
      .get();
    if (!hasTable) return [];
    const rows = db
      .prepare(
        `SELECT conversation_id, title, last_modified_time, workspace_uris, status
         FROM conversation_summaries
         ORDER BY last_modified_time DESC
         LIMIT ?`,
      )
      .all(MAX_ANTIGRAVITY_ROWS);
    const now = Date.now();
    const results: AntigravitySummaryEntry[] = [];
    for (const row of rows) {
      signal.throwIfAborted();
      const id = typeof row.conversation_id === "string" ? row.conversation_id.trim() : "";
      if (!ANTIGRAVITY_ID_RE.test(id)) continue;
      const title =
        typeof row.title === "string" && row.title.trim()
          ? row.title.trim().slice(0, 200)
          : "Antigravity";
      const updatedAt = normalizeTimestamp(row.last_modified_time);
      const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
      const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
      const activeStatus =
        status === "running" ||
        status === "active" ||
        status === "in_progress" ||
        status === "working";
      const workspace = parseWorkspaceUris(row.workspace_uris);
      results.push({
        id,
        title,
        ...(workspace ? { workspace } : {}),
        updatedAt,
        inProgress:
          activeStatus || (Number.isFinite(updatedMs) && now - updatedMs < IN_PROGRESS_MS),
      });
    }
    return results;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Collects rule file paths in one workspace directory for a given local agent. */
async function ruleFilesInWorkspace(
  deps: HostPaths,
  source: LocalSource,
  workspaceDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (!supportsLocalSources(deps.platform)) return [];
  const api = pathApi(deps.platform);
  if (!api.isAbsolute(workspaceDir)) return [];
  try {
    await assertFolderAllowed(deps as CapabilityContext["local"]["deps"], workspaceDir, signal);
    const info = await stat(workspaceDir);
    if (!info.isDirectory()) return [];
  } catch {
    return [];
  }
  const candidates: string[] = [];
  if (source === "codex" || source === "opencode")
    candidates.push(api.join(workspaceDir, "AGENTS.md"));
  else if (source === "claude-code") candidates.push(api.join(workspaceDir, "CLAUDE.md"));
  else if (source === "antigravity") candidates.push(api.join(workspaceDir, "GEMINI.md"));
  else if (source === "cursor") {
    candidates.push(api.join(workspaceDir, ".cursorrules"));
    const rulesDir = api.join(workspaceDir, ".cursor", "rules");
    const entries = await readdir(rulesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".mdc"))
        candidates.push(api.join(rulesDir, entry.name));
    }
  }
  const existing: string[] = [];
  for (const candidate of candidates) {
    signal.throwIfAborted();
    try {
      const { selected } = await authorizeRootedFile(
        deps,
        source,
        [workspaceDir],
        candidate,
        signal,
        { allowAiRoot: false },
      );
      if (selected.size > 0n && selected.size <= BigInt(MAX_RULE_FILE_BYTES)) {
        existing.push(candidate);
      }
    } catch {
      // Missing or protected file is skipped.
    }
  }
  return existing;
}

async function hasAnyProjectRules(
  deps: HostPaths,
  source: LocalSource,
  workspaces: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  const unique = [...new Set(workspaces.filter(Boolean))].slice(0, MAX_RULE_WORKSPACES);
  for (const dir of unique) {
    signal.throwIfAborted();
    if ((await ruleFilesInWorkspace(deps, source, dir, signal)).length > 0) return true;
  }
  return false;
}

async function readWorkspaceRules(
  deps: HostPaths,
  source: LocalSource,
  workspaces: readonly string[],
  signal: AbortSignal,
): Promise<{
  supplements: Supplement[];
  projects: ProjectRef[];
  verifiedFiles: Array<{
    root: string;
    path: string;
    resolved: string;
    mtimeNs: bigint;
    size: bigint;
  }>;
}> {
  const unique = [...new Set(workspaces.filter(Boolean))].slice(0, MAX_RULE_WORKSPACES);
  const supplements: Supplement[] = [];
  const projects: ProjectRef[] = [];
  const verifiedFiles: Array<{
    root: string;
    path: string;
    resolved: string;
    mtimeNs: bigint;
    size: bigint;
  }> = [];
  for (const dir of unique) {
    signal.throwIfAborted();
    const project = projectFromDirectory(dir);
    if (!project) continue;
    const files = await ruleFilesInWorkspace(deps, source, dir, signal);
    if (!files.length) continue;
    let addedForProject = false;
    for (const filePath of files) {
      signal.throwIfAborted();
      try {
        const { selected, resolved } = await authorizeRootedFile(
          deps,
          source,
          [dir],
          filePath,
          signal,
          { allowAiRoot: false },
        );
        if (selected.size === 0n || selected.size > BigInt(MAX_RULE_FILE_BYTES)) continue;
        const text = await readFile(resolved, { encoding: "utf8", signal });
        if (!text.trim() || text.includes("\0")) continue;
        supplements.push({ kind: "projects", text, sourcePath: resolved, project });
        verifiedFiles.push({
          root: dir,
          path: filePath,
          resolved,
          mtimeNs: selected.mtimeNs,
          size: selected.size,
        });
        addedForProject = true;
      } catch {
        // Skip unreadable rule file; other files/workspaces stay usable.
      }
    }
    if (addedForProject) projects.push(project);
  }
  return { supplements, projects, verifiedFiles };
}

async function probeReplaySupport(
  ctx: CapabilityContext,
  source: "cursor" | "antigravity",
  signal: AbortSignal,
): Promise<{ canExportContent: boolean; cannotExportReason?: CannotExportReason }> {
  const replay = ctx.ports.get<ExternalAgentReplayPort>(EXTERNAL_AGENT_REPLAY_PORT);
  if (!replay) return { canExportContent: false, cannotExportReason: "unsupported" };
  const caps = await replay.probeCapabilities(externalAgentIdFor(source), signal);
  if (caps.status === "ready") {
    return caps.loadSession
      ? { canExportContent: true }
      : { canExportContent: false, cannotExportReason: "no_load_session" };
  }
  if (caps.status === "unconfirmed")
    return { canExportContent: false, cannotExportReason: "agent_unconfirmed" };
  if (caps.status === "unsupported")
    return { canExportContent: false, cannotExportReason: "unsupported" };
  return { canExportContent: false, cannotExportReason: "agent_unavailable" };
}

function paginate<T>(items: T[], cursor = 0, limit = DEFAULT_PAGE_LIMIT) {
  const slice = items.slice(cursor, cursor + limit);
  const next = cursor + slice.length < items.length ? cursor + slice.length : null;
  return { slice, total: items.length, next };
}

/**
 * Lists conversations from a local agent's own conversation index (titles + times + project folder;
 * never full message bodies). Called only after the user explicitly clicks "List conversations".
 */
export async function listLocalConversations(
  ctx: CapabilityContext,
  workFolderPaths: readonly string[],
  params: { source: LocalImportSource; query?: string; cursor?: number; limit?: number },
  signal: AbortSignal,
): Promise<ImportConversationList> {
  const deps = ctx.local.deps;
  if (!supportsLocalSources(deps.platform)) {
    return {
      items: [],
      total: 0,
      next: null,
      canExportContent: false,
      cannotExportReason: "unsupported",
      hasMemory: false,
      hasProjectRules: false,
    };
  }
  const query = params.query?.trim().toLowerCase() ?? "";
  const cursor = params.cursor ?? 0;
  const limit = params.limit ?? DEFAULT_PAGE_LIMIT;
  const { source } = params;

  if (source === "codex") {
    const [index, hasMemory, hasRegisteredRules] = await Promise.all([
      readCodexIndex(deps, signal),
      hasLocalMemory(deps, "codex", signal),
      hasAnyProjectRules(deps, "codex", workFolderPaths, signal),
    ]);
    const files = await indexCodexSessionFiles(
      deps,
      new Set(index.map((entry) => entry.id)),
      signal,
    );
    const available = index.filter((entry) => files.byId.has(entry.id));
    const filtered = query
      ? available.filter((entry) => entry.title.toLowerCase().includes(query))
      : available;
    const { slice, total, next } = paginate(filtered, cursor, limit);
    const now = Date.now();
    const items: ListedConversation[] = await Promise.all(
      slice.map(async (entry) => {
        const filePath = files.byId.get(entry.id);
        const fileMtime = filePath
          ? await lstat(filePath)
              .then((s) => s.mtimeMs)
              .catch(() => 0)
          : 0;
        const updatedMs = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN;
        const inProgress =
          (fileMtime > 0 && now - fileMtime < IN_PROGRESS_MS) ||
          (Number.isFinite(updatedMs) && now - updatedMs < IN_PROGRESS_MS);
        return {
          id: entry.id,
          title: cleanTitle(entry.title, "Codex", ctx.redactor),
          updatedAt: entry.updatedAt ?? (fileMtime ? new Date(fileMtime).toISOString() : null),
          ...(inProgress ? { inProgress: true } : {}),
        };
      }),
    );
    return {
      items,
      total,
      next,
      canExportContent: true,
      hasMemory,
      // Selected Codex sessions carry their workspace `cwd` inside the session file; offer rules checkbox.
      hasProjectRules: hasRegisteredRules || available.length > 0,
    };
  }

  if (source === "claude-code") {
    const [{ projectsDir, entries }, hasMemory] = await Promise.all([
      scanClaudeSessions(deps, signal),
      hasLocalMemory(deps, "claude-code", signal),
    ]);
    const now = Date.now();
    const workspaces = new Set<string>(workFolderPaths);
    const resolveItem = async (entry: ClaudeSessionEntry): Promise<ListedConversation> => {
      let header: { title?: string; cwd?: string } = {};
      try {
        const auth = await authorizeRootedFile(
          deps,
          "claude-code",
          [projectsDir],
          entry.filePath,
          signal,
        );
        header = await readClaudeHeader(auth.resolved, signal);
      } catch {
        // Leave title/cwd as fallback when individual file cannot be read.
      }
      if (header.cwd) workspaces.add(header.cwd);
      const project =
        shortFolderName(header.cwd, ctx.redactor) ??
        redactImportText(ctx.redactor, decodeClaudeProjectName(entry.encodedProject)).slice(0, 200);
      const inProgress = now - entry.mtimeMs < IN_PROGRESS_MS;
      return {
        id: entry.id,
        title: cleanTitle(header.title, "Claude Code", ctx.redactor),
        updatedAt: new Date(entry.mtimeMs).toISOString(),
        ...(project ? { project } : {}),
        ...(inProgress ? { inProgress: true } : {}),
      };
    };

    if (query) {
      // Bound header reads when searching so huge histories stay fast.
      const scanned = await Promise.all(entries.slice(0, 500).map(resolveItem));
      const filtered = scanned.filter(
        (item) =>
          item.title.toLowerCase().includes(query) ||
          (item.project?.toLowerCase().includes(query) ?? false),
      );
      const { slice, total, next } = paginate(filtered, cursor, limit);
      const hasProjectRules =
        (await hasAnyProjectRules(deps, "claude-code", [...workspaces], signal)) ||
        entries.length > 0;
      return {
        items: slice,
        total,
        next,
        canExportContent: true,
        hasMemory,
        hasProjectRules,
      };
    }

    const { slice, total, next } = paginate(entries, cursor, limit);
    const items = await Promise.all(slice.map(resolveItem));
    const hasProjectRules =
      (await hasAnyProjectRules(deps, "claude-code", [...workspaces], signal)) ||
      entries.length > 0;
    return {
      items,
      total,
      next,
      canExportContent: true,
      hasMemory,
      hasProjectRules,
    };
  }

  if (source === "opencode") {
    const sessions = await listOpenCodeSessions(deps, signal);
    const filtered = query
      ? sessions.filter((s) => {
          const proj = shortFolderName(s.directory, ctx.redactor) ?? "";
          return s.title.toLowerCase().includes(query) || proj.toLowerCase().includes(query);
        })
      : sessions;
    const { slice, total, next } = paginate(filtered, cursor, limit);
    const workspaces = [
      ...sessions.map((s) => s.directory).filter((d): d is string => !!d),
      ...workFolderPaths,
    ];
    const hasProjectRules = await hasAnyProjectRules(deps, "opencode", workspaces, signal);
    return {
      items: slice.map((s) => {
        const project = shortFolderName(s.directory, ctx.redactor);
        return {
          id: s.id,
          title: cleanTitle(s.title, "OpenCode", ctx.redactor),
          updatedAt: s.updatedAt,
          ...(project ? { project } : {}),
          ...(s.inProgress ? { inProgress: true } : {}),
        };
      }),
      total,
      next,
      canExportContent: true,
      hasMemory: false,
      hasProjectRules,
    };
  }

  if (source === "cursor") {
    const [chats, replaySupport] = await Promise.all([
      scanCursorChats(deps, signal),
      probeReplaySupport(ctx, "cursor", signal),
    ]);
    const filtered = query
      ? chats.filter((c) => {
          const proj = shortFolderName(c.cwd, ctx.redactor) ?? "";
          return c.title.toLowerCase().includes(query) || proj.toLowerCase().includes(query);
        })
      : chats;
    const { slice, total, next } = paginate(filtered, cursor, limit);
    const workspaces = [
      ...chats.map((c) => c.cwd).filter((d): d is string => !!d),
      ...workFolderPaths,
    ];
    const hasProjectRules = await hasAnyProjectRules(deps, "cursor", workspaces, signal);
    return {
      items: slice.map((c) => {
        const project = shortFolderName(c.cwd, ctx.redactor);
        return {
          id: c.id,
          title: cleanTitle(c.title, "Cursor", ctx.redactor),
          updatedAt: c.updatedAt,
          ...(project ? { project } : {}),
          ...(c.inProgress ? { inProgress: true } : {}),
        };
      }),
      total,
      next,
      ...replaySupport,
      hasMemory: false,
      hasProjectRules,
    };
  }

  // Antigravity
  const [summaries, replaySupport] = await Promise.all([
    scanAntigravitySummaries(deps, signal),
    probeReplaySupport(ctx, "antigravity", signal),
  ]);
  const filtered = query
    ? summaries.filter((s) => {
        const proj = shortFolderName(s.workspace, ctx.redactor) ?? "";
        return s.title.toLowerCase().includes(query) || proj.toLowerCase().includes(query);
      })
    : summaries;
  const { slice, total, next } = paginate(filtered, cursor, limit);
  const api = pathApi(deps.platform);
  const agyRoot = configRootFor("antigravity", deps.platform, deps.userHome, deps.env);
  const now = Date.now();
  const items: ListedConversation[] = await Promise.all(
    slice.map(async (s) => {
      const convDb = api.join(agyRoot, "conversations", `${s.id}.db`);
      const convMtime = await lstat(convDb)
        .then((st) => st.mtimeMs)
        .catch(() => 0);
      const inProgress = s.inProgress || (convMtime > 0 && now - convMtime < IN_PROGRESS_MS);
      const project = shortFolderName(s.workspace, ctx.redactor);
      return {
        id: s.id,
        title: cleanTitle(s.title, "Antigravity", ctx.redactor),
        updatedAt: s.updatedAt,
        ...(project ? { project } : {}),
        ...(inProgress ? { inProgress: true } : {}),
      };
    }),
  );
  const workspaces = [
    ...summaries.map((s) => s.workspace).filter((d): d is string => !!d),
    ...workFolderPaths,
  ];
  const hasProjectRules = await hasAnyProjectRules(deps, "antigravity", workspaces, signal);
  return {
    items,
    total,
    next,
    ...replaySupport,
    hasMemory: false,
    hasProjectRules,
  };
}

/** Assigns monotonic ISO timestamps across replayed ACP messages within `[createdAt, updatedAt]`. */
function stampReplayedMessages(
  messages: readonly ReplayedMessage[],
  createdAtIso: string | null,
  updatedAtIso: string | null,
): { createdAt: string; updatedAt: string; records: Extract<ImportRecord, { kind: "message" }>[] } {
  const nowIso = new Date().toISOString();
  const endMs = updatedAtIso ? Date.parse(updatedAtIso) : Date.now();
  const safeEndMs = Number.isFinite(endMs) ? endMs : Date.now();
  const startMsRaw = createdAtIso ? Date.parse(createdAtIso) : safeEndMs;
  const safeStartMs =
    Number.isFinite(startMsRaw) && startMsRaw <= safeEndMs ? startMsRaw : safeEndMs;
  const span = Math.max(0, safeEndMs - safeStartMs);
  const count = messages.length;
  const records = messages.map((msg, index) => {
    const offset = count > 1 ? Math.floor((span * index) / (count - 1)) : 0;
    return {
      kind: "message" as const,
      role: msg.role,
      text: msg.text,
      createdAt: new Date(safeStartMs + offset).toISOString(),
    };
  });
  return {
    createdAt: new Date(safeStartMs).toISOString() || nowIso,
    updatedAt: new Date(safeEndMs).toISOString() || nowIso,
    records,
  };
}

/**
 * Resolves a user-confirmed local selection (conversation IDs + optional memory + optional project
 * rules) into a single policy-checked `ImportInput` backed by `input.batch`.
 */
export async function prepareLocalSelection(
  ctx: CapabilityContext,
  workFolderPaths: readonly string[],
  params: {
    source: LocalImportSource;
    conversationIds: readonly string[];
    includeMemory?: boolean;
    includeProjectRules?: boolean;
  },
  signal: AbortSignal,
): Promise<ImportInput> {
  const deps = ctx.local.deps;
  if (!supportsLocalSources(deps.platform)) throw new ImportFailure("unsupported");
  const ids = [...new Set(params.conversationIds)];
  if (ids.length > MAX_IMPORT_SELECTION) throw new ImportFailure("limit");
  const { source } = params;
  const now = Date.now();

  const fileInputs: ImportInput[] = [];
  let cachedRecords: ImportRecord[] | undefined;
  let opencodeContext:
    | {
        dbPath: string;
        roots: string[];
        sessionIds: string[];
        resolved: string;
        mtimeNs: bigint;
        size: bigint;
      }
    | undefined;
  const discoveredWorkspaces = new Set<string>();

  if (source === "codex" && ids.length) {
    const validIds = ids.filter((id) => CODEX_ID_RE.test(id));
    if (validIds.length !== ids.length) throw new ImportFailure("source_changed");
    const [index, files] = await Promise.all([
      readCodexIndex(deps, signal),
      indexCodexSessionFiles(deps, new Set(validIds), signal),
    ]);
    const titles = new Map(index.map((entry) => [entry.id, entry.title]));
    for (const id of ids) {
      signal.throwIfAborted();
      if (!CODEX_ID_RE.test(id)) throw new ImportFailure("source_changed");
      const filePath = files.byId.get(id);
      if (!filePath) throw new ImportFailure("source_changed");
      const info = await lstat(filePath).catch(() => undefined);
      if (!info?.isFile()) throw new ImportFailure("source_changed");
      if (now - info.mtimeMs < IN_PROGRESS_MS) throw new ImportFailure("source_in_use");
      const input = await rootedLocalInput(deps, "codex", files.roots, filePath, signal, {
        title: titles.get(id) || "Codex",
        localSession: true,
      });
      fileInputs.push(input);
    }
  } else if (source === "claude-code" && ids.length) {
    const { projectsDir, entries } = await scanClaudeSessions(deps, signal);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const id of ids) {
      signal.throwIfAborted();
      if (!CLAUDE_OPAQUE_ID_RE.test(id)) throw new ImportFailure("source_changed");
      const entry = byId.get(id);
      if (!entry) throw new ImportFailure("source_changed");
      if (now - entry.mtimeMs < IN_PROGRESS_MS) throw new ImportFailure("source_in_use");
      const auth = await authorizeRootedFile(
        deps,
        "claude-code",
        [projectsDir],
        entry.filePath,
        signal,
      );
      const header = await readClaudeHeader(auth.resolved, signal);
      if (header.cwd) discoveredWorkspaces.add(header.cwd);
      const input = await rootedLocalInput(
        deps,
        "claude-code",
        [projectsDir],
        entry.filePath,
        signal,
        {
          title: header.title || "Claude Code",
          localSession: true,
        },
      );
      fileInputs.push(input);
    }
  } else if (source === "opencode" && ids.length) {
    const located = await locateOpenCodeDb(deps, signal);
    if (!located) throw new ImportFailure("source_changed");
    const auth = await authorizeRootedFile(
      deps,
      "opencode",
      located.roots,
      located.dbPath,
      signal,
      {
        allowAiRoot: false,
      },
    );
    const sessions = await listOpenCodeSessions(deps, signal);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const id of ids) {
      const meta = byId.get(id);
      if (!meta) throw new ImportFailure("source_changed");
      if (meta.inProgress) throw new ImportFailure("source_in_use");
      if (meta.directory) discoveredWorkspaces.add(meta.directory);
    }
    opencodeContext = {
      dbPath: located.dbPath,
      roots: located.roots,
      sessionIds: ids,
      resolved: auth.resolved,
      mtimeNs: auth.selected.mtimeNs,
      size: auth.selected.size,
    };
  } else if ((source === "cursor" || source === "antigravity") && ids.length) {
    const replay = ctx.ports.get<ExternalAgentReplayPort>(EXTERNAL_AGENT_REPLAY_PORT);
    if (!replay) throw new ImportFailure("unsupported");
    const metas = new Map<
      string,
      {
        sessionId: string;
        title: string;
        cwd?: string;
        createdAt: string | null;
        updatedAt: string | null;
      }
    >();
    if (source === "cursor") {
      const chats = await scanCursorChats(deps, signal);
      const byId = new Map(chats.map((c) => [c.id, c]));
      for (const id of ids) {
        if (!CURSOR_OPAQUE_ID_RE.test(id)) throw new ImportFailure("source_changed");
        const chat = byId.get(id);
        if (!chat) throw new ImportFailure("source_changed");
        if (chat.inProgress) throw new ImportFailure("source_in_use");
        if (chat.cwd) discoveredWorkspaces.add(chat.cwd);
        metas.set(chat.chatId, {
          sessionId: chat.chatId,
          title: chat.title,
          ...(chat.cwd ? { cwd: chat.cwd } : {}),
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
        });
      }
    } else {
      const summaries = await scanAntigravitySummaries(deps, signal);
      const byId = new Map(summaries.map((s) => [s.id, s]));
      const api = pathApi(deps.platform);
      const agyRoot = configRootFor("antigravity", deps.platform, deps.userHome, deps.env);
      for (const id of ids) {
        if (!ANTIGRAVITY_ID_RE.test(id)) throw new ImportFailure("source_changed");
        const summary = byId.get(id);
        if (!summary) throw new ImportFailure("source_changed");
        const convMtime = await lstat(api.join(agyRoot, "conversations", `${id}.db`))
          .then((st) => st.mtimeMs)
          .catch(() => 0);
        if (summary.inProgress || (convMtime > 0 && now - convMtime < IN_PROGRESS_MS)) {
          throw new ImportFailure("source_in_use");
        }
        if (summary.workspace) discoveredWorkspaces.add(summary.workspace);
        metas.set(id, {
          sessionId: id,
          title: summary.title,
          ...(summary.workspace ? { cwd: summary.workspace } : {}),
          createdAt: summary.updatedAt,
          updatedAt: summary.updatedAt,
        });
      }
    }

    const replayed = await replay.replaySessions(
      externalAgentIdFor(source),
      [...metas.values()].map(({ sessionId, cwd }) => ({ sessionId, ...(cwd ? { cwd } : {}) })),
      signal,
    );
    if (!replayed.ok) {
      if (replayed.reason === "timeout") throw new ImportFailure("timeout");
      if (
        replayed.reason === "no_load_session" ||
        replayed.reason === "agent_unavailable" ||
        replayed.reason === "agent_unconfirmed" ||
        replayed.reason === "unsupported"
      )
        throw new ImportFailure("unsupported");
      if (replayed.reason === "agent_login_required") {
        throw new ImportFailure("source_changed");
      }
      throw new ImportFailure("format");
    }
    const records: ImportRecord[] = [];
    for (const session of replayed.sessions) {
      const meta = metas.get(session.sessionId);
      if (!meta || !session.messages.length) continue;
      const stamped = stampReplayedMessages(session.messages, meta.createdAt, meta.updatedAt);
      const project = projectFromDirectory(meta.cwd);
      records.push({
        kind: "topic",
        title: meta.title,
        createdAt: stamped.createdAt,
        updatedAt: stamped.updatedAt,
        ...(project ? { project } : {}),
      });
      records.push(...stamped.records);
    }
    cachedRecords = records;
  }

  // Gather memory items if requested (Codex & Claude Code).
  const memorySupplements: Supplement[] =
    params.includeMemory && (source === "codex" || source === "claude-code")
      ? await readLocalMemories(deps, source, signal)
      : [];

  // For Codex/Claude file inputs, discover project workspaces during preview if rules were requested.
  let ruleResult: Awaited<ReturnType<typeof readWorkspaceRules>> = {
    supplements: [],
    projects: [],
    verifiedFiles: [],
  };

  const resolveRules = async (currentSignal: AbortSignal) => {
    if (!params.includeProjectRules) return;
    if (!discoveredWorkspaces.size) {
      // Fall back to listed workspaces / registered work folders when no conversations were picked.
      if (source === "opencode") {
        for (const s of await listOpenCodeSessions(deps, currentSignal)) {
          if (s.directory) discoveredWorkspaces.add(s.directory);
        }
      } else if (source === "cursor") {
        for (const c of await scanCursorChats(deps, currentSignal)) {
          if (c.cwd) discoveredWorkspaces.add(c.cwd);
        }
      } else if (source === "antigravity") {
        for (const s of await scanAntigravitySummaries(deps, currentSignal)) {
          if (s.workspace) discoveredWorkspaces.add(s.workspace);
        }
      }
      for (const dir of workFolderPaths) discoveredWorkspaces.add(dir);
    }
    ruleResult = await readWorkspaceRules(deps, source, [...discoveredWorkspaces], currentSignal);
  };

  const singleAdapter =
    source === "codex" || source === "claude-code" ? transcriptAdapter(source) : undefined;

  async function* readBatchRecords(readSignal: AbortSignal): AsyncGenerator<ImportRecord> {
    if (cachedRecords) {
      for (const record of cachedRecords) {
        readSignal.throwIfAborted();
        yield record;
      }
      return;
    }
    if (opencodeContext) {
      const auth = await authorizeRootedFile(
        deps,
        "opencode",
        opencodeContext.roots,
        opencodeContext.dbPath,
        readSignal,
        { allowAiRoot: false },
      );
      if (auth.resolved !== opencodeContext.resolved) throw new ImportFailure("source_changed");
      if (
        auth.selected.mtimeNs !== opencodeContext.mtimeNs ||
        auth.selected.size !== opencodeContext.size
      ) {
        throw new ImportFailure("source_in_use");
      }
      for (const record of readOpenCodeDb(auth.resolved, opencodeContext.sessionIds, readSignal)) {
        yield record;
      }
      return;
    }
    if (singleAdapter) {
      for (const fileInput of fileInputs) {
        readSignal.throwIfAborted();
        for await (const record of singleAdapter.read(fileInput, readSignal)) {
          if (record.kind === "topic" && record.project?.path) {
            discoveredWorkspaces.add(record.project.path);
          }
          yield record;
        }
      }
    }
  }

  async function* previewBatch(previewSignal: AbortSignal): AsyncGenerator<PreviewRecord> {
    if (singleAdapter && fileInputs.length) {
      for (const fileInput of fileInputs) {
        previewSignal.throwIfAborted();
        for await (const record of singleAdapter.preview(fileInput, previewSignal)) {
          if (record.kind === "topic" && record.project?.path) {
            discoveredWorkspaces.add(record.project.path);
          }
          yield record;
        }
      }
    } else {
      for await (const record of readBatchRecords(previewSignal)) {
        if (record.kind === "topic") {
          yield {
            kind: "topic",
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            ...(record.project ? { project: record.project } : {}),
          };
        } else {
          yield previewMessage(record);
        }
      }
    }
    await resolveRules(previewSignal);
    for (const supplement of ruleResult.supplements) {
      if (supplement.project) {
        yield {
          kind: "projectKnowledge",
          project: supplement.project,
          pieces: supplement.text ? 1 : 0,
        };
      }
    }
    if (memorySupplements.length || ruleResult.projects.length) {
      yield {
        kind: "exportSummary",
        memories: memorySupplements.length,
        customInstructions: 0,
        projects: ruleResult.projects.length,
        skippedAttachments: 0,
        skippedFiles: 0,
      };
    }
  }

  async function* batchSupplements(readSignal: AbortSignal): AsyncGenerator<Supplement> {
    for (const item of memorySupplements) {
      readSignal.throwIfAborted();
      yield item;
    }
    for (const item of ruleResult.supplements) {
      readSignal.throwIfAborted();
      yield item;
    }
  }

  async function assertBatchSource(checkSignal: AbortSignal) {
    for (const file of ruleResult.verifiedFiles) {
      const auth = await authorizeRootedFile(deps, source, [file.root], file.path, checkSignal, {
        allowAiRoot: false,
      });
      if (
        auth.resolved !== file.resolved ||
        auth.selected.mtimeNs !== file.mtimeNs ||
        auth.selected.size !== file.size
      ) {
        throw new ImportFailure("source_changed");
      }
    }
  }

  const input: ImportInput = async function* () {
    // Batch inputs stream records directly via `input.batch`.
  };
  input.batch = {
    preview: previewBatch,
    read: readBatchRecords,
    supplements: batchSupplements,
    assertSource: assertBatchSource,
  };
  return input;
}
