import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ClaudePluginBundle,
  type ConnectorImportOrigin,
  type ConnectorManifest,
  ConnectorManifestSchema,
  type ConnectorOperation,
  ConnectorPageSchema,
  type ConnectorServer,
  ConnectorServerSchema,
  connectorAuditEvents,
  IdSchema,
  newConnectionDefaults,
  PageSchema,
  type PluginInstallation,
  PluginInstallationSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import type { AuditRepo } from "@pibot/storage";
import { readPage, transaction } from "@pibot/storage";
import {
  connectorConflict,
  connectorMissing,
  parseConnector,
  parseInstallation,
} from "./connector-records.ts";
import { freeInstalledName, installedManifestNames } from "./discovery.ts";
import {
  applyImportSettings,
  preserveNetworkChoices,
  readImportSettings,
  refreshSettingsTemplate,
  writeNetworkDenials,
} from "./plugin-settings.ts";

const SECRET_REF_GLOBAL = /\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g;
const MAX_INSTALLATION_SECRET_NAMES = 64;
const SECRET_RECONFIGURATION_REQUIRED = "secret_reconfiguration_required";
type SecretBackfillFailureReason =
  | "secret_reference_limit"
  | "secret_reference_ownership"
  | "invalid_legacy_configuration";

class SecretBackfillError extends Error {
  constructor(readonly reasonCode: SecretBackfillFailureReason) {
    super(reasonCode);
  }
}

function referencedSecretNames(server: ConnectorServer): string[] {
  const values =
    server.transport === "stdio"
      ? Object.values(server.env)
      : server.transport === "http"
        ? [...Object.values(server.headers), server.url]
        : [];
  const names = new Set<string>();
  for (const value of values)
    for (const match of value.matchAll(SECRET_REF_GLOBAL)) if (match[1]) names.add(match[1]);
  return [...names].sort();
}

function importedSecretPrefix(installationId: string): string {
  return `IMPORT_${installationId.replaceAll("-", "").toUpperCase()}_`;
}

export class PluginsRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditRepo,
  ) {}

  get(id: string): PluginInstallation | undefined {
    const row = this.db
      .prepare("SELECT * FROM plugin_installations WHERE id=?")
      .get(IdSchema.parse(id));
    return row ? parseInstallation(row) : undefined;
  }

  list({
    connectionsOnly,
    ...input
  }: {
    cursor?: string;
    limit?: number;
    connectionsOnly?: boolean;
  } = {}) {
    const page = ConnectorPageSchema.parse(input);
    const rows = readPage(
      this.db,
      "plugin_installations",
      "*",
      "created_at",
      { before: page.cursor, limit: page.limit + 1 },
      [
        ["(status <> 'removed')", 1],
        ...(connectionsOnly
          ? [["(json_array_length(manifest_json,'$.servers')>0)", 1] as const]
          : []),
      ],
      // A displayed cursor can be uninstalled before the next page is requested.
      [],
    );
    const items = rows.slice(0, page.limit).map(parseInstallation);
    return { items, nextCursor: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null };
  }

  availableRows(input: { before?: string; limit?: number } = {}) {
    const page = PageSchema.parse(input);
    const rows = readPage(
      this.db,
      "plugin_installations p",
      `p.*,
        (SELECT count(*) FROM connectors c WHERE c.plugin_installation_id=p.id
         AND c.removed_at IS NULL) AS connector_count,
        (SELECT count(*) FROM connector_tools t JOIN connectors c ON c.id=t.connector_id
         WHERE c.plugin_installation_id=p.id AND c.removed_at IS NULL
         AND t.catalog_version=c.catalog_version AND t.enabled=1) AS tool_count`,
      "created_at",
      { before: page.before, limit: (page.limit ?? 50) + 1 },
      // Skill-only plugins are listed too; the connections page shows every installation.
      [["status", "installed"]],
      [],
    );
    const items = rows.slice(0, page.limit ?? 50);
    const last = items.at(-1);
    return {
      items,
      nextBefore: rows.length > (page.limit ?? 50) && last ? IdSchema.parse(last.id) : null,
    };
  }

  /**
   * One-time compatibility migration for installations written before auth.secretNames became
   * the runtime allow-list. Existing non-empty lists are user-approved state and are never widened.
   */
  backfillImportedSecretAllowLists(actorBotId: string): {
    installationCount: number;
    secretNameCount: number;
    failures: Array<{ installationId: string; reasonCode: SecretBackfillFailureReason }>;
  } {
    let after = "";
    let installationCount = 0;
    let secretNameCount = 0;
    const failures: Array<{
      installationId: string;
      reasonCode: SecretBackfillFailureReason;
    }> = [];
    while (true) {
      const rows = this.db
        .prepare(`SELECT DISTINCT p.id,p.manifest_json FROM plugin_installations p
          JOIN connectors c ON c.plugin_installation_id=p.id
          WHERE p.source_kind='json' AND p.status='installed'
          AND c.removed_at IS NULL AND p.id>?
          AND NOT EXISTS(SELECT 1 FROM connectors failed
            WHERE failed.plugin_installation_id=p.id
            AND failed.status_detail_code='secret_reconfiguration_required')
          ORDER BY p.id LIMIT 100`)
        .all(after);
      if (rows.length === 0) break;
      for (const row of rows) {
        const installationId = IdSchema.parse(row.id);
        after = installationId;
        try {
          const result = transaction(this.db, () => {
            const manifest = ConnectorManifestSchema.parse(JSON.parse(String(row.manifest_json)));
            const connectorRows = this.db
              .prepare(`SELECT id,config_json FROM connectors
            WHERE plugin_installation_id=? AND removed_at IS NULL ORDER BY server_id LIMIT 100`)
              .all(installationId);
            const configurations = connectorRows.map((connector) => ({
              id: IdSchema.parse(connector.id),
              server: ConnectorServerSchema.parse(JSON.parse(String(connector.config_json))),
            }));
            // A partial/non-empty list is already authoritative. Compatibility code must not add
            // permissions to an installation that has passed through the new import flow.
            if (
              manifest.servers.some((server) => server.auth.secretNames.length > 0) ||
              configurations.some(({ server }) => server.auth.secretNames.length > 0)
            )
              return 0;

            const names = new Set<string>();
            const migratedManifest = ConnectorManifestSchema.parse({
              ...manifest,
              servers: manifest.servers.map((server) => {
                const secretNames = referencedSecretNames(server);
                for (const name of secretNames) names.add(name);
                return { ...server, auth: { ...server.auth, secretNames } };
              }),
            });
            const migratedConfigurations = configurations.map((configuration) => {
              const secretNames = referencedSecretNames(configuration.server);
              for (const name of secretNames) names.add(name);
              return {
                ...configuration,
                server: ConnectorServerSchema.parse({
                  ...configuration.server,
                  auth: { ...configuration.server.auth, secretNames },
                }),
              };
            });
            if (names.size === 0) return 0;
            if (names.size > MAX_INSTALLATION_SECRET_NAMES)
              throw new SecretBackfillError("secret_reference_limit");
            const prefix = importedSecretPrefix(installationId);
            if ([...names].some((name) => name.startsWith("IMPORT_") && !name.startsWith(prefix)))
              throw new SecretBackfillError("secret_reference_ownership");

            this.db
              .prepare("UPDATE plugin_installations SET manifest_json=? WHERE id=?")
              .run(JSON.stringify(migratedManifest), installationId);
            const updateConnector = this.db.prepare(
              "UPDATE connectors SET config_json=? WHERE id=?",
            );
            for (const configuration of migratedConfigurations)
              updateConnector.run(JSON.stringify(configuration.server), configuration.id);
            return names.size;
          });
          if (result > 0) {
            installationCount += 1;
            secretNameCount += result;
          }
        } catch (error) {
          const reasonCode =
            error instanceof SecretBackfillError
              ? error.reasonCode
              : "invalid_legacy_configuration";
          transaction(this.db, () => {
            const now = new Date().toISOString();
            this.db
              .prepare(`UPDATE connectors SET enabled=0,status='needs_setup',status_detail_code=?,
              revision=revision+1,catalog_version=catalog_version+1,updated_at=?
              WHERE plugin_installation_id=? AND removed_at IS NULL`)
              .run(SECRET_RECONFIGURATION_REQUIRED, now, installationId);
            this.db
              .prepare(`UPDATE plugin_installations SET enabled=0,revision=revision+1,updated_at=?
              WHERE id=? AND status='installed'`)
              .run(now, installationId);
            this.audit.append({
              botId: IdSchema.parse(actorBotId),
              kind: "plugin.changed",
              summary: connectorAuditEvents.secretBackfillFailed,
              detail: { installationId, reasonCode },
            });
          });
          failures.push({ installationId, reasonCode });
        }
      }
      if (rows.length < 100) break;
    }
    if (installationCount > 0)
      this.audit.append({
        botId: IdSchema.parse(actorBotId),
        kind: "plugin.changed",
        summary: connectorAuditEvents.secretBackfill,
        detail: { itemCount: secretNameCount },
      });
    return { installationCount, secretNameCount, failures };
  }

  /** Serverless installations own only skills, so their lifecycle is synchronous and atomic. */
  setEnabled(input: {
    installationId: string;
    expectedRevision: number;
    enabled: boolean;
    actorBotId: string;
  }): PluginInstallation {
    return transaction(this.db, () => {
      const id = IdSchema.parse(input.installationId);
      const row = this.db
        .prepare("SELECT * FROM plugin_installations WHERE id=? AND status='installed'")
        .get(id);
      if (!row) connectorMissing();
      if (row.revision !== input.expectedRevision) connectorConflict();
      const connectors = this.db
        .prepare(
          "SELECT count(*) AS count FROM connectors WHERE plugin_installation_id=? AND removed_at IS NULL",
        )
        .get(id);
      if (Number(connectors?.count ?? 0) !== 0)
        throw new RpcError(
          RpcErrorCodes.invalidParams,
          "Connector-backed plugins use connector lifecycle controls",
        );
      const current = parseInstallation(row);
      if (current.enabled === input.enabled) return current;
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE plugin_installations SET enabled=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(input.enabled ? 1 : 0, now, id);
      this.audit.append({
        botId: IdSchema.parse(input.actorBotId),
        kind: "plugin.changed",
        summary: connectorAuditEvents.pluginLifecycle,
        detail: { installationId: id, reasonCode: input.enabled ? "enabled" : "disabled" },
      });
      return this.get(id) as PluginInstallation;
    });
  }

  setImportSettings(
    installationId: string,
    value: Record<string, string | number | boolean>,
    skillCount: number,
    application = false,
    applicationPlatforms: readonly string[] = [],
    applicationId?: string,
    template?: ClaudePluginBundle,
  ): void {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(
        `plugin-import:${IdSchema.parse(installationId)}`,
        JSON.stringify({
          config: value,
          skillCount,
          application,
          applicationPlatforms,
          applicationId,
          ...(template ? { template } : {}),
        }),
      );
  }

  /** Plain settings and the template that re-evaluates them; undefined when not editable. */
  importSettings(installationId: string) {
    return readImportSettings(this.db, installationId);
  }

  applyImportSettings(input: Parameters<typeof applyImportSettings>[3]): PluginInstallation {
    return applyImportSettings(this.db, this.audit, () => this.get(input.installationId), input);
  }

  refreshSettingsTemplate(
    installationId: string,
    template: ClaudePluginBundle | undefined,
    config?: Record<string, string | number | boolean>,
  ): void {
    refreshSettingsTemplate(this.db, installationId, template, config);
  }

  importSkillCount(installationId: string): number {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`plugin-import:${IdSchema.parse(installationId)}`);
    if (!row) return 0;
    try {
      const value = JSON.parse(String(row.value)) as { skillCount?: unknown };
      return typeof value.skillCount === "number" && Number.isSafeInteger(value.skillCount)
        ? Math.max(0, Math.min(100, value.skillCount))
        : 0;
    } catch {
      return 0;
    }
  }

  isApplication(installationId: string): boolean {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`plugin-import:${IdSchema.parse(installationId)}`);
    if (!row) return false;
    try {
      return (JSON.parse(String(row.value)) as { application?: unknown }).application === true;
    } catch {
      return false;
    }
  }

  applicationPlatforms(installationId: string): string[] {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`plugin-import:${IdSchema.parse(installationId)}`);
    if (!row) return [];
    try {
      const value = JSON.parse(String(row.value)) as { applicationPlatforms?: unknown };
      return Array.isArray(value.applicationPlatforms)
        ? value.applicationPlatforms.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  applicationId(installationId: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`plugin-import:${IdSchema.parse(installationId)}`);
    if (!row) return undefined;
    try {
      const value = JSON.parse(String(row.value)) as { applicationId?: unknown };
      return typeof value.applicationId === "string" ? value.applicationId : undefined;
    } catch {
      return undefined;
    }
  }

  removeImportSettings(installationId: string): void {
    this.db
      .prepare("DELETE FROM settings WHERE key=?")
      .run(`plugin-import:${IdSchema.parse(installationId)}`);
  }

  /** Brain normalizes/copies the source and migrates all credentials before this call. */
  install(input: {
    id: string;
    manifest: ConnectorManifest;
    digest: string;
    sourceKind: PluginInstallation["sourceKind"];
    actorBotId: string;
    /** Skill-only plugins have no connector operation that could set installation enabled. */
    enableWithoutConnectors?: boolean;
    /** Synchronous encrypted writes prepared outside the install transaction. */
    commitSecrets?: () => void;
    /** When the caller wants "import and enable", the enable intents must share
     * the install transaction: committing the receipt without them would let a
     * later retry silently turn the interrupted import into an import-only one. */
    requestEnable?: (connectorId: string, expectedRevision: number) => ConnectorOperation;
    /** Brought over from another AI tool (tool id and the scan's item key). */
    origin?: { tool: string; key: string };
    /** A discovered plugin that was completed through the setup preview. */
    setupOrigin?: ConnectorImportOrigin;
    /** Host-validated source folder/file, never exposed to the renderer. */
    originPath?: string;
    /** Brain-owned knowledge connections are usable by nobody until a source assigns them. */
    accessMode?: "all" | "selected";
    confirmationMode?: "always_ask";
    /**
     * The brain owns this install. `source_kind` cannot say so (a person's imported
     * Notion MCP is 'json' too), and the marker is what startup repair and knowledge removal may
     * act on, so it is written in the same transaction as the installation.
     */
    managedBy?: "knowledge_source";
    networkDenials?: ReadonlyMap<string, ReadonlySet<string>>;
  }) {
    return transaction(this.db, () => {
      let manifest = ConnectorManifestSchema.parse(input.manifest);
      const now = new Date().toISOString();
      const installation = PluginInstallationSchema.parse({
        id: input.id,
        pluginId: manifest.id,
        version: manifest.version,
        digest: input.digest,
        revision: 1,
        sourceKind: input.sourceKind,
        status: "installed",
        enabled: input.enableWithoutConnectors === true && manifest.servers.length === 0,
        createdAt: now,
        updatedAt: now,
      });
      // A preview owns one installation id. A retry may return that receipt, never overwrite it.
      const previous = this.get(installation.id);
      if (previous) {
        if (previous.digest !== installation.digest || previous.status !== "installed")
          connectorConflict();
        return {
          installation: previous,
          connectors: this.connections(previous.id),
          created: false,
          enableOperations: [],
        };
      }
      const origin = input.setupOrigin ?? input.origin;
      if (
        origin &&
        this.db
          .prepare(
            "SELECT 1 FROM plugin_installations WHERE status='installed' AND origin_tool=? AND origin_key=? LIMIT 1",
          )
          .get(origin.tool, origin.key)
      )
        connectorConflict();
      if (input.setupOrigin) {
        const installed = installedManifestNames(this.db);
        const taken = new Set(
          installed.flatMap((row) => row.names.map((name) => name.toLowerCase())),
        );
        const en = freeInstalledName(manifest.name.en, taken);
        const zh = freeInstalledName(manifest.name.zh, taken);
        manifest = { ...manifest, name: { en, zh } };
      }
      input.commitSecrets?.();
      this.db
        .prepare(`INSERT INTO plugin_installations
        (id,plugin_id,version,manifest_json,digest,revision,source_kind,status,enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,1,?,'installed',?, ?,?)`)
        .run(
          installation.id,
          manifest.id,
          manifest.version,
          JSON.stringify(manifest),
          installation.digest,
          installation.sourceKind,
          installation.enabled ? 1 : 0,
          now,
          now,
        );
      this.db
        .prepare(
          "INSERT INTO plugin_access(installation_id,mode,bots_json,groups_json) VALUES(?,?,'[]','[]')",
        )
        // Something brought over from another AI tool is given to nobody in this same
        // transaction, so it is never briefly usable by every Bot. The same rule applies to
        // the brain-owned Notion connection, which is only lent out through a knowledge source.
        .run(
          installation.id,
          input.accessMode ?? (origin ? "selected" : newConnectionDefaults.accessMode),
        );
      if (origin)
        this.db
          .prepare(
            "UPDATE plugin_installations SET origin_tool=?,origin_key=?,origin_path=? WHERE id=?",
          )
          .run(
            origin.tool,
            origin.key,
            input.setupOrigin?.sourcePath ?? input.originPath ?? null,
            installation.id,
          );
      if (input.managedBy)
        this.db
          .prepare(
            "INSERT INTO knowledge_managed_installations(installation_id,created_at) VALUES(?,?)",
          )
          .run(installation.id, now);
      const insert = this.db.prepare(`INSERT INTO connectors
        (id,plugin_installation_id,server_id,revision,catalog_version,kind,identity,name,config_json,
        enabled,status,status_detail_code,removed_at,created_at,updated_at,confirmation_mode)
        VALUES(?,?,?,1,0,?,'user',?,?,0,'disabled',NULL,NULL,?,?,?)`);
      for (const server of manifest.servers) {
        const id = randomUUID();
        const kind =
          server.transport === "http"
            ? "mcp_remote"
            : server.transport === "stdio"
              ? "mcp_stdio"
              : "builtin";
        insert.run(
          id,
          installation.id,
          server.id,
          kind,
          manifest.name.en,
          JSON.stringify(server),
          now,
          now,
          input.confirmationMode ?? newConnectionDefaults.confirmationMode,
        );
        const denied = input.networkDenials?.get(server.id);
        if (denied?.size) writeNetworkDenials(this.db, id, denied);
        this.db
          .prepare(
            "INSERT INTO connector_access(connector_id,mode,bots_json) VALUES(?,'ask_first','[]')",
          )
          .run(id);
      }
      this.audit.append({
        botId: IdSchema.parse(input.actorBotId),
        kind: "plugin.changed",
        summary: connectorAuditEvents.plugin,
        detail: { installationId: installation.id, revision: 1 },
      });
      if (input.setupOrigin)
        this.audit.append({
          botId: input.actorBotId,
          kind: "plugin.changed",
          summary: connectorAuditEvents.broughtOver,
          detail: {
            installationId: installation.id,
            originTool: input.setupOrigin.tool,
            itemKind: "plugin",
            itemName: manifest.name.en.slice(0, 200),
            outcome: "imported",
          },
        });
      const enableOperations: ConnectorOperation[] = [];
      for (const connector of this.connections(installation.id))
        if (input.requestEnable)
          enableOperations.push(input.requestEnable(connector.id, connector.revision));
      return {
        installation,
        connectors: this.connections(installation.id),
        created: true,
        enableOperations,
      };
    });
  }

  origin(id: string) {
    const row = this.db
      .prepare(
        "SELECT origin_tool AS tool,origin_key AS key,origin_path AS path FROM plugin_installations WHERE id=?",
      )
      .get(IdSchema.parse(id));
    return row?.path
      ? { tool: String(row.tool ?? ""), key: String(row.key ?? ""), path: String(row.path) }
      : undefined;
  }

  manifest(id: string): ConnectorManifest | undefined {
    const row = this.db
      .prepare("SELECT manifest_json FROM plugin_installations WHERE id=?")
      .get(IdSchema.parse(id));
    if (!row) return undefined;
    return ConnectorManifestSchema.parse(JSON.parse(String(row.manifest_json)));
  }

  findBuiltPlugin(name: string, applicationId?: string) {
    const rows = applicationId
      ? this.db
          .prepare(
            "SELECT p.id FROM plugin_installations p JOIN settings s ON s.key='plugin-import:' || p.id WHERE p.source_kind='directory' AND p.status='installed' AND json_extract(s.value,'$.application')=1 AND json_extract(s.value,'$.applicationId')=? LIMIT 2",
          )
          .all(applicationId)
      : this.db
          .prepare(
            "SELECT id FROM plugin_installations WHERE source_kind='directory' AND status='installed' AND json_extract(manifest_json,'$.name.en')=? LIMIT 100",
          )
          .all(name);
    const applications = rows.filter((row) => this.isApplication(String(row.id)));
    if (applications.length > 1) connectorConflict();
    return applications[0] ? this.get(String(applications[0].id)) : undefined;
  }

  pendingBuiltSettings(id: string) {
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE connectors SET status='needs_setup',enabled=0 WHERE plugin_installation_id=? AND removed_at IS NULL",
        )
        .run(id);
    });
  }

  updateImported(input: {
    reconcileServers?: boolean;
    installationId: string;
    expectedRevision: number;
    manifest: ConnectorManifest;
    digest: string;
    actorBotId: string;
    commitSecrets?: () => void;
    changed: {
      commands: number;
      arguments: number;
      envNames: number;
      websites: number;
      files: number;
    };
  }) {
    return transaction(this.db, () => {
      const current = this.get(input.installationId);
      if (current?.status !== "installed") connectorMissing();
      if (current.revision !== input.expectedRevision) connectorConflict();
      input.commitSecrets?.();
      const now = new Date().toISOString();
      const old = new Map(
        this.db
          .prepare(
            "SELECT id,server_id,config_json FROM connectors WHERE plugin_installation_id=? AND removed_at IS NULL",
          )
          .all(input.installationId)
          .map((row) => [
            String(row.server_id),
            { id: String(row.id), config: String(row.config_json) },
          ]),
      );
      if (input.reconcileServers) {
        const incoming = new Set(input.manifest.servers.map((server) => server.id));
        for (const id of old.keys())
          if (!incoming.has(id))
            this.db
              .prepare(
                "UPDATE connectors SET removed_at=?,enabled=0,status='disabled' WHERE plugin_installation_id=? AND server_id=?",
              )
              .run(now, input.installationId, id);
        for (const server of input.manifest.servers)
          if (!old.has(server.id)) {
            const id = randomUUID();
            this.db
              .prepare(`INSERT INTO connectors (id,plugin_installation_id,server_id,revision,catalog_version,kind,identity,name,config_json,enabled,status,removed_at,created_at,updated_at,confirmation_mode)
            VALUES(?,?,?,1,0,?,'user',?,?,0,'disabled',NULL,?,?,?)`)
              .run(
                id,
                input.installationId,
                server.id,
                server.transport === "stdio" ? "mcp_stdio" : "mcp_remote",
                input.manifest.name.en,
                JSON.stringify(server),
                now,
                now,
                newConnectionDefaults.confirmationMode,
              );
            this.db
              .prepare(
                "INSERT INTO connector_access(connector_id,mode,bots_json) VALUES(?,'ask_first','[]')",
              )
              .run(id);
          }
      }
      const previous = new Map(
        this.manifest(input.installationId)?.servers.map((server) => [server.id, server]),
      );
      for (const server of input.manifest.servers) {
        const stored = old.get(server.id);
        if (!stored) continue;
        const configuration = preserveNetworkChoices(
          this.db,
          stored.id,
          server,
          previous.get(server.id),
          ConnectorServerSchema.parse(JSON.parse(stored.config)),
        );
        this.db
          .prepare(
            "UPDATE connectors SET config_json=?,revision=revision+1,catalog_version=catalog_version+1,updated_at=? WHERE plugin_installation_id=? AND server_id=? AND removed_at IS NULL",
          )
          .run(JSON.stringify(configuration), now, input.installationId, server.id);
      }
      this.db
        .prepare(
          "UPDATE plugin_installations SET manifest_json=?,digest=?,version=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(
          JSON.stringify(input.manifest),
          input.digest,
          input.manifest.version,
          now,
          input.installationId,
        );
      this.audit.append({
        botId: IdSchema.parse(input.actorBotId),
        kind: "plugin.changed",
        summary: connectorAuditEvents.pluginLifecycle,
        // The audit detail schema is strict and shared with the phone's records page; spreading the
        // change counts added unknown keys, so every confirmed update failed validation and rolled
        // back (Linux acceptance 2026-11-15). Record which parts changed with the existing field.
        detail: {
          installationId: input.installationId,
          reasonCode: "source_updated",
          fields: Object.entries(input.changed)
            .filter(([, count]) => count > 0)
            .map(([name]) => name),
        },
      });
      return this.get(input.installationId) as PluginInstallation;
    });
  }

  /** One installation is bounded by the manifest's 100-server cap; never a global list. */
  connections(id: string) {
    return this.db
      .prepare(`SELECT * FROM connectors WHERE plugin_installation_id=?
      AND removed_at IS NULL ORDER BY server_id LIMIT 100`)
      .all(id)
      .map(parseConnector);
  }
}
