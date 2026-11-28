import {
  type Connector,
  type ConnectorAccess,
  ConnectorAllowedSiteSchema,
  connectorEndpointSite,
  type MethodResults,
  newConnectionDefaults,
} from "@pibot/plugins-contract/full";
import {
  hostPlatform,
  SettingsFold,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useSettings,
} from "@pibot/renderer-kit";
import { Chip, Icon, IconTile } from "@pibot/ui";
import { useId } from "react";
import { ConnectorAccessEditor } from "../page/ConnectorAccessEditor.tsx";
import { DrawerHero } from "../page/connections/DrawerParts.tsx";
import styles from "../page/connections/drawer.module.css";
import { guideLinkKey, localText } from "../page/connections/local-text.ts";
import { fieldVisible, PluginSettingField } from "../page/connections/PluginSettingField.tsx";

type Preview = MethodResults["plugins.previewImport"];
type ConfigValue = string | number | boolean;
type ConfigField = NonNullable<Preview["plugin"]>["config"][number];

// Keep only reviewable, sanitized metadata, never a second copy of raw JSON or headers/env values.
export function previewSummary(value: Preview) {
  return {
    previewId: value.previewId,
    digest: value.digest,
    expiresAt: value.expiresAt,
    fromBringOver: value.fromBringOver === true,
    declaredVersion: value.declaredVersion,
    name: value.manifest.name,
    description: value.manifest.description,
    plugin: value.plugin,
    commandWarnings: value.commandWarnings,
    ignoredMcpMetadata: value.ignoredMcpMetadata,
    requiredKeys: value.requiredKeys ?? [],
    plainFields: value.plainFields ?? [],
    servers: value.manifest.servers.map((server) => ({
      id: server.id,
      transport: server.transport,
      auth: server.auth.kind,
      secrets: server.auth.secretNames,
      savedKeys: value.savedKeys?.find(({ serverId }) => serverId === server.id)?.names ?? [],
      fields: Object.keys(
        server.transport === "stdio"
          ? server.env
          : server.transport === "http"
            ? server.headers
            : {},
      ),
      domains:
        server.transport === "stdio"
          ? server.networkDomains.filter(
              (site) => ConnectorAllowedSiteSchema.safeParse(site).success,
            )
          : [],
      endpoint:
        server.transport === "http" ? connectorEndpointSite(new URL(server.url)) : undefined,
      cwd: server.transport === "stdio" ? server.cwd : undefined,
      startupTimeoutSec: server.startupTimeoutSec,
      command: server.transport === "stdio" ? server.command : undefined,
      args: server.transport === "stdio" ? server.args : [],
      bundledNode:
        !!value.plugin &&
        server.transport === "stdio" &&
        (server.command === "node" || server.command === "node.exe"),
    })),
  };
}
export type PreviewSummary = ReturnType<typeof previewSummary>;

export { fieldVisible };

/** The program name only; arguments can carry paths and are not something to read here. */
function commandName(command: string) {
  return command.split(/[\\/]/).at(-1) ?? command;
}

/**
 * The connect drawer's body for an imported package or MCP configuration: what it is, what to
 * prepare, the settings to fill, what it can do, and the technical details folded away.
 */
export function ImportPreview({
  preview,
  config,
  setValue,
  plainFields,
  setPlainFields,
  useSavedKeys,
  setUseSavedKeys,
  disabled,
  checking,
  settingsError,
  targets,
  setTargets,
  targetRequired = false,
}: {
  preview: PreviewSummary;
  config: Record<string, ConfigValue>;
  setValue(key: string, value: ConfigValue): void;
  plainFields: string[];
  setPlainFields(names: string[]): void;
  useSavedKeys: boolean;
  setUseSavedKeys(value: boolean): void;
  disabled: boolean;
  checking: boolean;
  settingsError?: string;
  targets: ConnectorAccess;
  setTargets(access: ConnectorAccess): void;
  targetRequired?: boolean;
}) {
  const { t, language } = useSettings();
  const inputId = useId();
  const card = preview.plugin?.application;
  const name = card?.name[language] || localText(preview.name[language], language);
  const mode = card?.modes[0];
  const help = mode?.help[language];
  const fields = preview.plugin?.config ?? [];
  const local = preview.servers.some((server) => server.transport === "stdio");
  const windows = hostPlatform() === "win32";
  // Widened on purpose: the rows follow whatever the default becomes.
  const confirmation: Connector["confirmationMode"] =
    newConnectionDefaults.confirmationMode as Connector["confirmationMode"];
  // Imported secrets are stored as IMPORT_<installation>_<setting>; people read the setting's title.
  const titleOf = (name: string) => {
    const field = fields.find(
      (candidate) => candidate.key === name || name.endsWith(`_${candidate.key}`),
    );
    return field
      ? localText(field.title, language)
      : name.replace(/^IMPORT_[0-9A-F]+_(?:S\d+_)?/, "");
  };
  const secretNames = [...new Set(preview.servers.flatMap((server) => server.secrets))];
  const pendingKeys = new Set(preview.requiredKeys.map(({ name }) => name));
  const localSites = [...new Set(preview.servers.flatMap((server) => server.domains))];
  const remoteSites = [
    ...new Set(preview.servers.flatMap(({ endpoint }) => (endpoint ? [endpoint] : []))),
  ];
  const dangerousCommand = preview.commandWarnings?.includes("dangerous");
  const showTrustWarning = !preview.plugin || preview.commandWarnings?.includes("unverified");
  const trustWarning = showTrustWarning
    ? [
        t("connections.drawer.importTrust"),
        t(
          local && !windows
            ? remoteSites.length
              ? "connections.drawer.importTrust.mixed"
              : "connections.drawer.importTrust.sandboxed"
            : "connections.drawer.importTrust.trusted",
        ),
        remoteSites.length > 0 && t("connections.drawer.importTrust.remote"),
      ]
        .filter(Boolean)
        .join(language === "zh" ? "" : " ")
    : undefined;
  const siteChips = (sites: string[]) => (
    <span className={styles.siteChips}>
      {sites.map((site) => (
        <Chip key={site} className={styles.mono}>
          {site}
        </Chip>
      ))}
    </span>
  );
  const skipped = (preview.plugin?.components ?? []).filter(
    (component) => component.status === "unsupported",
  );
  const skippedCustomSkills = skipped.filter(
    (component) =>
      component.reason === "not-supported" &&
      (component.name === "plugin.json skills" || component.name === "plugin.json commands"),
  );
  const skippedOther = skipped.filter((component) => !skippedCustomSkills.includes(component));
  const sandbox = t(
    windows ? "connections.drawer.run.unsandboxed" : "connections.drawer.run.sandboxed",
  );
  const runs = preview.servers.map((server) => {
    const base =
      server.transport === "http"
        ? t("connections.drawer.run.remote", { url: server.endpoint ?? "" })
        : server.transport === "stdio"
          ? `${
              server.bundledNode
                ? t("connections.drawer.run.node")
                : t("connections.drawer.run.command", {
                    command: commandName(server.command ?? ""),
                  })
            }${sandbox}`
          : t("connections.drawer.run.builtin");
    const extras = [
      server.cwd && t("connectors.startup.cwd", { cwd: server.cwd }),
      server.startupTimeoutSec &&
        t("connectors.startup.timeout", { seconds: String(server.startupTimeoutSec) }),
    ].filter(Boolean);
    const detail = [base, ...extras].join(language === "zh" ? "；" : "; ");
    return preview.servers.length > 1
      ? t("connections.drawer.run.extra", { id: server.id, detail })
      : detail;
  });
  const field = (item: ConfigField) => (
    <PluginSettingField
      key={item.key}
      field={item}
      fields={fields}
      config={config}
      idPrefix={inputId}
      disabled={disabled}
      setValue={setValue}
    />
  );
  return (
    <div className={styles.drawer}>
      <DrawerHero
        name={name}
        note={card?.description[language] || localText(preview.description[language], language)}
        chips={
          <>
            <Chip>
              {preview.plugin
                ? preview.declaredVersion
                  ? t("connections.drawer.chip.plugin", { version: preview.declaredVersion })
                  : t("connections.drawer.chip.pluginNoVersion")
                : t("connections.drawer.chip.mcp")}
            </Chip>
            {preview.servers.length > 0 && (
              <Chip>
                {t(local ? "connections.drawer.chip.local" : "connections.drawer.chip.remote")}
              </Chip>
            )}
          </>
        }
      />
      {preview.ignoredMcpMetadata && (
        <SettingsLine>{t("connectors.paste.ignoredMetadata")}</SettingsLine>
      )}
      {(trustWarning || dangerousCommand || (windows && local)) && (
        <div className={styles.lines}>
          {dangerousCommand && (
            <SettingsLine tone="danger" dot="danger" role="alert">
              {t("connectors.commandDangerous")}
            </SettingsLine>
          )}
          {trustWarning && (
            <SettingsLine dot="warn" role="alert">
              {trustWarning}
            </SettingsLine>
          )}
          {windows && local && (
            <SettingsLine dot="warn" role="alert">
              {t("connectors.windowsWarning")}
            </SettingsLine>
          )}
        </div>
      )}
      {help && (
        <SettingsSection title={t("connections.drawer.prep")}>
          <div className={styles.prep}>
            <IconTile icon="file" tone="amber" size="lg" />
            <div className={styles.prepText}>
              <span>{help}</span>
              {mode?.documentationUrl && (
                <a
                  className={styles.link}
                  href={mode.documentationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t(guideLinkKey(name), { name })}
                  <Icon name="link" size={13} />
                </a>
              )}
            </div>
          </div>
        </SettingsSection>
      )}
      {(remoteSites.length > 0 ||
        secretNames.length > 0 ||
        preview.servers.some((server) => server.fields.length > 0)) && (
        <SettingsSection title={t("connectors.paste.recipients")}>
          {preview.servers
            .filter((server) => server.endpoint || server.secrets.length || server.fields.length)
            .map((server) => {
              const keys = server.secrets.filter((key) => !pendingKeys.has(key));
              const shownFields = server.fields.map((field) =>
                preview.plainFields.some(
                  ({ name, label, serverId }) =>
                    serverId === server.id && label === field && plainFields.includes(name),
                )
                  ? t("connectors.paste.plainField", { label: field })
                  : field,
              );
              const joinNames = (names: string[]) => names.join(language === "zh" ? "、" : ", ");
              const savedKeyNote =
                server.savedKeys.length > 0 &&
                (server.command
                  ? t("connectors.paste.savedKeysForProgram", {
                      names: joinNames(server.savedKeys),
                      program: commandName(server.command),
                    })
                  : t("connectors.paste.savedKeys", { names: joinNames(server.savedKeys) }));
              return (
                <SettingsRow
                  key={server.id}
                  icon={server.endpoint ? "globe" : "key"}
                  tone="blue"
                  label={preview.servers.length > 1 ? server.id : name}
                  note={
                    savedKeyNote
                      ? [
                          savedKeyNote,
                          shownFields.length > 0 &&
                            t("connectors.paste.configurationFields", {
                              names: joinNames(shownFields),
                            }),
                        ]
                          .filter(Boolean)
                          .join(language === "zh" ? "" : " ")
                      : !preview.plugin && shownFields.length
                        ? t("connectors.paste.protectedFields", { names: joinNames(shownFields) })
                        : keys.length
                          ? t("connections.drawer.secretsCount", {
                              count: keys.length,
                              names: keys.map(titleOf).join(language === "zh" ? "、" : ", "),
                            })
                          : undefined
                  }
                >
                  {server.endpoint && siteChips([server.endpoint])}
                </SettingsRow>
              );
            })}
          {preview.servers.some((server) => server.savedKeys.length) && (
            <label className={styles.inlineActions}>
              <input
                type="checkbox"
                checked={useSavedKeys}
                disabled={disabled || checking}
                onChange={(event) => setUseSavedKeys(event.currentTarget.checked)}
              />
              {t("connectors.paste.useSavedKeys")}
            </label>
          )}
        </SettingsSection>
      )}
      {preview.requiredKeys.length > 0 && (
        <SettingsSection title={t("connectors.paste.fillKeys")}>
          {preview.requiredKeys.map(({ name: keyName, label, serverId }) => (
            <div key={keyName} className={styles.stackedControl}>
              <label className={styles.stackedControl} htmlFor={`${inputId}-${keyName}`}>
                {t("connectors.paste.fillKey", {
                  label,
                  service: preview.servers.length > 1 ? serverId : name,
                })}
                <input
                  id={`${inputId}-${keyName}`}
                  type="password"
                  autoComplete="new-password"
                  maxLength={4096}
                  disabled={disabled}
                  value={String(config[keyName] ?? "")}
                  onChange={(event) => setValue(keyName, event.currentTarget.value)}
                />
              </label>
            </div>
          ))}
          <SettingsLine>{t("connectors.paste.keyNote")}</SettingsLine>
        </SettingsSection>
      )}
      {fields.length > 0 && (
        <SettingsSection
          title={t("connections.drawer.fill")}
          action={
            checking ? (
              <small className={styles.fieldNote} role="status">
                {t("connections.drawer.checking")}
              </small>
            ) : undefined
          }
        >
          {fields.map(field)}
          {settingsError && (
            <SettingsLine tone="danger" dot="danger" role="alert">
              {settingsError}
            </SettingsLine>
          )}
        </SettingsSection>
      )}
      {preview.servers.length > 0 && (
        <SettingsSection
          title={t("connections.drawer.can")}
          action={<small className={styles.fieldNote}>{t("connections.drawer.canLater")}</small>}
        >
          <SettingsRow
            icon="eye"
            tone="blue"
            label={t("connections.drawer.read")}
            note={t(
              confirmation === "always_ask"
                ? "connectors.paste.asksToUse"
                : "connections.drawer.readFree",
            )}
          >
            <Chip tone={confirmation === "always_ask" ? "orange" : "neutral"}>
              {t(
                confirmation === "always_ask"
                  ? "connections.drawer.chipAsk"
                  : "connections.drawer.chipDirect",
              )}
            </Chip>
          </SettingsRow>
          <SettingsRow
            icon="edit"
            tone="orange"
            label={t("connections.drawer.write")}
            note={t(
              confirmation === "read_only"
                ? "connections.drawer.writeOff"
                : "connections.drawer.writeAsk",
            )}
          >
            <Chip tone={confirmation === "read_only" ? "neutral" : "orange"}>
              {t(
                confirmation === "read_only"
                  ? "connections.drawer.chipOff"
                  : "connections.drawer.chipAsk",
              )}
            </Chip>
          </SettingsRow>
          <SettingsLine>
            {preview.fromBringOver
              ? t("connections.drawer.accessDefaultBringOver")
              : t("connections.drawer.accessDefault", {
                  access: t(`connectors.access.${newConnectionDefaults.accessMode}`),
                })}
          </SettingsLine>
        </SettingsSection>
      )}
      {!!preview.plugin?.skillCount && (
        <>
          {!preview.servers.length && (
            <SettingsSection title={t("connections.drawer.can")}>
              <SettingsRow
                icon="puzzle"
                tone="violet"
                label={t("connections.drawer.skills", { count: preview.plugin.skillCount })}
                note={preview.plugin.components
                  .filter(
                    (component) => component.kind === "skill" && component.status === "import",
                  )
                  .map((component) => localText(component.name, language))
                  .join(language === "zh" ? "、" : ", ")}
              />
            </SettingsSection>
          )}
          <div className={targetRequired ? styles.targetRequired : undefined}>
            <ConnectorAccessEditor access={targets} disabled={disabled} save={setTargets} />
          </div>
          {!targets.bots.length && !targets.groups.length && (
            <p className={styles.fieldNote}>
              {t(
                targetRequired
                  ? "connectors.skillOnlyTargetRequired"
                  : "connectors.skillTargetRequired",
              )}
            </p>
          )}
        </>
      )}
      {skipped.length > 0 && (
        <div className={styles.lines}>
          {skippedCustomSkills.length > 0 && (
            <SettingsLine dot="warn" role="status">
              {t("connectors.skippedCustomSkills")}
            </SettingsLine>
          )}
          {skippedOther.length > 0 && (
            <SettingsLine dot="warn" role="status">
              {t("connectors.skippedOtherNotice", { count: skippedOther.length })}
            </SettingsLine>
          )}
        </div>
      )}
      <SettingsFold
        title={t("connections.drawer.tech")}
        summary={t("connections.drawer.techSummary")}
        icon="server"
        tone="neutral"
      >
        {preview.servers.length > 0 && (
          <SettingsRow
            icon="terminal"
            tone="teal"
            label={t("connections.drawer.run")}
            note={runs.join(" · ")}
          />
        )}
        {preview.servers
          .filter(({ args }) => args.length > 0)
          .map((server) => (
            <SettingsRow
              key={server.id}
              icon="terminal"
              tone="blue"
              label={t("connectors.paste.launchOptions", {
                command: commandName(server.command ?? ""),
              })}
              note={
                <code className={styles.mono}>
                  {server.args
                    .map((arg) => (/\s|^$/.test(arg) ? JSON.stringify(arg) : arg))
                    .join(" ")}
                </code>
              }
            />
          ))}
        {local && (
          <SettingsRow
            icon="globe"
            tone="blue"
            label={t("connections.drawer.sites")}
            note={t(windows ? "connectors.network.unisolated" : "connectors.network.requestNote")}
          >
            {!windows && localSites.length > 0 && siteChips(localSites)}
          </SettingsRow>
        )}
        {remoteSites.length > 0 && (
          <SettingsRow
            icon="globe"
            tone="blue"
            label={t("connectors.network.declared")}
            note={t("connectors.network.remote")}
          >
            {siteChips(remoteSites)}
          </SettingsRow>
        )}
        {preview.plugin && preview.servers.length > 0 && (
          <SettingsRow
            icon="key"
            tone="pink"
            label={t("connections.drawer.secrets")}
            note={
              secretNames.length
                ? t("connections.drawer.secretsCount", {
                    count: secretNames.length,
                    names: secretNames.map(titleOf).join(language === "zh" ? "、" : ", "),
                  })
                : t("connections.drawer.secretsNone")
            }
          />
        )}
        {preview.plainFields.length > 0 && (
          <SettingsSection title={t("connectors.paste.plainFields")}>
            <p className={styles.fieldNote}>{t("connectors.paste.plainFieldsNote")}</p>
            {preview.plainFields.map(({ name: field, label, serverId }) => (
              <label key={field}>
                <input
                  type="checkbox"
                  checked={plainFields.includes(field)}
                  disabled={disabled}
                  onChange={(event) =>
                    setPlainFields(
                      event.currentTarget.checked
                        ? [...plainFields, field]
                        : plainFields.filter((name) => name !== field),
                    )
                  }
                />{" "}
                {preview.servers.length > 1 ? `${serverId} · ${label}` : label}
              </label>
            ))}
          </SettingsSection>
        )}
        {skipped.length > 0 && (
          <SettingsRow
            icon="warning"
            tone="amber"
            label={t("connections.drawer.skipped")}
            note={skipped
              .map((component) =>
                component.reason
                  ? `${component.name} · ${t(`connectors.unsupported.${component.reason}`)}`
                  : component.name,
              )
              .join(language === "zh" ? "；" : "; ")}
          />
        )}
        <SettingsRow
          icon="shield"
          tone="green"
          label={t("connections.drawer.source")}
          note={
            <>
              <span>
                {t(
                  preview.plugin
                    ? "connections.drawer.chip.pluginNoVersion"
                    : "connections.drawer.chip.mcp",
                )}
              </span>
              <br />
              <code className={styles.mono}>
                {t("connections.drawer.source.digest", { digest: preview.digest.slice(0, 8) })}
              </code>
            </>
          }
        />
      </SettingsFold>
    </div>
  );
}
