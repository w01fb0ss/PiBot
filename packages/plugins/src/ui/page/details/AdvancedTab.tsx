import type {
  ConnectionToken,
  Connector,
  ConnectorDiagnostics,
  ConnectorSourceDetails,
  MethodResults,
} from "@pibot/plugins-contract/full";
import {
  CONNECTOR_STARTUP_MAX_SECONDS,
  ConnectorStartupWaitSchema,
} from "@pibot/plugins-contract/full";
import {
  SettingsFold,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useSettings,
} from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import { type ReactNode, useId, useState } from "react";
import { ConnectorNetworkEditor } from "../ConnectorNetworkEditor.tsx";
import { ConnectorSandboxSection } from "../ConnectorSandbox.tsx";
import { ConnectorSourceDiff } from "../ConnectorSourceDiff.tsx";
import { DrawerField, SecretInput } from "../connections/DrawerParts.tsx";
import styles from "../connections/drawer.module.css";

export type SourceUpdate = {
  state: "preview" | "source_not_found" | "updated";
  details?: ConnectorSourceDetails;
  sourceDigest?: string;
  changes: {
    commands: number;
    arguments: number;
    envNames: number;
    websites: number;
    files: number;
  };
};

/**
 * 高级: turning the connection on or off, updating from its source, restarting, its keys, the
 * sites it may reach (edited only here, with a confirmation), per-tool kinds, the sandbox switch,
 * and removal. Every control calls the same RPCs the earlier single-page panel did.
 */
export function AdvancedTab({
  connector,
  switchChecked,
  switchDisabled,
  toggle,
  disabled,
  restart,
  sourceUpdate,
  updateFromSource,
  tokens,
  replaceToken,
  settings,
  network,
  diagnostics,
  setOutsideSandbox,
  startup,
  saveStartup,
  toolKinds,
  skills,
  remove,
}: {
  connector: Connector;
  switchChecked: boolean;
  switchDisabled: boolean;
  toggle(enabled: boolean): void;
  disabled: boolean;
  restart(): void;
  sourceUpdate?: SourceUpdate;
  updateFromSource?(confirmed: boolean): void;
  tokens: ConnectionToken[];
  replaceToken(name: string, value: string): Promise<boolean>;
  /** The package's plain settings editor, when it has any it can change here. */
  settings?: ReactNode;
  network?: { domains: readonly string[]; editable: boolean; save(domains: string[]): void };
  diagnostics?: ConnectorDiagnostics;
  setOutsideSandbox(enabled: boolean): void;
  startup?: MethodResults["connectors.get"]["startup"];
  saveStartup(seconds: number | null): void;
  toolKinds: ReactNode;
  skills?: ReactNode;
  remove?(): void;
}) {
  const { t } = useSettings();
  return (
    <>
      <SettingsSection title={t("connections.drawer.tab.advanced")}>
        <SettingsRow
          icon="power"
          tone="green"
          label={t("connections.drawer.use")}
          note={t("connections.drawer.useNote")}
        >
          <Switch
            checked={switchChecked}
            label={t(connector.enabled ? "connectors.disable" : "connectors.enable")}
            disabled={switchDisabled}
            onCheckedChange={toggle}
          />
        </SettingsRow>
        {updateFromSource && (
          <>
            <SettingsRow
              icon="download"
              tone="blue"
              label={t("connectors.updateSource")}
              note={
                !sourceUpdate || sourceUpdate.state === "preview"
                  ? t("connectors.updateSourceConfirm")
                  : sourceUpdate.state === "source_not_found"
                    ? t("connectors.updateSourceNotFound")
                    : t("connectors.updateSourceDone")
              }
            >
              <Button
                variant="secondary"
                disabled={disabled || (sourceUpdate?.state !== "preview" && !!sourceUpdate)}
                onClick={() => updateFromSource(!!sourceUpdate)}
              >
                {t("connectors.updateSource")}
              </Button>
            </SettingsRow>
            {sourceUpdate?.state === "preview" && (
              <div className={styles.stackedControl}>
                <span className={styles.fieldNote}>
                  {t("connectors.updateSourceDiff", sourceUpdate.changes)}
                </span>
                {sourceUpdate.details && <ConnectorSourceDiff details={sourceUpdate.details} />}
              </div>
            )}
          </>
        )}
        <SettingsRow
          icon="refresh"
          tone="teal"
          label={t("connectors.restart")}
          note={t("connections.drawer.restartNote")}
        >
          <Button
            variant="secondary"
            disabled={disabled || connector.status === "starting"}
            onClick={restart}
          >
            {t("connectors.restart")}
          </Button>
        </SettingsRow>
      </SettingsSection>
      {startup && (
        <StartupWait
          key={`${connector.id}:${startup.override}`}
          startup={startup}
          disabled={disabled}
          save={saveStartup}
        />
      )}
      {(settings || tokens.length > 0) && (
        <SettingsSection title={t("connections.drawer.settings")}>
          {settings}
          {tokens.map((token) => (
            <TokenRow key={token.name} token={token} disabled={disabled} save={replaceToken} />
          ))}
          {!settings && updateFromSource && (
            <SettingsLine>{t("connections.drawer.settingsNote")}</SettingsLine>
          )}
        </SettingsSection>
      )}
      {network && (
        <ConnectorNetworkEditor
          key={`${connector.id}:${connector.revision}`}
          domains={network.domains}
          editable={network.editable}
          disabled={disabled}
          save={network.save}
        />
      )}
      {diagnostics && (
        <ConnectorSandboxSection
          connector={connector}
          diagnostics={diagnostics}
          disabled={disabled}
          toggle={setOutsideSandbox}
        />
      )}
      <SettingsFold
        title={t("connections.drawer.toolKinds")}
        summary={t("connections.drawer.toolKindsNote")}
        icon="puzzle"
        tone="violet"
      >
        {toolKinds}
      </SettingsFold>
      {skills}
      {remove && (
        <SettingsSection title={t("connections.drawer.remove")}>
          <SettingsRow
            icon="trash"
            tone="red"
            label={t("connections.panel.delete")}
            note={t("connections.drawer.removeNote")}
          >
            <Button variant="secondary" className={styles.danger} onClick={remove}>
              {t("connections.panel.delete")}
            </Button>
          </SettingsRow>
        </SettingsSection>
      )}
    </>
  );
}

/** One of the connection's keys: replaced through the same authorize path as 访问令牌. */
function TokenRow({
  token,
  disabled,
  save,
}: {
  token: ConnectionToken;
  disabled: boolean;
  save(name: string, value: string): Promise<boolean>;
}) {
  const { t } = useSettings();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  if (!editing)
    return (
      <SettingsRow
        icon="key"
        tone={token.hasValue ? "pink" : "amber"}
        label={token.name}
        note={t(token.hasValue ? "connections.drawer.keySaved" : "connections.drawer.keyMissing")}
      >
        <Button variant="secondary" disabled={disabled} onClick={() => setEditing(true)}>
          {t(token.hasValue ? "connections.drawer.replace" : "connections.drawer.fillKey")}
        </Button>
      </SettingsRow>
    );
  return (
    <div>
      <DrawerField id={id} label={token.name} secret>
        <SecretInput id={id} label={token.name} value={value} disabled={busy} onChange={setValue} />
      </DrawerField>
      <div className={styles.stackedControl}>
        <div className={styles.inlineActions}>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setValue("");
              setEditing(false);
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button
            loading={busy}
            disabled={busy || disabled || !value.trim()}
            onClick={async () => {
              setBusy(true);
              const saved = await save(token.name, value.trim());
              setBusy(false);
              if (saved) {
                setValue("");
                setEditing(false);
              }
            }}
          >
            {t("connections.drawer.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StartupWait({
  startup,
  disabled,
  save,
}: {
  startup: NonNullable<MethodResults["connectors.get"]["startup"]>;
  disabled: boolean;
  save(seconds: number | null): void;
}) {
  const { t } = useSettings();
  const [seconds, setSeconds] = useState(startup.override?.toString() ?? "");
  const parsed = ConnectorStartupWaitSchema.safeParse(Number(seconds));
  const value = seconds === "" ? null : parsed.success ? parsed.data : undefined;
  return (
    <SettingsSection title={t("connectors.paste.timeout")}>
      <label className={styles.field}>
        {t("connectors.recovery.startupCurrent", { seconds: String(startup.seconds) })}
        <span className={styles.inputBox}>
          <input
            type="number"
            min={1}
            max={CONNECTOR_STARTUP_MAX_SECONDS}
            value={seconds}
            placeholder={t("connectors.recovery.automatic")}
            disabled={disabled}
            onChange={(event) => setSeconds(event.currentTarget.value)}
          />
        </span>
      </label>
      <Button
        variant="secondary"
        disabled={disabled || value === undefined || value === (startup.override ?? null)}
        onClick={() => {
          if (value !== undefined) save(value);
        }}
      >
        {t("connections.drawer.save")}
      </Button>
    </SettingsSection>
  );
}
