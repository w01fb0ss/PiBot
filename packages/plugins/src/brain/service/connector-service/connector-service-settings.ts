// 高级 → 设置: an installed package's plain settings (a folder, a region, a client id) changed
// after install. Secret settings keep their own replace flow and are never read or listed here.
import { join } from "node:path";
import { RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import {
  type ConnectorPreview,
  editablePluginSettings,
  pluginSettingSecretName,
  pluginSettingsTemplate,
  reconfigureInstalledPlugin,
  USER_SECRET_SCOPE,
} from "../connector-import.ts";
import type { ConnectorServiceOperations } from "../connector-service.ts";

type SettingValue = string | number | boolean;

function installed(ops: ConnectorServiceOperations, installationId: string) {
  const installation = ops.deps.plugins.get(installationId);
  if (installation?.status !== "installed")
    throw new RpcError(RpcErrorCodes.connectorUnavailable, "Installation unavailable");
  return installation;
}

/** Settings whose value lives in the secret store, by the name the import gave it. */
function storedSecretKeys(
  ops: ConnectorServiceOperations,
  installationId: string,
  keys: readonly string[],
) {
  return new Set(
    keys.filter((key) =>
      ops.deps.secrets.has(USER_SECRET_SCOPE, pluginSettingSecretName(installationId, key)),
    ),
  );
}

export function pluginSettingsStep(
  this: ConnectorServiceOperations,
  { installationId }: { installationId: string },
) {
  const installation = installed(this, installationId);
  const stored = this.deps.plugins.importSettings(installationId);
  const template = stored?.template;
  if (!template)
    return {
      installationId,
      revision: installation.revision,
      editable: false,
      fields: [],
      values: {},
    };
  const secrets = storedSecretKeys(
    this,
    installationId,
    template.config.map((field) => field.key),
  );
  const fields = editablePluginSettings(template.config, secrets);
  const keys = new Set(fields.map((field) => field.key));
  return {
    installationId,
    revision: installation.revision,
    editable: fields.length > 0,
    fields,
    values: Object.fromEntries(
      Object.entries(stored.config).filter(([key]) => keys.has(key)),
    ) as Record<string, SettingValue>,
  };
}

export async function updatePluginSettingsStep(
  this: ConnectorServiceOperations,
  input: {
    installationId: string;
    expectedRevision: number;
    config: Record<string, SettingValue>;
  },
  signal?: AbortSignal,
) {
  const installation = installed(this, input.installationId);
  if (installation.revision !== input.expectedRevision)
    throw new RpcError(RpcErrorCodes.connectorStale, "Installation revision changed");
  const stored = this.deps.plugins.importSettings(input.installationId);
  const template = stored?.template;
  if (!template) throw new RpcError(RpcErrorCodes.invalidParams, "plugin_settings_unavailable");
  const secrets = storedSecretKeys(
    this,
    input.installationId,
    template.config.map((field) => field.key),
  );
  const editable = new Set(editablePluginSettings(template.config, secrets).map((f) => f.key));
  for (const key of Object.keys(input.config))
    if (!editable.has(key))
      throw new RpcError(RpcErrorCodes.invalidParams, "plugin_setting_not_editable");
  // Only plain settings are ever kept; anything else in the row is not carried forward.
  const previous = Object.fromEntries(
    Object.entries(stored.config).filter(([key]) => editable.has(key)),
  );
  const config = { ...previous, ...input.config };
  const changed = [...editable].filter((key) => config[key] !== previous[key]);
  if (!changed.length) return { installation, changed: [], operationIds: [] };
  const current = this.deps.plugins.manifest(input.installationId);
  if (!current) throw new RpcError(RpcErrorCodes.connectorUnavailable, "Manifest unavailable");
  const root = this.deps.dataDir
    ? join(this.deps.dataDir, "plugins", input.installationId)
    : undefined;
  const finalized = reconfigureInstalledPlugin(
    template,
    input.installationId,
    root,
    config,
    secrets,
  );
  // A setting picks values inside the same servers; it never adds or drops a connection.
  const before = new Set(current.servers.map((server) => server.id));
  if (
    finalized.manifest.servers.length !== before.size ||
    finalized.manifest.servers.some((server) => !before.has(server.id))
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "plugin_settings_server_set_changed");
  // A plain field given something that reads as a credential is stored as one, as at import. It
  // is written before the manifest that names it: an unused value in this installation's own
  // namespace is harmless, a reference to a missing one is not.
  for (const secret of finalized.secrets)
    await this.deps.secrets.set(USER_SECRET_SCOPE, secret.name, secret.value);
  signal?.throwIfAborted();
  // The name, id and version stay the installation's own; only server settings change.
  const manifest = {
    ...finalized.manifest,
    id: current.id,
    version: current.version,
    name: current.name,
    description: current.description,
  };
  const updated = this.deps.plugins.applyImportSettings({
    installationId: input.installationId,
    expectedRevision: input.expectedRevision,
    manifest,
    digest: finalized.digest,
    config: finalized.settings,
    changed,
    actorBotId: this.deps.actorBotId,
  });
  const operationIds: string[] = [];
  for (const connector of this.deps.plugins.connections(input.installationId)) {
    this.targets.delete(connector.id);
    this.emitConnectorChanged(connector.id);
    if (!connector.enabled) continue;
    // The same restart as 测试连接, including Windows' consent for a changed configuration.
    const { operationId } = await this.owner.restart(
      { id: connector.id, expectedRevision: connector.revision },
      signal,
    );
    operationIds.push(operationId);
  }
  return { installation: updated, changed, operationIds };
}

/**
 * 从来源更新 re-reads a package without its settings, so its preview holds placeholders where the
 * person's values were. Evaluated with the installation's own plain settings and stored secrets
 * instead, an update keeps them. When that cannot be done (the new version requires a setting it
 * did not have), the plain preview is used as before and the person fills it in again.
 */
export function sourceWithInstalledSettings(
  ops: ConnectorServiceOperations,
  installationId: string,
  preview: ConnectorPreview,
) {
  if (!preview.plugin) return { manifest: preview.manifest };
  const plugin = preview.plugin;
  const secrets = storedSecretKeys(
    ops,
    installationId,
    plugin.config.map((field) => field.key),
  );
  const editable = new Set(editablePluginSettings(plugin.config, secrets).map((f) => f.key));
  const stored = ops.deps.plugins.importSettings(installationId);
  const config = Object.fromEntries(
    Object.entries(stored?.config ?? {}).filter(([key]) => editable.has(key)),
  );
  const template = pluginSettingsTemplate(plugin, installationId, preview.installationRoot);
  try {
    const finalized = reconfigureInstalledPlugin(
      plugin,
      installationId,
      preview.installationRoot,
      config,
      secrets,
    );
    // Stored plain values were not credentials at import; one that reads as one now has no
    // stored value to point at, so keep the plain preview rather than a dangling reference.
    if (finalized.secrets.length) return { manifest: preview.manifest, template };
    return { manifest: finalized.manifest, template, config: finalized.settings };
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    return { manifest: preview.manifest, template };
  }
}
