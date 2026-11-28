import {
  accessAllows,
  type ConnectionAvailability,
  type ConnectionTarget,
  IdSchema,
} from "@pibot/plugins-contract/full";
import { connectionConfirmation } from "@pibot/policy";
import type { ConnectorsRepo, PluginsRepo } from "../../store/index.ts";
import { isManagedNotionRead } from "../../store/notion-tools.ts";
import type { PluginRegistry } from "../apps/registry.ts";

/** This projection explains state; dispatch still revalidates credentials, policy and versions. */
export function connectionAvailability(
  deps: {
    connectors: ConnectorsRepo;
    plugins: PluginsRepo;
    registry: PluginRegistry;
    platform: string;
    displayRedact?: (value: string) => string;
  },
  target: ConnectionTarget,
  connection: string,
  tool?: string,
  knowledgeWrite = false,
): ConnectionAvailability {
  const app = deps.registry
    .list(deps.platform as NodeJS.Platform)
    .find(
      (entry) =>
        entry.id === connection ||
        entry.name.zh === connection ||
        entry.name.en.toLowerCase() === connection.toLowerCase(),
    );
  const reference = IdSchema.safeParse(connection);
  const connector = reference.success
    ? deps.connectors.get(reference.data)
    : app
      ? deps.connectors.forApp(app.id)[0]
      : undefined;
  const result: ConnectionAvailability = {
    connection: connector?.id ?? app?.id ?? "unknown",
    ...(connector
      ? { connectorId: connector.id, confirmationMode: connector.confirmationMode }
      : {}),
    // Imported display text never becomes trusted model instructions.
    name:
      app?.name ??
      (connector
        ? {
            zh: (deps.displayRedact?.(connector.name) ?? connector.name).slice(0, 200),
            en: (deps.displayRedact?.(connector.name) ?? connector.name).slice(0, 200),
          }
        : { zh: "未知连接", en: "Unknown connection" }),
    ...(app ? { trustedName: app.name } : {}),
    reason: "not_connected",
  };
  if (!connector) {
    if (app?.supported === false) result.reason = "platform_unsupported";
    return result;
  }
  const installation = deps.plugins.get(connector.pluginInstallationId);
  const builtin = deps.registry
    .fromInstallation(installation)
    ?.card(deps.platform as NodeJS.Platform);
  if (builtin) {
    result.name = builtin.name;
    result.trustedName = builtin.name;
  }
  if (installation?.status !== "installed" || connector.status === "needs_setup") return result;
  if (connector.status === "needs_auth") result.reason = "needs_auth";
  else if (connector.status === "error") result.reason = "error";
  else if (builtin?.supported === false) result.reason = "platform_unsupported";
  else if (!connector.enabled || !installation.enabled) result.reason = "disabled";
  else if (!["ready", "idle"].includes(connector.status)) result.reason = "not_connected";
  else if (
    !accessAllows(
      deps.connectors.access(connector.id),
      target.kind === "bot" ? target.id : "",
      target.kind === "group" ? target.id : undefined,
    )
  )
    result.reason = "no_access";
  else {
    const row = tool
      ? (deps.connectors.tool(connector.id, connector.catalogVersion, tool) ??
        deps.connectors.toolByCapability(connector.id, connector.catalogVersion, tool))
      : undefined;
    const writable = row
      ? deps.connectors.managedKnowledgeWriteAllowed(
          connector,
          knowledgeWrite ? row.tool : undefined,
        )
      : undefined;
    const readOnly =
      row?.readOnly === true &&
      (writable !== undefined
        ? isManagedNotionRead(row.tool)
        : !builtin || deps.registry.toolPolicy(installation.pluginId, row.tool).readOnly);
    // A guessed tool name that the connection does not have is not "disabled": saying so made a
    // Bot give up on GitHub instead of looking the real tool up (owner's Mac, 2026-11-01).
    result.reason =
      tool && !row
        ? "unknown_tool"
        : tool && !row?.enabled
          ? "tool_disabled"
          : tool &&
              ((!readOnly && writable === false) ||
                connectionConfirmation(connector.confirmationMode, !readOnly) === "blocked")
            ? "read_only_mode"
            : "available";
  }
  return result;
}
