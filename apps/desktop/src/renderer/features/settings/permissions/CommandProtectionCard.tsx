import { isolationReasonText } from "@pibot/client-core";
import type { MethodParams, MethodResults } from "@pibot/protocol";
import { layoutStyles, useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";

type Status = MethodResults["permissions.commandProtection"];

const APPARMOR_RELOAD = "sudo apparmor_parser -r /etc/apparmor.d/bwrap";

export function CommandProtectionCard({
  reason,
  refreshed,
}: {
  reason: string;
  refreshed?(status: Status): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const action = useAction();
  const [status, setStatus] = useState<Status>();
  const [copied, setCopied] = useState<"copied" | "failed">();
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    void peer
      .call("permissions.commandProtection", { action: "check" }, { signal: controller.signal })
      .then(
        (result) => {
          if (!controller.signal.aborted) setStatus(result);
        },
        () => {
          if (!controller.signal.aborted) action.setError("commandProtection.checkFailed");
        },
      );
    return () => controller.abort();
  }, [peer, action.setError]);
  const request = async (params: MethodParams["permissions.commandProtection"]) => {
    setCopied(undefined);
    const result = await action.run(
      (signal) =>
        peer?.call("permissions.commandProtection", params, {
          signal,
          timeoutMs: params.action === "install" ? 1_230_000 : 30_000,
        }) ?? Promise.resolve(null),
      () => "commandProtection.checkFailed",
    );
    if (result) {
      setStatus(result);
      refreshed?.(result);
    }
  };
  const dependency = status?.dependency;
  const currentReason = status ? status.reason : reason;
  const appArmor = currentReason === "linux_userns_restricted";
  const manualCommand = appArmor ? APPARMOR_RELOAD : status?.manualCommand;
  return (
    <section className={layoutStyles.banner} aria-label={t("commandProtection.title")}>
      <div>
        <strong>{t("commandProtection.title")}</strong>
        {!status?.available && <p>{t("commandProtection.blocked")}</p>}
        <p>
          {status?.available
            ? t("commandProtection.ready")
            : isolationReasonText(currentReason, t) || t("commandProtection.checkFailed")}
        </p>
        {dependency && (
          <p>
            {t(
              status?.canInstall ? "commandProtection.installNote" : "commandProtection.manualNote",
            )}
          </p>
        )}
        {status?.outcome && <p role="status">{t(`commandProtection.outcome.${status.outcome}`)}</p>}
        {action.error && <p role="alert">{t(action.error)}</p>}
        {manualCommand && (
          <details
            open={
              status?.canInstall === false ||
              status?.outcome === "denied" ||
              status?.outcome === "failed"
                ? true
                : undefined
            }
          >
            <summary>{t("commandProtection.advanced")}</summary>
            {appArmor && <p>{t("commandProtection.apparmor")}</p>}
            <p>
              <code>{manualCommand}</code>
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(manualCommand).then(
                  () => setCopied("copied"),
                  () => setCopied("failed"),
                );
              }}
            >
              {t("commandProtection.copy")}
            </Button>
            {copied && (
              <span role="status">
                {" "}
                {t(copied === "copied" ? "commandProtection.copied" : "messages.copyFailed")}
              </span>
            )}
          </details>
        )}
        <div className={layoutStyles.labelled}>
          {!status?.available && (
            <Button
              variant="secondary"
              disabled={!peer || action.busy}
              onClick={() => void request({ action: "check" })}
            >
              {t("commandProtection.recheck")}
            </Button>
          )}
          {dependency && status?.canInstall && status.outcome !== "installed" && (
            <Button
              loading={action.busy}
              disabled={!peer || action.busy}
              onClick={() => void request({ action: "install", dependency })}
            >
              {t("commandProtection.install", { dependency })}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
