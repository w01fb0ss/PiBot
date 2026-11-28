// Read-only, immutable SQLite reader for OpenCode sessions (`opencode.db`).
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  type ImportAdapter,
  ImportFailure,
  type ImportRecord,
  type ProjectRef,
  previewMessage,
} from "../adapter.ts";
import { LONG_MESSAGE_CHARS } from "../limits.ts";
import { authorizeRootedFile, type HostPaths } from "../source.ts";
import { opencodeDataRoots, pathApi, supportsLocalSources } from "./locations.ts";

const IN_PROGRESS_MS = 2 * 60_000;
const MAX_SESSIONS_LIST = 10_000;
const MAX_MESSAGES_PER_SESSION = 50_000;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;

const messageDataSchema = z.looseObject({
  role: z.enum(["user", "assistant"]).optional(),
  time: z
    .looseObject({
      created: z.number().optional(),
      completed: z.number().optional(),
    })
    .optional(),
});

const partDataSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  tool: z.string().optional(),
  state: z
    .looseObject({
      title: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
});

export interface OpenCodeSessionMeta {
  id: string;
  title: string;
  directory?: string;
  createdAt: string | null;
  updatedAt: string | null;
  inProgress: boolean;
}

/** Converts epoch ms, epoch s, or ISO datetime strings into an ISO UTC timestamp. */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return normalizeTimestamp(num);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function openReadOnlySqlite(resolvedPath: string): DatabaseSync {
  const uri = `${pathToFileURL(resolvedPath).href}?immutable=1`;
  return new DatabaseSync(uri, { readOnly: true });
}

export function projectFromDirectory(dir: string | undefined): ProjectRef | undefined {
  if (!dir || !ABSOLUTE_PATH.test(dir) || dir.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(dir))
    return undefined;
  const name =
    dir
      .split(/[\\/]+/u)
      .filter(Boolean)
      .at(-1) ?? dir;
  const key = `local:${createHash("sha256").update(dir).digest("hex").slice(0, 32)}`;
  return { key, name: name.slice(0, 200), path: dir };
}

/** Locates and authorizes `opencode.db` inside OpenCode's platform data root(s). */
export async function locateOpenCodeDb(
  deps: HostPaths,
  signal: AbortSignal,
): Promise<{ dbPath: string; resolved: string; roots: string[] } | undefined> {
  if (!supportsLocalSources(deps.platform)) return undefined;
  const api = pathApi(deps.platform);
  const roots = opencodeDataRoots(deps.platform, deps.userHome, deps.env);
  for (const root of roots) {
    signal.throwIfAborted();
    const candidate = api.join(root, "opencode.db");
    try {
      const { resolved } = await authorizeRootedFile(deps, "opencode", [root], candidate, signal, {
        allowAiRoot: false,
      });
      return { dbPath: candidate, resolved, roots: [root] };
    } catch {
      // Try next candidate data root (e.g. LOCALAPPDATA on Windows).
    }
  }
  return undefined;
}

/** Lists top-level, non-archived OpenCode sessions reading only the `session` table. */
export async function listOpenCodeSessions(
  deps: HostPaths,
  signal: AbortSignal,
): Promise<OpenCodeSessionMeta[]> {
  const located = await locateOpenCodeDb(deps, signal);
  if (!located) return [];
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnlySqlite(located.resolved);
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session'")
      .get();
    if (!hasTable) return [];
    const rows = db
      .prepare(
        `SELECT id, title, directory, time_created, time_updated
         FROM session
         WHERE (parent_id IS NULL OR parent_id = '')
           AND (time_archived IS NULL OR time_archived = 0)
         ORDER BY time_updated DESC
         LIMIT ?`,
      )
      .all(MAX_SESSIONS_LIST);
    const now = Date.now();
    const results: OpenCodeSessionMeta[] = [];
    for (const row of rows) {
      signal.throwIfAborted();
      const id = typeof row.id === "string" ? row.id : "";
      if (!SESSION_ID_RE.test(id)) continue;
      const title =
        typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 200) : "";
      const directory =
        typeof row.directory === "string" && row.directory.trim()
          ? row.directory.trim()
          : undefined;
      const createdAt = normalizeTimestamp(row.time_created);
      const updatedAt = normalizeTimestamp(row.time_updated) ?? createdAt;
      const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
      const inProgress = Number.isFinite(updatedMs) && now - updatedMs < IN_PROGRESS_MS;
      results.push({
        id,
        title: title || "OpenCode",
        ...(directory ? { directory } : {}),
        createdAt,
        updatedAt,
        inProgress,
      });
    }
    return results;
  } catch {
    // Unreadable or non-OpenCode SQLite file degrades to an empty list rather than crashing listing.
    return [];
  } finally {
    db?.close();
  }
}

function formatPartText(rawJson: unknown): string | undefined {
  if (typeof rawJson !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  const part = partDataSchema.safeParse(parsed);
  if (!part.success) return undefined;
  const { type, text, tool, state } = part.data;
  if (type === "text") return text?.trim() ? text : undefined;
  if (type === "tool") {
    const name = (tool ?? "tool").replace(/\s+/gu, " ").trim().slice(0, 80);
    const title = (state?.title ?? "").replace(/\s+/gu, " ").trim().slice(0, 240);
    return title ? `[tool] ${name}: ${title}` : `[tool] ${name}`;
  }
  // Reasoning, patch, step-start, step-finish and unknown part kinds are intentionally skipped.
  return undefined;
}

/** Reads selected OpenCode sessions from an already-authorized read-only immutable DB path. */
export function* readOpenCodeDb(
  resolvedDbPath: string,
  sessionIds: readonly string[] | undefined,
  signal: AbortSignal,
): Generator<ImportRecord> {
  let db: DatabaseSync | undefined;
  try {
    db = openReadOnlySqlite(resolvedDbPath);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session','message','part')",
      )
      .all()
      .map((row) => String(row.name));
    if (!tables.includes("session") || !tables.includes("message") || !tables.includes("part")) {
      throw new ImportFailure("format");
    }
    const selectOneSession = db.prepare(
      `SELECT id, title, directory, time_created, time_updated
       FROM session
       WHERE id = ?
         AND (parent_id IS NULL OR parent_id = '')
         AND (time_archived IS NULL OR time_archived = 0)`,
    );
    const sessions = sessionIds
      ? sessionIds.flatMap((id) => {
          if (!SESSION_ID_RE.test(id)) throw new ImportFailure("format");
          const row = selectOneSession.get(id);
          return row ? [row] : [];
        })
      : db
          .prepare(
            `SELECT id, title, directory, time_created, time_updated
             FROM session
             WHERE (parent_id IS NULL OR parent_id = '')
               AND (time_archived IS NULL OR time_archived = 0)
             ORDER BY time_updated DESC
             LIMIT 200`,
          )
          .all();

    const selectMessages = db.prepare(
      `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC LIMIT ?`,
    );
    const selectParts = db.prepare(
      `SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC`,
    );

    const now = Date.now();
    for (const session of sessions) {
      signal.throwIfAborted();
      const sessionId = String(session.id);
      const updatedIso = normalizeTimestamp(session.time_updated);
      const updatedMs = updatedIso ? Date.parse(updatedIso) : Number.NaN;
      if (sessionIds && Number.isFinite(updatedMs) && now - updatedMs < IN_PROGRESS_MS) {
        throw new ImportFailure("source_in_use");
      }
      const partsByMessage = new Map<string, string[]>();
      for (const partRow of selectParts.all(sessionId)) {
        signal.throwIfAborted();
        const messageId = typeof partRow.message_id === "string" ? partRow.message_id : "";
        if (!messageId) continue;
        const formatted = formatPartText(partRow.data);
        if (!formatted) continue;
        const list = partsByMessage.get(messageId) ?? [];
        list.push(formatted);
        partsByMessage.set(messageId, list);
      }

      const records: Extract<ImportRecord, { kind: "message" }>[] = [];
      let earliest: string | undefined;
      let latest: string | undefined;
      for (const msgRow of selectMessages.all(sessionId, MAX_MESSAGES_PER_SESSION)) {
        signal.throwIfAborted();
        if (typeof msgRow.data !== "string") continue;
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(msgRow.data);
        } catch {
          continue;
        }
        const parsed = messageDataSchema.safeParse(parsedJson);
        if (!parsed.success || !parsed.data.role) continue;
        const messageId = typeof msgRow.id === "string" ? msgRow.id : "";
        const pieces = partsByMessage.get(messageId);
        if (!pieces?.length) continue;
        const text = pieces.join("\n\n").trim();
        if (!text) continue;
        if (text.length > LONG_MESSAGE_CHARS) throw new ImportFailure("limit");
        const createdAt =
          normalizeTimestamp(msgRow.time_created) ??
          normalizeTimestamp(parsed.data.time?.created) ??
          normalizeTimestamp(session.time_created) ??
          updatedIso;
        if (!createdAt) continue;
        if (!earliest || createdAt < earliest) earliest = createdAt;
        if (!latest || createdAt > latest) latest = createdAt;
        records.push({ kind: "message", role: parsed.data.role, text, createdAt });
      }
      if (!records.length) continue;
      const createdAt =
        normalizeTimestamp(session.time_created) ?? earliest ?? new Date().toISOString();
      const updatedAtRaw = updatedIso ?? latest ?? createdAt;
      const updatedAt = updatedAtRaw < createdAt ? createdAt : updatedAtRaw;
      const title =
        typeof session.title === "string" && session.title.trim()
          ? session.title.trim().slice(0, 200)
          : "OpenCode";
      const project = projectFromDirectory(
        typeof session.directory === "string" ? session.directory : undefined,
      );
      yield {
        kind: "topic",
        title,
        createdAt: earliest && earliest < createdAt ? earliest : createdAt,
        updatedAt: latest && latest > updatedAt ? latest : updatedAt,
        ...(project ? { project } : {}),
      };
      for (const message of records) yield message;
    }
  } catch (error) {
    if (error instanceof ImportFailure) throw error;
    if (signal.aborted) throw error;
    throw new ImportFailure("format");
  } finally {
    db?.close();
  }
}

/** Single-file adapter when a user explicitly picks `opencode.db` from the file picker. */
export const opencodeAdapter: ImportAdapter = {
  async *detect(signal) {
    signal.throwIfAborted();
    yield true;
  },
  async *preview(input, signal) {
    if (!input.sourcePath) throw new ImportFailure("format");
    let hasAny = false;
    for (const record of readOpenCodeDb(input.sourcePath, undefined, signal)) {
      hasAny = true;
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
    if (!hasAny) throw new ImportFailure("format");
  },
  async *read(input, signal) {
    if (!input.sourcePath) throw new ImportFailure("format");
    for (const record of readOpenCodeDb(input.sourcePath, undefined, signal)) {
      yield record;
    }
  },
};
