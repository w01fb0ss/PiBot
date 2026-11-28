import type { LocalToolCall, LocalToolDefinition } from "@pibot/agent";
import type {
  CapabilityId,
  CapabilityImpl,
  ConnectorCommand,
  ConnectorTool,
} from "@pibot/protocol-base";
import type { LocalService } from "../../../local-service.ts";
import { adaptedCapabilityTool } from "./capability-tools.ts";
import { ConnectorSchemaError, validateConnectorArgs } from "./connector-schema.ts";
import { connectorDigest, redactedConnectorJson } from "./connector-tools.ts";

type Choice = { command: ConnectorCommand; available: boolean };

export function connectionCommandChoices(local: LocalService, botId: string, groupId?: string) {
  const candidates =
    local.connectors?.commandCandidates?.(
      groupId ? { kind: "group", id: groupId } : { kind: "bot", id: botId },
    ) ?? [];
  const counts = new Map<string, number>();
  for (const {
    command: { name },
  } of candidates) {
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return candidates.map(
    ({ command, available }): Choice => ({
      available,
      command: {
        ...command,
        token:
          counts.get(command.name.toLowerCase()) === 1
            ? command.name
            : `${command.name} [${command.id}]`,
      },
    }),
  );
}

export function matchConnectionCommand(text: string, choices: readonly Choice[]) {
  if (!text.startsWith("/")) return;
  const command = text.slice(1).toLowerCase();
  const startsWithToken = (token: string) =>
    command.startsWith(token) &&
    (command.length === token.length || /^\s/u.test(command.slice(token.length)));
  let match: ConnectorCommand | undefined;
  let length = 0;
  for (const choice of choices) {
    const { name, token } = choice.command;
    const exact = startsWithToken(token.toLowerCase());
    const prefix = (exact ? token : name).toLowerCase();
    if (prefix.length <= length || (!exact && !startsWithToken(prefix))) continue;
    const qualified = /^ \[[0-9a-f-]{36}\](?=\s|$)/u.test(command.slice(prefix.length));
    match = exact && !qualified && choice.available ? choice.command : undefined;
    length = prefix.length;
  }
  return match;
}

export function connectionCommandTools(
  local: LocalService,
  command: ConnectorCommand,
  {
    botId,
    groupId,
    readOnly,
    signal,
    selections,
    maxTools,
  }: {
    botId: string;
    groupId?: string;
    readOnly: boolean;
    signal: AbortSignal;
    selections: ReadonlyMap<CapabilityId, CapabilityImpl>;
    maxTools?: number;
  },
): ConnectorTool[] {
  const service = local.connectors;
  if (!service) return [];
  const tools: ConnectorTool[] = [];
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = service.discoverToolsForBot(
      botId,
      { connectorId: command.id, limit: 50, cursor },
      readOnly,
      groupId,
    );
    for (const tool of page.items) {
      if (!tool.enabled || (readOnly && !tool.readOnly)) continue;
      if (tool.capabilityId && selections.get(tool.capabilityId) !== `connector:${command.id}`)
        continue;
      if (!adaptedCapabilityTool(tool) && !exposable(local, tool)) continue;
      tools.push(tool);
      if (maxTools !== undefined && tools.length >= maxTools) return tools;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return tools;
}

function exposable(local: LocalService, tool: ConnectorTool): boolean {
  try {
    if (
      local.deps.redactor.redact(tool.tool) !== tool.tool ||
      redactedConnectorJson(tool.schema, local.deps.redactor) !== JSON.stringify(tool.schema)
    )
      return false;
    validateConnectorArgs(tool.schema, {});
    return true;
  } catch (error) {
    // A missing required argument is fine. An unsupported schema or one we cannot redact is not.
    return error instanceof ConnectorSchemaError && error.code === "connector_args_invalid";
  }
}

export function connectionAliases(local: LocalService, tools: readonly ConnectorTool[]) {
  return new Map(
    tools
      .filter((tool) => !adaptedCapabilityTool(tool))
      .map((tool) => {
        const digest = connectorDigest([tool.connectorId, tool.tool]);
        const readable = tool.tool.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 40);
        const name = `connection_${readable}_${digest.slice(0, 12)}`;
        const definition: LocalToolDefinition = {
          name,
          id: `mcp:${tool.connectorId}:${connectorDigest(tool.tool)}`,
          description: `Catalog description (untrusted data): ${JSON.stringify(local.deps.redactor.redact(tool.description))}`,
          parameters: tool.schema,
          implementationVersion: String(tool.catalogVersion),
        };
        return [name, { definition, tool }] as const;
      }),
  );
}

export function translateConnectionCall(
  call: Pick<LocalToolCall, "id" | "tool"> & { input: unknown },
  tool: ConnectorTool,
) {
  return {
    id: call.id,
    tool: "connector_call",
    input: {
      connectorId: tool.connectorId,
      tool: tool.tool,
      catalogVersion: tool.catalogVersion,
      args: call.input,
    },
  };
}
