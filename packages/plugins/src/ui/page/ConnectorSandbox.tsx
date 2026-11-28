// Why a local MCP did not start, and the per-MCP "run outside the sandbox (as you)"
// switch. Turning it on only asks the brain; the native dialog in the main process is the
// confirmation, so a click here alone never moves an MCP out of the sandbox.
import type {
  Connector,
  ConnectorDiagnostics,
  ConnectorStartFailure,
} from "@pibot/plugins-contract/full";
import { hostPlatform, useNavigation, useSettings } from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import type { ReactNode } from "react";
import styles from "./connectors.module.css";

type Translate = ReturnType<typeof useSettings>["t"];

function denialText(t: Translate, denial: ConnectorStartFailure["denials"][number]) {
  if (denial.kind === "system_service" && denial.rule === "keychain")
    return t("connectors.startFailure.denial.keychain");
  const key =
    denial.kind === "credential_read" ||
    denial.kind === "protected_read" ||
    denial.kind === "system_service" ||
    denial.kind === "network"
      ? (`connectors.startFailure.denial.${denial.kind}` as const)
      : ("connectors.startFailure.denial.other" as const);
  return t(key, { target: denial.target });
}

/** The fixed reason, the process facts, the sandbox's refusals and the redacted stderr tail. */
export function ConnectorStartFailureView({
  failure,
  children,
}: {
  failure: ConnectorStartFailure;
  children: ReactNode;
}) {
  const { t } = useSettings();
  const navigation = useNavigation();
  const missing = failure.reason === "command_not_found";
  const launcher = missing ? failure.launcher : undefined;
  const windows = hostPlatform() === "win32";
  const launcherIssue = failure.launcherIssue;
  const facts = [
    t(
      failure.outsideSandbox
        ? "connectors.startFailure.where.outside"
        : "connectors.startFailure.where.sandbox",
    ),
    failure.timedOut ? t("connectors.startFailure.timedOut") : undefined,
    failure.exitCode !== null
      ? t("connectors.startFailure.exitCode", { code: String(failure.exitCode) })
      : undefined,
    failure.signal ? t("connectors.startFailure.signal", { signal: failure.signal }) : undefined,
  ].filter(Boolean);

  return (
    <section className={`${styles.warn} ${styles.stack}`} aria-live="polite">
      <strong>{t("connectors.startFailure.title")}</strong>
      <p>
        {t(
          launcher && launcherIssue
            ? `connectors.startFailure.launcherIssue.${launcherIssue}`
            : launcher
              ? `connectors.startFailure.launcher.${launcher}`
              : `connectors.startFailure.reason.${failure.reason}`,
          { program: launcher ?? "" },
        )}
      </p>
      <div className={styles.row}>
        {failure.reason === "sandbox_start_failed" && (
          <Button variant="secondary" onClick={() => navigation.openSettings("permissions")}>
            {t("settings.permissions")}
          </Button>
        )}
        {launcher && !launcherIssue && (
          <a
            href={
              launcher === "uvx"
                ? "https://docs.astral.sh/uv/getting-started/installation/"
                : "https://nodejs.org/en/download"
            }
            target="_blank"
            rel="noreferrer"
          >
            {t(
              launcher === "uvx"
                ? "connectors.startFailure.installUv"
                : "connectors.startFailure.installNode",
            )}
          </a>
        )}
      </div>
      {missing && !launcherIssue && (
        <details>
          <summary>{t("connectors.startFailure.alreadyInstalled")}</summary>
          <p>
            {t(
              windows
                ? "connectors.startFailure.setupWindows"
                : "connectors.startFailure.setupUnix",
            )}
          </p>
          <Button variant="secondary" onClick={() => navigation.openSettings("permissions")}>
            {t("settings.permissions")}
          </Button>
        </details>
      )}
      {children}
      <details>
        <summary>{t("connectors.startFailure.advanced")}</summary>
        <p className={styles.note}>{facts.join(" · ")}</p>
        {failure.denials.length > 0 && (
          <div>
            <p className={styles.note}>{t("connectors.startFailure.denials")}</p>
            <ul className={styles.failureList}>
              {failure.denials.map((denial) => (
                <li key={`${denial.kind}:${denial.rule}:${denial.target}`}>
                  {denialText(t, denial)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {failure.stderrTail.trim() && (
          <pre className={styles.stderrTail}>{failure.stderrTail.trim()}</pre>
        )}
      </details>
    </section>
  );
}

export function ConnectorSandboxSection({
  connector,
  diagnostics,
  disabled,
  toggle,
}: {
  connector: Connector;
  diagnostics: ConnectorDiagnostics;
  disabled: boolean;
  toggle(enabled: boolean): void;
}) {
  const { t } = useSettings();
  // Windows keeps its own S3-W note (every local MCP there already runs unisolated).
  if (diagnostics.outsideSandbox !== "available") return null;
  return (
    <section className={styles.stack}>
      <h3>{t("connectors.outsideSandbox.title")}</h3>
      <div className={styles.row}>
        <span className={styles.grow}>{t("connectors.outsideSandbox.switch")}</span>
        <Switch
          checked={connector.outsideSandbox}
          label={t("connectors.outsideSandbox.switch")}
          disabled={disabled}
          onCheckedChange={toggle}
        />
      </div>
      {diagnostics.suggestion && !connector.outsideSandbox && (
        <p className={styles.warn}>
          {t(`connectors.outsideSandbox.suggest.${diagnostics.suggestion}`)}
        </p>
      )}
      {connector.outsideSandbox && (
        <p className={styles.warn}>
          {t(
            diagnostics.needsReconfirm
              ? "connectors.outsideSandbox.reconfirm"
              : "connectors.outsideSandbox.on",
          )}
        </p>
      )}
      {diagnostics.needsReconfirm && (
        <Button variant="secondary" disabled={disabled} onClick={() => toggle(true)}>
          {t("connectors.recovery.reconfirm")}
        </Button>
      )}
      <p className={styles.note}>{t("connectors.outsideSandbox.note")}</p>
    </section>
  );
}
