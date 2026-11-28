// The per-MCP "run outside the sandbox (as you)" switch and the start diagnosis the
// detail panel reads. Turning it on needs the person's click in the native host dialog; nothing
// else (a Bot, YOLO, a remembered grant, the phone) reaches this path.
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { connectorDigest } from "@pibot/brain/kit";
import { aiConfigReadBoundary } from "@pibot/execution";
import type {
  Connector,
  ConnectorDiagnostics,
  ConnectorServer,
} from "@pibot/plugins-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import type { ConnectorServiceOperations } from "../connector-service.ts";

export const OUTSIDE_SANDBOX_ACK = "outside-sandbox-ack";

const platformOf = (ops: ConnectorServiceOperations) =>
  (ops.deps.platform ?? process.platform) as NodeJS.Platform;

/** Where the switch applies: user-imported stdio MCPs on macOS / Linux. */
export function outsideSandboxAvailability(
  ops: ConnectorServiceOperations,
  connector: Connector,
  server: ConnectorServer | undefined,
): ConnectorDiagnostics["outsideSandbox"] {
  if (server?.transport !== "stdio") return "unavailable";
  const platform = platformOf(ops);
  if (platform === "win32") return "windows";
  if (platform !== "darwin" && platform !== "linux") return "unavailable";
  // Built-in apps run fixed, trusted servers inside the sandbox with their own system grants.
  const installation = ops.deps.plugins.get(connector.pluginInstallationId);
  return installation && installation.sourceKind !== "builtin" ? "available" : "unavailable";
}

/** The receipt binds the confirmation to this connector, installation and exact configuration. */
export async function outsideSandboxConfirmed(
  ops: ConnectorServiceOperations,
  connector: Connector,
  server: ConnectorServer,
): Promise<boolean> {
  const raw = await ops.deps.secrets.get(`connector:${connector.id}`, OUTSIDE_SANDBOX_ACK);
  if (!raw) return false;
  try {
    const accepted = JSON.parse(raw) as {
      connectorId?: unknown;
      installationId?: unknown;
      configurationDigest?: unknown;
    };
    return (
      accepted.connectorId === connector.id &&
      accepted.installationId === connector.pluginInstallationId &&
      accepted.configurationDigest === connectorDigest(server)
    );
  } catch {
    // A corrupt receipt cannot authorize running outside the sandbox.
    return false;
  }
}

/** The command or an argument lives in another AI tool's configuration folder. */
async function pointsIntoAiConfig(ops: ConnectorServiceOperations, server: ConnectorServer) {
  if (server.transport !== "stdio") return false;
  const home = ops.deps.home;
  // Roots hold each folder as written and canonical, so a path as the config wrote it matches.
  const { roots } = await aiConfigReadBoundary(platformOf(ops), [home], ops.deps.commandEnv);
  return [server.command, ...server.args].some((value) => {
    const path = value.startsWith("~/")
      ? join(home, value.slice(2))
      : isAbsolute(value)
        ? resolve(value)
        : undefined;
    if (!path) return false;
    return roots.some((root) => {
      const rest = relative(root, path);
      return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest));
    });
  });
}

export async function diagnosticsStep(
  this: ConnectorServiceOperations,
  { id }: { id: string },
): Promise<ConnectorDiagnostics> {
  const connector = this.deps.connectors.get(id);
  if (!connector) throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector not found");
  const stored = this.deps.connectors.configuration(id);
  const server = stored
    ? this.registry.effectiveServer(this.deps.plugins.get(connector.pluginInstallationId), stored)
    : undefined;
  const availability = outsideSandboxAvailability(this, connector, server);
  const lastFailure = this.startFailures.get(id) ?? null;
  const needsReconfirm =
    availability === "available" &&
    connector.outsideSandbox &&
    !!server &&
    !(await outsideSandboxConfirmed(this, connector, server));
  let suggestion: ConnectorDiagnostics["suggestion"] = null;
  if (
    availability === "available" &&
    !connector.outsideSandbox &&
    server &&
    lastFailure?.reason !== "command_not_found" &&
    lastFailure?.reason !== "dependency_missing"
  ) {
    if (await pointsIntoAiConfig(this, server).catch(() => false)) suggestion = "ai_config_path";
    // A refusal before spawning happens outside the sandbox too; running as the person would not help.
    else if (
      lastFailure &&
      !lastFailure.outsideSandbox &&
      lastFailure.reason !== "location_refused" &&
      lastFailure.reason !== "config_invalid" &&
      lastFailure.reason !== "proxy_scheme"
    )
      suggestion = "sandbox_start_failed";
  }
  let loginCommand: string | undefined;
  let loginGuide: string | undefined;
  if (
    server?.transport === "stdio" &&
    (lastFailure?.reason === "login_required" || lastFailure?.reason === "password_prompt")
  ) {
    // Only fixed, known commands. Never copy an imported line (including shell syntax or keys).
    const executable = server.command
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.(exe|cmd|bat)$/i, "");
    const runner = executable?.toLowerCase();
    switch (runner) {
      case "gh":
        loginCommand = "gh auth login";
        break;
      case "gcloud":
        loginCommand = "gcloud auth login";
        break;
      case "az":
        loginCommand = "az login";
        break;
      case "aws":
        if (/\baws sso login\b/i.test(lastFailure.stderrTail)) loginCommand = "aws sso login";
        break;
      case "op":
        loginCommand = "op signin";
        break;
    }
    if (runner && ["npx", "npm", "pnpm", "bunx", "uv", "uvx"].includes(runner)) {
      // A package runner starts a provider's program. Registry login only helps a registry error.
      if (
        ["npm", "npx"].includes(runner) &&
        /(?:^|\n)npm (?:ERR!|error) (?:code (?:ENEEDAUTH|E401)\b|.*\bnpm login\b)/m.test(
          lastFailure.stderrTail,
        )
      ) {
        loginCommand = "npm login";
      } else {
        const args = server.args.filter((arg) => !["-y", "--yes", "--"].includes(arg));
        const prefix = ["exec", "dlx", "run", "tool"].includes(args[0] ?? "");
        const index = prefix ? (args[0] === "tool" && args[1] === "run" ? 2 : 1) : 0;
        const packageName = args[index];
        if (
          packageName &&
          /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._-]+)?$/i.test(packageName)
        ) {
          const name = packageName.replace(/(?<=.)@[a-z0-9._-]+$/i, "");
          if (runner === "uv" || runner === "uvx") {
            if (!name.includes("/")) loginGuide = `https://pypi.org/project/${name}/`;
          } else loginGuide = `https://www.npmjs.com/package/${name}`;
        }
      }
    }
  }
  return {
    outsideSandbox: availability,
    needsReconfirm,
    suggestion,
    lastFailure,
    ...(loginCommand ? { loginCommand } : {}),
    ...(loginGuide ? { loginGuide } : {}),
  };
}

export async function setOutsideSandboxStep(
  this: ConnectorServiceOperations,
  input: { id: string; expectedRevision: number; enabled: boolean },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const connector = this.deps.connectors.get(input.id);
  if (!connector) throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector not found");
  if (connector.revision !== input.expectedRevision)
    throw new RpcError(RpcErrorCodes.connectorStale, "Connector revision changed");
  const stored = this.deps.connectors.configuration(input.id);
  const server = stored
    ? this.registry.effectiveServer(this.deps.plugins.get(connector.pluginInstallationId), stored)
    : undefined;
  if (!server || outsideSandboxAvailability(this, connector, server) !== "available")
    throw new RpcError(RpcErrorCodes.unsupported, "outside_sandbox_unavailable");
  const scope = `connector:${connector.id}`;
  let updated: Connector;
  if (input.enabled) {
    if (server.transport !== "stdio") throw new RpcError(RpcErrorCodes.unsupported, "stdio_only");
    const receipt = await this.deps.confirmUnisolated?.(
      {
        connectorId: connector.id,
        installationId: connector.pluginInstallationId,
        revision: connector.revision,
        command: server.command,
        args: server.args,
        networkDomains: server.networkDomains,
        mode: "outside_sandbox",
      },
      signal,
    );
    signal?.throwIfAborted();
    if (!receipt)
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "connector_confirmation_unavailable");
    if (!receipt.approved)
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "outside_sandbox_cancelled");
    const commit = await this.deps.secrets.prepareSet(
      scope,
      OUTSIDE_SANDBOX_ACK,
      JSON.stringify({
        connectorId: connector.id,
        installationId: connector.pluginInstallationId,
        configurationDigest: connectorDigest(server),
        approvedRevision: connector.revision,
        approvedAt: new Date().toISOString(),
      }),
    );
    signal?.throwIfAborted();
    // Revision CAS inside the same transaction: a change during the dialog voids the answer.
    updated = this.deps.connectors.setOutsideSandbox(
      { ...input, enabled: true },
      this.deps.actorBotId,
      commit,
    );
  } else {
    updated = this.deps.connectors.setOutsideSandbox(
      { ...input, enabled: false },
      this.deps.actorBotId,
      () => this.deps.secrets.remove(scope, OUTSIDE_SANDBOX_ACK),
    );
  }
  // The last failure described the other environment.
  this.startFailures.delete(connector.id);
  this.emitConnectorChanged(connector.id);
  if (!updated.enabled) return { connector: updated, operationId: null };
  // A running connection keeps its old process until restarted; restart so the choice applies now.
  const operation = this.deps.operations.request(
    { id: updated.id, expectedRevision: updated.revision, kind: "restart" },
    this.deps.actorBotId,
  );
  this.emitOperation(operation);
  this.spawn(() => this.runStart(operation), updated.id);
  return {
    connector: this.deps.connectors.get(updated.id) ?? updated,
    operationId: operation.id,
  };
}
