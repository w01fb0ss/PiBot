// Keep the Windows disclosure and explicit consent with the existing YOLO confirmation.
import {
  type ChatPeer,
  isolationReasonText,
  sameYoloScope,
  yoloScopeUnavailable,
} from "@pibot/client-core";
import type { ConversationYolo } from "@pibot/protocol";
import { useAction, useNavigation, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import { Overlay } from "../../workspace/Overlay.tsx";
import styles from "./yolo.module.css";

export function YoloConfirmation({
  peer,
  conversationId,
  group,
  close,
  enable,
}: {
  peer: ChatPeer;
  conversationId: string;
  group: boolean;
  close(): void;
  enable(signal: AbortSignal, acknowledged: boolean): Promise<ConversationYolo | undefined>;
}) {
  const { t, settings } = useSettings();
  const action = useAction();
  const [acknowledged, setAcknowledged] = useState(false);
  const [scope, setScope] = useState<ConversationYolo | "unavailable">();
  const readScope = useCallback(
    async (signal: AbortSignal) => {
      setScope(undefined);
      try {
        const value = await peer.call("conversations.yolo.get", { conversationId }, { signal });
        if (!signal.aborted) setScope(value);
      } catch {
        if (!signal.aborted) setScope("unavailable");
      }
    },
    [peer, conversationId],
  );
  useEffect(() => {
    const request = new AbortController();
    void readScope(request.signal);
    return () => request.abort();
  }, [readScope]);
  const knownScope =
    scope && scope !== "unavailable" && !yoloScopeUnavailable(scope) ? scope : null;
  const isolation = knownScope?.isolation;
  const windowsDirectRun = knownScope?.windowsDirectRun;
  const windows = isolation?.available === false && isolation.reason === "windows_unisolated";
  const canConsent =
    windows && window.pibot.platform === "win32" && windowsDirectRun !== "unavailable";
  const consented =
    windowsDirectRun === undefined
      ? settings?.yoloUnisolatedCommands === true
      : windowsDirectRun === "consented";
  const needsConsent = canConsent && !consented;
  const confirm = () => {
    if (!knownScope) return;
    void action
      .run(
        async (signal) => {
          let latest: ConversationYolo;
          try {
            latest = await peer.call("conversations.yolo.get", { conversationId }, { signal });
          } catch {
            if (!signal.aborted) setScope("unavailable");
            return;
          }
          signal.throwIfAborted();
          setScope(latest);
          const unavailable = yoloScopeUnavailable(latest);
          if (unavailable || !sameYoloScope(latest, knownScope)) {
            setAcknowledged(false);
            if (!unavailable) action.setError("yolo.scopeChanged");
            return;
          }
          return enable(signal, needsConsent && acknowledged);
        },
        () => "yolo.failed",
      )
      .then((value) => {
        if (value?.enabled) close();
      });
  };
  return (
    <Overlay
      icon="bolt"
      tone="orange"
      title={t("yolo.confirmTitle")}
      close={close}
      busy={action.busy}
      footer={
        <>
          {action.error && (
            <p role="alert" className={styles.confirmError}>
              {t(action.error)}
            </p>
          )}
          <Button variant="secondary" disabled={action.busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          {knownScope ? (
            <Button
              className={styles.turnOn}
              loading={action.busy}
              disabled={canConsent && !settings}
              onClick={confirm}
            >
              {t("yolo.confirm")}
            </Button>
          ) : (
            <Button disabled={!scope || action.busy} onClick={() => void action.run(readScope)}>
              {t("common.retry")}
            </Button>
          )}
        </>
      }
    >
      {isolation ? (
        <div className={styles.confirm}>
          <p>{t("yolo.confirmIntro")}</p>
          {group && <p>{t("yolo.confirmGroup")}</p>}
          <p>{t("yolo.privacy")}</p>
          {isolation.available && <p className={styles.risk}>{t("yolo.savedDirectRuns")}</p>}
          {!isolation.available && !windows && (
            <p className={styles.risk} role="alert">
              {t("yolo.unisolated")}
            </p>
          )}
          <YoloScopes
            windows={windows}
            isolated={isolation.available}
            directRun={consented || (needsConsent && acknowledged)}
            isolationDetail={
              !isolation.available ? isolationReasonText(isolation.reason, t) : undefined
            }
          />
          {canConsent && (
            <WindowsYoloDisclosure
              consented={consented}
              ready={settings !== undefined || windowsDirectRun !== undefined}
              acknowledged={acknowledged}
              setAcknowledged={setAcknowledged}
              busy={action.busy}
              close={close}
            />
          )}
          {windows && !canConsent && (
            <p className={styles.note}>
              {t(
                consented
                  ? "yolo.windowsReminder"
                  : windowsDirectRun === undefined
                    ? "yolo.windowsConsentUnknown"
                    : "yolo.windowsWithoutConsent",
              )}
            </p>
          )}
          <p className={styles.note}>
            {t(
              windows && (consented || (needsConsent && acknowledged))
                ? "yolo.nothingRemembered.windows"
                : "yolo.nothingRemembered",
            )}
          </p>
        </div>
      ) : scope ? (
        <p role="alert" className={styles.risk}>
          {t("yolo.scopeUnavailable")}
        </p>
      ) : (
        <p role="status">{t("common.loading")}</p>
      )}
    </Overlay>
  );
}

function YoloScopes({
  windows,
  isolated,
  directRun,
  isolationDetail,
}: {
  windows: boolean;
  isolated: boolean;
  directRun: boolean;
  isolationDetail?: string;
}) {
  const { t } = useSettings();
  const commands = isolated
    ? "yolo.filesAndCommands"
    : windows && directRun
      ? "yolo.filesAndCommands.windows"
      : "yolo.filesOnly";
  const skips = [t(commands), ...t("yolo.skipsList").split("\n")];
  const keeps = t(windows ? "yolo.keepsList.windows" : "yolo.keepsList")
    .split("\n")
    .filter(Boolean);
  return (
    <>
      <div className={styles.scopes}>
        <section className={styles.scope} data-tone="ok">
          <h2>{t("yolo.skips")}</h2>
          <ul>
            {skips.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section className={styles.scope} data-tone="danger">
          <h2>{t("yolo.keeps")}</h2>
          <ul>
            {keeps.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>{t(windows ? "yolo.readOnly.windows" : "yolo.keepsSafety")}</p>
        </section>
      </div>
      <p className={styles.note}>{t("yolo.pending")}</p>
      <details className={styles.details}>
        <summary>{t("yolo.detailsSummary")}</summary>
        <p>{t(windows ? "yolo.details.windows" : "yolo.details")}</p>
        {!windows && isolationDetail && <p>{isolationDetail}</p>}
      </details>
    </>
  );
}

function WindowsYoloDisclosure({
  consented,
  ready,
  acknowledged,
  setAcknowledged,
  busy,
  close,
}: {
  consented: boolean;
  ready: boolean;
  acknowledged: boolean;
  setAcknowledged(value: boolean): void;
  busy: boolean;
  close(): void;
}) {
  const { t } = useSettings();
  const { openSettings } = useNavigation();
  if (!ready) return <p role="status">{t("common.loading")}</p>;
  if (consented)
    return (
      <p className={styles.note}>
        {isolationReasonText("windows_unisolated", t, consented)}{" "}
        <button
          type="button"
          className={styles.consentLink}
          disabled={busy}
          onClick={() => {
            close();
            openSettings("permissions");
          }}
        >
          {t("yolo.windowsConsentSettings")}
        </button>
      </p>
    );
  return (
    <div className={styles.consentBanner}>
      <p>
        <strong>{t("yolo.windowsDisclosureTitle")}</strong> {t("yolo.windowsDisclosure")}
      </p>
      {!acknowledged && <p>{t("yolo.windowsWithoutConsent")}</p>}
      <label className={styles.consentCheck}>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
        />
        {t("yolo.windowsAcknowledge")}
      </label>
    </div>
  );
}
