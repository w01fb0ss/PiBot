// Which exec path starts a stdio MCP, and what is reported when it does not come up.
// Exec stays the only process creator; this module only chooses between its three entries.
import { posix, win32 } from "node:path";
import {
  type ConnectorNetworkFilter,
  type ConnectorServerStream,
  ConnectorStartError,
  childNodeRuntime,
  type NetworkProxy,
  startSandboxedServer,
  startUnisolatedConnectorServer,
  windowsSystemRoot,
} from "@pibot/execution";
import type { ConnectorStartFailure } from "@pibot/plugins-contract/full";
import {
  type ConnectorLauncherHint,
  classifyStartFailure,
  startRefusalReason,
} from "./connector-start-failure.ts";

export interface StdioStartOptions {
  platform: NodeJS.Platform;
  command: string;
  cwd?: string;
  args: readonly string[];
  /** The MCP's own declared variables, secrets resolved. */
  declaredEnv: NodeJS.ProcessEnv;
  /** The reduced allowlist (PATH/HOME/LANG/TMPDIR) a sandboxed or Windows server starts from. */
  baseEnv: NodeJS.ProcessEnv;
  /** Sanitized app environment; outside the sandbox the terminal allowlist is drawn from it. */
  commandEnv: NodeJS.ProcessEnv;
  proxy?: NetworkProxy;
  registerProxySecret?(value: string): void;
  networkDomains: readonly string[];
  networkFilter?: ConnectorNetworkFilter;
  home: string;
  dataDir?: string;
  tempDir: string;
  importedRoots?: { install: string; data: string };
  trustedStdio?: { machLookup?: readonly string[]; hostScriptPath?: string };
  /** MacOS / Linux, confirmed by the person and receipt-checked by the caller. */
  outsideSandbox: boolean;
  /** Settings → Permissions extra command folders; an MCP finds its launcher like a command. */
  pathEntries?: readonly string[];
  redact(value: string): string;
  reportStartFailure?(failure: ConnectorStartFailure): void;
  signal: AbortSignal;
}

/** Resolve only the bare Node launcher: explicit paths keep their declared meaning. */
function bundledNodeCommand(command: string, imported: boolean) {
  if (!imported) return command;
  return command === "node" || command === "node.exe" ? childNodeRuntime().executable : command;
}

/** Only the allowlisted name and kind of failure can leave the classifier. */
function launcherHint(
  command: string,
  platform: NodeJS.Platform,
): ConnectorLauncherHint | undefined {
  const windows = platform === "win32";
  const file = (windows ? win32 : posix).basename(command);
  const name = windows ? file.toLowerCase().replace(/\.(?:cmd|bat|exe)$/, "") : file;
  if (name !== "node" && name !== "npx" && name !== "uvx") return undefined;
  const issue: ConnectorStartFailure["launcherIssue"] =
    windows && (/\.(?:cmd|bat)$/i.test(file) || (command === file && file.toLowerCase() === "npx"))
      ? "windows_wrapper"
      : command !== file
        ? "configured_path"
        : undefined;
  return { name, command, issue };
}

/** True where this server runs without any system isolation. */
export const runsUnisolated = (options: Pick<StdioStartOptions, "platform" | "outsideSandbox">) =>
  options.platform === "win32" || options.outsideSandbox;

export async function startStdioStream(options: StdioStartOptions): Promise<ConnectorServerStream> {
  const roots = options.importedRoots;
  let command: string | undefined;
  try {
    // Inside the try: finding Pi Bot's own Node can already refuse, and that is a start failure
    // the person should see a reason for, like any other.
    command = bundledNodeCommand(options.command, roots !== undefined);
    const common = {
      platform: options.platform,
      command,
      args: options.args,
      cwd: options.cwd ?? roots?.install ?? options.home,
      readOnlyRoots: roots ? [roots.install] : undefined,
      readWriteRoots: roots ? [roots.data] : undefined,
      ...(options.pathEntries?.length ? { pathEntries: options.pathEntries } : {}),
      signal: options.signal,
      proxy: options.proxy,
      registerProxySecret: options.registerProxySecret,
    };
    if (options.platform === "win32")
      return await startUnisolatedConnectorServer({
        ...common,
        env: { ...options.baseEnv, ...options.declaredEnv },
        windowsRoot: windowsSystemRoot(options.commandEnv),
        proxyEnv: options.commandEnv,
      });
    if (options.outsideSandbox)
      return await startUnisolatedConnectorServer({
        ...common,
        env: options.declaredEnv,
        outsideSandbox: { userHome: options.home, userEnv: options.commandEnv },
      });
    return await startSandboxedServer({
      ...common,
      useConfiguredCwd: options.cwd !== undefined,
      env: { ...options.baseEnv, ...options.declaredEnv },
      networkDomains: options.networkDomains,
      networkFilter: options.networkFilter,
      boundaryEnv: options.commandEnv,
      allowAll: false,
      tempDir: options.tempDir,
      systemHome: options.home,
      dataDir: options.dataDir,
      allowMachLookup: options.trustedStdio?.machLookup,
      hostScriptPath: options.trustedStdio?.hostScriptPath,
    });
  } catch (error) {
    const refusal = options.signal.aborted ? undefined : startRefusalReason(error);
    if (error instanceof ConnectorStartError || refusal)
      options.reportStartFailure?.(
        classifyStartFailure({
          phase: "start",
          ...(error instanceof ConnectorStartError ? { diagnosis: error.diagnosis } : {}),
          ...(refusal ? { refusal } : {}),
          ...(command === options.command
            ? { launcher: launcherHint(command, options.platform) }
            : {}),
          timedOut: false,
          outsideSandbox: runsUnisolated(options),
          redact: options.redact,
        }),
      );
    throw error;
  }
}

/**
 * The server started but the MCP handshake failed. The agent factory has already closed the
 * stream, so the diagnosis sees how the process ended. A stop by the person is not a failure.
 */
export async function reportInitializeFailure(
  stream: ConnectorServerStream,
  options: Pick<
    StdioStartOptions,
    | "platform"
    | "outsideSandbox"
    | "redact"
    | "reportStartFailure"
    | "signal"
    | "command"
    | "importedRoots"
  >,
) {
  if (!options.reportStartFailure) return;
  const reason = options.signal.reason as { name?: unknown } | undefined;
  const timedOut = options.signal.aborted && reason?.name === "TimeoutError";
  if (options.signal.aborted && !timedOut) return;
  await stream.close().catch(() => undefined);
  options.reportStartFailure(
    classifyStartFailure({
      phase: "initialize",
      launcher:
        options.importedRoots && (options.command === "node" || options.command === "node.exe")
          ? undefined
          : launcherHint(options.command, options.platform),
      diagnosis: await stream.diagnose(),
      timedOut,
      outsideSandbox: runsUnisolated(options),
      redact: options.redact,
    }),
  );
}
