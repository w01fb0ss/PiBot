// 高级 → 设置: an installed package's plain settings, edited with the connect drawer's fields.
// Secret settings never come here (the brain does not list them); keys keep their own 更换 row.
import type { MethodResults } from "@pibot/plugins-contract/full";
import { type Peer, SettingsLine, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useId, useState } from "react";
import { useConnectorAction, useConnectorRead } from "../../shell/remote.ts";
import styles from "../connections/drawer.module.css";
import { fieldVisible, PluginSettingField } from "../connections/PluginSettingField.tsx";

type ConfigValue = string | number | boolean;
type Settings = MethodResults["plugins.settings"];

/** Loads the plain settings again whenever the connection's snapshot moves on. */
export function usePluginSettings(installationId: string | undefined, snapshot: number) {
  const settings = useConnectorRead(
    useCallback(
      (peer: Peer, signal: AbortSignal): Promise<Settings | undefined> =>
        installationId
          ? peer.call("plugins.settings", { installationId }, { signal })
          : Promise.resolve(undefined),
      [installationId],
    ),
  );
  const refresh = settings.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: every connector event retires the snapshot.
  useEffect(() => refresh(), [snapshot, refresh]);
  return settings;
}

export function PluginSettingsFields({
  settings,
  disabled,
  changed,
  saved,
}: {
  settings: Settings;
  disabled: boolean;
  /** After any attempt, saved or refused, the detail reads the authoritative state again. */
  changed(): void;
  /** The restarts a save started, for the detail to follow. */
  saved(operationIds: readonly string[]): void;
}) {
  const { t } = useSettings();
  const idPrefix = useId();
  const [draft, setDraft] = useState<Record<string, ConfigValue>>();
  const [done, setDone] = useState(false);
  const action = useConnectorAction(changed);
  // A newer snapshot (saved here, or changed elsewhere) replaces what was being edited.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the installation revision.
  useEffect(() => setDraft(undefined), [settings.revision]);
  const values = draft ?? settings.values;
  const visible = settings.fields.filter((field) => fieldVisible(field, settings.fields, values));
  const dirty = visible.some((field) => values[field.key] !== settings.values[field.key]);
  const missing = visible.some((field) => {
    if (!field.required) return false;
    const value = values[field.key];
    return (
      value === undefined ||
      (typeof value === "string" && !value.trim()) ||
      (typeof value === "number" && !Number.isFinite(value))
    );
  });
  const save = async () => {
    if (!dirty || missing || action.busy) return;
    const config = Object.fromEntries(
      visible
        .filter((field) => values[field.key] !== undefined)
        .map((field) => [field.key, values[field.key] as ConfigValue]),
    );
    const result = await action.run(
      (peer, signal) =>
        peer.call(
          "plugins.updateSettings",
          { installationId: settings.installationId, expectedRevision: settings.revision, config },
          { signal },
        ),
      330_000,
    );
    if (!result) return;
    setDone(true);
    saved(result.operationIds);
  };
  return (
    <>
      {settings.fields.map((field) => (
        <PluginSettingField
          key={field.key}
          field={field}
          fields={settings.fields}
          config={values}
          idPrefix={idPrefix}
          disabled={disabled || action.busy}
          showFullPath
          setValue={(key, value) => {
            setDone(false);
            setDraft((current) => ({ ...(current ?? settings.values), [key]: value }));
          }}
        />
      ))}
      {(dirty || action.error || done) && (
        <div className={styles.stackedControl}>
          {action.error ? (
            <span role="alert" className={styles.fieldError}>
              {t(action.error)}
            </span>
          ) : dirty && !missing ? null : (
            // The restart is already said by the note under the card; only a missing field or a
            // finished save needs a line here.
            <span role="status" className={styles.fieldNote}>
              {t(
                dirty ? "connections.drawer.settingsRequired" : "connections.drawer.settingsSaved",
              )}
            </span>
          )}
          {dirty && (
            <div className={styles.inlineActions}>
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() => setDraft(undefined)}
              >
                {t("connections.drawer.settingsUndo")}
              </Button>
              <Button
                loading={action.busy}
                disabled={disabled || missing || action.busy}
                onClick={() => void save()}
              >
                {t("connections.drawer.save")}
              </Button>
            </div>
          )}
        </div>
      )}
      <SettingsLine>{t("connections.drawer.settingsEditNote")}</SettingsLine>
    </>
  );
}
