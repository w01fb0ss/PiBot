import { isolationReasonText } from "@pibot/i18n";
import type { DeviceView } from "@pibot/remote-contract";
import { Overlay, SettingsLine, useT } from "@pibot/renderer-kit";
import { Button, Chip, IconTile } from "@pibot/ui";
import { useEffect, useState } from "react";
import { displaySecurityCode } from "../pairing/security-code.ts";
import styles from "../settings/remote.module.css";
export function DeviceRow({
  device,
  busy,
  rename,
  revoke,
}: {
  device: DeviceView;
  busy: boolean;
  rename(id: string, name: string): void;
  revoke(id: string, removeAnyway?: true): Promise<boolean>;
}) {
  const t = useT();
  const [name, setName] = useState(device.name);
  const [confirm, setConfirm] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setName(device.name), [device.name]);
  const runnerConnection = device.runnerConnection;
  const runnerState =
    typeof runnerConnection === "object" ? runnerConnection.state : runnerConnection;
  const runnerPath =
    device.kind === "runner" && typeof runnerConnection === "object"
      ? runnerConnection.path
      : undefined;
  const direct = runnerPath ? runnerPath !== "relay" : device.path !== "relay";
  const pathText = runnerPath
    ? t(`remote.runner.path.${runnerPath}`)
    : device.path === "lan" || device.path === "punched"
      ? t(`remote.runner.path.${device.path}`)
      : t(direct ? "remote.path.direct" : "remote.path.relay");
  // Reported by the phone in its current session; the phone enforces these itself.
  const phoneData = device.phoneData;
  const shared = phoneData
    ? [
        ...(phoneData.media ? [t("remote.phoneData.media")] : []),
        ...(phoneData.smsCode ? [t("remote.phoneData.smsCode")] : []),
      ]
    : [];
  const renameDisabled = busy || !!device.revokedAt;
  // The name is the hero's title and saves when it loses focus (Enter); Esc puts it back.
  const commitName = () => {
    const next = name.trim();
    if (!next || next === device.name) {
      setName(device.name);
      return;
    }
    rename(device.id, next);
  };
  const status = t(
    device.online
      ? "remote.online"
      : device.kind === "runner" && !device.revokedAt && device.runnerConnection
        ? runnerState === "drain_failed"
          ? "remote.runner.drainFailed"
          : "remote.runner.reconnecting"
        : "remote.offline",
  );
  return (
    <div>
      <div className={styles.deviceHero}>
        <IconTile
          icon={device.kind === "phone" ? "phone" : "laptop"}
          tone={device.kind === "phone" ? "teal" : "blue"}
          size="lg"
          className={styles.deviceHeroTile}
        />
        <div className={styles.deviceHeroText}>
          <input
            className={styles.deviceName}
            aria-label={t(device.kind === "runner" ? "remote.runner.name" : "remote.phoneName")}
            value={name}
            maxLength={80}
            disabled={renameDisabled}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.preventDefault();
                setName(device.name);
              }
            }}
          />
          <small>
            {t(device.kind === "runner" ? "remote.runner.kind" : "remote.phone.kind")} ·{" "}
            {device.lastSeenAt
              ? t("remote.lastSeen", { time: new Date(device.lastSeenAt).toLocaleString() })
              : t("remote.neverSeen")}
          </small>
          {device.online && direct && <small>{t("remote.path.directHint")}</small>}
          {phoneData && (
            <small>
              {shared.length
                ? t("remote.phoneData", { list: shared.join(" · ") })
                : t("remote.phoneData.none")}
            </small>
          )}
        </div>
        <Chip tone={device.online ? "ok" : "warn"}>
          {device.online && direct ? `${status} · ${pathText}` : status}
        </Chip>
      </div>
      {device.online && !direct && (
        <details className={styles.deviceDetails}>
          <summary>{pathText}</summary>
          <p>{t("remote.path.relayHint")}</p>
          {device.directFailure && <p>{t("remote.direct.fallback")}</p>}
        </details>
      )}
      {device.securityCode && (
        <details className={styles.deviceDetails}>
          <summary>{t("remote.verifyCode")}</summary>
          <p>{t("remote.securityCode", { code: displaySecurityCode(device.securityCode) })}</p>
        </details>
      )}
      <div className={styles.deviceActions}>
        <Button
          variant="ghost"
          className={styles.dangerText}
          disabled={busy}
          onClick={() => setConfirm(true)}
        >
          {t("remote.revoke")}
        </Button>
        {device.revocationPending && (
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
            {t("remote.removeAnyway")}
          </Button>
        )}
      </div>
      {(device.online || device.kind === "runner") &&
        device.isolation &&
        !device.isolation.available && (
          <SettingsLine tone="warn">
            {device.isolation.reason === "windows_unisolated" ||
            device.isolation.reason === "acp_editor_terminal_unisolated"
              ? t("isolation.warning.device")
              : t("isolation.deviceBlocked", { name: device.name })}{" "}
            {isolationReasonText(device.isolation.reason, t)}
            {(device.isolation.reason === "linux_bubblewrap_missing" ||
              device.isolation.reason === "linux_socat_missing") &&
              ` ${t("isolation.deviceInstall", {
                name: device.name,
                dependency:
                  device.isolation.reason === "linux_bubblewrap_missing" ? "bubblewrap" : "socat",
              })}`}
          </SettingsLine>
        )}
      {device.revocationPending && (
        <SettingsLine tone="warn">{t(`remote.revocationPending.${device.kind}`)}</SettingsLine>
      )}
      {confirm && (
        <SettingsLine
          role="alert"
          tone="warn"
          action={
            <div className={styles.actions}>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirm(false)}>
                {t("remote.cancel")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setConfirm(false);
                  void revoke(device.id);
                }}
              >
                {t("remote.confirmRevoke")}
              </Button>
            </div>
          }
        >
          {t("remote.revokeConfirm")}
        </SettingsLine>
      )}
      {confirmRemove && device.revocationPending && (
        <Overlay
          icon="trash"
          tone="red"
          title={t("remote.removeAnyway")}
          busy={busy}
          close={() => setConfirmRemove(false)}
        >
          <p>{device.name}</p>
          <p>{t(`remote.removeAnywayConfirm.${device.kind}`)}</p>
          <div className={styles.actions}>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmRemove(false)}>
              {t("remote.cancel")}
            </Button>
            <Button
              disabled={busy}
              loading={busy}
              onClick={() => {
                void revoke(device.id, true).then(() => setConfirmRemove(false));
              }}
            >
              {t("remote.removeAnyway")}
            </Button>
          </div>
        </Overlay>
      )}
    </div>
  );
}
