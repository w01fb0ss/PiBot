import { createHash } from "node:crypto";
import {
  connectorEffectClass,
  type LocalToolDefinition,
  type ToolEffectClass,
  toolEffectClass,
} from "@pibot/agent";
import { connectorCallRequest, type PolicyRequest, type PolicyResult } from "@pibot/policy";
import { CAPABILITIES, type CapabilityId, type ConnectorTool } from "@pibot/protocol-base";
import { webFetchInputChars } from "@pibot/tools/web";
import type { PreparedTool, ToolRunContext } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";
import type { ToolInput } from "../tools.ts";
import { adaptedCapabilityTool, CAPABILITY_CONNECTOR_TOOLS } from "./capability-tools.ts";
import {
  type ConnectorCallInput,
  ConnectorToolError,
  redactedConnectorJson,
} from "./connector-tools.ts";

export interface AdapterTarget {
  capabilityId: CapabilityId;
  connectorId: string;
  tool: ConnectorTool;
}

function selectedTools(local: LocalService, context: ToolRunContext, capabilityId: CapabilityId) {
  const selected = context.capabilities?.get(capabilityId);
  if (!selected?.startsWith("connector:") || !local.connectors) return [];
  return local.connectors.capabilityTools(
    context.botId,
    selected.slice("connector:".length),
    capabilityId,
    context.groupId,
  );
}

function targetFor(
  local: LocalService,
  context: ToolRunContext,
  capabilityId: CapabilityId,
  stableTool: string,
): AdapterTarget | undefined {
  const adapter = CAPABILITY_CONNECTOR_TOOLS[capabilityId]?.[stableTool];
  if ((!adapter && !connectionRuled(capabilityId)) || !local.connectors) return undefined;
  const tools = selectedTools(local, context, capabilityId).filter((tool) => tool.enabled);
  if (!adapter) {
    const tool = tools.find(
      (candidate) => candidate.capabilityTool === stableTool && adaptedCapabilityTool(candidate),
    );
    return tool ? { capabilityId, connectorId: tool.connectorId, tool } : undefined;
  }
  for (const raw of adapter.raw) {
    const tool = tools.find(
      (candidate) =>
        candidate.tool === raw &&
        candidate.capabilityTool === stableTool &&
        adaptedCapabilityTool(candidate),
    );
    if (tool) return { capabilityId, connectorId: tool.connectorId, tool };
  }
  return undefined;
}

/** Stable model declaration, with implementation identity kept outside its schema/description. */
export function connectorCapabilityDefinition(
  local: LocalService,
  context: ToolRunContext,
  definition: LocalToolDefinition,
  capabilityId: CapabilityId,
): LocalToolDefinition | undefined {
  const target = targetFor(local, context, capabilityId, definition.name);
  if (!target) return undefined;
  return {
    ...definition,
    capabilityImplementation: { capabilityId, connectorId: target.connectorId },
    implementationVersion: createHash("sha256")
      .update(
        JSON.stringify([
          definition.implementationVersion,
          target.connectorId,
          target.tool.catalogVersion,
          target.tool.tool,
          target.tool.schema,
        ]),
      )
      .digest("hex"),
  };
}

/**
 * A connection-ruled declaration carries no instance or raw tool, so evaluating it separately
 * would deny it and show a duplicate first-use card. The selected connection owns the decision.
 */
export function connectionRuled(capabilityId: CapabilityId): boolean {
  return (
    capabilityId === "browser" ||
    CAPABILITIES.find((capability) => capability.id === capabilityId)?.permissionCategory ===
      "connector"
  );
}

export function capabilityConnectorPolicy(
  local: LocalService,
  target: AdapterTarget,
): PolicyRequest {
  const connector = local.connectors?.get(target.connectorId);
  if (!local.connectors || !connector) throw new ConnectorToolError("connector_unavailable");
  return connectorCallRequest({
    connector,
    access: local.connectors.access(target.connectorId),
    tool: target.tool,
  });
}

export function capabilityAdapterTarget(
  local: LocalService,
  context: ToolRunContext,
  input: ToolInput,
): AdapterTarget | undefined {
  const capability = CAPABILITIES.find((item) =>
    (item.builtinTools as readonly string[]).includes(input.tool),
  );
  return capability ? targetFor(local, context, capability.id, input.tool) : undefined;
}

function rawArguments(
  capabilityId: CapabilityId,
  input: ToolInput,
  result: PolicyResult,
): ConnectorCallInput["args"] {
  const path = result.path?.path;
  switch (input.tool) {
    case "read_file":
      if (!path) throw new ConnectorToolError("connector_args_invalid");
      return { path };
    case "list_dir":
      if (!path || (input.args.depth ?? 1) !== 1)
        throw new ConnectorToolError("connector_args_invalid");
      return { path };
    case "find_files":
      if (!path) throw new ConnectorToolError("connector_args_invalid");
      return { path, pattern: input.args.pattern };
    case "web_fetch":
      return {
        url: result.url ?? input.args.url,
        max_length: webFetchInputChars(input.args),
      };
    case "browser_snapshot":
      if (input.args.tab) throw new ConnectorToolError("connector_args_invalid");
      return {};
    case "browser_tabs":
      return { action: "list" };
    case "browser_screenshot":
      if (input.args.tab || input.args.viewport)
        throw new ConnectorToolError("connector_args_invalid");
      return { ...(input.args.fullPage === undefined ? {} : { fullPage: input.args.fullPage }) };
    case "browser_wait":
      if (input.args.tab || input.args.for === "ref")
        throw new ConnectorToolError("connector_args_invalid");
      if (input.args.for === "text") {
        const text = input.args.value;
        if (!text) throw new ConnectorToolError("connector_args_invalid");
        return { text };
      }
      return { time: Math.max(0.1, Math.min(25, (input.args.timeoutMs ?? 1000) / 1000)) };
    default:
      if (connectionRuled(capabilityId)) {
        const args: ConnectorCallInput["args"] = { ...input.args };
        return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
      }
      throw new ConnectorToolError("connector_tool_denied");
  }
}

export function prepareCapabilityConnector(
  local: LocalService,
  context: ToolRunContext,
  input: ToolInput,
  target: AdapterTarget,
  result: PolicyResult,
) {
  if (result.decision === "deny") throw new ConnectorToolError("connector_context_denied");
  if (!local.connectors) throw new ConnectorToolError("connector_unavailable");
  const connector = local.connectors.get(target.connectorId);
  if (!connector) throw new ConnectorToolError("connector_unavailable");
  const connectorInput: ConnectorCallInput = {
    connectorId: target.connectorId,
    catalogVersion: connector.catalogVersion,
    tool: target.tool.tool,
    args: rawArguments(target.capabilityId, input, result),
  };
  if (
    redactedConnectorJson(connectorInput.args, local.deps.redactor, "connector_args_invalid") !==
    JSON.stringify(connectorInput.args)
  )
    throw new ConnectorToolError("connector_secret_denied");
  const prepared = local.connectors.resolveTool(context.botId, connectorInput, context.groupId);
  if (
    prepared.tool.capabilityId !== target.capabilityId ||
    prepared.tool.capabilityTool !== input.tool ||
    !adaptedCapabilityTool(prepared.tool)
  )
    throw new ConnectorToolError("capability_served_elsewhere");
  return { capabilityId: target.capabilityId, input: connectorInput, prepared };
}

export function capabilityConnectorEffect(prepared: PreparedTool) {
  const capability = prepared.capabilityConnector;
  if (!capability || !prepared.connector) return undefined;
  const rank: Record<ToolEffectClass, number> = {
    read: 0,
    idempotent: 1,
    local_effect: 2,
    external: 3,
  };
  const stable = toolEffectClass(prepared.call.tool, prepared.call.input);
  const connector = connectorEffectClass(prepared.connector.tool.readOnly, prepared.connector.tool);
  return rank[connector] > rank[stable] ? connector : stable;
}

export function capabilitySelectionMatches(
  context: ToolRunContext,
  capabilityId: CapabilityId,
  connectorId: string,
) {
  return context.capabilities?.get(capabilityId) === `connector:${connectorId}`;
}
