// Runtime target construction: brain resolves credentials and the sandbox
// profile, exec owns the process, and the agent factory owns the SDK client.
// Nothing here is reachable from a plugin or the renderer.
import {
  type ConnectorNetworkAttempt,
  type ConnectorServerStream,
  connectorNetworkSite,
} from "@pibot/execution";
import {
  type Connector,
  type ConnectorBlockedSite,
  ConnectorCallError,
  type ConnectorConnection,
  type ConnectorConnectionFactory,
  type ConnectorFailureCode,
  type ConnectorNetworkApproval,
  ConnectorNetworkBlockedError,
  type ConnectorOAuthStorage,
  type ConnectorServer,
  type ConnectorStartFailure,
  connectorStartupSeconds,
} from "@pibot/plugins-contract/full";
import { connectorSandboxEn, connectorSandboxZh } from "@pibot/plugins-contract/i18n";
import { importedCredentialParts } from "./connector-import.ts";
import { observeStderr } from "./connector-stderr.ts";
import { reportInitializeFailure, startStdioStream } from "./connector-stdio.ts";
import { createPluginOAuthLoopback } from "./plugin-oauth-loopback.ts";
import { pluginSecretStream } from "./plugin-secrets.ts";

/** Opening failures carry the operation's failure code for the store and UI. */
export class ConnectorOpenError extends Error {
  constructor(
    public readonly failureCode: ConnectorFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorOpenError";
  }
}

const _SECRET_REF = /^\$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/;
const SECRET_REF_GLOBAL = /\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g;
const SECRET_MARKER = "${secret:";

function privateValueMatcher(values: ReadonlySet<string>) {
  const words = [...values]
    .filter((value) => value.length < 8)
    .map((value) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u");
    });
  const literals = [...values];
  return (value: unknown, inToolResult = false): boolean => {
    const pending = [value];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "string") {
        if (
          literals.some(
            (literal) => (inToolResult || literal.length >= 8) && item.includes(literal),
          ) ||
          (!inToolResult && words.some((word) => word.test(item)))
        )
          return true;
      } else if (typeof item === "number" || typeof item === "boolean") {
        if (values.has(String(item))) return true;
      } else if (item && typeof item === "object") {
        if (Array.isArray(item)) {
          for (const child of item) pending.push(child);
        } else {
          for (const [key, child] of Object.entries(item)) pending.push(key, child);
        }
      }
    }
    return false;
  };
}

async function resolveSecretRef(
  name: string,
  resolveSecret: (name: string) => Promise<string | undefined>,
): Promise<string> {
  const secret = await resolveSecret(name);
  if (secret === undefined)
    throw new ConnectorOpenError("secret_required", `Secret ${name} is not stored yet`);
  return secret;
}

/**
 * Whole-value references and embedded header templates both resolve here.
 * Replacement slices the original template, so a secret value is an opaque
 * literal: `$&`-style patterns and `${secret:...}` inside a secret are never
 * re-interpreted. A marker that is not a complete reference means corrupted
 * config; the open fails instead of sending unresolved reference text.
 */
async function resolveConfigValue(
  value: string,
  resolveSecret: (name: string) => Promise<string | undefined>,
): Promise<string> {
  if (!value.includes(SECRET_MARKER)) return value;
  const remainder = value.replaceAll(SECRET_REF_GLOBAL, "");
  if (remainder.includes(SECRET_MARKER))
    throw new ConnectorOpenError("invalid_source", "Invalid secret reference");
  const matches = [...value.matchAll(SECRET_REF_GLOBAL)];
  const parts: string[] = [];
  let last = 0;
  for (const match of matches) {
    const name = match[1];
    if (!name) throw new ConnectorOpenError("invalid_source", "Invalid secret reference");
    const start = match.index ?? 0;
    parts.push(value.slice(last, start), await resolveSecretRef(name, resolveSecret));
    last = start + match[0].length;
  }
  parts.push(value.slice(last));
  return parts.join("");
}

async function resolveHttpUrl(
  value: string,
  resolveSecret: (name: string) => Promise<string | undefined>,
): Promise<string> {
  const url = new URL(value);
  const path = url.pathname.split("/");
  for (let index = 0; index < path.length; index++) {
    const decoded = decodeURIComponent(path[index] ?? "");
    path[index] = encodeURIComponent(await resolveConfigValue(decoded, resolveSecret));
  }
  url.pathname = path.join("/");
  const query = [...url.searchParams.entries()];
  url.search = "";
  for (const [name, item] of query)
    url.searchParams.append(
      await resolveConfigValue(name, resolveSecret),
      await resolveConfigValue(item, resolveSecret),
    );
  if (url.hash) {
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment.includes("=")) {
      const resolved = new URLSearchParams();
      for (const [name, item] of new URLSearchParams(fragment))
        resolved.append(
          await resolveConfigValue(name, resolveSecret),
          await resolveConfigValue(item, resolveSecret),
        );
      url.hash = resolved.toString();
    } else url.hash = encodeURIComponent(await resolveConfigValue(fragment, resolveSecret));
  }
  return url.toString();
}

/** Only a fixed allowlist plus SecretStore results reach the server process. */
function baseCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  // A copied Windows environment keeps the system's spelling ("Path"); names are case
  // insensitive there, so an exact lookup dropped PATH and only absolute commands could start.
  const keys = new Map(Object.keys(env).map((key) => [key.toUpperCase(), key]));
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    const value = env[name] ?? env[keys.get(name) ?? name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}

export interface ConnectorNetworkCall {
  approval?: ConnectorNetworkApproval;
  asks: number;
  blocked?: ConnectorBlockedSite;
  waitingHost?: string;
}

export interface ConnectorTargetOptions {
  connector: Connector;
  logStderr?(connectorId: string, tail: string): void;
  server: ConnectorServer;
  factory: ConnectorConnectionFactory;
  /** SecretStore lookup in the user-secret scope; brain owns the scope name. */
  resolveSecret: (name: string) => Promise<string | undefined>;
  /** Reduced base environment (PATH/HOME/...), already sanitized by the entrypoint. */
  commandEnv: NodeJS.ProcessEnv;
  registerProxySecret?(value: string): void;
  proxy?(): { url: string } | undefined;
  home: string;
  dataDir?: string;
  /** Exact roots derived by brain from a directory installation id, never from its manifest. */
  importedRoots?: { install: string; data: string };
  tempDir: string;
  platform?: NodeJS.Platform;
  oauth?: ConnectorOAuthStorage;
  remoteBearer?: string;
  startupTimeoutMs?: number;
  pluginSecretRequest?(input: unknown): Promise<unknown>;
  /** Opens a vetted https URL in the system browser for built-in OAuth flows. */
  openExternal?(url: string): Promise<void>;
  enabledPluginTools?(): string[];
  redactor?: { stream(): unknown; add(secret: string): void };
  /** Supplied only after resolving a sourceKind=builtin installation through PluginRegistry. */
  trustedStdio?: { machLookup?: readonly string[]; hostScriptPath?: string };
  /**
   * Run this stdio MCP outside the sandbox as the person (macOS / Linux). The caller
   * sets it only after checking the confirmation receipt for this exact configuration.
   */
  outsideSandbox?: boolean;
  /** Settings → Permissions extra command folders, read at each start. */
  pathEntries?: readonly string[];
  /** Redaction for what the person may see (stderr tail, denial targets). */
  displayRedact?: (value: string) => string;
  /** One call per stdio start or handshake that failed; not for a stop by the person. */
  reportStartFailure?(failure: ConnectorStartFailure): void;
  sandboxNetwork?(
    attempt: ConnectorNetworkAttempt,
    signal: AbortSignal,
    call?: ConnectorNetworkCall,
  ): Promise<boolean>;
}

/**
 * Re-entrant open: the pool may call it again for the same generation after an
 * idle drain, so every resource is created inside this function.
 */
export async function openConnectorConnection(
  options: ConnectorTargetOptions,
  signal: AbortSignal,
): Promise<ConnectorConnection> {
  const { server } = options;
  const privateValues = new Set<string>();
  let containsPrivateValue: ReturnType<typeof privateValueMatcher> | undefined;
  // System authentication never reads credentials, even if a stale configuration names one.
  const resolveSecret =
    server.auth.kind === "system"
      ? async (_name: string): Promise<string | undefined> => {
          throw new ConnectorOpenError(
            "invalid_source",
            "System connection cannot reference secrets",
          );
        }
      : async (name: string) => {
          const value = await options.resolveSecret(name);
          if (value !== undefined && name.startsWith("IMPORT_"))
            for (const part of [value, ...importedCredentialParts(value, true)]) {
              for (const literal of [part, part.trim()]) {
                if (!literal.trim()) continue;
                privateValues.add(literal);
                privateValues.add(JSON.stringify(literal).slice(1, -1));
              }
            }
          return value;
        };
  let stderr: ReturnType<typeof observeStderr> | undefined;
  let stdio: ConnectorServerStream | undefined;
  const decide = options.sandboxNetwork;
  let active:
    | (ConnectorNetworkCall & {
        signal: AbortSignal;
        pending: Map<string, Promise<boolean>>;
      })
    | undefined;
  const networkFilter =
    decide &&
    ((attempt: ConnectorNetworkAttempt, incoming: AbortSignal) => {
      const call = active;
      if (!call || call.signal.aborted) return decide(attempt, incoming);
      const key = `${connectorNetworkSite(attempt.host, attempt.port)}:${attempt.refusal ?? ""}`;
      const pending = call.pending.get(key);
      if (pending) return pending;
      const request = decide(attempt, AbortSignal.any([incoming, call.signal]), call).finally(() =>
        call.pending.delete(key),
      );
      call.pending.set(key, request);
      return request;
    });
  const platform = options.platform ?? process.platform;
  const report = {
    platform,
    outsideSandbox: options.outsideSandbox === true,
    // Short imported values also need protection in renderer-facing startup diagnostics.
    redact: (value: string) =>
      containsPrivateValue?.(value, true)
        ? "[REDACTED]"
        : (options.displayRedact?.(value) ?? value),
    ...(options.reportStartFailure ? { reportStartFailure: options.reportStartFailure } : {}),
    signal,
  };
  let connectionOptions: Parameters<ConnectorConnectionFactory["connect"]>[0];
  if (server.transport === "stdio") {
    const declaredEnv: NodeJS.ProcessEnv = Object.create(null);
    for (const [name, value] of Object.entries(server.env))
      declaredEnv[name] = await resolveConfigValue(value, resolveSecret);
    if (privateValues.size) containsPrivateValue = privateValueMatcher(privateValues);
    const stream = await startStdioStream({
      ...report,
      command: server.command,
      ...(server.cwd ? { cwd: server.cwd } : {}),
      args: server.args,
      declaredEnv,
      baseEnv: baseCommandEnv(options.commandEnv),
      commandEnv: options.commandEnv,
      proxy: options.proxy?.(),
      registerProxySecret: options.registerProxySecret,
      networkDomains: server.networkDomains,
      networkFilter,
      home: options.home,
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      tempDir: options.tempDir,
      ...(options.importedRoots ? { importedRoots: options.importedRoots } : {}),
      ...(options.trustedStdio ? { trustedStdio: options.trustedStdio } : {}),
      ...(options.pathEntries ? { pathEntries: options.pathEntries } : {}),
    });
    stdio = stream;
    const loopback = createPluginOAuthLoopback(signal);
    stderr = observeStderr(stream, (tail) => options.logStderr?.(options.connector.id, tail));
    const closeStderr = stderr.close;
    stderr.close = async () => {
      loopback.close();
      await closeStderr();
    };
    connectionOptions = {
      transport: "stdio",
      startupTimeoutMs: options.startupTimeoutMs ?? connectorStartupSeconds(server) * 1000,
      stream: {
        write: stream.write.bind(stream),
        onMessage: options.pluginSecretRequest
          ? pluginSecretStream(
              stream,
              async (input) => {
                const method = (input as { method?: string }).method;
                if (method === "pibot/oauth-loopback")
                  return loopback.handle((input as { params: unknown }).params);
                if (method === "pibot/enabled-tools")
                  return { tools: options.enabledPluginTools?.() ?? [] };
                if (method === "pibot/open-external") {
                  const url = String((input as { params?: { url?: unknown } }).params?.url ?? "");
                  const parsed = new URL(url);
                  if (parsed.protocol !== "https:" || !options.openExternal)
                    throw new Error("plugin_external_url_denied");
                  await options.openExternal(url);
                  return {};
                }
                return options.pluginSecretRequest?.(input);
              },
              signal,
            ).onMessage
          : stream.onMessage.bind(stream),
        onClose: stream.onClose.bind(stream),
        close: stderr.close,
      },
      ...(options.trustedStdio && server.auth.kind === "bearer" ? { trustedAuthErrors: true } : {}),
      ...(options.trustedStdio && server.auth.kind === "system"
        ? { trustedNativeErrors: true }
        : {}),
      signal,
    };
  } else if (server.transport === "http") {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(server.headers))
      headers[name] = await resolveConfigValue(value, resolveSecret);
    if (options.remoteBearer) headers.Authorization = `Bearer ${options.remoteBearer}`;
    connectionOptions = {
      transport: "http",
      startupTimeoutMs: options.startupTimeoutMs ?? connectorStartupSeconds(server) * 1000,
      url: await resolveHttpUrl(server.url, resolveSecret),
      headers,
      ...(server.sseFallback === true ? { sseFallback: true } : {}),
      ...(options.oauth ? { oauth: options.oauth } : {}),
      signal,
    };
  } else {
    // Builtin servers are registered by their own batch, never by import.
    throw new ConnectorOpenError("unsupported_format", "Builtin servers cannot be imported");
  }
  try {
    if (privateValues.size) containsPrivateValue ??= privateValueMatcher(privateValues);
    const connection = await options.factory.connect({
      ...connectionOptions,
      ...(containsPrivateValue ? { containsPrivateValue } : {}),
    });
    if (!stderr) return connection;
    // Startup is over: end the kernel-report watch in the background (it settles within ~1 s).
    void stdio?.diagnose().catch(() => undefined);
    const observation = stderr;
    return {
      ...connection,
      listTools: async (input) => {
        try {
          return await connection.listTools(input);
        } catch (error) {
          observation.failed();
          throw error;
        }
      },
      callTool: async (input) => {
        const { networkApproval, ...callInput } = input;
        const lifetime = new AbortController();
        if (decide)
          active = {
            signal: AbortSignal.any([input.signal, lifetime.signal]),
            approval: networkApproval,
            asks: 0,
            pending: new Map(),
          };
        try {
          const result = await connection.callTool(callInput);
          // A late result can arrive after the call deadline while an approval is still settling.
          if (decide) input.signal.throwIfAborted();
          return result;
        } catch (error) {
          observation.failed();
          // The SDK can reject on the call deadline before the waiting approval settles.
          const blocked: ConnectorBlockedSite | undefined =
            input.signal.aborted && active?.waitingHost
              ? { host: active.waitingHost, reason: "timeout" }
              : active?.blocked;
          if (blocked) {
            const message = (labels: typeof connectorSandboxEn) =>
              [
                labels["connectors.network.error"].replace("{host}", blocked.host),
                labels[`connectors.network.reason.${blocked.reason}`],
                ...(["denied", "unattended", "timeout"].includes(blocked.reason)
                  ? [labels["connectors.network.errorAction"]]
                  : []),
              ].join(" ");
            throw new ConnectorNetworkBlockedError(
              !input.signal.aborted && error instanceof ConnectorCallError
                ? error.outcome
                : "unknown",
              [message(connectorSandboxZh), message(connectorSandboxEn)].join(" / "),
            );
          }
          throw error;
        } finally {
          lifetime.abort();
          active = undefined;
        }
      },
      onToolsChanged: connection.onToolsChanged.bind(connection),
      close: connection.close.bind(connection),
    };
  } catch (error) {
    stderr?.failed();
    if (stdio && server.transport === "stdio")
      await reportInitializeFailure(stdio, {
        ...report,
        command: server.command,
        importedRoots: options.importedRoots,
      });
    throw error;
  }
}
