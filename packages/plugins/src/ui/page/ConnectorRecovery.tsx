import type { ConnectorDiagnostics } from "@pibot/plugins-contract/full";
import { hostPlatform, SettingsLine, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { useConnectorAction } from "../shell/remote.ts";
import styles from "./connectors.module.css";

export function ConnectorRecovery({
  diagnostics,
  disabled,
  askRunAsMe,
  retry,
  retryWithMoreTime,
}: {
  diagnostics: ConnectorDiagnostics;
  disabled: boolean;
  askRunAsMe(): void;
  retry(): void;
  retryWithMoreTime?(): void;
}) {
  const { t } = useSettings();
  const [pathStep, setPathStep] = useState<"read" | string[]>();
  const [loginHelp, setLoginHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const action = useConnectorAction(() => {});
  const reason = diagnostics.lastFailure?.reason;
  const denials = diagnostics.lastFailure?.denials ?? [];
  const websiteOnly = denials.length > 0 && denials.every(({ kind }) => kind === "network");
  const windows = hostPlatform() === "win32";

  async function readPaths() {
    const value = await action.run((peer, signal) =>
      peer.call(
        "permissions.paths.discover",
        { source: windows ? "windows" : "terminal" },
        { signal },
      ),
    );
    if (value) setPathStep(value.paths);
  }

  async function savePaths(paths: string[]) {
    const result = await action.run(async (peer, signal) => {
      const settings = await peer.call("permissions.get", undefined, { signal });
      const pathEntries = [...new Set([...(settings.pathEntries ?? []), ...paths])];
      if (pathEntries.length > 200) return "too_many";
      await peer.call("permissions.set", { pathEntries }, { signal });
      return "saved";
    });
    if (result === "saved") retry();
    if (result === "too_many") setPathStep([]);
  }

  async function copyLogin() {
    const command = diagnostics.loginCommand;
    setLoginHelp(true);
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // The same vetted command can be selected in the recovery card.
      setCopied(false);
    }
  }

  if (diagnostics.outsideSandbox === "available" && diagnostics.needsReconfirm)
    return (
      <Button variant="secondary" disabled={disabled} onClick={askRunAsMe}>
        {t("connectors.recovery.reconfirm")}
      </Button>
    );
  if (
    diagnostics.outsideSandbox === "available" &&
    !diagnostics.lastFailure?.outsideSandbox &&
    !websiteOnly &&
    (reason === "sandbox_denied" ||
      reason === "sandbox_start_failed" ||
      (diagnostics.suggestion === "ai_config_path" &&
        reason !== "command_not_found" &&
        reason !== "login_required" &&
        reason !== "password_prompt" &&
        reason !== "timeout" &&
        reason !== "proxy_scheme"))
  )
    return (
      <Button variant="secondary" disabled={disabled} onClick={askRunAsMe}>
        {t("connectors.recovery.runAsMe")}
      </Button>
    );
  if (reason === "command_not_found")
    return (
      <div className={styles.stack}>
        {pathStep === undefined && (
          <Button variant="secondary" disabled={disabled} onClick={() => setPathStep("read")}>
            {t("connectors.recovery.importPaths")}
          </Button>
        )}
        {pathStep === "read" && (
          <div className={styles.stack}>
            <SettingsLine>
              {t(windows ? "connectors.recovery.windowsPaths" : "paths.shellWarning")}
            </SettingsLine>
            <div className={styles.row}>
              <Button disabled={disabled || action.disabled} onClick={() => void readPaths()}>
                {t("paths.read")}
              </Button>
              <Button variant="ghost" disabled={action.busy} onClick={() => setPathStep(undefined)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
        {Array.isArray(pathStep) && (
          <div className={styles.stack}>
            {pathStep.length ? (
              <>
                <SettingsLine>{t("connectors.recovery.pathsConfirm")}</SettingsLine>
                <ul className={styles.failureList}>
                  {pathStep.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
                <Button
                  disabled={disabled || action.disabled}
                  onClick={() => void savePaths(pathStep)}
                >
                  {t("connectors.recovery.savePaths")}
                </Button>
              </>
            ) : (
              <SettingsLine dot="warn">{t("connectors.recovery.pathsUnavailable")}</SettingsLine>
            )}
            <Button variant="ghost" disabled={action.busy} onClick={() => setPathStep(undefined)}>
              {t("common.cancel")}
            </Button>
          </div>
        )}
        {action.error && <p role="alert">{t(action.error)}</p>}
      </div>
    );
  if (reason === "timeout" && retryWithMoreTime)
    return (
      <Button variant="secondary" disabled={disabled} onClick={retryWithMoreTime}>
        {t("connectors.recovery.extend")}
      </Button>
    );
  if (reason === "login_required" || reason === "password_prompt")
    return (
      <div className={styles.stack}>
        <Button variant="secondary" disabled={disabled} onClick={() => void copyLogin()}>
          {t(
            diagnostics.loginCommand
              ? "connectors.recovery.copyLogin"
              : "connectors.recovery.login",
          )}
        </Button>
        {loginHelp && (
          <>
            {diagnostics.loginCommand ? (
              <SettingsLine>
                {t(copied ? "connectors.recovery.loginCopied" : "connectors.recovery.loginRun")}
              </SettingsLine>
            ) : (
              <SettingsLine>
                {t(
                  diagnostics.loginGuide
                    ? "connectors.recovery.packageLogin"
                    : "connectors.recovery.loginInstructions",
                )}
              </SettingsLine>
            )}
            {diagnostics.loginGuide && (
              <a href={diagnostics.loginGuide} target="_blank" rel="noreferrer">
                {t("connectors.recovery.loginGuide")}
              </a>
            )}
            {diagnostics.loginCommand && <code>{diagnostics.loginCommand}</code>}
            <Button variant="secondary" disabled={disabled} onClick={retry}>
              {t("common.retry")}
            </Button>
          </>
        )}
      </div>
    );
  return (
    <Button variant="secondary" disabled={disabled} onClick={retry}>
      {t("common.retry")}
    </Button>
  );
}
