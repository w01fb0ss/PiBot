import {
  approvalCountdown,
  approvalDeadline,
  approvalExplanation,
  approvalText,
} from "@pibot/client-core";
import {
  type Approval,
  credentialSiteLabel,
  type LoginApprovalRequest,
} from "@pibot/credentials-contract/full";
import { ApprovalExplanation, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import approvalStyles from "./approval.module.css";
import styles from "./credentials.module.css";

function KeyIcon() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="15" r="4" />
      <path d="M10.85 12.15 19 4M18 5l2 2M15 8l2 2" />
    </svg>
  );
}

/**
 * First automatic login on a site: "<Bot> wants to log in to <site> as <account>".
 * Buttons: deny / allow once / always allow; "always" remembers this Bot + site (or,
 * on a routine card, preauthorizes this routine). Several accounts → the user picks one and
 * nothing can be remembered. Resolves through `credentials.login.resolve` so the pick reaches
 * brain with the answer; the backend's event/read is the only proof of the outcome.
 */
export function LoginApprovalCard({
  approval,
  request,
  refresh,
  inbox = false,
}: {
  approval: Approval;
  request: LoginApprovalRequest;
  refresh(): Promise<void>;
  inbox?: boolean;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const [chosen, setChosen] = useState(
    request.accounts.length === 1 ? request.accounts[0]?.id : undefined,
  );
  const [busy, setBusy] = useState<"deny" | "once" | "always">();
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { remaining, pauses, paused, expired } = approvalDeadline(approval, now);
  useEffect(() => {
    if (approval.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approval.status]);
  useEffect(() => {
    if (remaining === 0 && approval.status === "pending")
      void refresh().catch(() => {
        if (active.current) setError(true);
      });
  }, [remaining, approval.status, refresh]);
  const routine = approval.source === "routine" && !!approval.canPreauthorize;
  const canAlways = !paused && (approval.canRemember || routine) && approval.risk !== "danger";
  const site = credentialSiteLabel(request.site);
  const resolve = async (kind: "deny" | "once" | "always") => {
    if (!peer || busy || expired) return;
    if (kind !== "deny" && !chosen) return;
    setBusy(kind);
    setError(false);
    try {
      await peer.call("credentials.login.resolve", {
        approvalId: approval.id,
        decision: kind === "deny" ? "deny" : "allow",
        ...(kind !== "deny" && chosen ? { credentialId: chosen } : {}),
        remember: kind === "always" && !routine,
        ...(kind === "always" && routine ? { preauthorize: true } : {}),
      });
      await refresh();
    } catch {
      if (active.current) setError(true);
      try {
        await refresh();
      } catch {
        // The error above is already shown; a failed reread cannot change the decision.
      }
    } finally {
      if (active.current) setBusy(undefined);
    }
  };
  const disabled = !peer || !!busy || expired;
  return (
    <section
      tabIndex={-1}
      id={`approval-${approval.id}`}
      className={`${approvalStyles.approval} ${inbox ? approvalStyles.inbox : approvalStyles.lively}`}
      data-tone="violet"
      aria-label={t("credentials.card.label")}
    >
      <header>
        <span aria-hidden="true">
          <KeyIcon />
        </span>
        <strong>{approvalText(approval, language).title}</strong>
      </header>
      <ApprovalExplanation {...approvalExplanation(approval, t)} />
      <dl className={approvalStyles.facts}>
        <div>
          <dt>{t("credentials.card.site")}</dt>
          <dd>{site}</dd>
        </div>
        {request.accounts.length === 1 && (
          <div>
            <dt>{t("credentials.card.account")}</dt>
            <dd>{request.accounts[0]?.label}</dd>
          </div>
        )}
      </dl>
      {request.accounts.length > 1 && (
        <fieldset className={styles.choices}>
          <legend>{t("credentials.card.choose")}</legend>
          {request.accounts.map((account) => (
            <label key={account.id} className={styles.choice}>
              <input
                type="radio"
                name={`login-${approval.id}`}
                checked={chosen === account.id}
                disabled={disabled}
                onChange={() => setChosen(account.id)}
              />
              <IconTile icon="user" tone="blue" size="sm" className={styles.chatTile} />
              <span>{account.label}</span>
            </label>
          ))}
          <small className={approvalStyles.note}>{t("credentials.card.multiNote")}</small>
        </fieldset>
      )}
      <p className={styles.cardNote}>
        <IconTile icon="key" tone="neutral" size="sm" />
        {t("credentials.card.secretNote")}{" "}
        {canAlways &&
          (routine
            ? t("credentials.card.routineAlwaysHint", { site })
            : t("credentials.card.alwaysHint", { site }))}
      </p>
      <footer>
        {remaining > 0 && (
          <small role="timer">
            {t(pauses ? "approval.chatCountdown" : "approval.countdown", {
              time: approvalCountdown(remaining),
            })}
          </small>
        )}
        {remaining === 0 && (
          <p role="status">{t(paused ? "approval.paused" : "approval.awaitingExpiry")}</p>
        )}
        {error && (
          <p role="alert" className={approvalStyles.risk}>
            {t("approval.error")}
          </p>
        )}
        <div className={approvalStyles.actions}>
          <Button
            variant="secondary"
            loading={busy === "deny"}
            disabled={disabled}
            title={t("credentials.card.deniedHint")}
            onClick={() => void resolve("deny")}
          >
            {t("approval.deny")}
          </Button>
          <Button
            variant={canAlways ? "secondary" : "primary"}
            className={canAlways ? undefined : approvalStyles.allow}
            loading={busy === "once"}
            disabled={disabled || !chosen}
            onClick={() => void resolve("once")}
          >
            {t("approval.allowOnce")}
          </Button>
          {canAlways && (
            <Button
              className={approvalStyles.allow}
              loading={busy === "always"}
              disabled={disabled || !chosen}
              onClick={() => void resolve("always")}
            >
              {t("approval.allowAlways")}
            </Button>
          )}
          {(error || expired) && (
            <Button variant="ghost" onClick={() => void refresh()}>
              {t("common.retry")}
            </Button>
          )}
        </div>
      </footer>
    </section>
  );
}
