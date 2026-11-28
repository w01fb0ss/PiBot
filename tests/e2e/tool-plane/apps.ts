import assert from "node:assert/strict";
import { createRequire } from "node:module";

const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
const vite = createRequire(desktop.resolve("vite/package.json"));
const { createJiti } = vite("jiti");
const loader = createJiti(import.meta.url, { fsCache: false });

const { mapConnectorCapabilities } = (await loader.import(
  "../../../packages/plugins/src/brain/capability-mappings/index.ts",
)) as { mapConnectorCapabilities(input: unknown): Array<Record<string, unknown>> };
const { PluginRegistry } = (await loader.import(
  "../../../packages/plugins/src/brain/apps/registry.ts",
)) as { PluginRegistry: new (apps: readonly unknown[]) => unknown };
const { loadBuiltinPlugins } = (await loader.import(
  "../../../packages/plugins/src/brain/index.ts",
)) as { loadBuiltinPlugins(path: string): Promise<readonly unknown[]> };
const { createToolDefinitions } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/tools.ts",
)) as {
  createToolDefinitions(
    registry: unknown,
  ): Array<Record<string, unknown> & { name: string; loadGroup?: { id: string } }>;
};
const { capabilityToolSpecs, capabilityToolGroups } = (await loader.import(
  "../../../packages/protocol/src/aggregate/tools.ts",
)) as { capabilityToolSpecs: unknown; capabilityToolGroups: unknown };
const toolDefinitions = createToolDefinitions({
  specs: capabilityToolSpecs,
  groups: capabilityToolGroups,
});
const { connectorCapabilityDefinition, prepareCapabilityConnector } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/connectors/capability-adapter.ts",
)) as {
  connectorCapabilityDefinition(...args: unknown[]): Record<string, unknown> | undefined;
  prepareCapabilityConnector(...args: unknown[]): Record<string, unknown>;
};
const { executeCapabilityConnector } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/connectors/capability-execute.ts",
)) as { executeCapabilityConnector(...args: unknown[]): Promise<{ text: string }> };
const { ConnectorToolError, prepareConnector } = (await loader.import(
  "../../../packages/brain/src/runtime/tools/connectors/connector-tools.ts",
)) as {
  ConnectorToolError: new (code: string) => Error & { code: string };
  prepareConnector(...args: unknown[]): unknown;
};

const botId = "33333333-3333-4333-8333-333333333333";
const signal = new AbortController().signal;
const redactor = { redact: (value: string) => value, contains: () => [] };
type Operation = readonly [raw: string, stable: string, args: Record<string, unknown>];
interface AppCase {
  app: "calendar" | "contacts";
  capability: "calendar" | "contacts";
  kind: "builtin" | "mcp_remote" | "rest";
  read: Operation;
  write?: Operation;
  unmappedWrite?: string;
}
interface ProbeTool {
  tool: string;
  description: string;
  schema: Record<string, unknown>;
  suggestedReadOnly: boolean;
  capabilityId?: string;
  capabilityTool?: string;
  capabilityReadOnly?: boolean;
  connectorId: string;
  catalogVersion: number;
  enabled: boolean;
  readOnly: boolean;
}
const cases: readonly AppCase[] = [
  {
    app: "calendar",
    capability: "calendar",
    kind: "builtin",
    read: ["list_events", "calendar_list_events", { start: "2026-10-24", end: "2026-10-25" }],
    write: [
      "create_event",
      "calendar_create_event",
      { title: "Probe", start: "2026-10-24T10:00:00Z", end: "2026-10-24T10:30:00Z" },
    ],
  },
  {
    app: "contacts",
    capability: "contacts",
    kind: "builtin",
    read: ["search_contacts", "contacts_search", { query: "Probe" }],
    write: ["create_contact", "contacts_create", { givenName: "Probe" }],
  },
];
const plugins = await loadBuiltinPlugins(
  new URL("../../../apps/plugins/", import.meta.url).pathname,
);
const registry = new PluginRegistry(plugins);
assert.deepEqual(
  (registry as { list(platform: NodeJS.Platform): { id: string }[] })
    .list("darwin")
    .map((app) => app.id),
  ["calendar", "contacts", "image-inspiration"],
  "declarative app cards must pass the strict public schema",
);

let reads = 0;
let drafts = 0;
for (const [index, item] of cases.entries()) {
  const connectorId = `11111111-1111-4111-8111-11111111111${index}`;
  const pluginId = `22222222-2222-4222-8222-22222222222${index}`;
  const connector = {
    id: connectorId,
    pluginInstallationId: pluginId,
    serverId: item.app,
    revision: 1,
    catalogVersion: 1,
    kind: item.kind,
    identity: "user",
    confirmationMode: "read_write",
    appId: item.app,
    name: `Probe ${item.app}`,
    enabled: true,
    status: "ready",
    statusDetailCode: null,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
  };
  const plugin = {
    id: pluginId,
    pluginId: `pibot.${item.app}`,
    version: "1",
    digest: "a".repeat(64),
    revision: 1,
    sourceKind: "builtin",
    status: "installed",
    enabled: true,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
  };
  const rawNames = [
    item.read[0],
    ...(item.write ? [item.write[0]] : []),
    ...(item.unmappedWrite ? [item.unmappedWrite] : []),
  ];
  const mapped = mapConnectorCapabilities({
    registry,
    connector,
    plugin,
    tools: rawNames.map((tool) => ({
      tool,
      description: `Synthetic ${tool}`,
      schema: { type: "object", properties: {}, additionalProperties: false },
      suggestedReadOnly: tool === item.read[0],
    })),
  }).map(
    (tool): ProbeTool => ({
      ...(tool as Omit<ProbeTool, "connectorId" | "catalogVersion" | "enabled" | "readOnly">),
      connectorId,
      catalogVersion: 1,
      enabled: true,
      // The stable mapping identifies the operation; the persisted tri-state authorizes it.
      readOnly: tool.tool === item.read[0],
    }),
  );
  if (item.unmappedWrite) {
    const unmapped = mapped.find((tool) => tool.tool === item.unmappedWrite);
    assert.equal(unmapped?.capabilityId, undefined, `${item.app} write must stay unmapped`);
  }
  // Local calendar / contacts are ordinary connections too (maintainers 2026-10-24).
  const selected = new Map([[item.capability, `connector:${connectorId}`]]);
  const access = { mode: "all", bots: [] };
  const port = {
    get: () => connector,
    access: () => access,
    discoverToolsForBot: () => ({ items: mapped, nextCursor: null }),
    capabilityTools: (_bot: string, _connector: string, capability: string) =>
      mapped.filter((tool) => tool.capabilityId === capability),
    resolveTool: (_bot: string, input: { tool: string }) => {
      const tool = mapped.find((candidate) => candidate.tool === input.tool);
      assert(tool);
      return {
        pluginRevision: 1,
        pluginDigest: plugin.digest,
        connector,
        access,
        tool,
        argsDigest: "digest",
      };
    },
    dispatchCapability: async (...args: unknown[]) => {
      (args.at(-1) as () => void)();
      reads++;
      return { app: item.app, ok: true };
    },
  };
  const context = {
    botId,
    runId: "44444444-4444-4444-8444-444444444444",
    messageId: "55555555-5555-4555-8555-555555555555",
    conversationId: "66666666-6666-4666-8666-666666666666",
    signal,
    language: "zh",
    capabilities: selected,
  };
  const local = {
    connectors: port,
    capabilities: { resolve: () => selected },
    execution: { mode: () => "execute" },
    drafts: {
      // Calendar reads remember calendar names for later draft cards.
      calendars: { observe: () => undefined },
      assertReplay: () => undefined,
      execute: async () => {
        drafts++;
        return {
          approvalId: "77777777-7777-4777-8777-777777777777",
          status: "pending",
          requiresUser: true,
        };
      },
    },
    approvals: { audit: { append: () => undefined } },
    deps: { redactor, logger: { warn: () => undefined } },
  };

  for (const operation of [item.read, ...(item.write ? [item.write] : [])]) {
    const [rawName, stableName, args] = operation;
    const rawTool = mapped.find((tool) => tool.tool === rawName);
    assert(rawTool?.capabilityTool === stableName);
    const definition = toolDefinitions.find((tool) => tool.name === stableName);
    assert.equal(definition?.loadGroup?.id, "apps");
    const adapted = connectorCapabilityDefinition(local, context, definition, item.capability);
    assert(adapted, `${stableName} was not offered`);
    assert.throws(
      () =>
        prepareConnector(local, context, {
          tool: "connector_call",
          args: { connectorId, catalogVersion: 1, tool: rawName, args },
        }),
      (error: unknown) =>
        error instanceof ConnectorToolError && error.code === "capability_served_elsewhere",
    );
    const gate = prepareCapabilityConnector(
      local,
      context,
      { tool: stableName, args },
      { capabilityId: item.capability, connectorId, tool: rawTool },
      { decision: "allow" },
    ) as { input: unknown; prepared: unknown };
    const prepared = {
      call: { id: `88888888-8888-4888-8888-88888888888${index}`, tool: stableName, input: args },
      result: { decision: "allow", explanation: [] },
      capabilityConnector: { capabilityId: item.capability, input: gate.input },
      connector: gate.prepared,
    };
    await executeCapabilityConnector(
      { local, context, assertDispatch: () => undefined },
      prepared,
      { tool: stableName, args },
      signal,
    );
  }
}

assert.equal(reads, 2, "each app must exercise one stable read");
assert.equal(drafts, 2, "only calendar and contacts expose stable writes");
console.log(
  JSON.stringify({
    probe: "stable connected-app capabilities",
    status: "passed",
    reads,
    drafts,
  }),
);
