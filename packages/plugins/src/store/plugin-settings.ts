// An imported package's plain settings after install: what it was given, the template that
// re-evaluates it, and the one transaction that applies a change. Values of secret settings are
// never here; they stay in the secret store under their own names.
import type { DatabaseSync } from "node:sqlite";
import {
  type ClaudePluginBundle,
  ClaudePluginBundleSchema,
  type ConnectorManifest,
  ConnectorManifestSchema,
  ConnectorNetworkSiteSchema,
  ConnectorServerSchema,
  connectorAuditEvents,
  connectorEndpointSite,
  IdSchema,
  type PluginInstallation,
} from "@pibot/plugins-contract/full";
import type { AuditRepo } from "@pibot/storage";
import { transaction } from "@pibot/storage";
import { z } from "zod";
import { connectorConflict, connectorMissing } from "./connector-records.ts";

type SettingValue = string | number | boolean;
const settingsKey = (installationId: string) => `plugin-import:${IdSchema.parse(installationId)}`;
// The row also carries skill and application bookkeeping that other readers own; only these two
// keys are read here, and a write keeps the rest as it was.
const StoredSettingsSchema = z.object({
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  template: ClaudePluginBundleSchema.optional(),
});
const AUDIT_FIELD = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

function storedRow(db: DatabaseSync, installationId: string): Record<string, unknown> | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(settingsKey(installationId));
  if (!row) return undefined;
  try {
    const value: unknown = JSON.parse(String(row.value));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    // A row this release cannot read only means its settings are not editable here.
    return undefined;
  }
}

export function readImportSettings(
  db: DatabaseSync,
  installationId: string,
): { config: Record<string, SettingValue>; template?: ClaudePluginBundle } | undefined {
  const parsed = StoredSettingsSchema.safeParse(storedRow(db, installationId));
  return parsed.success ? parsed.data : undefined;
}

const networkDenialsKey = (id: string) => `connector-network-denials:${IdSchema.parse(id)}`;
const networkDenialsSchema = z.array(ConnectorNetworkSiteSchema);

export function readNetworkDenials(db: DatabaseSync, id: string): string[] {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(networkDenialsKey(id));
  return row ? networkDenialsSchema.parse(JSON.parse(String(row.value))) : [];
}

export function writeNetworkDenials(db: DatabaseSync, id: string, sites: ReadonlySet<string>) {
  const key = networkDenialsKey(id);
  if (!sites.size) db.prepare("DELETE FROM settings WHERE key=?").run(key);
  else
    db.prepare(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(key, JSON.stringify([...sites].sort()));
}

export function remoteNetworkSite(
  server: Extract<ConnectorManifest["servers"][number], { transport: "http" }>,
  declared: ConnectorManifest["servers"][number] | undefined,
  denied: ReadonlySet<string>,
) {
  const url = new URL(server.url);
  const site = connectorEndpointSite(url);
  const host = url.hostname.replace(/\.$/u, "");
  const websites = declared?.transport === "http" ? declared.networkDomains : [];
  // Before port-specific approvals, remote connectors stored the hostname of their one URL.
  const legacyHost = site !== host && !websites.includes(site);
  const legacyAllowed = legacyHost && !denied.has(host) && server.networkDomains.includes(host);
  // An empty legacy row also represents a removed website. Only a saved grant counts.
  const allowed = !denied.has(site) && (server.networkDomains.includes(site) || legacyAllowed);
  return { site, allowed };
}

/** The row is the allow-list. Recover removals from legacy rows before replacing the source. */
export function preserveNetworkChoices(
  db: DatabaseSync,
  id: string,
  server: ConnectorManifest["servers"][number],
  previous: ConnectorManifest["servers"][number] | undefined,
  stored: ConnectorManifest["servers"][number],
) {
  const denied = new Set(readNetworkDenials(db, id));
  if (stored.transport === previous?.transport) {
    const allowed = new Set(stored.networkDomains);
    for (const site of previous.networkDomains) if (!allowed.has(site)) denied.add(site);
  }
  const priorEndpoint =
    stored.transport === "http" ? remoteNetworkSite(stored, previous, denied) : undefined;
  if (
    priorEndpoint &&
    !priorEndpoint.allowed &&
    ConnectorNetworkSiteSchema.safeParse(priorEndpoint.site).success
  )
    denied.add(priorEndpoint.site);
  writeNetworkDenials(db, id, denied);
  if (server.transport === "http") {
    const networkDomains = server.networkDomains.filter((site) => !denied.has(site));
    const endpoint = connectorEndpointSite(new URL(server.url));
    if (
      priorEndpoint?.site === endpoint &&
      priorEndpoint.allowed &&
      !networkDomains.includes(endpoint)
    )
      networkDomains.unshift(endpoint);
    return { ...server, networkDomains: networkDomains.slice(0, 64) };
  }
  if (server.transport !== "stdio") return server;
  const prior = stored.transport === "stdio" ? stored.networkDomains : [];
  return {
    ...server,
    // Old rows cannot tell us about a removed site the source did not originally declare.
    // Keep the existing allow-list; a new source declaration still needs explicit approval.
    networkDomains: prior.filter((site) => !denied.has(site)),
  };
}

export function applyImportSettings(
  db: DatabaseSync,
  audit: AuditRepo,
  current: () => PluginInstallation | undefined,
  input: {
    installationId: string;
    expectedRevision: number;
    manifest: ConnectorManifest;
    digest: string;
    config: Record<string, SettingValue>;
    changed: readonly string[];
    actorBotId: string;
  },
): PluginInstallation {
  return transaction(db, () => {
    const installation = current();
    if (installation?.status !== "installed") connectorMissing();
    if (installation.revision !== input.expectedRevision) connectorConflict();
    const installedRow = db
      .prepare("SELECT manifest_json FROM plugin_installations WHERE id=?")
      .get(input.installationId);
    const installed = ConnectorManifestSchema.parse(
      JSON.parse(String(installedRow?.manifest_json)),
    );
    const before = new Map(installed.servers.map((server) => [server.id, server]));
    const now = new Date().toISOString();
    for (const server of input.manifest.servers) {
      const row = db
        .prepare(
          "SELECT id,config_json FROM connectors WHERE plugin_installation_id=? AND server_id=? AND removed_at IS NULL",
        )
        .get(input.installationId, server.id);
      if (!row) connectorMissing();
      const stored = ConnectorServerSchema.parse(JSON.parse(String(row.config_json)));
      const next = preserveNetworkChoices(
        db,
        String(row.id),
        server,
        before.get(server.id),
        stored,
      );
      db.prepare(
        "UPDATE connectors SET config_json=?,revision=revision+1,catalog_version=catalog_version+1,updated_at=? WHERE id=?",
      ).run(JSON.stringify(next), now, String(row.id));
    }
    db.prepare(
      "UPDATE plugin_installations SET manifest_json=?,digest=?,revision=revision+1,updated_at=? WHERE id=?",
    ).run(JSON.stringify(input.manifest), input.digest, now, input.installationId);
    db.prepare("UPDATE settings SET value=? WHERE key=?").run(
      JSON.stringify({ ...storedRow(db, input.installationId), config: input.config }),
      settingsKey(input.installationId),
    );
    audit.append({
      botId: IdSchema.parse(input.actorBotId),
      kind: "plugin.changed",
      summary: connectorAuditEvents.settings,
      // Which settings changed, never their values.
      detail: {
        installationId: input.installationId,
        reasonCode: "settings_changed",
        fields: input.changed.filter((key) => AUDIT_FIELD.test(key)).slice(0, 40),
      },
    });
    return current() as PluginInstallation;
  });
}

/** After 从来源更新: the new version's template, and the plain values it was evaluated with. */
export function refreshSettingsTemplate(
  db: DatabaseSync,
  installationId: string,
  template: ClaudePluginBundle | undefined,
  config?: Record<string, SettingValue>,
) {
  const row = storedRow(db, installationId);
  if (!row) return;
  const { template: _previous, ...rest } = row;
  db.prepare("UPDATE settings SET value=? WHERE key=?").run(
    JSON.stringify({ ...rest, ...(config ? { config } : {}), ...(template ? { template } : {}) }),
    settingsKey(installationId),
  );
}
