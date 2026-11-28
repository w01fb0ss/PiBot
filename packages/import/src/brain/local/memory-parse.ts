// Parses Codex and Claude Code markdown memory stores into reviewable memory supplements.
import { readdir, readFile } from "node:fs/promises";
import type { Supplement } from "../exports/supplement.ts";
import { authorizeRootedFile, type HostPaths } from "../source.ts";
import { configRootFor, pathApi, supportsLocalSources } from "./locations.ts";

const MAX_MEMORY_FILE_BYTES = 256 * 1024;
const MAX_MEMORY_FILES = 64;
const MAX_MEMORY_ITEMS = 200;

const CODEX_TOP_FILES = ["MEMORY.md", "memory_summary.md", "raw_memories.md"] as const;

const METHOD_HEADING =
  /\b(workflow|workflows|method|methods|convention|conventions|coding|code style|style|tooling|tools|commands|testing|tests|git|repo|repository|project|projects|debugging|debug|process|rules|guidelines|architecture|build|deploy|feedback|reference)\b|工作方式|做事方法|开发规范|代码风格|项目|工具|命令|测试|流程|规则/iu;

const PREF_HEADING =
  /\b(preference|preferences|personal|about|user|profile|identity|language|habit|habits|communication|tone|background|role)\b|关于你|个人|偏好|习惯|语言|沟通|背景/iu;

type Frontmatter = { type?: string; name?: string; description?: string; body: string };

/** Splits optional YAML frontmatter (`--- ... ---`) from a Claude Code memory markdown file. */
export function parseFrontmatter(raw: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(raw);
  if (!match) return { body: raw };
  const header = match[1] ?? "";
  const body = match[2] ?? "";
  const field = (name: string) => {
    const line = new RegExp(`^${name}\\s*:\\s*(.+)$`, "imu").exec(header)?.[1]?.trim();
    return line?.replace(/^['"]|['"]$/gu, "").trim() || undefined;
  };
  return {
    type: field("type")?.toLowerCase(),
    name: field("name"),
    description: field("description"),
    body,
  };
}

/** Splits one markdown memory file into individual reviewable memory candidates. */
export function parseMemoryMarkdown(
  raw: string,
  defaultKind: "preference" | "method",
): Array<{ text: string; memoryKind: "preference" | "method" }> {
  const { type, name, description, body } = parseFrontmatter(raw);
  let baseKind: "preference" | "method" = defaultKind;
  if (type === "user") baseKind = "preference";
  else if (type === "feedback" || type === "project" || type === "reference") baseKind = "method";

  const results: Array<{ text: string; memoryKind: "preference" | "method" }> = [];
  let sectionKind: "preference" | "method" = baseKind;
  let inCodeBlock = false;
  for (const rawLine of body.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || !trimmed) continue;
    const heading = /^#{1,6}\s+(.+)$/u.exec(trimmed);
    if (heading) {
      const title = heading[1] ?? "";
      if (PREF_HEADING.test(title)) sectionKind = "preference";
      else if (METHOD_HEADING.test(title)) sectionKind = "method";
      else sectionKind = baseKind;
      continue;
    }
    // Skip markdown index link lines like `- [foo.md](foo.md) — description` or `[foo.md](foo.md) — desc`.
    if (
      /^(?:(?:[-*•]|\d+[.)])\s+)?\[[^\]]+\]\([^)]+\.md(?:#[^)]*)?\)(?:\s*[-–—:：].*|\s+.*)?$/iu.test(
        trimmed,
      )
    )
      continue;
    const cleaned = trimmed
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, "")
      .replace(/^\*\*(.+?)\*\*$/u, "$1")
      .trim();
    if (!cleaned || cleaned.length < 3 || /^---+$/.test(cleaned)) continue;
    results.push({ text: cleaned, memoryKind: sectionKind });
    if (results.length >= MAX_MEMORY_ITEMS) break;
  }

  // If a frontmatter note had a short description and no body lines, keep the description itself.
  if (!results.length && (description || name)) {
    const summary = [name, description].filter(Boolean).join(": ").trim();
    if (summary) results.push({ text: summary, memoryKind: baseKind });
  }
  return results;
}

async function readBoundedMarkdown(
  deps: HostPaths,
  source: "codex" | "claude-code",
  allowedRoots: readonly string[],
  filePath: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const { selected, resolved } = await authorizeRootedFile(
      deps,
      source,
      allowedRoots,
      filePath,
      signal,
    );
    if (selected.size === 0n || selected.size > BigInt(MAX_MEMORY_FILE_BYTES)) return undefined;
    const text = await readFile(resolved, { encoding: "utf8", signal });
    if (!text.trim() || text.includes("\0")) return undefined;
    return text;
  } catch {
    // Missing, protected, or unreadable individual memory file is skipped; remaining files still load.
    return undefined;
  }
}

async function codexMemoryFiles(deps: HostPaths, signal: AbortSignal): Promise<string[]> {
  if (!supportsLocalSources(deps.platform)) return [];
  const api = pathApi(deps.platform);
  const root = configRootFor("codex", deps.platform, deps.userHome, deps.env);
  const memDir = api.join(root, "memories");
  const files: string[] = [];
  for (const name of CODEX_TOP_FILES) {
    const filePath = api.join(memDir, name);
    const ok = await authorizeRootedFile(deps, "codex", [memDir], filePath, signal).then(
      () => true,
      () => false,
    );
    if (ok) files.push(filePath);
  }
  const rolloutDir = api.join(memDir, "rollout_summaries");
  const entries = await readdir(rolloutDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    signal.throwIfAborted();
    if (files.length >= MAX_MEMORY_FILES) break;
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const filePath = api.join(rolloutDir, entry.name);
    const ok = await authorizeRootedFile(deps, "codex", [memDir], filePath, signal).then(
      () => true,
      () => false,
    );
    if (ok) files.push(filePath);
  }
  return files;
}

async function claudeMemoryFiles(deps: HostPaths, signal: AbortSignal): Promise<string[]> {
  if (!supportsLocalSources(deps.platform)) return [];
  const api = pathApi(deps.platform);
  const root = configRootFor("claude-code", deps.platform, deps.userHome, deps.env);
  const projectsDir = api.join(root, "projects");
  const projectDirs = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const dir of projectDirs) {
    signal.throwIfAborted();
    if (files.length >= MAX_MEMORY_FILES) break;
    if (!dir.isDirectory()) continue;
    const memDir = api.join(projectsDir, dir.name, "memory");
    const entries = await readdir(memDir, { withFileTypes: true }).catch(() => []);
    const dirFiles: Array<{ name: string; path: string }> = [];
    for (const entry of entries) {
      signal.throwIfAborted();
      // Allow +1 slot before filtering MEMORY.md so skipping the index never drops a sibling at the cap.
      if (files.length + dirFiles.length >= MAX_MEMORY_FILES + 1) break;
      if (!entry.isFile() || !/^[\w.-][\w.-]*\.md$/i.test(entry.name)) continue;
      const filePath = api.join(memDir, entry.name);
      const ok = await authorizeRootedFile(deps, "claude-code", [projectsDir], filePath, signal)
        .then(() => true)
        .catch(() => false);
      if (ok) dirFiles.push({ name: entry.name, path: filePath });
    }
    const hasSiblings = dirFiles.some((file) => file.name.toLowerCase() !== "memory.md");
    for (const file of dirFiles) {
      if (files.length >= MAX_MEMORY_FILES) break;
      // Skip the pure index file if sibling memory files exist; keep it when standalone.
      if (hasSiblings && file.name.toLowerCase() === "memory.md") continue;
      files.push(file.path);
    }
  }
  return files;
}

export async function hasLocalMemory(
  deps: HostPaths,
  source: "codex" | "claude-code",
  signal: AbortSignal,
): Promise<boolean> {
  const files =
    source === "codex"
      ? await codexMemoryFiles(deps, signal)
      : await claudeMemoryFiles(deps, signal);
  return files.length > 0;
}

export async function readLocalMemories(
  deps: HostPaths,
  source: "codex" | "claude-code",
  signal: AbortSignal,
): Promise<Supplement[]> {
  if (!supportsLocalSources(deps.platform)) return [];
  const api = pathApi(deps.platform);
  const root = configRootFor(source, deps.platform, deps.userHome, deps.env);
  const allowedRoots =
    source === "codex" ? [api.join(root, "memories")] : [api.join(root, "projects")];
  const files =
    source === "codex"
      ? await codexMemoryFiles(deps, signal)
      : await claudeMemoryFiles(deps, signal);
  const supplements: Supplement[] = [];
  for (const filePath of files) {
    signal.throwIfAborted();
    if (supplements.length >= MAX_MEMORY_ITEMS) break;
    const text = await readBoundedMarkdown(deps, source, allowedRoots, filePath, signal);
    if (!text) continue;
    const isRollout =
      source === "codex" &&
      api.basename(api.dirname(filePath)).toLowerCase() === "rollout_summaries";
    const defaultKind = source === "codex" && !isRollout ? "preference" : "method";
    for (const item of parseMemoryMarkdown(text, defaultKind)) {
      if (supplements.length >= MAX_MEMORY_ITEMS) break;
      supplements.push({ kind: "memories", text: item.text, memoryKind: item.memoryKind });
    }
  }
  return supplements;
}
