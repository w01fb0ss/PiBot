// Sandboxed stdio MCP servers: their boundary. The process,
// its pipes and its cleanup are the shared stdio host (stdio-host.ts, also used by external
// agents).
// Windows is not supported (the SRT host path is POSIX-only) and reports it explicitly; Windows and
// MCPs the person moved outside the sandbox use connector-unisolated.ts instead.
import { isAbsolute, resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { commandEnvironment } from "../command/environment.ts";
import { canonicalPath, checkedRoot, within } from "../core/paths.ts";
import type { ExecRedactor } from "../core/types.ts";
import { ExecError } from "../core/types.ts";
import type { ConnectorNetworkFilter } from "../sandbox/connector-network.ts";
import { SAFE_SYSTEM_SERVICES } from "../sandbox/sandbox-config.ts";
import { sensitiveReadBoundary } from "../sandbox/sensitive-paths.ts";
import type { NetworkProxy } from "../web/network-proxy.ts";
import {
  assertConnectorProxyBridge,
  connectorNoProxy,
  connectorProxyUrls,
  withoutConnectorProxyEnvironment,
} from "./connector-proxy-env.ts";
import { type ConnectorServerStream, openSandboxedStdio } from "./stdio-host.ts";

/** A stdio connector inherits the command boundary; its manifest cannot grant file access. */
export async function connectorSandboxConfig(
  networkDomains: readonly string[],
  context: {
    platform: NodeJS.Platform;
    systemHome: string;
    env: Readonly<NodeJS.ProcessEnv>;
    dataDir?: string;
    readOnlyRoots?: readonly string[];
    readWriteRoots?: readonly string[];
    allowMachLookup?: readonly string[];
    signal: AbortSignal;
  },
): Promise<SandboxRuntimeConfig> {
  context.signal.throwIfAborted();
  const reads = await sensitiveReadBoundary(
    context.platform,
    [
      ...new Set([
        context.systemHome,
        ...(context.env.HOME && isAbsolute(context.env.HOME) ? [context.env.HOME] : []),
      ]),
    ],
    context.env,
  );
  const dataRoots = context.dataDir
    ? [resolve(context.dataDir), await canonicalPath(context.dataDir, context.systemHome)]
    : [];
  const grantedRoots = [...(context.readOnlyRoots ?? []), ...(context.readWriteRoots ?? [])];
  const canonicalGrants = await Promise.all(grantedRoots.map((root) => checkedRoot(resolve(root))));
  if (
    canonicalGrants.some(
      (root) => dataRoots.length === 0 || !dataRoots.some((dataRoot) => within(dataRoot, root)),
    )
  )
    throw new ExecError("outside_workplace");
  const readOnlyCount = context.readOnlyRoots?.length ?? 0;
  context.signal.throwIfAborted();
  const config = {
    network: { allowedDomains: [...networkDomains], deniedDomains: [], strictAllowlist: true },
    filesystem: {
      denyRead: [
        ...[...new Set([...reads.denyRead, ...dataRoots])].map((path) => ({ path, literal: true })),
        ...reads.denyReadGlobs,
      ],
      allowRead: canonicalGrants.map((path) => ({ path, literal: true })),
      allowWrite: canonicalGrants.slice(readOnlyCount).map((path) => ({ path, literal: true })),
      denyWrite: [],
    },
  } as SandboxRuntimeConfig;
  if (context.platform === "darwin")
    config.network.allowMachLookup = [
      ...new Set([...SAFE_SYSTEM_SERVICES, ...(context.allowMachLookup ?? [])]),
    ];
  return config;
}

export type { ConnectorServerStream } from "./stdio-host.ts";

export interface SandboxedServerOptions {
  platform: NodeJS.Platform;
  /** Server command with arguments; the caller resolves them before this point. */
  command: string;
  args: readonly string[];
  cwd: string;
  /** A source-declared working directory selects cwd, never grants file access. */
  useConfiguredCwd?: boolean;
  /**
   * The resolved command environment for the MCP server process: explicit
   * allowlist entries plus SecretStore results only. This is the payload env
   * (like every background command); the host keeps its own reduced env.
   */
  env: NodeJS.ProcessEnv;
  /** Host configuration locations affect deny rules but never enter the server environment. */
  boundaryEnv?: Readonly<NodeJS.ProcessEnv>;
  proxy?: NetworkProxy;
  networkDomains?: readonly string[];
  networkFilter?: ConnectorNetworkFilter;
  /** Compatibility for existing internal callers; only network domains are honored. */
  config?: SandboxRuntimeConfig;
  allowAll: boolean;
  /** Workspace temp root for the host's private TMPDIR. */
  tempDir: string;
  systemHome: string;
  dataDir?: string;
  /** Brain-derived installation roots only; a connector manifest cannot populate these. */
  readOnlyRoots?: readonly string[];
  readWriteRoots?: readonly string[];
  /** Trusted compiled-in services only; never populated from ConnectorServer/manifest. */
  allowMachLookup?: readonly string[];
  /** Open signal: aborting during startup tears the host down. */
  signal: AbortSignal;
  redactor?: ExecRedactor;
  /** Dev-probe seam: run this host script instead of the built-in sandbox host. */
  hostScriptPath?: string;
  /** The person's extra command folders (Settings → Permissions), as agent commands get them. */
  pathEntries?: readonly string[];
}

export async function startSandboxedServer(
  options: SandboxedServerOptions,
): Promise<ConnectorServerStream> {
  if (options.platform === "win32") {
    // Honest unsupported platform instead of a POSIX-only path failing at spawn.
    throw new ExecError("connector_server_unavailable", "unsupported_platform");
  }
  const config = await connectorSandboxConfig(
    options.networkDomains ?? options.config?.network.allowedDomains ?? [],
    {
      platform: options.platform,
      systemHome: options.systemHome,
      env: { ...options.env, ...options.boundaryEnv },
      dataDir: options.dataDir,
      readOnlyRoots: options.readOnlyRoots,
      readWriteRoots: options.readWriteRoots,
      allowMachLookup: options.allowMachLookup,
      signal: options.signal,
    },
  );
  const hostEnv = options.boundaryEnv ?? {};
  const ambient = connectorProxyUrls(hostEnv);
  const fallback = ambient.get("ALL_PROXY");
  const configured = options.proxy ? new URL(options.proxy.url) : undefined;
  const http = configured ?? ambient.get("HTTP_PROXY") ?? fallback;
  const https = configured ?? ambient.get("HTTPS_PROXY") ?? fallback;
  if (http || https) {
    // Only the trusted host receives the upstream. The MCP sees SRT's filtered local endpoint.
    for (const upstream of [http, https]) if (upstream) assertConnectorProxyBridge(upstream);
    config.network.parentProxy = {
      http: http?.href,
      https: https?.href,
      noProxy: connectorNoProxy(hostEnv) ?? "",
    };
  }
  let serverCwd: string | undefined;
  const grantedRoots = [...(options.readOnlyRoots ?? []), ...(options.readWriteRoots ?? [])];
  // An imported Codex `cwd` only picks where the server starts; it grants no access.
  if (grantedRoots.length || options.useConfiguredCwd) {
    serverCwd = await checkedRoot(resolve(options.cwd));
    const checkedGrants = await Promise.all(grantedRoots.map((root) => checkedRoot(resolve(root))));
    if (checkedGrants.length && !checkedGrants.some((root) => within(root, serverCwd as string)))
      throw new ExecError("outside_workplace");
    // Granted roots always sit inside the denied Pi Bot data tree (checked in the config) and the
    // sandbox re-allows exactly them, so a deny that is a strict ancestor of the grant holding the
    // cwd is the expected shape. Any other deny covering the cwd (a protected tree, or a deny at
    // or inside the grant) still refuses to start.
    const cwdGrants = checkedGrants.filter((root) => within(root, serverCwd as string));
    if (
      config.filesystem.denyRead.some(
        (entry) =>
          typeof entry !== "string" &&
          within(entry.path, serverCwd as string) &&
          !cwdGrants.some((root) => root !== entry.path && within(entry.path, root)),
      )
    )
      throw new ExecError("outside_workplace");
  }
  options.signal.throwIfAborted();
  // The search path an agent command gets in the sandbox: the person's extra folders, the app's
  // PATH, then the usual tool folders. A Dock or login-item launch has only launchd's
  // /usr/bin:/bin:/usr/sbin:/sbin, where npx, uv or a Homebrew tool is never found.
  const env = {
    ...withoutConnectorProxyEnvironment(options.env),
    PATH: commandEnvironment(options.platform, options.env, options.systemHome, options.tempDir, [
      ...(options.pathEntries ?? []),
    ]).PATH,
  };
  return openSandboxedStdio({
    platform: options.platform,
    // An MCP start that fails names what the macOS kernel refused.
    kernelReports: true,
    config,
    allowAll: options.allowAll,
    networkFilter: options.networkFilter,
    command: options.command,
    args: options.args,
    env,
    tempDir: options.tempDir,
    systemHome: options.systemHome,
    // HOME/TMPDIR are private runtime state, independent of the trusted user's deny roots.
    home: serverCwd ? { kind: "private", cwd: serverCwd } : { kind: "private" },
    commandIdPrefix: "connector",
    signal: options.signal,
    ...(options.redactor ? { redactor: options.redactor } : {}),
    ...(options.hostScriptPath ? { hostScriptPath: options.hostScriptPath } : {}),
  });
}
