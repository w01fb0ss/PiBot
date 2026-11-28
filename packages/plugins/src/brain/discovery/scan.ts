import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PortablePiBotApplicationSchema } from "@pibot/plugin-sdk";
import {
  type DiscoveredItemKind,
  type DiscoverySourceId,
  implicitPluginConfigKeys,
  isExcludedPluginEntry,
  normalizePluginConfigField,
  PLUGIN_CONFIG_MAX_BYTES,
  requiresPluginSetup,
} from "@pibot/plugins-contract/full";
import { importWorkingDirectory } from "../import-working-directory.ts";
import { packageManagerDomains } from "../service/connector-import.ts";
import { codexMcpServers, parseJsonc, skillFrontMatter } from "./formats.ts";
import type { McpFormat, SourceLayout } from "./locations.ts";
import {
  entryDescription,
  entrySecrets,
  fromCodexEntry,
  fromMcpServersEntry,
  fromOpenCodeEntry,
  type McpEntry,
} from "./mcp.ts";

/** `.claude.json` also keeps project history and grows large; other configs are small. */
const MAX_CONFIG_BYTES = { "claude-json": 16 * 1024 * 1024, other: 1024 * 1024 } as const;
/** Only the front matter is used; a SKILL.md beyond this is read no further. */
const SKILL_HEAD_BYTES = 64 * 1024;
const PLUGIN_MANIFEST_BYTES = 256 * 1024;
const MAX_ITEMS_PER_SOURCE = 500;
const MAX_DIR_ENTRIES = 400;
const MAX_SKILL_DIRS_OPENED = 200;

export type Locator =
  | { kind: "skill"; source: DiscoverySourceId; folder: string }
  | {
      kind: "mcp";
      source: DiscoverySourceId;
      file: string;
      format: McpFormat;
      scope: string | null;
      entry: string;
    }
  | { kind: "plugin"; source: DiscoverySourceId; folder: string };

export interface ScannedItem {
  key: string;
  kind: DiscoveredItemKind;
  name: string;
  description: string;
  secrets: { name: string; kind: "stored" | "needed" }[];
  contains?: { mcp: boolean; skills: boolean };
  needsSetup?: boolean;
  workingDirectory?: string;
  registrySites?: readonly string[];
  locator: Locator;
  /**
   * Fingerprint of what was read (kept in memory only): bringing it over re-reads and refuses
   * with `changed` when the file no longer says what the person was shown.
   */
  digest: string;
}
export interface ScannedSource {
  layout: SourceLayout;
  installed: boolean;
  items: ScannedItem[];
}
/** Skips are logged by file label and reason only; never a value or the file's content. */
export type SkipLog = (source: DiscoverySourceId, label: string, reason: string) => void;

export function itemKey(locator: Locator) {
  const identity =
    locator.kind === "mcp" ? [locator.file, locator.scope ?? "", locator.entry] : [locator.folder];
  return `${locator.source}:${locator.kind}:${createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 24)}`;
}

export const digestOf = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

const missing = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  ["ENOENT", "ENOTDIR"].includes(String(error.code));

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Reads at most `max` bytes; `whole` refuses a longer file instead of cutting it. */
export async function readBounded(path: string, max: number, whole: boolean, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("discovery_not_file");
    if (whole && info.size > max) throw new Error("discovery_too_large");
    const buffer = Buffer.alloc(Math.min(info.size, max));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

async function children(path: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  try {
    return (await readdir(path)).filter((name) => !name.startsWith(".")).slice(0, MAX_DIR_ENTRIES);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/**
 * Skill folders under one root. A folder without SKILL.md is opened up to two levels down: pi
 * groups skills one level deeper (`<group>/<skill>`), and Claude Code keeps the skills it syncs
 * from claude.ai two levels deeper (`synced/<account bucket>/<skill>`). A folder with SKILL.md is
 * a skill and is never entered, so a package's own sub-folders are not mistaken for skills.
 */
async function skillFolders(root: string, signal: AbortSignal): Promise<string[]> {
  const found: string[] = [];
  // Bounds the walk of a root that is not a skills folder at all (a cloned repository).
  let opened = 0;
  const visit = async (folder: string, depth: number) => {
    if (++opened > MAX_SKILL_DIRS_OPENED) return;
    for (const name of await children(folder, signal)) {
      const path = join(folder, name);
      if (!(await isDirectory(path))) continue;
      if (await exists(join(path, "SKILL.md"))) found.push(path);
      else if (depth < 2) await visit(path, depth + 1);
    }
  };
  await visit(root, 0);
  return found;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface McpFileEntry {
  scope: string | null;
  name: string;
  entry: McpEntry | undefined;
  /** Turned off in the tool itself (enabled = false / disabled = true): skipped on purpose. */
  disabled?: boolean;
}

/** Every server one config file declares, in file order; an entry Pi Bot cannot read is undefined. */
export async function readMcpFile(
  source: DiscoverySourceId,
  path: string,
  format: McpFormat,
  signal: AbortSignal,
): Promise<McpFileEntry[] | undefined> {
  let text: string;
  try {
    text = await readBounded(
      path,
      MAX_CONFIG_BYTES[format === "claude-json" ? "claude-json" : "other"],
      true,
      signal,
    );
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  text = text.replace(/^\uFEFF/u, "");
  const off = (raw: unknown) =>
    !!raw &&
    typeof raw === "object" &&
    ((raw as { enabled?: unknown }).enabled === false ||
      (raw as { disabled?: unknown }).disabled === true);
  const convert = (name: string, raw: unknown) => {
    try {
      if (format === "codex-toml") return fromCodexEntry(name, raw);
      if (format === "opencode") return fromOpenCodeEntry(name, raw);
      return fromMcpServersEntry(source, name, raw);
    } catch {
      return undefined;
    }
  };
  if (format === "codex-toml")
    return Object.entries(codexMcpServers(text)).map(([name, raw]) => ({
      scope: null,
      name,
      entry: raw === undefined ? undefined : convert(name, raw),
      ...(off(raw) ? { disabled: true } : {}),
    }));
  // Claude Code writes plain JSON; the others are hand-edited and may carry comments.
  const root = record(format === "claude-json" ? JSON.parse(text) : parseJsonc(text));
  if (!root) throw new Error("discovery_format_unsupported");
  const out: McpFileEntry[] = [];
  const servers = format === "opencode" ? record(root.mcp) : record(root.mcpServers);
  for (const [name, raw] of Object.entries(servers ?? {}))
    out.push({
      scope: null,
      name,
      entry: convert(name, raw),
      ...(off(raw) ? { disabled: true } : {}),
    });
  // Claude Code's "local" scope: servers a person added for one project, kept in the same file.
  if (format === "claude-json")
    for (const [project, value] of Object.entries(record(root.projects) ?? {}))
      for (const [name, raw] of Object.entries(record(record(value)?.mcpServers) ?? {}))
        out.push({
          scope: project,
          name,
          entry: convert(name, raw),
          ...(off(raw) ? { disabled: true } : {}),
        });
  return out;
}

/** Plugin folders a tool installed: Claude Code's install record, or Codex's plugin cache. */
async function pluginFolders(
  plugins: NonNullable<SourceLayout["plugins"]>,
  signal: AbortSignal,
): Promise<string[]> {
  if (plugins.kind === "claude-installed") {
    let text: string;
    try {
      text = await readBounded(plugins.file, MAX_CONFIG_BYTES.other, true, signal);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const root = record(JSON.parse(text));
    const out = new Set<string>();
    // One row per plugin@marketplace: Claude Code can install the same plugin both for the user
    // and inside a project; the user-wide install is the one to bring over.
    for (const value of Object.values(record(root?.plugins) ?? {})) {
      const installs = (Array.isArray(value) ? value : [value])
        .map((install) => record(install))
        .filter((install) => typeof install?.installPath === "string" && install.installPath);
      const chosen = installs.find((install) => install?.scope === "user") ?? installs[0];
      if (chosen) out.add(String(chosen.installPath));
    }
    return [...out];
  }
  if (plugins.kind === "codex") {
    const out: string[] = [];
    for (const entry of await children(plugins.root, signal)) {
      const folder = join(plugins.root, entry);
      if (!(await isDirectory(folder))) continue;
      // Local Codex bundles use <plugins>/<name>/.codex-plugin/plugin.json.
      if (await exists(join(folder, ".codex-plugin", "plugin.json"))) out.push(folder);
      // Installed marketplace bundles retain the nested cache shape.
      else
        for (const market of await children(folder, signal))
          for (const plugin of await children(join(folder, market), signal))
            for (const version of await children(join(folder, market, plugin), signal))
              out.push(join(folder, market, plugin, version));
    }
    return out;
  }
  // cache/<marketplace>/<plugin>/<version>/
  const out: string[] = [];
  for (const market of await children(plugins.root, signal))
    for (const plugin of await children(join(plugins.root, market), signal))
      for (const version of await children(join(plugins.root, market, plugin), signal))
        out.push(join(plugins.root, market, plugin, version));
  return out;
}

function insideDir(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Reads a bounded regular file strictly inside `realRoot` without following any symbolic links
 * along the path or at the leaf, matching the import host's containment checks.
 */
async function readPluginFileNoFollow(
  realRoot: string,
  filePath: string,
  max: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const resolvedPath = resolve(filePath);
  if (realRoot === resolvedPath || !insideDir(realRoot, resolvedPath)) return undefined;
  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    let ancestor = realRoot;
    for (const part of relative(realRoot, resolvedPath).split(sep).slice(0, -1)) {
      ancestor = join(ancestor, part);
      if (!(await lstat(ancestor)).isDirectory()) return undefined;
    }
    initial = await lstat(resolvedPath, { bigint: true });
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (!initial.isFile() || Number(initial.size) > max) return undefined;
  if (!insideDir(realRoot, await realpath(resolvedPath))) return undefined;
  const file = await open(
    resolvedPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat({ bigint: true });
    if (
      !info.isFile() ||
      Number(info.size) > max ||
      info.dev !== initial.dev ||
      info.ino !== initial.ino
    )
      return undefined;
    const buffer = Buffer.alloc(Number(info.size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const latest = await lstat(resolvedPath, { bigint: true });
    if (
      bytesRead !== buffer.length ||
      !insideDir(realRoot, await realpath(resolvedPath)) ||
      latest.dev !== info.dev ||
      latest.ino !== info.ino ||
      latest.size !== info.size ||
      latest.mtimeMs !== info.mtimeMs
    )
      return undefined;
    signal.throwIfAborted();
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

/** Uses the importer's setting rules without staging or reading the full plugin package. */
async function pluginNeedsSetup(
  realFolder: string,
  manifest: Record<string, unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  const fields = [];
  for (const [key, raw] of Object.entries(record(manifest.userConfig) ?? {})) {
    const field = record(raw);
    if (field) fields.push(normalizePluginConfigField(key, field));
  }
  if (requiresPluginSetup(fields)) return true;

  const readConfig = async (filePath: string) => {
    try {
      const text = await readPluginFileNoFollow(
        realFolder,
        filePath,
        PLUGIN_CONFIG_MAX_BYTES,
        signal,
      );
      if (text !== undefined) return record(JSON.parse(text.replace(/^\uFEFF/u, "")));
    } catch {
      signal.throwIfAborted();
      // The full import reports unreadable, unsafe or malformed files when opened.
    }
    return undefined;
  };
  const declared = new Set(fields.map((field) => field.key));
  const needsImplicitSetting = (servers: unknown) => {
    const source = record(servers);
    return !!source && implicitPluginConfigKeys(source, declared).size > 0;
  };
  const application = PortablePiBotApplicationSchema.safeParse(
    await readConfig(join(realFolder, "pibot.json")),
  );
  if (application.success) return needsImplicitSetting({ env: application.data.server.env });

  const rootMcpPath = join(realFolder, ".mcp.json");
  const rootMcp = await readConfig(rootMcpPath);
  if (needsImplicitSetting(rootMcp?.mcpServers ?? rootMcp)) return true;
  if (typeof manifest.mcpServers !== "string") return needsImplicitSetting(manifest.mcpServers);

  const declaredPath = manifest.mcpServers;
  if (isAbsolute(declaredPath) || declaredPath.includes("${")) return false;
  const resolved = resolve(realFolder, declaredPath);
  if (
    resolved === rootMcpPath ||
    !insideDir(realFolder, resolved) ||
    relative(realFolder, resolved)
      .split(sep)
      .some((part, index) => isExcludedPluginEntry(part, index === 0))
  )
    return false;
  const source = await readConfig(resolved);
  return needsImplicitSetting(source?.mcpServers ?? source);
}

/** The manifest text and its fields; the text is what the item's digest covers. */
export async function pluginManifest(folder: string, signal: AbortSignal) {
  for (const candidate of [
    join(folder, ".codex-plugin", "plugin.json"),
    join(folder, ".claude-plugin", "plugin.json"),
    join(folder, "plugin.json"),
  ])
    try {
      const text = await readBounded(candidate, PLUGIN_MANIFEST_BYTES, true, signal);
      const value = record(JSON.parse(text.replace(/^\uFEFF/u, "")));
      if (value) return { text, value };
    } catch (error) {
      if (!missing(error)) throw error;
    }
  return undefined;
}

/** What a skill item's digest covers: the SKILL.md head the scan read. */
export function skillHead(folder: string, signal: AbortSignal) {
  return readBounded(join(folder, "SKILL.md"), SKILL_HEAD_BYTES, false, signal);
}

/** The digest an item has now, re-read from its file; undefined when it is gone. */
export async function currentDigest(
  locator: Locator,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    if (locator.kind === "skill") return digestOf(await skillHead(locator.folder, signal));
    if (locator.kind === "plugin") {
      const manifest = await pluginManifest(locator.folder, signal);
      return manifest && digestOf(manifest.text);
    }
    const entries = await readMcpFile(locator.source, locator.file, locator.format, signal);
    const found = entries?.find(
      (candidate) => candidate.scope === locator.scope && candidate.name === locator.entry,
    );
    return found?.entry && digestOf(found.entry);
  } catch (error) {
    signal.throwIfAborted();
    if (missing(error)) return undefined;
    throw error;
  }
}

// Text that crosses to the renderer is bounded and stripped here, so one odd item can never fail
// the contract check of the whole result.
const clean = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[\p{Cc}]/gu, " ")
        .trim()
        .slice(0, max)
    : "";

/**
 * One read-only pass over one tool. Each file is read independently: a file that is missing is
 * simply absent, one that fails to read or parse is skipped (logged by label) and the rest go on.
 * `seen` holds real paths of skill folders already listed by an earlier tool.
 */
export async function scanSource(
  layout: SourceLayout,
  seen: Set<string>,
  signal: AbortSignal,
  skip: SkipLog,
  userHome: string,
): Promise<ScannedSource> {
  const installed = await isDirectory(layout.base);
  const items: ScannedItem[] = [];
  const push = (item: Omit<ScannedItem, "key">) => {
    if (items.length >= MAX_ITEMS_PER_SOURCE) return;
    const name = clean(item.name, 200);
    if (!name) return;
    items.push({
      ...item,
      name,
      description: clean(item.description, 1024),
      key: itemKey(item.locator),
    });
  };
  for (const root of layout.skillRoots) {
    let folders: string[];
    try {
      folders = await skillFolders(root, signal);
    } catch {
      signal.throwIfAborted();
      skip(layout.id, "skills", "unreadable");
      continue;
    }
    for (const folder of folders) {
      try {
        const real = await realpath(folder);
        if (seen.has(real)) continue;
        seen.add(real);
        const head = await skillHead(folder, signal);
        const meta = skillFrontMatter(head, basename(folder));
        push({
          kind: "skill",
          name: meta.name,
          description: meta.description,
          secrets: [],
          locator: { kind: "skill", source: layout.id, folder: real },
          digest: digestOf(head),
        });
      } catch {
        signal.throwIfAborted();
        skip(layout.id, "SKILL.md", "unreadable");
      }
    }
  }
  for (const file of layout.mcpFiles) {
    let entries: McpFileEntry[] | undefined;
    try {
      entries = await readMcpFile(layout.id, file.path, file.format, signal);
    } catch {
      signal.throwIfAborted();
      skip(layout.id, basename(file.path), "unreadable");
      continue;
    }
    // The same server added to several projects is one thing to bring over: the user-wide entry,
    // else the one for the home folder (what the tool uses outside any project), else the first.
    // Copies often differ (a key added in one project only), so file order alone picked a copy
    // the person does not use.
    const chosen = new Map<string, McpFileEntry & { entry: McpEntry }>();
    for (const candidate of entries ?? []) {
      const previous = chosen.get(candidate.name);
      if (previous && (previous.scope === null || previous.scope === file.homeScope)) continue;
      if (!candidate.entry) {
        // An entry the person turned off in the tool is not a reading failure.
        if (!previous)
          skip(
            layout.id,
            basename(file.path),
            candidate.disabled ? "mcp_entry_disabled" : "mcp_entry_unsupported",
          );
        continue;
      }
      if (!previous || candidate.scope === null || candidate.scope === file.homeScope)
        chosen.set(candidate.name, { ...candidate, entry: candidate.entry });
    }
    for (const { scope, name, entry } of chosen.values()) {
      const workingDirectory =
        entry.cwd === undefined ? undefined : importWorkingDirectory(entry.cwd, userHome);
      if (entry.cwd !== undefined && workingDirectory === undefined) {
        skip(layout.id, basename(file.path), "mcp_entry_unsupported");
        continue;
      }
      push({
        kind: "mcp",
        name,
        description: entryDescription(entry),
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(entry.transport === "stdio" && entry.command
          ? { registrySites: packageManagerDomains(entry.command) }
          : {}),
        secrets: entrySecrets(entry),
        locator: {
          kind: "mcp",
          source: layout.id,
          file: file.path,
          format: file.format,
          scope,
          entry: name,
        },
        digest: digestOf(entry),
      });
    }
  }
  if (layout.plugins) {
    let folders: string[] = [];
    try {
      folders = await pluginFolders(layout.plugins, signal);
    } catch {
      signal.throwIfAborted();
      skip(layout.id, "plugins", "unreadable");
    }
    for (const folder of folders) {
      try {
        if (!(await isDirectory(folder))) continue;
        const manifest = await pluginManifest(folder, signal);
        if (!manifest) continue;
        const real = await realpath(folder);
        // Claude Code plugins declare servers in .mcp.json or the manifest's mcpServers; the
        // import reads skills from skills/ only (declarative-loader.ts).
        const contains = {
          mcp: manifest.value.mcpServers !== undefined || (await exists(join(real, ".mcp.json"))),
          skills: await isDirectory(join(real, "skills")),
        };
        const needsSetup = await pluginNeedsSetup(real, manifest.value, signal);
        push({
          kind: "plugin",
          name: clean(manifest.value.name, 200) || basename(folder),
          description: clean(manifest.value.description, 1024),
          secrets: [],
          contains,
          ...(needsSetup ? { needsSetup: true } : {}),
          locator: { kind: "plugin", source: layout.id, folder: real },
          digest: digestOf(manifest.text),
        });
      } catch {
        signal.throwIfAborted();
        skip(layout.id, "plugin.json", "unreadable");
      }
    }
  }
  return { layout, installed, items };
}
