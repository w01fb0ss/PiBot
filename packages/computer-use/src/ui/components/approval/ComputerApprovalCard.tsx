import {
  approvalCountdown,
  approvalDeadline,
  approvalExplanation,
  approvalText,
} from "@pibot/client-core";
import type {
  Approval,
  ComputerApprovalRequest,
  ComputerGrantDuration,
} from "@pibot/computer-use-contract/full";
import { ApprovalExplanation, approvalStyles, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../computer.module.css";
import { computerErrorKey, isDesktopApp } from "../presentation.ts";
import { SystemPermissionRows } from "../settings/SystemPermissions.tsx";

type Request = ComputerApprovalRequest;

function MonitorIcon() {
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
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

/** The always-list and the card list only hold desktop apps; the Bot browser is a website matter. */
function initialSelection(request: Request) {
  return new Set(
    request.apps
      .filter(
        (app) =>
          isDesktopApp(app.id) &&
          !app.blocked &&
          (app.suggested ||
            request.alwaysAppIds.some((id) => id.toLowerCase() === app.id.toLowerCase())),
      )
      .map((app) => app.id),
  );
}

/**
 * "Wants to use your computer" card. Resolves through `computer.grant.resolve`, not
 * `approvals.resolve`, so the extended choices (apps, duration, foreground, coordinates, always)
 * reach brain in one call; the backend's event/read remains the only proof of the outcome.
 */
export function ComputerApprovalCard({
  approval,
  request,
  refresh,
  inbox = false,
}: {
  approval: Approval;
  request: Request;
  refresh(): Promise<void>;
  inbox?: boolean;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const [selected, setSelected] = useState(() => initialSelection(request));
  const [duration, setDuration] = useState<ComputerGrantDuration>("task");
  const [foregroundAsk, setForegroundAsk] = useState(true);
  // D8: always off by default, even when this request is specifically about coordinates.
  const [coordinates, setCoordinates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof computerErrorKey>>();
  const [now, setNow] = useState(Date.now);
  const active = useRef(true);
  const locked = useRef(false);
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
        if (active.current) setError("computerUse.error.failed");
      });
  }, [remaining, approval.status, refresh]);
  const apps = request.apps.filter((app) => isDesktopApp(app.id));
  const acceptsImages = request.modelAcceptsImages === true;
  const inAlways = (id: string) =>
    request.alwaysAppIds.some((always) => always.toLowerCase() === id.toLowerCase());
  // "always" adds the checked apps to the Bot's always-list (never screenshot clicks).
  const resolve = async (decision: "allow" | "deny", always = false) => {
    if (!peer || locked.current || expired) return;
    if (decision === "allow" && selected.size === 0) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await peer.call(
        "computer.grant.resolve",
        decision === "allow"
          ? {
              approvalId: approval.id,
              decision,
              apps: [...selected],
              duration,
              foregroundAsk,
              allowCoordinates: acceptsImages && coordinates,
              ...(!paused && always ? { always: true } : {}),
            }
          : { approvalId: approval.id, decision },
      );
      await refresh();
    } catch (e) {
      if (active.current) setError(computerErrorKey(e));
      try {
        await refresh();
      } catch {
        // The error above is already shown; a failed reread cannot change the decision.
      }
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  };
  const disabled = !peer || busy || expired;
  const reasonKey = `computerUse.card.reason.${request.reason}` as const;
  return (
    <section
      tabIndex={-1}
      id={`approval-${approval.id}`}
      className={`${approvalStyles.approval} ${inbox ? approvalStyles.inbox : styles.card}`}
      data-tone="pink"
      aria-label={t("computerUse.card.label")}
    >
      <header>
        <span aria-hidden="true">
          <MonitorIcon />
        </span>
        <strong>{approvalText(approval, language).title}</strong>
      </header>
      <ApprovalExplanation {...approvalExplanation(approval, t)} />
      <p className={styles.subtitle}>
        {request.reason === "first" || (!acceptsImages && request.reason === "coordinates")
          ? t("computerUse.card.subtitle")
          : t(reasonKey)}
      </p>
      <SystemPermissionRows compact />
      {apps.map((app) => {
        const locked = app.blocked;
        const always = inAlways(app.id);
        return (
          <label key={app.id} className={styles.appRow} data-locked={locked || undefined}>
            <input
              type="checkbox"
              checked={!locked && selected.has(app.id)}
              disabled={disabled || locked}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((old) => {
                  const next = new Set(old);
                  if (checked) next.add(app.id);
                  else next.delete(app.id);
                  return next;
                });
              }}
            />
            <span className={styles.appName}>{app.name}</span>
            {locked ? (
              <span className={styles.hint} data-tone="danger">
                {t("computerUse.card.blocked")}
              </span>
            ) : always ? (
              <span className={styles.hint} data-tone="muted">
                {t("computerUse.card.inAlways")}
              </span>
            ) : (
              app.suggested && (
                <span className={styles.hint}>{t("computerUse.card.suggested")}</span>
              )
            )}
          </label>
        );
      })}
      <div className={styles.durationRow}>
        <span>{t("computerUse.card.duration")}</span>
        <SegmentedControl<ComputerGrantDuration>
          label={t("computerUse.card.duration")}
          value={duration}
          disabled={disabled}
          options={[
            { value: "task", label: t("computerUse.duration.task") },
            { value: "today", label: t("computerUse.duration.today") },
          ]}
          onValueChange={setDuration}
        />
      </div>
      <label className={styles.optionRow}>
        <input
          type="checkbox"
          checked={foregroundAsk}
          disabled={disabled}
          onChange={(event) => setForegroundAsk(event.currentTarget.checked)}
        />
        <span className={styles.optionText}>{t("computerUse.card.foregroundAsk")}</span>
      </label>
      {acceptsImages && (
        <label className={styles.optionRow}>
          <input
            type="checkbox"
            checked={coordinates}
            disabled={disabled}
            onChange={(event) => setCoordinates(event.currentTarget.checked)}
          />
          <span className={styles.optionText}>
            <span>{t("computerUse.card.coordinates")}</span>
            <small>{t("computerUse.card.coordinatesNote")}</small>
            {request.coordinatesRequested && (
              <small>{t("computerUse.card.coordinatesRequested")}</small>
            )}
          </span>
        </label>
      )}
      {/* The four notices read as pills rather than one long dotted line. */}
      <ul className={styles.cardNotes}>
        {[
          acceptsImages
            ? request.providerName
              ? t("computerUse.card.noticeProvider", { provider: request.providerName })
              : t("computerUse.card.noticeLocal")
            : t("computerUse.card.noticeNoImages"),
          t("computerUse.card.noticeScope"),
          t("computerUse.card.noticePassword"),
          t("computerUse.card.noticeRecord"),
        ].map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
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
        {selected.size === 0 && remaining > 0 && (
          <p role="status" className={approvalStyles.note}>
            {t("computerUse.card.noneSelected")}
          </p>
        )}
        {error && (
          <p role="alert" className={approvalStyles.risk}>
            {t(error)}
          </p>
        )}
        {!paused && <small>{t("computerUse.card.alwaysNote")}</small>}
        <div className={approvalStyles.actions}>
          <Button variant="secondary" disabled={disabled} onClick={() => void resolve("deny")}>
            {t("approval.deny")}
          </Button>
          <Button
            variant="secondary"
            loading={busy}
            disabled={!peer || expired || selected.size === 0}
            onClick={() => void resolve("allow")}
          >
            {t("approval.allowOnce")}
          </Button>
          {!paused && (
            <Button
              className={inbox ? undefined : styles.primary}
              disabled={!peer || busy || expired || selected.size === 0}
              onClick={() => void resolve("allow", true)}
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
