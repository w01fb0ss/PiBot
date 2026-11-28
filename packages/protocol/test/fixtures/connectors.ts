// Fixtures for the existing contract matrix, not a new test suite.
import type {
  ConnectorActivityMethods,
  ConnectorEvents,
  ConnectorMethods,
  DiscoveryMethods,
} from "@pibot/plugins-contract";
import type { EventPayloads, MethodParams, MethodResults } from "../../src/aggregate/api.ts";

const id = "00000000-0000-4000-8000-000000000001";
const at = "2026-10-16T00:00:00.000Z";
const connector = {
  id,
  pluginInstallationId: id,
  serverId: "test",
  revision: 1,
  catalogVersion: 0,
  kind: "mcp_remote" as const,
  identity: "user" as const,
  confirmationMode: "read_write" as const,
  outsideSandbox: false,
  name: "Test",
  enabled: false,
  status: "disabled" as const,
  statusDetailCode: null,
  createdAt: at,
  updatedAt: at,
};
const installation = {
  id,
  pluginId: "test",
  version: "1",
  digest: "a".repeat(64),
  revision: 1,
  sourceKind: "json" as const,
  status: "installed" as const,
  enabled: false,
  createdAt: at,
  updatedAt: at,
};
const access = { mode: "ask_first" as const, bots: [], groups: [] };
const summary = {
  installationId: id,
  pluginId: "test",
  revision: 1,
  enabled: false,
  application: false,
  applicationPlatforms: [],
  name: { zh: "测试", en: "Test" },
  description: { zh: "测试插件", en: "Test plugin" },
  toolCount: 0,
  connectorCount: 0,
  skillCount: 1,
  skillUpdateCount: 0,
  access,
};
const operation = {
  id,
  installationId: id,
  connectorId: id,
  kind: "enable" as const,
  revision: 1,
  state: "pending" as const,
  phase: "queued" as const,
  failureCode: null,
  createdAt: at,
  updatedAt: at,
};
const manifest = {
  schemaVersion: 1 as const,
  id: "test",
  version: "1",
  name: { zh: "测试", en: "Test" },
  description: { zh: "测试连接", en: "Test connection" },
  servers: [
    {
      id: "test",
      transport: "http" as const,
      url: "https://example.com/mcp",
      auth: { kind: "none" as const, secretNames: [] },
      networkDomains: [],
      headers: {},
    },
  ],
};
type Names =
  | keyof typeof ConnectorMethods
  | keyof typeof ConnectorActivityMethods
  | keyof typeof DiscoveryMethods;
const discoveredKey = `claude-code:mcp:${"a".repeat(24)}`;
type Fixture<K extends Names> = {
  params: MethodParams[K];
  result: MethodResults[K];
  badParams: unknown;
  badResult: unknown;
};
const change = { id, expectedRevision: 1 };
const operationResult = { operationId: id };
export const connectorMethodCases = {
  "connections.commands": {
    params: { botId: id, groupId: id, readOnly: true, limit: 50 },
    result: { items: [{ id, name: "Test", token: "Test", kind: "mcp" }], nextCursor: null },
    badParams: { botId: id, limit: 101 },
    badResult: { items: [{ id, name: "Test", kind: "mcp" }], nextCursor: null },
  },
  "connections.availability": {
    params: { target: { kind: "bot", id }, connection: "calendar" },
    badParams: { target: { kind: "other", id }, connection: "calendar" },
    result: {
      connection: "calendar",
      name: { zh: "本机日历", en: "Local calendar" },
      reason: "not_connected",
    },
    badResult: { reason: "model_reason" },
  },
  "plugins.list": {
    params: { limit: 50 },
    result: { items: [installation], nextCursor: null },
    badParams: { limit: 101 },
    badResult: [],
  },
  "plugins.available": {
    params: { limit: 50 },
    result: { items: [summary], nextBefore: null },
    badParams: { limit: 101 },
    badResult: { items: [installation] },
  },
  "plugins.setEnabled": {
    params: { installationId: id, expectedRevision: 1, enabled: true },
    result: installation,
    badParams: { installationId: id, enabled: true },
    badResult: summary,
  },
  "plugins.previewImport": {
    params: { source: { kind: "json", text: "{}" } },
    result: {
      previewId: id,
      digest: "a".repeat(64),
      manifest: {
        ...manifest,
        servers: [
          {
            ...manifest.servers[0]!,
            headers: { Authorization: "" },
            auth: { kind: "bearer", secretNames: ["SAVED_KEY"] },
          },
        ],
      },
      savedKeys: [{ serverId: "test", names: ["SAVED_KEY"] }],
      expiresAt: at,
    },
    badParams: { source: { kind: "selection", path: "/arbitrary" } },
    badResult: {},
  },
  "plugins.cancelPreview": {
    params: { previewId: id },
    result: { ok: true },
    badParams: {},
    badResult: { ok: false },
  },
  "plugins.pendingSkillAssignments": {
    params: { limit: 50 },
    result: { items: [], totalCount: 0, nextBefore: null },
    badParams: { limit: 101 },
    badResult: { items: [], totalCount: -1, nextBefore: null },
  },
  "plugins.skillAssignments": {
    params: { installationId: id },
    result: {
      installationId: id,
      revision: 1,
      unassignedCount: 0,
      pendingTargetCount: 0,
      updateCount: 0,
    },
    badParams: { installationId: "bad" },
    badResult: {},
  },
  "plugins.assignSkills": {
    params: { installationId: id, expectedRevision: 1, targets: { bots: [id], groups: [] } },
    result: {
      installationId: id,
      revision: 1,
      unassignedCount: 0,
      pendingTargetCount: 0,
      updateCount: 0,
    },
    badParams: { installationId: id },
    badResult: {},
  },
  "plugins.import": {
    params: { previewId: id, enable: false, expectedDigest: "a".repeat(64), useSavedKeys: true },
    result: { installation, connectors: [connector] },
    badParams: { previewId: id, enable: false },
    badResult: {},
  },
  "plugins.settings": {
    params: { installationId: id },
    result: {
      installationId: id,
      revision: 1,
      editable: true,
      fields: [
        {
          key: "REGION",
          type: "string" as const,
          title: "Region",
          description: "Region",
          sensitive: false,
          required: false,
        },
      ],
      values: { REGION: "eu" },
    },
    badParams: {},
    badResult: { installationId: id },
  },
  "plugins.updateSettings": {
    params: { installationId: id, expectedRevision: 1, config: { REGION: "us" } },
    result: { installation, changed: ["REGION"], operationIds: [id] },
    badParams: { installationId: id, config: {} },
    badResult: { installation },
  },
  "plugins.uninstall": {
    params: { installationId: id, expectedRevision: 1 },
    result: operationResult,
    badParams: { installationId: id },
    badResult: {},
  },
  "connectors.list": {
    params: { limit: 50 },
    result: { items: [connector], nextCursor: null },
    badParams: { limit: 101 },
    badResult: [],
  },
  "connectors.get": {
    params: { id },
    result: { connector, access, networkMode: "remote", blockedRemoteSite: "example.com" },
    badParams: {},
    badResult: connector,
  },
  "connectors.network.resolve": {
    params: { id, host: "example.com:8443", action: "allow" },
    result: { ok: true },
    badParams: { id, host: "https://example.com/path", action: "allow" },
    badResult: { ok: false },
  },
  "connectors.update": {
    params: { ...change, access },
    result: connector,
    badParams: change,
    badResult: {},
  },
  "connectors.updateFromSource": {
    params: { ...change, confirmed: false },
    result: {
      state: "preview",
      installationId: id,
      expectedRevision: 1,
      changes: { commands: 1, arguments: 0, envNames: 0, websites: 0, files: 0 },
    },
    badParams: change,
    badResult: { state: "missing" },
  },
  "connectors.operation": {
    params: { operationId: id },
    result: operation,
    badParams: {},
    badResult: { ...operation, state: "ready" },
  },
  "connectors.recentUse": {
    params: { id, before: `${at}~${id}`, limit: 10 },
    result: {
      items: [
        {
          id,
          at,
          botId: id,
          botName: "Test",
          groupId: null,
          groupName: null,
          runId: id,
          tool: "list_events",
          kind: "read",
          outcome: "failed",
          reasonCode: "connector_call_failed",
        },
      ],
      nextCursor: null,
    },
    badParams: { id, before: "arguments", limit: 10 },
    badResult: { items: [{ id, at, botId: id, kind: "read", outcome: "done", args: {} }] },
  },
  "connectors.dataDestinations": {
    params: { id },
    result: {
      items: [
        {
          destination: { kind: "domain", domain: "api.example.com" },
          categories: ["requests", "credential"],
          lastAt: at,
        },
        { destination: { kind: "this_computer" }, categories: ["requests"], lastAt: null },
      ],
    },
    badParams: {},
    badResult: { items: [{ destination: { kind: "url", url: "https://example.com/?q=1" } }] },
  },
  "connectors.tools": {
    params: { id, limit: 50 },
    result: { items: [], nextCursor: null },
    badParams: { id, limit: 51 },
    badResult: [],
  },
  "connectors.setEnabled": {
    params: { ...change, enabled: false },
    result: operationResult,
    badParams: change,
    badResult: {},
  },
  "connectors.disconnect": {
    params: change,
    result: operationResult,
    badParams: { id },
    badResult: {},
  },
  "connectors.restart": {
    params: change,
    result: operationResult,
    badParams: { id },
    badResult: {},
  },
  "connectors.diagnostics": {
    params: { id },
    result: {
      outsideSandbox: "available",
      needsReconfirm: false,
      suggestion: null,
      lastFailure: null,
    },
    badParams: {},
    badResult: { outsideSandbox: "yes" },
  },
  "connectors.setOutsideSandbox": {
    params: { ...change, enabled: true },
    result: { connector, operationId: null },
    badParams: change,
    badResult: { connector },
  },
  "connections.discover": {
    params: {},
    result: {
      scannedAt: at,
      consent: true,
      sources: [
        {
          id: "claude-code" as const,
          name: "Claude Code",
          installed: true,
          items: [
            {
              key: discoveredKey,
              kind: "mcp" as const,
              name: "sentry",
              description: "npx @sentry/mcp-server",
              secrets: [{ name: "SENTRY_TOKEN", kind: "stored" as const, existing: false }],
              conflict: "none" as const,
            },
          ],
        },
      ],
    },
    badParams: { path: "/tmp" },
    badResult: { consent: true, sources: [] },
  },
  "connections.discoverConsent": {
    params: { allow: true },
    result: { consent: true },
    badParams: {},
    badResult: {},
  },
  "connections.bringOver": {
    params: { keys: [discoveredKey] },
    result: { results: [{ key: discoveredKey, outcome: "imported" as const, name: "sentry" }] },
    badParams: { keys: [discoveredKey, discoveredKey] },
    badResult: { results: [{ key: discoveredKey, outcome: "done" }] },
  },
  "connections.cancelBringOver": {
    params: { batchId: id },
    result: { ok: true as const },
    badParams: {},
    badResult: {},
  },
  "connections.previewBringOver": {
    params: { keys: [discoveredKey] },
    result: {
      results: [
        {
          key: discoveredKey,
          outcome: "previewed" as const,
          preview: {
            previewId: id,
            botId: id,
            document: {
              name: "sentry",
              description: "Bring Sentry issues into context",
              body: "1. Open {project}",
              params: [{ name: "project", default: "app" }],
            },
            files: [{ path: "SKILL.md", bytes: 20, script: false, text: true }],
            totalBytes: 20,
            skipped: 0,
            source: "folder" as const,
            sourceName: "Claude Code",
            expiresAt: at,
          },
        },
      ],
    },
    badParams: { keys: [] },
    badResult: { results: [{ key: discoveredKey, outcome: "previewed" }] },
  },
  "connections.previewSetup": {
    params: { key: discoveredKey },
    result: {
      previewId: id,
      digest: "a".repeat(64),
      manifest,
      expiresAt: at,
    },
    badParams: { key: "invalid" },
    badResult: { previewId: id },
  },
  "connections.adoptBringOver": {
    params: { key: discoveredKey },
    result: { selectionId: id },
    badParams: { key: "bad" },
    badResult: { selectionId: null },
  },
  "connections.tokens": {
    params: {},
    result: {
      items: [
        {
          connectorId: id,
          connectorName: "sentry",
          connectorRevision: 1,
          installationId: id,
          originTool: "claude-code" as const,
          name: "SENTRY_AUTH_TOKEN",
          hasValue: true,
        },
      ],
    },
    badParams: { limit: 1 },
    badResult: { items: [{ connectorId: id, hasValue: true }] },
  },
} satisfies { [K in Names]: Fixture<K> };
export const connectorEventCases = {
  "plugins.changed": {
    payload: { installationId: id, revision: 1, reason: "imported" },
    bad: { installationId: id, revision: 0, reason: "imported" },
  },
  "connectors.changed": {
    payload: { connectorId: id, revision: 1, catalogVersion: 0, status: "disabled" },
    bad: { connectorId: id, revision: 1, catalogVersion: -1, status: "disabled" },
  },
  "connectors.toolsChanged": {
    payload: { connectorId: id, revision: 1, catalogVersion: 0 },
    bad: { connectorId: id, revision: 1 },
  },
  "connectors.operationChanged": { payload: operation, bad: { ...operation, state: "ready" } },
} satisfies { [K in keyof typeof ConnectorEvents]: { payload: EventPayloads[K]; bad: unknown } };

// Extend the existing per-method contract matrix as the public surface grows.
export const connectorAppMethodCases = {
  "apps.list": { params: {}, result: { items: [] }, badParams: { id }, badResult: [] },
  "apps.connect": {
    params: { appId: "github" as const, mode: "mcp" as const, enable: false },
    result: { installation, connectors: [connector] },
    badParams: { appId: "invalid app", mode: "mcp", enable: true },
    badResult: {},
  },
  "connectors.authorize": {
    params: { id, expectedRevision: 1 },
    result: { authorizationId: id, expiresAt: at },
    badParams: { id },
    badResult: {},
  },
  "connectors.cancelAuthorization": {
    params: { authorizationId: id },
    result: { ok: true as const },
    badParams: {},
    badResult: {},
  },
  "connectors.pickWorkingDirectory": {
    params: {},
    result: { path: "/example/project" },
    badParams: { path: "/example/project" },
    badResult: {},
  },
  "connectors.waitAuthorization": {
    params: { authorizationId: id },
    result: { status: "failed" as const },
    badParams: {},
    badResult: { status: "pending" },
  },
  "plugins.pickImport": {
    params: { kind: "directory" as const },
    result: { selectionId: null, canceled: true },
    badParams: { kind: "path" },
    badResult: { selectionId: "x" },
  },
  "plugins.pickSettingPath": {
    params: { kind: "directory" as const },
    result: { path: "/tmp/example" },
    badParams: { kind: "path" },
    badResult: { path: "relative/path" },
  },
};
const selectionParams = { selectionId: id, installationId: id };
const setupOrigin = { tool: "claude-code" as const, key: `claude-code:plugin:${"a".repeat(24)}` };
const setupPath = "/home/user/.claude/plugins/cache/m/p/1.0.0";
export const connectorHostCases = {
  "host.pickConnectorImport": connectorAppMethodCases["plugins.pickImport"],
  "host.readConnectorImport": {
    params: selectionParams,
    result: {
      text: "{}",
      sourceDigest: "a".repeat(64),
      sourceKind: "plugin" as const,
      bringOver: { ...setupOrigin, sourcePath: setupPath },
    },
    badParams: { selectionId: id },
    badResult: {},
  },
  "host.materializeConnectorImport": {
    params: { ...selectionParams, expectedDigest: "a".repeat(64) },
    result: { ok: true as const },
    badParams: selectionParams,
    badResult: {},
  },
  "host.adoptConnectorImport": {
    params: { path: setupPath, bringOver: setupOrigin },
    result: { selectionId: id },
    badParams: { path: "" },
    badResult: { selectionId: null },
  },
  "host.releaseConnectorImport": {
    params: { selectionId: id },
    result: { ok: true as const },
    badParams: {},
    badResult: {},
  },
  "host.removeConnectorImport": {
    params: { installationId: id },
    result: { ok: true as const },
    badParams: {},
    badResult: {},
  },
  "host.confirmConnectorCommand": {
    params: {
      connectorId: id,
      installationId: id,
      revision: 1,
      command: "node",
      args: [],
      networkDomains: [],
    },
    result: { approved: false },
    badParams: { connectorId: id },
    badResult: {},
  },
};
