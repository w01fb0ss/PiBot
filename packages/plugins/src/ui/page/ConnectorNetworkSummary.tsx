import type { ConnectorBlockedSite } from "@pibot/plugins-contract/full";
import { SettingsRow, SettingsSection, useSettings } from "@pibot/renderer-kit";
import { Button, Chip } from "@pibot/ui";
import { useState } from "react";
import styles from "./connections/drawer.module.css";

export function ConnectorNetworkSummary({
  mode,
  declared,
  blockedRemoteSite,
  blocked,
  disabled,
  resolve,
  revokeRemote,
}: {
  mode: "sandbox" | "unisolated" | "remote";
  declared: readonly string[];
  blockedRemoteSite?: string;
  blocked: readonly (ConnectorBlockedSite & { sessionDenied: boolean })[];
  disabled: boolean;
  resolve(host: string, action: "allow" | "reset"): void;
  revokeRemote?: () => void;
}) {
  const { t } = useSettings();
  const [confirmSite, setConfirmSite] = useState<string>();
  const [revokeSite, setRevokeSite] = useState<string>();
  const remoteSite = mode === "remote" && revokeRemote ? declared[0] : undefined;
  const confirmRevoke = remoteSite !== undefined && revokeSite === remoteSite;
  return (
    <>
      {mode !== "sandbox" && <p className={styles.fieldNote}>{t(`connectors.network.${mode}`)}</p>}
      {mode === "remote" && blockedRemoteSite && (
        <SettingsRow
          icon="globe"
          tone="blue"
          label={t("connectors.network.blocked", { host: blockedRemoteSite })}
          note={t(
            confirmSite === blockedRemoteSite
              ? "connectors.network.remoteConsent"
              : "connectors.failure.website_approval_required",
          )}
        >
          {confirmSite === blockedRemoteSite && (
            <Button variant="ghost" disabled={disabled} onClick={() => setConfirmSite(undefined)}>
              {t("common.cancel")}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              if (confirmSite === blockedRemoteSite) {
                resolve(blockedRemoteSite, "allow");
                setConfirmSite(undefined);
              } else setConfirmSite(blockedRemoteSite);
            }}
          >
            {t(
              confirmSite === blockedRemoteSite
                ? "connectors.network.confirmAllow"
                : "connectors.network.allow",
            )}
          </Button>
        </SettingsRow>
      )}
      {remoteSite && revokeRemote && (
        <SettingsRow
          icon="globe"
          tone="blue"
          label={t("connectors.network.revokeRemote", { host: remoteSite })}
          note={confirmRevoke ? t("connectors.network.revokeRemoteNote") : undefined}
        >
          {confirmRevoke && (
            <Button variant="ghost" disabled={disabled} onClick={() => setRevokeSite(undefined)}>
              {t("common.cancel")}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              if (confirmRevoke) {
                setRevokeSite(undefined);
                revokeRemote();
              } else setRevokeSite(remoteSite);
            }}
          >
            {t(confirmRevoke ? "connectors.network.confirmRevoke" : "connectors.network.revoke")}
          </Button>
        </SettingsRow>
      )}
      {declared.length > 0 && mode !== "unisolated" && !remoteSite && (
        <SettingsSection title={t("connectors.network.declared")}>
          <div className={styles.stackedControl}>
            <span className={`${styles.siteChips} ${styles.start}`}>
              {declared.map((site) => (
                <Chip key={site} className={styles.mono}>
                  {site}
                </Chip>
              ))}
            </span>
          </div>
        </SettingsSection>
      )}
      {mode === "sandbox" &&
        blocked.map(({ host, reason, sessionDenied }) => (
          <SettingsRow
            key={host}
            icon="globe"
            tone="blue"
            label={t("connectors.network.blocked", { host })}
            note={t(`connectors.network.reason.${reason}`)}
          >
            {sessionDenied && (
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() => resolve(host, "reset")}
              >
                {t("connectors.network.reset")}
              </Button>
            )}
            {(reason === "denied" || reason === "unattended" || reason === "timeout") && (
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() => resolve(host, "allow")}
              >
                {t("connectors.network.allow")}
              </Button>
            )}
          </SettingsRow>
        ))}
    </>
  );
}
