// The MCP configuration other tools write (Claude Code / Claude Desktop / Cursor `mcpServers`, or
// one bare server) turned into a connector manifest. The pasted text is untrusted: its shape is
// checked here with zod before anything is read from it, and the manifest schema checks the result.
import { createHash } from "node:crypto";
import { looksLikeCredentialValue } from "@pibot/plugins-contract";
import {
  CONNECTOR_STARTUP_MAX_SECONDS,
  ConnectorNetworkSiteSchema,
  connectorEndpointSite,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { z } from "zod";

const invalid = (reason: string) => new RpcError(RpcErrorCodes.pluginImportInvalid, reason);
const MAX_SERVERS = 100;
const DEFAULT_NAME = { zh: "自定义 MCP", en: "Custom MCP" };

const text = z.string().max(16384);
const stringMap = z.record(z.string().min(1).max(256), text);
/** One `mcpServers` entry; unknown fields are refused rather than silently dropped. */
const ignoredFields = [
  "timeout",
  "disabled",
  "alwaysAllow",
  "autoApprove",
  "description",
  "envFile",
  "tool_timeout_sec",
] as const;
const ServerEntrySchema = z.strictObject({
  type: z.string().max(32).optional(),
  transport: z.string().max(32).optional(),
  command: z.string().min(1).max(4096).optional(),
  args: z.array(text).max(256).optional(),
  env: stringMap.optional(),
  url: z.string().min(1).max(4096).optional(),
  headers: stringMap.optional(),
  http_headers: stringMap.optional(),
  bearer_token_env_var: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .optional(),
  ...(Object.fromEntries(ignoredFields.map((field) => [field, z.unknown().optional()])) as Record<
    (typeof ignoredFields)[number],
    z.ZodOptional<z.ZodUnknown>
  >),
  networkDomains: z.array(z.string().max(260)).max(64).optional(),
  // Shape checked by the manifest schema; only Pi Bot's own exports carry it.
  auth: z.unknown().optional(),
  sseFallback: z.boolean().optional(),
  cwd: z.string().min(1).max(4096).optional(),
  // Codex writes snake_case; the manifest keeps camelCase.
  startup_timeout_sec: z.number().int().min(1).optional(),
  startupTimeoutSec: z.number().int().min(1).optional(),
});
type ServerEntry = z.output<typeof ServerEntrySchema>;
// A whole claude_desktop_config.json has other top-level settings; only mcpServers is read.
const ServersFileSchema = z.record(z.string().min(1).max(200), z.unknown());

function serverEntry(raw: unknown): ServerEntry {
  const parsed = ServerEntrySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.code === "unrecognized_keys") throw invalid("connector_paste_unknownField");
    const field = issue?.path[0];
    if (field === "args") throw invalid("connector_paste_arguments");
    if (field === "env") throw invalid("connector_paste_variables");
    if (field === "cwd") throw invalid("connector_paste_workingDirectory");
    if (field === "url") throw invalid("connector_paste_url");
    if (field === "headers" || field === "http_headers" || field === "bearer_token_env_var")
      throw invalid("connector_paste_headers");
    if (field === "startupTimeoutSec" || field === "startup_timeout_sec")
      throw invalid("connector_paste_timeout");
    throw invalid("connector_paste_command");
  }
  const entry = parsed.data;
  if (!entry.command === !entry.url) throw invalid("connector_paste_target");
  return entry;
}

function serverId(name: string, index: number, used: Set<string>) {
  let id = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9.-]/g, "-")
    .slice(0, 56);
  if (!/^[a-z]/.test(id)) id = `server-${index}-${id}`.slice(0, 64);
  if (used.has(id)) throw invalid("connector_paste_duplicateNames");
  used.add(id);
  return id;
}

/**
 * The connection is called what the person called the server (the key in mcpServers); several
 * servers share one entry named after all of them. A key that looks like a credential is never
 * shown as a name.
 */
function displayName(names: readonly string[]) {
  const shown = names.map((name) => name.trim()).filter(Boolean);
  if (!shown.length || shown.some((name) => looksLikeCredentialValue(name))) return DEFAULT_NAME;
  const joined = shown.join(", ").slice(0, 200);
  return { zh: joined, en: joined };
}

function manifestServer(name: string, entry: ServerEntry, index: number, used: Set<string>) {
  const headers = { ...entry.http_headers, ...entry.headers };
  if (
    entry.bearer_token_env_var &&
    !Object.keys(headers).some((header) => header.toLowerCase() === "authorization")
  )
    headers.Authorization = `Bearer \${env:${entry.bearer_token_env_var}}`;
  const bearer = Object.entries(headers).some(
    ([header, value]) => header.toLowerCase() === "authorization" && /^Bearer /i.test(value),
  );
  const transport = entry.url ? "http" : "stdio";
  const declared = (entry.type ?? entry.transport)?.toLowerCase();
  if (
    declared &&
    ![
      transport,
      transport === "http" ? "streamable-http" : "stdio",
      ...(transport === "http" ? ["sse"] : []),
    ].includes(declared)
  )
    throw invalid("connector_paste_transport");
  let host: string | undefined;
  if (entry.url)
    try {
      host = ConnectorNetworkSiteSchema.safeParse(connectorEndpointSite(new URL(entry.url))).data;
    } catch {
      throw invalid("connector_paste_url");
    }
  const startupTimeoutSec = entry.startup_timeout_sec ?? entry.startupTimeoutSec;
  return {
    id: serverId(name, index, used),
    transport,
    auth: entry.auth ?? { kind: bearer ? "bearer" : "none", secretNames: [] },
    networkDomains: entry.networkDomains ?? (host ? [host] : []),
    ...(startupTimeoutSec !== undefined
      ? { startupTimeoutSec: Math.min(startupTimeoutSec, CONNECTOR_STARTUP_MAX_SECONDS) }
      : {}),
    ...(transport === "http"
      ? {
          url: entry.url,
          headers,
          ...((declared === "sse" || entry.sseFallback === true) && { sseFallback: true }),
        }
      : {
          command: entry.command,
          args: entry.args ?? [],
          env: entry.env ?? {},
          ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
        }),
  };
}

function bareServerName(entry: ServerEntry | undefined): string {
  if (entry?.url) return new URL(entry.url).host;
  const command = entry?.command?.split(/[\\/]/).at(-1) ?? "";
  if (/^(?:npx|npm|pnpm|bunx|uvx|uv)(?:\.(?:cmd|bat|exe))?$/i.test(command)) {
    const index = (entry?.args ?? []).findIndex((arg) => !arg.startsWith("-"));
    const args = entry?.args ?? [];
    const candidate = args[index + (args[index] === "exec" || args[index] === "run" ? 1 : 0)];
    if (
      candidate &&
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._-]+)?$/i.test(candidate)
    )
      return candidate;
  }
  return command;
}

/** A Pi Bot manifest passes through; anything else must be an MCP configuration. */
export function compatibleSource(value: unknown): {
  manifest: unknown;
  ignoredMcpMetadata?: true;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { manifest: value };
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== undefined) return { manifest: source };
  const serverMap = source.mcpServers ?? source.servers ?? source.mcp_servers;
  let servers: [string, unknown][];
  if (serverMap !== undefined) {
    const file = ServersFileSchema.safeParse(serverMap);
    if (!file.success) throw invalid("connector_paste_shape");
    servers = Object.entries(file.data);
  } else if (typeof source.command === "string" || typeof source.url === "string")
    servers = [["custom", source]];
  else {
    const file = ServersFileSchema.safeParse(source);
    if (!file.success) throw invalid("connector_paste_shape");
    servers = Object.entries(file.data);
  }
  if (!servers.length || servers.length > MAX_SERVERS) throw invalid("connector_paste_shape");
  const used = new Set<string>();
  const entries = servers.map(([name, raw]) => ({ name, entry: serverEntry(raw) }));
  const bare = serverMap === undefined && servers[0]?.[1] === source;
  const normalized = entries.map(({ name, entry }, index) =>
    manifestServer(name, entry, index, used),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(entries.map(({ name }) => name)))
    .digest("hex")
    .slice(0, 16);
  return {
    ...(entries.some(({ entry }) => ignoredFields.some((field) => Object.hasOwn(entry, field)))
      ? { ignoredMcpMetadata: true as const }
      : {}),
    manifest: {
      schemaVersion: 1,
      id: `custom.${digest}`,
      version: "1.0.0",
      // A bare server has no key of its own.
      name: displayName(bare ? [bareServerName(entries[0]?.entry)] : servers.map(([name]) => name)),
      description: { zh: "从 MCP 配置导入", en: "Imported from MCP configuration" },
      servers: normalized,
    },
  };
}
