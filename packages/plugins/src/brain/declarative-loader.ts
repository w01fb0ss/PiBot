import type { Dirent } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childNodeRuntime, unpackedPath } from "@pibot/execution";
import {
  type PiBotPluginManifest,
  PiBotPluginManifestSchema,
  type PiBotServerPreset,
  type Plugin,
  type PluginSkill,
  PluginSkillIdSchema,
  parseClaudePluginManifest,
} from "@pibot/plugin-sdk";
import { type ConnectorServer, ConnectorServerSchema } from "@pibot/plugins-contract/full";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PLUGIN_FILES = 500;

export interface DeclarativePluginFiles {
  pluginJson: unknown;
  pibotJson?: unknown;
  skills: readonly {
    id: string;
    locale: "zh" | "en";
    skillMd: string;
    files?: readonly { path: string; content: string | Uint8Array }[];
  }[];
}

function fixedServicePath(
  name: Extract<PiBotServerPreset, { transport: "stdio" }>["fixedService"],
) {
  const current = new URL(import.meta.url);
  const entry = current.pathname.endsWith(".ts")
    ? new URL(`../../../../apps/plugins/${name}/server/index.ts`, current)
    : new URL(`./plugin-${name}-server.js`, current);
  return fileURLToPath(entry);
}

function serverFromPreset(preset: PiBotServerPreset, credentialName?: string): ConnectorServer {
  const secretNames = credentialName ? [credentialName] : [];
  const credential = preset.auth.credential;
  const value = credentialName ? `${credential?.prefix ?? ""}\${secret:${credentialName}}` : "";
  if (preset.transport === "http") {
    const headers = { ...preset.headers };
    if (credential?.target === "header" && value) headers[credential.name] = value;
    return ConnectorServerSchema.parse({
      id: preset.id,
      transport: "http",
      url: preset.url,
      ...(preset.sseFallback === true ? { sseFallback: true } : {}),
      headers,
      auth: { kind: preset.auth.kind, secretNames },
      networkDomains: preset.networkDomains,
    });
  }
  const env: Record<string, string> = { ...preset.env };
  if (credential?.target === "env" && value) env[credential.name] = value;
  return ConnectorServerSchema.parse({
    id: preset.id,
    transport: "stdio",
    // The separately signed helper Node, never Pi Bot's own executable.
    command: childNodeRuntime().executable,
    args: [unpackedPath(fixedServicePath(preset.fixedService))],
    env,
    auth: { kind: preset.auth.kind, secretNames },
    networkDomains: preset.networkDomains,
  });
}

function draftBinding(
  rules: NonNullable<PiBotPluginManifest["mcp"]>["draftBindings"],
  tool: string,
  schema: unknown,
  args?: Record<string, unknown>,
) {
  const rule = rules.find((candidate) => candidate.tool === tool);
  if (!rule) return undefined;
  for (const name of rule.when?.string ?? [])
    if (typeof args?.[name] !== "string") return undefined;
  for (const name of rule.when?.absent ?? []) if (args?.[name] !== undefined) return undefined;
  if (Object.keys(rule.when?.schemaTypes ?? {}).length) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
    const properties = (schema as { properties?: unknown }).properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties))
      return undefined;
    for (const [name, types] of Object.entries(rule.when?.schemaTypes ?? {})) {
      const field = (properties as Record<string, unknown>)[name];
      const type =
        field && typeof field === "object" && !Array.isArray(field)
          ? (field as { type?: unknown }).type
          : undefined;
      if (!types.includes(type as never)) return undefined;
    }
  }
  return rule.binding;
}

/** Shared boundary parser. Imported plugins call it without pibotJson, so trusted fields cannot enter. */
export function parseDeclarativePlugin(input: DeclarativePluginFiles): Plugin {
  const claude = parseClaudePluginManifest(input.pluginJson);
  if (!input.pibotJson) throw new TypeError("Pi Bot metadata is required for builtin plugins");
  const manifest = PiBotPluginManifestSchema.parse(input.pibotJson);
  if (claude.name && claude.name !== manifest.id)
    throw new TypeError("Plugin manifest names differ");
  const bySkill = new Map<string, Partial<Record<"zh" | "en", PluginSkill["locales"]["zh"]>>>();
  for (const skill of input.skills) {
    const skillId = PluginSkillIdSchema.parse(skill.id);
    const locales = bySkill.get(skillId) ?? {};
    if (locales[skill.locale]) throw new TypeError("Duplicate localized plugin skill");
    locales[skill.locale] = {
      skillMd: skill.skillMd,
      ...(skill.files ? { files: skill.files } : {}),
    };
    bySkill.set(skillId, locales);
  }
  const skills = [...bySkill].map(([id, locales]) => {
    if (!locales.zh || !locales.en) throw new TypeError(`Missing localized plugin skill: ${id}`);
    return { id, locales: { zh: locales.zh, en: locales.en } };
  });
  const mcp = manifest.mcp;
  const trustedStdio = mcp?.trusted?.stdio;
  const disabledPatterns = (mcp?.disabledToolPatterns ?? []).map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch {
      throw new TypeError("Invalid disabled tool pattern");
    }
  });
  return {
    id: manifest.id,
    version: claude.version ?? "0.0.0",
    card(platform) {
      const { platforms: _platforms, ...publicCard } = manifest.card;
      const supported =
        !manifest.card.platforms || manifest.card.platforms.includes(platform as never);
      return {
        ...publicCard,
        id: manifest.id,
        supported,
        unsupportedReason: supported
          ? null
          : (manifest.card.unsupportedReason ?? "unsupported_platform"),
      };
    },
    ...(mcp
      ? {
          mcp: {
            server: ({ mode, credentialName }) => {
              const preset = mcp.presets[mode];
              if (!preset) throw new TypeError("Unsupported application mode");
              return serverFromPreset(preset, credentialName);
            },
            requiresToken: (mode) => mcp.requiresToken.includes(mode),
            authorizeOnEnable: mcp.authorizeOnEnable,
            trustedReads: new Set(mcp.readOnlyTools),
            ...(mcp.toolDescriptions ? { toolDescriptions: mcp.toolDescriptions } : {}),
            defaultEnabled: (tool) =>
              !mcp.disabledTools.includes(tool) &&
              !disabledPatterns.some((pattern) => pattern.test(tool)),
            draftBinding: (tool, schema, args) =>
              draftBinding(mcp.draftBindings, tool, schema, args),
            ...(mcp.oauthStartTool ? { oauthStartTool: mcp.oauthStartTool } : {}),
            ...(mcp.capability
              ? {
                  capability: {
                    id: mcp.capability.id,
                    tools: mcp.capability.tools,
                    readOnlyTools: new Set(mcp.capability.readOnlyTools),
                  },
                }
              : {}),
            ...(trustedStdio
              ? {
                  trustedStdio: { machLookup: trustedStdio.machLookup },
                  ...(trustedStdio.openTimeoutMs
                    ? { openTimeoutMs: trustedStdio.openTimeoutMs }
                    : {}),
                  legacyBuiltinMode: (server: ConnectorServer) =>
                    server.transport === "builtin" &&
                    server.builtinId === trustedStdio.legacyBuiltinId
                      ? (trustedStdio.legacyMode ?? Object.keys(mcp.presets)[0])
                      : undefined,
                }
              : {}),
          },
        }
      : {}),
    ...(skills.length ? { skills } : {}),
  };
}

async function readJson(path: string) {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new TypeError("Plugin file too large");
  return JSON.parse(text) as unknown;
}

async function pluginFiles(
  root: string,
  pibotManifest = "pibot.json",
): Promise<DeclarativePluginFiles> {
  const pluginJson = await readJson(join(root, ".claude-plugin", "plugin.json"));
  const pibotJson = await readJson(join(root, pibotManifest));
  const skills: DeclarativePluginFiles["skills"][number][] = [];
  const skillsRoot = join(root, "skills");
  let count = 2;
  let skillEntries: Dirent[];
  try {
    skillEntries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return { pluginJson, pibotJson, skills };
    throw error;
  }
  for (const skill of skillEntries) {
    if (!skill.isDirectory()) continue;
    for (const locale of ["zh", "en"] as const) {
      const localeRoot = join(skillsRoot, skill.name, locale);
      const path = join(localeRoot, "SKILL.md");
      let skillMd: string;
      try {
        skillMd = await readFile(path, "utf8");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          throw new TypeError(`Missing localized plugin skill: ${skill.name}/${locale}`);
        throw error;
      }
      if (Buffer.byteLength(skillMd) > MAX_FILE_BYTES)
        throw new TypeError("Plugin skill too large");
      const resources: { path: string; content: Uint8Array }[] = [];
      for (const entry of await readdir(localeRoot, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name === "SKILL.md") continue;
        const content = await readFile(join(localeRoot, entry.name));
        if (content.byteLength > MAX_FILE_BYTES) throw new TypeError("Plugin resource too large");
        resources.push({ path: entry.name, content });
        if (++count > MAX_PLUGIN_FILES) throw new TypeError("Too many plugin files");
      }
      skills.push({
        id: skill.name,
        locale,
        skillMd,
        ...(resources.length ? { files: resources } : {}),
      });
      if (++count > MAX_PLUGIN_FILES) throw new TypeError("Too many plugin files");
    }
  }
  return { pluginJson, pibotJson, skills };
}

export async function loadBuiltinPlugins(
  root: string,
  options: { includeLocalGmail?: boolean } = {},
): Promise<readonly Plugin[]> {
  const candidates = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
  // apps/plugins also holds importable plugins with their own build (gmail: plugin/ and
  // dist/, no pibot.json). Only a folder with pibot.json is built in; a built-in folder that is
  // incomplete still fails loudly below. Without this the brain did not start (owner smoke).
  const directories = (
    await Promise.all(
      candidates.map(async (directory) => {
        const localGmail = options.includeLocalGmail === true && basename(directory) === "gmail";
        const manifest = localGmail ? "pibot.local.json" : "pibot.json";
        return (await access(join(directory, manifest)).then(
          () => true,
          () => false,
        ))
          ? directory
          : undefined;
      }),
    )
  ).filter((directory): directory is string => directory !== undefined);
  const loaded = await Promise.all(
    directories.map(async (directory) => {
      const localGmail = options.includeLocalGmail === true && basename(directory) === "gmail";
      const manifest = localGmail ? "pibot.local.json" : "pibot.json";
      return {
        plugin: parseDeclarativePlugin(await pluginFiles(directory, manifest)),
        order: PiBotPluginManifestSchema.parse(await readJson(join(directory, manifest))).order,
      };
    }),
  );
  return loaded.sort((left, right) => left.order - right.order).map((item) => item.plugin);
}

export function defaultBuiltinPluginDir(): string {
  const current = new URL(import.meta.url);
  return fileURLToPath(
    current.pathname.endsWith(".ts")
      ? new URL("../../../../apps/plugins/", current)
      : new URL("../plugins/", current),
  );
}
