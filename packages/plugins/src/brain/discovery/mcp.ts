import { createHash } from "node:crypto";
import {
  looksLikeCredential,
  looksLikeCredentialName,
  looksLikeCredentialValue,
} from "@pibot/plugins-contract";
import {
  ConnectorNetworkSiteSchema,
  connectorEndpointSite,
  type DiscoverySourceId,
} from "@pibot/plugins-contract/full";

/**
 * One MCP server as another tool configures it, in a shared shape. Variable references of every
 * dialect (`${VAR}`, `${VAR:-default}`, Cursor `${env:VAR}`, OpenCode `{env:VAR}`, Codex
 * `bearer_token_env_var` / `env_http_headers` / `env_vars`) are rewritten to `${VAR}` here, so the
 * rest of the pipeline knows one form. Values stay in the brain; only names leave it.
 */
export interface McpEntry {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  cwd?: string;
  startupTimeoutSec?: number;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  sse: boolean;
  /** Variables the tool passes through from its own environment; Pi Bot asks for them instead. */
  passthrough: string[];
}

export class McpEntryError extends Error {
  constructor() {
    super("discovery_mcp_unsupported");
  }
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpEntryError();
  return value as Record<string, unknown>;
};
const strings = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new McpEntryError();
  return value as string[];
};
const stringMap = (value: unknown): Record<string, string> => {
  if (value === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item !== "string") throw new McpEntryError();
    out[key] = item;
  }
  return out;
};

/** Rewrites one tool's reference dialect to `${VAR}` / `${VAR:-default}`. */
function canonical(source: DiscoverySourceId, value: string): string {
  const toVar = (_match: string, name: string) => `\${${name}}`;
  if (source === "cursor") return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, toVar);
  if (source === "opencode") return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, toVar);
  return value;
}
function canonicalMap(source: DiscoverySourceId, map: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [key, canonical(source, value)]),
  );
}

/** Claude Code / Cursor / pi `mcpServers` entry (stdio: command/args/env; http: type/url/headers). */
export function fromMcpServersEntry(
  source: DiscoverySourceId,
  name: string,
  raw: unknown,
): McpEntry {
  const entry = record(raw);
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;
  if (entry.enabled === false || entry.disabled === true) throw new McpEntryError();
  if (typeof entry.url === "string") {
    if (type && !["http", "streamable-http", "sse"].includes(type)) throw new McpEntryError();
    return {
      name,
      transport: "http",
      url: canonical(source, entry.url),
      headers: canonicalMap(source, stringMap(entry.headers)),
      args: [],
      env: {},
      sse: type === "sse",
      passthrough: [],
    };
  }
  if (typeof entry.command !== "string" || (type && type !== "stdio")) throw new McpEntryError();
  return {
    name,
    transport: "stdio",
    command: canonical(source, entry.command),
    args: strings(entry.args).map((arg) => canonical(source, arg)),
    env: canonicalMap(source, stringMap(entry.env)),
    headers: {},
    sse: false,
    passthrough: [],
  };
}

/** Codex `[mcp_servers.<name>]`. */
export function fromCodexEntry(name: string, raw: unknown): McpEntry {
  const entry = record(raw);
  if (entry.enabled === false) throw new McpEntryError();
  if (
    entry.startup_timeout_sec !== undefined &&
    (typeof entry.startup_timeout_sec !== "number" ||
      !Number.isInteger(entry.startup_timeout_sec) ||
      entry.startup_timeout_sec < 1)
  )
    throw new McpEntryError();
  const startup =
    entry.startup_timeout_sec === undefined
      ? {}
      : { startupTimeoutSec: Math.min(entry.startup_timeout_sec as number, 300) };
  if (typeof entry.url === "string") {
    const headers = stringMap(entry.http_headers);
    for (const [header, variable] of Object.entries(stringMap(entry.env_http_headers)))
      headers[header] = `\${${variable}}`;
    if (typeof entry.bearer_token_env_var === "string")
      headers.Authorization = `Bearer \${${entry.bearer_token_env_var}}`;
    return {
      name,
      transport: "http",
      url: entry.url,
      ...startup,
      headers,
      args: [],
      env: {},
      sse: false,
      passthrough: [],
    };
  }
  if (typeof entry.command !== "string") throw new McpEntryError();
  if (
    entry.cwd !== undefined &&
    (typeof entry.cwd !== "string" ||
      !/^(?:~[\\/]|\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(entry.cwd) ||
      /[\0\r\n]/.test(entry.cwd))
  )
    throw new McpEntryError();
  return {
    name,
    transport: "stdio",
    command: entry.command,
    ...(entry.cwd !== undefined ? { cwd: entry.cwd as string } : {}),
    ...startup,
    args: strings(entry.args),
    env: stringMap(entry.env),
    headers: {},
    sse: false,
    passthrough: strings(entry.env_vars),
  };
}

/** OpenCode `mcp.<name>` (`type: local` with a command array, or `type: remote`). */
export function fromOpenCodeEntry(name: string, raw: unknown): McpEntry {
  const entry = record(raw);
  if (entry.enabled === false) throw new McpEntryError();
  if (entry.type === "remote" && typeof entry.url === "string")
    return {
      name,
      transport: "http",
      url: canonical("opencode", entry.url),
      headers: canonicalMap("opencode", stringMap(entry.headers)),
      args: [],
      env: {},
      sse: false,
      passthrough: [],
    };
  const command = strings(entry.command).map((part) => canonical("opencode", part));
  if (entry.type !== "local" || !command[0]) throw new McpEntryError();
  return {
    name,
    transport: "stdio",
    command: command[0],
    args: command.slice(1),
    env: canonicalMap("opencode", stringMap(entry.environment)),
    headers: {},
    sse: false,
    passthrough: [],
  };
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Keys by name: `stored` ones have the value written in the configuration (bringing it over moves
 * it into Pi Bot's keychain), `needed` ones are read from the tool's environment and have to be
 * filled in. Names outside the contract's shape are left out rather than failing the scan.
 */
export function entrySecrets(entry: McpEntry): { name: string; kind: "stored" | "needed" }[] {
  const found = new Map<string, "stored" | "needed">();
  for (const name of entry.passthrough) found.set(name, "needed");
  const visit = (key: string | undefined, value: string) => {
    let referenced = false;
    for (const match of value.matchAll(REFERENCE)) {
      referenced = true;
      const variable = match[1] as string;
      if (match[2] === undefined || looksLikeCredentialName(variable))
        found.set(variable, "needed");
    }
    if (!referenced && key && looksLikeCredential(key, value) && !found.has(key))
      found.set(key, "stored");
  };
  for (const [key, value] of Object.entries(entry.env)) visit(key, value);
  for (const [key, value] of Object.entries(entry.headers)) visit(key, value);
  if (entry.url) visit(undefined, entry.url);
  return [...found]
    .filter(([name]) => SECRET_NAME.test(name))
    .slice(0, 64)
    .map(([name, kind]) => ({ name, kind }));
}
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

/** Discovery exposes the program or endpoint host. Other arguments may carry vendor keys. */
export function entryDescription(entry: McpEntry): string {
  if (entry.transport === "http") {
    try {
      const host = new URL(entry.url?.replace(REFERENCE, "") ?? "").host;
      return looksLikeCredentialValue(host) ? "" : host;
    } catch {
      return "";
    }
  }
  const program = entry.command?.split(/[\\/]/).at(-1) ?? "";
  return looksLikeCredentialValue(program) ? "" : program.slice(0, 200);
}

/**
 * A Pi Bot connector manifest for one entry. References become `${env:VAR}` (stored in Pi
 * Bot's preview as a service-scoped key to fill in); a non-secret reference with a
 * default takes the default. Literal credentials are left in place: the import's own
 * normalization moves them into the secret store before anything is persisted.
 */
export function entryManifest(
  entry: McpEntry,
  options: { id: string; name: string; description: { zh: string; en: string } },
): unknown {
  const resolve = (value: string, allowSecret: boolean) =>
    value.replace(REFERENCE, (_match, variable: string, fallback: string | undefined) => {
      if (fallback !== undefined && !looksLikeCredentialName(variable)) return fallback;
      if (!allowSecret || !SECRET.test(variable)) throw new McpEntryError();
      return `\${env:${variable}}`;
    });
  const serverId =
    entry.name
      .toLowerCase()
      .replaceAll(/[^a-z0-9.-]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .slice(0, 60) || "server";
  const base = {
    id: serverId,
    networkDomains: [] as string[],
    ...(entry.startupTimeoutSec !== undefined
      ? { startupTimeoutSec: entry.startupTimeoutSec }
      : {}),
  };
  let server: Record<string, unknown>;
  if (entry.transport === "http") {
    const url = resolve(entry.url ?? "", false);
    const headers = Object.fromEntries(
      Object.entries(entry.headers).map(([key, value]) => [key, resolve(value, true)]),
    );
    const bearer = Object.entries(headers).some(
      ([key, value]) => key.toLowerCase() === "authorization" && /^Bearer /i.test(value),
    );
    let host: string | undefined;
    try {
      host = ConnectorNetworkSiteSchema.safeParse(connectorEndpointSite(new URL(url))).data;
    } catch {
      throw new McpEntryError();
    }
    server = {
      ...base,
      transport: "http",
      url,
      headers,
      ...(entry.sse ? { sseFallback: true } : {}),
      auth: { kind: bearer ? "bearer" : "none", secretNames: [] },
      networkDomains: host ? [host] : [],
    };
  } else {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.env)) env[key] = resolve(value, true);
    for (const variable of entry.passthrough)
      if (SECRET.test(variable) && env[variable] === undefined)
        env[variable] = `\${env:${variable}}`;
    server = {
      ...base,
      transport: "stdio",
      command: resolve(entry.command ?? "", false),
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      args: entry.args.map((arg) => resolve(arg, false)),
      env,
      auth: { kind: "none", secretNames: [] },
    };
  }
  return {
    schemaVersion: 1,
    id: options.id,
    version: "1",
    name: { zh: options.name, en: options.name },
    description: options.description,
    servers: [server],
  };
}

/** Stable per tool + server name, so a second bring-over is recognised as the same item. */
export function broughtOverId(source: DiscoverySourceId, name: string) {
  return `from.${source}.${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}
