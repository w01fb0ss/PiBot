import {
  AbsolutePathSchema,
  BuiltinAppConnectSchema,
  BuiltinAppSchema,
  ClaudePluginBundleSchema,
  ClaudePluginComponentSchema,
  ClaudePluginConfigFieldSchema,
  CONNECTOR_IMPORT_MAX_BYTES,
  ConnectionAvailabilitySchema,
  ConnectionTargetSchema,
  ConnectorAccessSchema,
  ConnectorBlockedSiteSchema,
  ConnectorCommandSchema,
  ConnectorDiagnosticsSchema,
  ConnectorEnvNameSchema,
  ConnectorImportFileChangesSchema,
  ConnectorManifestSchema,
  ConnectorNetworkSiteSchema,
  ConnectorOperationSchema,
  ConnectorPageSchema,
  ConnectorSchema,
  ConnectorStatusSchema,
  ConnectorToolSchema,
  ConnectorUpdateSchema,
  IdSchema,
  PluginInstallationSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

// UI <-> brain methods of the connectors capability. Entity schemas stay in protocol-base: the run
// engine (approvals, drafts, unattended runs, the tool runner) reasons about connectors too.
const time = z.iso.datetime();
const count = z.number().int().nonnegative().safe();
const revision = count.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const plain = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const kind = z.enum(["file", "directory"]);
const importConfig = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    z.union([z.string().max(16384), z.number().finite(), z.boolean()]),
  )
  .refine((value) => Object.keys(value).length <= 100)
  .default({});
const moveCommandKeyTo = ConnectorEnvNameSchema.optional();
const importFieldName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const importField = z.strictObject({
  name: importFieldName,
  label: z.string().min(1).max(64),
  serverId: ConnectorSchema.shape.serverId,
});
const source = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("json"),
    moveCommandKeyTo,
    text: z
      .string()
      .min(1)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= CONNECTOR_IMPORT_MAX_BYTES,
        "Import too large",
      ),
  }),
  // The host owns this short-lived selection; renderer cannot supply an arbitrary path.
  z.strictObject({ kind: z.literal("selection"), selectionId: IdSchema, moveCommandKeyTo }),
  // Re-evaluates one backend-owned plugin snapshot with the user's current settings.
  z.strictObject({ kind: z.literal("configured"), previewId: IdSchema, config: importConfig }),
]);
const operation = z.strictObject({ operationId: IdSchema });
const change = z.strictObject({ id: IdSchema, expectedRevision: revision });
export const PluginSkillTargetsSchema = z.strictObject({
  bots: z.array(IdSchema).max(500),
  groups: z.array(IdSchema).max(500),
});
const skillAssignments = z.strictObject({
  installationId: IdSchema,
  revision,
  unassignedCount: count,
  pendingTargetCount: count,
  /** Skills a target already had from an earlier import whose package has since changed. */
  updateCount: count,
});
export const PluginSummarySchema = z.strictObject({
  installationId: IdSchema,
  pluginId: plain,
  revision,
  enabled: z.boolean(),
  /** Json = an MCP configuration, directory = a plugin package (the page's two tabs). */
  sourceKind: z.enum(["builtin", "json", "directory"]).optional(),
  /** Pi Bot application package; shown in Applications while retaining connector permissions. */
  application: z.boolean().default(false),
  managedByKnowledge: z.literal(true).optional(),
  applicationPlatforms: z.array(z.enum(["darwin", "win32", "linux"])).default([]),
  /** The other AI tool it was brought over from. */
  originTool: z.enum(["claude-code", "codex", "cursor", "pi", "opencode"]).optional(),
  /** Bots / groups that received a copy of its skills (the row's faces for skill-only plugins). */
  skillTargets: z
    .strictObject({ bots: z.array(IdSchema).max(500), groups: z.array(IdSchema).max(500) })
    .optional(),
  name: z.strictObject({ zh: plain, en: plain }),
  description: z.strictObject({ zh: z.string().max(4096), en: z.string().max(4096) }),
  toolCount: count,
  connectorCount: count,
  skillCount: count,
  skillUpdateCount: count,
  access: ConnectorAccessSchema,
});
export type PluginSummary = z.output<typeof PluginSummarySchema>;
export const ConnectorSourceDetailsSchema = z.strictObject({
  servers: z
    .array(
      z.strictObject({
        id: z.string().max(4096),
        command: z
          .strictObject({ before: z.string().max(4096), after: z.string().max(4096) })
          .optional(),
        arguments: z
          .strictObject({
            before: z.array(z.string().max(4096)).max(64),
            after: z.array(z.string().max(4096)).max(64),
          })
          .optional(),
        envNames: z.strictObject({
          added: z.array(z.string().max(64)).max(64),
          removed: z.array(z.string().max(64)).max(64),
        }),
        websites: z.strictObject({
          before: z.array(z.string().max(4096)).max(129),
          after: z.array(z.string().max(4096)).max(129),
        }),
      }),
    )
    .max(100),
  files: ConnectorImportFileChangesSchema.optional(),
});
export type ConnectorSourceDetails = z.output<typeof ConnectorSourceDetailsSchema>;

export const ConnectorMethods = {
  "connectors.updateFromSource": {
    params: change.extend({ confirmed: z.boolean(), expectedDigest: digest.optional() }),
    timeoutMs: 330_000,
    result: z.strictObject({
      state: z.enum(["preview", "updated", "source_not_found"]),
      installationId: IdSchema,
      expectedRevision: revision,
      changes: z.strictObject({
        commands: count,
        arguments: count,
        envNames: count,
        websites: count,
        files: count,
      }),
      connector: ConnectorSchema.optional(),
      details: ConnectorSourceDetailsSchema.optional(),
      sourceDigest: digest.optional(),
    }),
  },
  "connections.commands": {
    params: ConnectorPageSchema.extend({
      botId: IdSchema,
      groupId: IdSchema.optional(),
      readOnly: z.boolean().optional(),
    }),
    result: z.strictObject({
      items: z.array(ConnectorCommandSchema).max(100),
      nextCursor: IdSchema.nullable(),
    }),
  },
  "connections.availability": {
    params: z.strictObject({
      target: ConnectionTargetSchema,
      connection: z.string().min(1).max(200),
      tool: z.string().min(1).max(4096).optional(),
    }),
    result: ConnectionAvailabilitySchema,
  },
  "plugins.list": {
    params: ConnectorPageSchema.extend({ connectionsOnly: z.boolean().optional() }),
    result: z.strictObject({
      items: z.array(PluginInstallationSchema).max(100),
      nextCursor: plain.nullable(),
    }),
  },
  "plugins.available": {
    params: z.strictObject({
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    result: z.strictObject({
      items: z.array(PluginSummarySchema).max(100),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "plugins.setEnabled": {
    params: z.strictObject({
      installationId: IdSchema,
      expectedRevision: revision,
      enabled: z.boolean(),
    }),
    result: PluginInstallationSchema,
  },
  "plugins.previewImport": {
    params: z.strictObject({ source }),
    result: z.strictObject({
      previewId: IdSchema,
      digest,
      manifest: ConnectorManifestSchema,
      declaredVersion: ConnectorManifestSchema.shape.version.optional(),
      ignoredMcpMetadata: z.literal(true).optional(),
      requiredKeys: z.array(importField).max(64).optional(),
      savedKeys: z
        .array(
          z.strictObject({
            serverId: ConnectorSchema.shape.serverId,
            names: z.array(importFieldName).min(1).max(64),
          }),
        )
        .max(100)
        .optional(),
      plainFields: z.array(importField).max(64).optional(),
      commandWarnings: z
        .array(z.enum(["dangerous", "unverified"]))
        .max(2)
        .optional(),
      plugin: z
        .strictObject({
          components: z.array(ClaudePluginComponentSchema).max(300),
          config: z.array(ClaudePluginConfigFieldSchema).max(100),
          skillCount: count,
          /** A Pi Bot application package's card: its 准备工作 help and documentation link. */
          application: ClaudePluginBundleSchema.shape.applicationCard,
        })
        .optional(),
      expiresAt: time,
      /** True when this preview came from a discovered plugin's Bring Over setup handoff. */
      fromBringOver: z.boolean().optional(),
    }),
  },
  "plugins.cancelPreview": {
    params: z.union([
      z.strictObject({ previewId: IdSchema }),
      z.strictObject({ selectionId: IdSchema }),
    ]),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "plugins.pendingSkillAssignments": {
    params: z.strictObject({
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    result: z.strictObject({
      items: z
        .array(skillAssignments.extend({ name: z.strictObject({ zh: plain, en: plain }) }))
        .max(100),
      totalCount: count,
      nextBefore: IdSchema.nullable(),
    }),
  },
  "plugins.skillAssignments": {
    params: z.strictObject({ installationId: IdSchema }),
    result: skillAssignments,
  },
  "plugins.assignSkills": {
    params: z.strictObject({
      installationId: IdSchema,
      expectedRevision: revision,
      targets: PluginSkillTargetsSchema,
    }),
    result: skillAssignments,
  },
  "plugins.import": {
    params: z.strictObject({
      previewId: IdSchema,
      enable: z.boolean(),
      expectedDigest: digest,
      skillTargets: PluginSkillTargetsSchema.default({ bots: [], groups: [] }),
      config: importConfig,
      plainFields: z.array(importFieldName).max(64).optional(),
      useSavedKeys: z.literal(true).optional(),
      networkDomains: z
        .record(
          z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
          z.array(ConnectorNetworkSiteSchema).max(64),
        )
        .refine((value) => Object.keys(value).length <= 100)
        .default({}),
    }),
    result: z.strictObject({
      installation: PluginInstallationSchema,
      connectors: z.array(ConnectorSchema).max(100),
      unassignedSkillCount: count.optional(),
      pendingSkillTargetCount: count.optional(),
    }),
  },
  /** An installed package's plain settings; secret settings are never listed or returned. */
  "plugins.settings": {
    params: z.strictObject({ installationId: IdSchema }),
    result: z.strictObject({
      installationId: IdSchema,
      revision,
      /** False when the package can change its settings only by updating from its source. */
      editable: z.boolean(),
      fields: z.array(ClaudePluginConfigFieldSchema).max(100),
      values: importConfig,
    }),
  },
  /** Changes plain settings, then restarts the running connections the same way a test does. */
  "plugins.updateSettings": {
    params: z.strictObject({
      installationId: IdSchema,
      expectedRevision: revision,
      config: importConfig,
    }),
    timeoutMs: 330_000,
    result: z.strictObject({
      installation: PluginInstallationSchema,
      changed: z.array(z.string().max(64)).max(100),
      operationIds: z.array(IdSchema).max(100),
    }),
  },
  "plugins.uninstall": {
    params: z.strictObject({ installationId: IdSchema, expectedRevision: revision }),
    result: operation,
  },
  "connectors.list": {
    params: ConnectorPageSchema.extend({
      installationId: IdSchema.optional(),
      builtin: z.boolean().optional(),
    }),
    result: z.strictObject({
      items: z.array(ConnectorSchema).max(100),
      nextCursor: plain.nullable(),
    }),
  },
  "connectors.get": {
    params: z.strictObject({ id: IdSchema }),
    result: z.strictObject({
      connector: ConnectorSchema,
      access: ConnectorAccessSchema,
      auth: z.enum(["none", "bearer", "oauth", "system"]).optional(),
      canReplaceCredential: z.boolean().optional(),
      canAuthorizeInBrowser: z.boolean().optional(),
      canAddRemoteKey: z.boolean().optional(),
      hasSavedOAuth: z.boolean().optional(),
      networkDomains: z.array(ConnectorNetworkSiteSchema).max(64).optional(),
      declaredNetworkDomains: z.array(z.string().max(260)).max(129).optional(),
      blockedRemoteSite: ConnectorBlockedSiteSchema.shape.host.optional(),
      blockedNetworkSites: z
        .array(ConnectorBlockedSiteSchema.extend({ sessionDenied: z.boolean() }))
        .max(64)
        .optional(),
      networkMode: z.enum(["sandbox", "unisolated", "remote", "none"]).optional(),
      canEditNetworkDomains: z.boolean().optional(),
      canUpdateFromSource: z.boolean().optional(),
      sharedSecretNames: z
        .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
        .max(64)
        .optional(),
      bundledNode: z.boolean().optional(),
      startup: z
        .strictObject({
          seconds: z.number().int().min(1).max(300),
          override: z.number().int().min(1).max(300).optional(),
          packageRunner: z.boolean(),
        })
        .optional(),
    }),
  },
  "connectors.network.resolve": {
    params: z.strictObject({
      id: IdSchema,
      host: ConnectorBlockedSiteSchema.shape.host,
      action: z.enum(["allow", "reset"]),
    }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "connectors.update": { params: ConnectorUpdateSchema, result: ConnectorSchema },
  "connectors.operation": {
    params: z.strictObject({ operationId: IdSchema }),
    result: ConnectorOperationSchema,
  },
  "connectors.tools": {
    params: ConnectorPageSchema.extend({
      id: IdSchema,
      limit: z.number().int().min(1).max(50).default(50),
    }),
    result: z.strictObject({
      items: z.array(ConnectorToolSchema).max(50),
      nextCursor: plain.nullable(),
    }),
  },
  "connectors.setEnabled": {
    params: change.extend({ enabled: z.boolean() }),
    timeoutMs: 330_000,
    result: operation,
  },
  "connectors.disconnect": { params: change, result: operation },
  "connectors.restart": { params: change, timeoutMs: 330_000, result: operation },
  /** Desktop-only; the phone allowlist leaves both out on purpose. */
  "connectors.diagnostics": {
    params: z.strictObject({ id: IdSchema }),
    result: ConnectorDiagnosticsSchema,
  },
  "connectors.setOutsideSandbox": {
    params: change.extend({ enabled: z.boolean() }),
    // Outlives the native confirmation and host forwarding deadlines.
    timeoutMs: 330_000,
    result: z.strictObject({
      connector: ConnectorSchema,
      /** The running connection restarts so the new setting takes effect. */
      operationId: IdSchema.nullable(),
    }),
  },
} as const;
const connectorVersion = { connectorId: IdSchema, revision, catalogVersion: count };
export const ConnectorEvents = {
  "plugins.changed": z.strictObject({
    installationId: IdSchema,
    revision,
    reason: z.enum(["imported", "enabled", "disabled", "removed", "access"]),
  }),
  "connectors.changed": z.strictObject({ ...connectorVersion, status: ConnectorStatusSchema }),
  "connectors.toolsChanged": z.strictObject(connectorVersion),
  "connectors.operationChanged": ConnectorOperationSchema,
} as const;
export const ConnectorImportMethods = {
  "connectors.pickWorkingDirectory": {
    params: z.strictObject({}),
    timeoutMs: 650_000,
    result: z
      .strictObject({ path: AbsolutePathSchema.refine((path) => path.length <= 4096) })
      .nullable(),
  },
  "plugins.pickImport": {
    params: z.strictObject({ kind }),
    // The picker is a native dialog a person may keep open for minutes, so it declares
    // its own deadline (the background request guard and the caller's default follow it). It is
    // longer than the 620 s a background picks forwards to the window with, and only guards a hang.
    timeoutMs: 650_000,
    // A cancel is a result, not a failure: the panel returns to its buttons without an error.
    result: z.strictObject({ selectionId: IdSchema.nullable(), canceled: z.boolean() }),
  },
  /** Native OS dialog for a plugin userConfig field of type directory or file. */
  "plugins.pickSettingPath": {
    params: z.strictObject({ kind }),
    timeoutMs: 650_000,
    result: z.strictObject({ path: AbsolutePathSchema.nullable() }),
  },
} as const;
export const ConnectorAppMethods = {
  "apps.list": {
    params: z.strictObject({}),
    result: z.strictObject({ items: z.array(BuiltinAppSchema).max(100) }),
  },
  "apps.connect": {
    params: BuiltinAppConnectSchema,
    result: z.strictObject({
      installation: PluginInstallationSchema,
      connectors: z.array(ConnectorSchema).max(1),
    }),
  },
  "connectors.authorize": {
    params: z.strictObject({
      id: IdSchema,
      expectedRevision: z.number().int().positive().safe(),
      token: z
        .string()
        .min(1)
        .max(16384)
        .refine((value) => !/[\0\r\n]/.test(value))
        .optional(),
      /** Which of a brought-over connection's tokens to replace (as 访问令牌 lists it). */
      tokenName: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
        .optional(),
      /** When true, clears stored OAuth tokens in memory to force an interactive browser consent flow. */
      fresh: z.boolean().optional(),
    }),
    result: z.strictObject({ authorizationId: IdSchema, expiresAt: z.iso.datetime() }),
  },
  "connectors.cancelAuthorization": {
    params: z.strictObject({ authorizationId: IdSchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "connectors.waitAuthorization": {
    params: z.strictObject({ authorizationId: IdSchema }),
    result: z.strictObject({ status: z.enum(["succeeded", "failed", "cancelled"]) }),
  },
} as const;
