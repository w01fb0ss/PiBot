// Keeps desktop-selected imports within the documented local source layouts.
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { ImportSource, LocalImportSource } from "@pibot/import-contract";
import { containsPath, type Platform } from "@pibot/policy";
import { ImportFailure } from "../adapter.ts";

export type LocalSource = LocalImportSource;
export type LocalSelection = {
  kind: "history" | "projectNote";
  /** The specific agent root that authorized this selection. */
  configRoot?: string;
  /** The root in `aiConfigReadBoundary` to narrow only after containment inside `configRoot`. */
  aiRoot?: string;
};

export function isLocalSource(source: ImportSource): source is LocalSource {
  return (
    source === "claude-code" ||
    source === "codex" ||
    source === "cursor" ||
    source === "opencode" ||
    source === "antigravity"
  );
}

export function supportsLocalSources(platform: NodeJS.Platform): platform is Platform {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

export function pathApi(platform: Platform) {
  return platform === "win32" ? win32 : posix;
}

export function envVar(
  env: Readonly<NodeJS.ProcessEnv> | undefined,
  name: string,
  platform: Platform,
): string | undefined {
  if (!env) return undefined;
  if (platform === "win32") {
    const upper = name.toUpperCase();
    for (const [key, value] of Object.entries(env)) {
      if (key.toUpperCase() === upper && value?.trim()) return value.trim();
    }
    return undefined;
  }
  const value = env[name]?.trim();
  return value || undefined;
}

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const jsonl = /^([\da-f-]+)\.jsonl$/i;
const mdFile = /^[\w.-][\w.-]*\.md$/i;

function claudeSelection(
  parts: string[],
  configRoot: string,
  aiRoot: string | undefined,
): LocalSelection | undefined {
  if (parts[0] !== "projects" || !parts[1]) return;
  if (parts.length === 3 && uuid.test(jsonl.exec(parts[2] ?? "")?.[1] ?? ""))
    return { kind: "history", configRoot, ...(aiRoot ? { aiRoot } : {}) };
  if (parts.length === 4 && parts[2] === "memory" && mdFile.test(parts[3] ?? ""))
    return { kind: "projectNote", configRoot, ...(aiRoot ? { aiRoot } : {}) };
}

function codexSelection(
  parts: string[],
  configRoot: string,
  aiRoot: string | undefined,
): LocalSelection | undefined {
  if (
    parts.length === 5 &&
    parts[0] === "sessions" &&
    /^\d{4}$/.test(parts[1] ?? "") &&
    /^\d{2}$/.test(parts[2] ?? "") &&
    /^\d{2}$/.test(parts[3] ?? "") &&
    /^rollout-[\w-]+\.jsonl(?:\.zst)?$/i.test(parts[4] ?? "")
  )
    return { kind: "history", configRoot, ...(aiRoot ? { aiRoot } : {}) };
  if (
    parts.length === 2 &&
    parts[0] === "archived_sessions" &&
    /^[\w.-]+\.jsonl(?:\.zst)?$/i.test(parts[1] ?? "")
  )
    return { kind: "history", configRoot, ...(aiRoot ? { aiRoot } : {}) };
}

function cursorTranscript(parts: string[]) {
  if (parts[0] !== "projects" || !parts[1] || parts[2] !== "agent-transcripts") return false;
  const id = jsonl.exec(parts.at(-1) ?? "")?.[1];
  return !!id && uuid.test(id) && (parts.length === 4 || (parts.length === 5 && parts[3] === id));
}

/** Primary local data/config root for a local agent, honouring injected environment overrides. */
export function configRootFor(
  source: LocalSource,
  platform: Platform,
  home: string,
  env?: Readonly<NodeJS.ProcessEnv>,
) {
  const api = pathApi(platform);
  if (source === "codex") {
    const custom = envVar(env, "CODEX_HOME", platform);
    if (custom && api.isAbsolute(custom)) return api.normalize(custom);
    return api.join(home, ".codex");
  }
  if (source === "claude-code") {
    const custom = envVar(env, "CLAUDE_CONFIG_DIR", platform);
    if (custom && api.isAbsolute(custom)) return api.normalize(custom);
    return api.join(home, ".claude");
  }
  if (source === "cursor") return api.join(home, ".cursor");
  if (source === "antigravity") return api.join(home, ".gemini", "antigravity-cli");
  // OpenCode stores opencode.db under XDG_DATA_HOME/opencode or ~/.local/share/opencode.
  const xdgData = envVar(env, "XDG_DATA_HOME", platform);
  if (xdgData && api.isAbsolute(xdgData)) return api.join(api.normalize(xdgData), "opencode");
  return api.join(home, ".local", "share", "opencode");
}

/** Candidate data directories where OpenCode may store `opencode.db` on this platform. */
export function opencodeDataRoots(
  platform: Platform,
  home: string,
  env?: Readonly<NodeJS.ProcessEnv>,
): string[] {
  const api = pathApi(platform);
  const roots = [configRootFor("opencode", platform, home, env)];
  if (platform === "win32") {
    const localAppData = envVar(env, "LOCALAPPDATA", platform);
    if (localAppData && api.isAbsolute(localAppData)) {
      const candidate = api.join(api.normalize(localAppData), "opencode");
      if (!roots.includes(candidate)) roots.push(candidate);
    }
  }
  return roots;
}

/**
 * The entry in `sensitiveReadBoundary.aiConfigReadBoundary.roots` that corresponds to `source`.
 * Callers may exclude this root ONLY after verifying the file is strictly inside `configRootFor`.
 */
export function aiBoundaryRootFor(
  source: LocalSource,
  platform: Platform,
  home: string,
  env?: Readonly<NodeJS.ProcessEnv>,
): string | undefined {
  const api = pathApi(platform);
  if (source === "codex") return api.join(home, ".codex");
  if (source === "claude-code") return api.join(home, ".claude");
  if (source === "cursor") return api.join(home, ".cursor");
  // Antigravity lives under ~/.gemini/antigravity-cli while aiConfigReadBoundary lists ~/.gemini.
  if (source === "antigravity") return api.join(home, ".gemini");
  const xdg = envVar(env, "XDG_CONFIG_HOME", platform);
  if (platform !== "win32" && xdg && api.isAbsolute(xdg))
    return api.join(api.normalize(xdg), "opencode");
  return api.join(home, ".config", "opencode");
}

export function sameLocalPath(
  platform: Platform,
  home: string,
  canonicalHome: string,
  file: string,
  canonicalFile: string,
) {
  const api = pathApi(platform);
  const physical = containsPath(home, file, platform)
    ? api.join(canonicalHome, api.relative(home, file))
    : file;
  return api.relative(physical, canonicalFile) === "";
}

export function localSelection(
  source: LocalSource,
  platform: Platform,
  home: string,
  file: string,
  env?: Readonly<NodeJS.ProcessEnv>,
): LocalSelection {
  const api = pathApi(platform);
  const configRoot = configRootFor(source, platform, home, env);
  const aiRoot = aiBoundaryRootFor(source, platform, home, env);
  const parts = api.relative(configRoot, file).split(api.sep);
  if (source === "cursor" && /\.vscdb(?:-wal|-shm)?$/i.test(api.basename(file)))
    throw new ImportFailure("unsupported");
  if (source === "opencode") {
    for (const root of opencodeDataRoots(platform, home, env)) {
      if (containsPath(root, file, platform)) {
        const rel = api.relative(root, file).split(api.sep);
        if (rel.length === 1 && rel[0] === "opencode.db") {
          return { kind: "history", configRoot: root };
        }
        throw new ImportFailure("source_changed");
      }
    }
  } else if (containsPath(configRoot, file, platform)) {
    let selection: LocalSelection | undefined;
    if (source === "claude-code") selection = claudeSelection(parts, configRoot, aiRoot);
    if (source === "codex") selection = codexSelection(parts, configRoot, aiRoot);
    if (source === "cursor" && cursorTranscript(parts))
      selection = { kind: "history", configRoot, ...(aiRoot ? { aiRoot } : {}) };
    if (selection) return selection;
    throw new ImportFailure("source_changed");
  }

  const name = api.basename(file);
  const parent = api.dirname(file);
  const isProject = api.relative(home, parent) !== "" && api.parse(parent).root !== parent;
  if (source === "claude-code" && name === "CLAUDE.md" && isProject) return { kind: "projectNote" };
  if ((source === "codex" || source === "opencode") && name === "AGENTS.md" && isProject)
    return { kind: "projectNote" };
  if (source === "antigravity" && name === "GEMINI.md" && isProject) return { kind: "projectNote" };
  if (source === "cursor" && isProject && isCursorRule(api, file)) return { kind: "projectNote" };
  throw new ImportFailure("source_changed");
}

function isCursorRule(api: ReturnType<typeof pathApi>, file: string) {
  const name = api.basename(file);
  if (name === ".cursorrules") return true;
  if (!name.endsWith(".mdc")) return false;
  const parts = api.dirname(file).split(api.sep);
  return parts.some((part, index) => part === ".cursor" && parts[index + 1] === "rules");
}

/**
 * A selected CLAUDE.md / AGENTS.md / GEMINI.md / Cursor rule is one project: the folder it lives in
 * (above `.cursor`). A Claude Code memory note only names its encoded project folder, never a path.
 */
export function noteSummary(platform: NodeJS.Platform, file: string) {
  const api = pathApi(platform === "win32" ? "win32" : "darwin");
  const parts = api.dirname(file).split(api.sep);
  const cursor = parts.lastIndexOf(".cursor");
  const memory = parts.at(-1) === "memory" && parts.at(-3) === "projects";
  const folder = memory
    ? undefined
    : cursor > 0
      ? parts.slice(0, cursor).join(api.sep) || api.sep
      : api.dirname(file);
  const name = (folder ? api.basename(folder) : (parts.at(-2) ?? "").replace(/^-+/u, "")) || "";
  const key = `note:${createHash("sha256")
    .update(folder ?? file)
    .digest("hex")
    .slice(0, 32)}`;
  return {
    summary: {
      topics: 0,
      messages: 0,
      from: null,
      through: null,
      projectNotes: 1,
      projects: [{ key, name: name.slice(0, 200), topics: 0, messages: 0, knowledge: 1 }],
    },
    paths: new Map<string, string>(folder ? [[key, folder]] : []),
  };
}
