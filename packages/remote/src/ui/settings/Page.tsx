import { OFFICIAL_RELAY_URL, RelayUrlSchema, type RemoteSettings } from "@pibot/remote-contract";
import {
  layoutStyles,
  SettingsBack,
  SettingsEmpty,
  SettingsFold,
  SettingsHero,
  SettingsLine,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  useSettings,
} from "@pibot/renderer-kit";
import { Button, Chip, IconTile, SegmentedControl, Switch, TextField } from "@pibot/ui";
import { useEffect, useState } from "react";
import { DeviceRow } from "../devices/DeviceRow.tsx";
import { EndpointCapabilities } from "../devices/EndpointCapabilities.tsx";
import { OfflineModels } from "../devices/OfflineModels.tsx";
import { RunnerControl } from "../devices/RunnerControl.tsx";
import { CopyPairCode } from "../pairing/CopyPairCode.tsx";
import { Pairing } from "../pairing/Pairing.tsx";
import { DirectSettings } from "./DirectSettings.tsx";
import styles from "./remote.module.css";
import { StunPrivacy } from "./StunPrivacy.tsx";
import { useRemoteSettings } from "./use-remote.ts";

const RUNNER_DOWNLOAD = {
  zh: "https://pibot.space/cn/download/",
  en: "https://pibot.space/en/download/",
} as const;

export function RemoteSettingsPage() {
  const { t, language } = useSettings();
  const remote = useRemoteSettings();
  const [draft, setDraft] = useState<RemoteSettings>();
  const [selectedId, setSelectedId] = useState<string>();
  const [addMenu, setAddMenu] = useState(false);
  const [runnerInput, setRunnerInput] = useState(false);
  const runnerPair = remote.pair?.kind === "runner" ? remote.pair : undefined;
  const runnerStatus = !runnerPair
    ? undefined
    : runnerPair.status === "paired"
      ? t("remote.runner.addedNamed", {
          name: remote.devices.find((device) => device.id === runnerPair.deviceId)?.name ?? "",
        })
      : runnerPair.status === "waiting"
        ? runnerPair.relayProblem === "unreachable"
          ? t("remote.runner.relayUnreachable")
          : runnerPair.relayProblem === "tls"
            ? t("remote.runner.relayTls")
            : runnerPair.relayProblem === "certificate"
              ? t("remote.runner.relayCertificate")
              : t("remote.runner.waiting")
        : runnerPair.status === "expired"
          ? t("remote.runner.expired")
          : runnerPair.status === "failed"
            ? t("remote.error.pairFailed")
            : undefined;
  const [runnerCode, setRunnerCode] = useState("");
  const [runnerDialog, setRunnerDialog] = useState(false);
  const [relayEdited, setRelayEdited] = useState(false);
  useEffect(() => {
    if (!runnerDialog || remote.pair?.status !== "paired") return;
    const timer = setTimeout(() => {
      setRunnerDialog(false);
    }, 1800);
    return () => clearTimeout(timer);
  }, [runnerDialog, remote.pair?.status]);
  const [tab, setTab] = useState<"capabilities" | "offline" | "control">("capabilities");
  useEffect(() => {
    setDraft(remote.settings);
  }, [remote.settings]);
  const edit = (patch: Partial<RemoteSettings>) =>
    setDraft((old) => (old ? { ...old, ...patch } : old));
  const submitRunner = () => {
    const code = runnerCode.trim();
    if (code.length < 25) return;
    void remote.addRunner(code).then((added) => {
      if (added) {
        setRunnerCode("");
        setRunnerDialog(false);
      }
    });
  };
  /**
   * Maintainers 2026-11-12/13: every setting takes effect as it is changed, with no save or confirm
   * step (a confirmation banner far from the row made changes look lost). A change that sends
   * data somewhere new (validateSettingsChange: turning remote on, another relay, a new STUN
   * server) is consented by the user's own choice on a row whose note says what goes where.
   */
  const commit = (patch: Partial<Omit<RemoteSettings, "version">>) => {
    edit(patch);
    const saved = remote.settings;
    if (!saved) return;
    const { version: _, ...base } = saved;
    const next = { ...base, ...patch };
    const sendsSomewhereNew =
      (next.enabled &&
        (!saved.enabled || next.relay !== saved.relay || next.relayUrl !== saved.relayUrl)) ||
      (next.direct.mode === "stun" &&
        (saved.direct.mode !== "stun" || saved.direct.stunUrl !== next.direct.stunUrl));
    void remote.save(next, sendsSomewhereNew);
  };
  if (remote.loading || !draft)
    return (
      <SettingsPage>
        <SettingsLine
          role={remote.error ? "alert" : "status"}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void remote.reload();
              }}
            >
              {t("remote.retry")}
            </Button>
          }
        >
          {t(remote.error ? "remote.failed" : "remote.loading")}
        </SettingsLine>
      </SettingsPage>
    );
  const validRelay = RelayUrlSchema.safeParse(draft.relayUrl).success;
  const relayError = draft.relay === "custom" && relayEdited && !validRelay;
  const pairingAvailable = remote.status?.pairingAvailable;
  const selected = remote.devices.find((device) => device.id === selectedId);
  const pathLabel = (device: (typeof remote.devices)[number]) => {
    const connection = device.kind === "runner" ? device.runnerConnection : undefined;
    const path = typeof connection === "object" ? connection.path : device.path;
    return t(
      path === "lan"
        ? "remote.runner.path.lan"
        : path === "punched"
          ? "remote.runner.path.punched"
          : path === "address"
            ? "remote.runner.path.address"
            : path === "relay"
              ? "remote.runner.path.relay"
              : "remote.path.direct",
    );
  };
  type Device = (typeof remote.devices)[number];
  const deviceRow = (device: Device) => (
    <button
      className={styles.deviceSummary}
      key={device.id}
      type="button"
      onClick={() => {
        setTab("capabilities");
        setSelectedId(device.id);
      }}
    >
      <IconTile
        icon={device.kind === "phone" ? "phone" : "laptop"}
        tone={device.kind === "phone" ? "teal" : "blue"}
        size="lg"
      />
      <span className={styles.deviceSummaryText}>
        <strong>{device.name}</strong>
        <span>
          <i className={device.online ? styles.onlineDot : styles.offlineDot} />
          {device.online ? `${t("remote.online")} · ${pathLabel(device)}` : t("remote.offline")}
        </span>
      </span>
      {device.kind === "runner" && device.isolation && !device.isolation.available && (
        <Chip tone="warn">
          {t(
            device.isolation.reason === "windows_unisolated" ||
              device.isolation.reason === "acp_editor_terminal_unisolated"
              ? "isolation.warning"
              : "remote.runner.commandsBlocked",
          )}
        </Chip>
      )}
      <span className={styles.deviceChevron} aria-hidden="true">
        ›
      </span>
    </button>
  );
  const phones = remote.devices.filter((device) => device.kind === "phone");
  const runners = remote.devices.filter((device) => device.kind === "runner");
  const errorLine = (retry: () => void, label = t("remote.retry")) =>
    remote.error && (
      <SettingsLine
        role="alert"
        tone="danger"
        action={
          <Button variant="secondary" disabled={remote.busy} onClick={retry}>
            {label}
          </Button>
        }
      >
        {t(
          remote.error === "stale"
            ? "remote.stale"
            : remote.error === "failed"
              ? "remote.failed"
              : `remote.error.${remote.error}`,
        )}
      </SettingsLine>
    );
  if (selected) {
    // The device card, then its details one tab at a time.
    const tabs =
      selected.kind === "phone"
        ? (["capabilities", "offline", "control"] as const)
        : (["capabilities", "control"] as const);
    const current = (tabs as readonly string[]).includes(tab) ? tab : "capabilities";
    return (
      <SettingsPage>
        {errorLine(() => void remote.reload())}
        <SettingsBack label={t("remote.devices")} onClick={() => setSelectedId(undefined)} />
        <div className={layoutStyles.card}>
          <DeviceRow
            device={selected}
            busy={remote.busy}
            rename={(id, name) => void remote.rename(id, name)}
            revoke={remote.revoke}
          />
        </div>
        <SegmentedControl
          label={selected.name}
          value={current}
          options={tabs.map((value) => ({
            value,
            label: t(
              value === "capabilities"
                ? "remote.tab.capabilities"
                : value === "offline"
                  ? "remote.tab.offline"
                  : selected.kind === "phone"
                    ? "remote.tab.runners"
                    : "remote.tab.phones",
            ),
          }))}
          onValueChange={setTab}
        />
        {current === "capabilities" && (
          <EndpointCapabilities paired={remote.devices} endpointId={selected.id} />
        )}
        {current === "offline" && selected.kind === "phone" && (
          <OfflineModels deviceId={selected.id} disabled={remote.busy} />
        )}
        {current === "control" &&
          (selected.kind === "phone" ? (
            <RunnerControl phoneId={selected.id} disabled={remote.busy} />
          ) : (
            <RunnerControl runnerDeviceId={selected.id} disabled={remote.busy} />
          ))}
      </SettingsPage>
    );
  }
  return (
    <SettingsPage>
      <div className={styles.leadRow}>
        <p className={layoutStyles.lead}>{t("remote.lead")}</p>
        <div className={styles.addDeviceWrap}>
          <Button
            disabled={remote.busy || !pairingAvailable}
            aria-expanded={addMenu}
            onClick={() => setAddMenu((value) => !value)}
          >
            {t("remote.addDevice")}
          </Button>
          {addMenu && pairingAvailable && !remote.busy && (
            <div className={styles.addDeviceMenu}>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  setAddMenu(false);
                  void remote.add();
                }}
              >
                <IconTile icon="phone" tone="teal" size="sm" />
                {t("remote.addPhone")}
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  setAddMenu(false);
                  setRunnerDialog(true);
                  setRunnerInput(false);
                  setRunnerCode("");
                  void remote.add("runner");
                }}
              >
                <IconTile icon="laptop" tone="violet" size="sm" />
                {t("remote.addRunner")}
              </button>
            </div>
          )}
        </div>
      </div>
      {(!runnerDialog || remote.errorScope !== "runner") &&
        errorLine(
          () => (remote.errorScope === "phone" ? void remote.add() : void remote.reload()),
          remote.errorScope === "phone" ? t("remote.tryAgain") : undefined,
        )}
      <SettingsHero
        icon="laptop"
        title={draft.desktopName}
        note={
          draft.enabled && remote.busy && remote.status?.reason === "off" ? (
            <span role="status">{t("remote.waitingForConnection")}</span>
          ) : (
            remote.status && (
              <span role="status">
                <i className={draft.enabled ? styles.onlineDot : styles.offlineDot} />
                {t(
                  draft.enabled && remote.status.reason === "connecting"
                    ? "remote.waitingForConnection"
                    : `remote.status.${remote.status.reason}`,
                )}
              </span>
            )
          )
        }
      >
        <Switch
          label={t("remote.enabled")}
          checked={draft.enabled}
          disabled={remote.busy}
          onCheckedChange={(enabled) => commit({ enabled })}
        />
      </SettingsHero>
      <p className={layoutStyles.note}>{t("remote.disclosure")}</p>
      <SettingsFold title={t("remote.privacyDetails")}>
        <SettingsLine>{t("remote.disclosureDetails")}</SettingsLine>
      </SettingsFold>
      {!draft.enabled && <SettingsLine>{t("remote.enableBeforePair")}</SettingsLine>}
      {draft.enabled && !remote.status && (
        <SettingsLine role="status">{t("remote.waitingForConnection")}</SettingsLine>
      )}
      {runnerDialog && (
        <div className={layoutStyles.card}>
          <SettingsRow
            icon="laptop"
            tone="violet"
            label={t(runnerInput ? "remote.runner.code" : "remote.runner.addTitle")}
            stacked
          >
            {runnerInput ? (
              <div className={styles.actions}>
                <TextField
                  label={t("remote.runner.code")}
                  value={runnerCode}
                  maxLength={1152}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setRunnerCode(event.target.value)}
                />
                <Button
                  disabled={remote.busy || runnerCode.trim().length < 25}
                  onClick={submitRunner}
                >
                  {t("remote.runner.add")}
                </Button>
              </div>
            ) : (
              <div className={styles.runnerCode}>
                <p className={styles.runnerNote}>{t("remote.runner.role")}</p>
                <ol className={styles.runnerNote}>
                  <li>
                    <a href={RUNNER_DOWNLOAD[language]} target="_blank" rel="noreferrer">
                      {t("remote.runner.download")}
                    </a>
                  </li>
                  <li>{t("remote.runner.openTray")}</li>
                  <li>{t("remote.runner.pasteCode")}</li>
                </ol>
                {runnerPair?.payload && (
                  <>
                    <TextField
                      label={t("remote.runner.code")}
                      value={runnerPair.payload}
                      readOnly
                    />
                    <p className={styles.runnerNote}>{t("remote.shareCodeWarning")}</p>
                  </>
                )}
                <div className={styles.actions}>
                  {runnerPair?.payload && (
                    <CopyPairCode
                      key={runnerPair.id}
                      code={runnerPair.payload}
                      disabled={remote.busy}
                    />
                  )}
                  {(runnerPair || remote.errorScope !== "runner") &&
                    runnerPair?.status !== "paired" && (
                      <Button
                        variant="secondary"
                        disabled={remote.busy}
                        onClick={() => void remote.add("runner")}
                      >
                        {t("remote.newPairCode")}
                      </Button>
                    )}
                </div>
                {runnerStatus ? (
                  <p className={styles.runnerNote} role="status">
                    {runnerStatus}
                  </p>
                ) : remote.busy && !remote.error ? (
                  <p className={styles.runnerNote} role="status">
                    {t("remote.runner.creating")}
                  </p>
                ) : null}
                <details className={styles.runnerNote}>
                  <summary>{t("remote.advanced")}</summary>
                  <p>{t("remote.runner.commandLine")}</p>
                  <code>pibot runner pair &quot;{t("remote.runner.code")}&quot;</code>
                </details>
              </div>
            )}
            {remote.errorScope === "runner" &&
              errorLine(
                () => (runnerInput ? submitRunner() : void remote.add("runner")),
                t("remote.tryAgain"),
              )}
            <div className={styles.actions}>
              <Button
                variant="secondary"
                disabled={remote.busy}
                onClick={() => {
                  if (!runnerInput) void remote.cancel();
                  else void remote.add("runner");
                  remote.clearActionError();
                  setRunnerInput(!runnerInput);
                }}
              >
                {t(runnerInput ? "remote.runner.useGenerated" : "remote.runner.useLegacy")}
              </Button>
              <Button
                variant="secondary"
                disabled={remote.busy}
                onClick={() => {
                  remote.clearActionError();
                  void remote.cancel();
                  setRunnerCode("");
                  setRunnerDialog(false);
                }}
              >
                {t("remote.runner.closeCode")}
              </Button>
            </div>
          </SettingsRow>
        </div>
      )}
      {!runnerDialog && remote.pair && remote.pair.kind !== "runner" && (
        <div className={layoutStyles.card}>
          <Pairing
            pair={remote.pair}
            busy={remote.busy}
            cancel={() => void remote.cancel()}
            retry={() => void remote.add()}
          />
        </div>
      )}
      <SettingsSection title={`${t("remote.phones")} · ${phones.length}`}>
        {phones.map(deviceRow)}
        {!phones.length && <SettingsEmpty icon="phone" title={t("remote.empty")} />}
      </SettingsSection>
      <SettingsSection title={`${t("remote.runners")} · ${runners.length}`}>
        {runners.map(deviceRow)}
        {!runners.length && <SettingsEmpty icon="laptop" title={t("remote.empty")} />}
      </SettingsSection>
      {remote.hasMore && (
        <Button variant="secondary" disabled={remote.busy} onClick={() => void remote.more()}>
          {t("remote.more")}
        </Button>
      )}
      <SettingsFold
        icon="network"
        tone="teal"
        title={t("remote.advanced")}
        summary={t("remote.advancedSummary")}
      >
        <SettingsRow
          icon="server"
          tone="teal"
          label={t("remote.relay")}
          note={
            // Maintainers 2026-11-12: name the official relay so users see where data goes.
            draft.relay === "official"
              ? t("remote.officialAddress", { url: OFFICIAL_RELAY_URL })
              : undefined
          }
        >
          <SegmentedControl
            label={t("remote.relay")}
            value={draft.relay}
            disabled={remote.busy}
            options={[
              { value: "official", label: t("remote.official") },
              { value: "custom", label: t("remote.custom") },
            ]}
            onValueChange={(relay) => {
              setRelayEdited(false);
              if (relay === "custom" && !validRelay) edit({ relay });
              else commit({ relay });
            }}
          />
        </SettingsRow>
        {draft.relay === "custom" && (
          <SettingsRow icon="server" tone="teal" label={t("remote.address")} stacked>
            <TextField
              label={t("remote.address")}
              hideLabel
              value={draft.relayUrl ?? ""}
              maxLength={2048}
              disabled={remote.busy}
              aria-invalid={relayError}
              onChange={(e) => {
                setRelayEdited(true);
                edit({ relayUrl: e.target.value || null });
              }}
              onBlur={() => {
                setRelayEdited(true);
                if (
                  validRelay &&
                  (remote.settings?.relay !== "custom" ||
                    draft.relayUrl !== remote.settings.relayUrl)
                )
                  commit({ relay: "custom", relayUrl: draft.relayUrl });
              }}
            />
            {relayError && (
              <SettingsLine
                role="alert"
                tone="danger"
                action={
                  <Button
                    variant="secondary"
                    disabled={remote.busy}
                    onClick={() => commit({ relay: "official" })}
                  >
                    {t("remote.official")}
                  </Button>
                }
              >
                {t("remote.error.relayInvalid")}
              </SettingsLine>
            )}
          </SettingsRow>
        )}
        <SettingsRow icon="edit" tone="blue" label={t("remote.desktopName")} stacked>
          <TextField
            label={t("remote.desktopName")}
            hideLabel
            value={draft.desktopName}
            maxLength={80}
            disabled={remote.busy}
            onChange={(e) => edit({ desktopName: e.target.value })}
            onBlur={() => {
              const name = draft.desktopName.trim();
              if (name && name !== remote.settings?.desktopName) commit({ desktopName: name });
            }}
          />
        </SettingsRow>
        <DirectSettings
          value={draft.direct}
          busy={remote.busy}
          edit={(direct) => edit({ direct })}
          commit={(direct) => commit({ direct })}
        />
        <SettingsRow
          icon="moon"
          tone="violet"
          label={t("remote.keepAwake")}
          note={
            remote.status
              ? `${t("remote.keepAwakeNote")} · ${t(
                  remote.status.keepAwake === "requested"
                    ? "remote.keepAwakeRequested"
                    : remote.status.keepAwake === "unsupported"
                      ? "remote.keepAwakeUnsupported"
                      : "remote.keepAwakeOff",
                )}`
              : t("remote.keepAwakeNote")
          }
        >
          <Switch
            label={t("remote.keepAwake")}
            checked={draft.keepAwake}
            disabled={remote.busy}
            onCheckedChange={(keepAwake) => commit({ keepAwake })}
          />
        </SettingsRow>
        <SettingsRow
          icon="globe"
          tone="blue"
          label={t("remote.lanDiscovery")}
          note={t("remote.lanDiscoveryNote")}
        >
          <Switch
            label={t("remote.lanDiscovery")}
            checked={draft.lanDiscovery}
            disabled={remote.busy}
            onCheckedChange={(lanDiscovery) => commit({ lanDiscovery })}
          />
        </SettingsRow>
        {remote.settings && <StunPrivacy settings={remote.settings} />}
      </SettingsFold>
    </SettingsPage>
  );
}
