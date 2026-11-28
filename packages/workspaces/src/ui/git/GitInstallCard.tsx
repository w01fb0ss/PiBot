import type { TranslationKey } from "@pibot/i18n";
import { approvalStyles, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { GitSetupStatus } from "@pibot/workspaces-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./git-install.module.css";

const POLL_MS = 3000;
const MARK = "\u0001";

function BranchIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10M18 10c0 4-6 3-12 7" />
    </svg>
  );
}

/** A translated sentence with its {command} shown as code. */
function WithCommand({ text, command }: { text: string; command: string }) {
  const [before, after] = text.split(MARK);
  return (
    <>
      {before}
      <code className={styles.code}>{command}</code>
      {after}
    </>
  );
}

/**
 * 「Pi Bot 需要安装 Git」 (maintainers 2026-11-21), shown only where a feature just needed Git: a
 * group plan whose parallel steps had to take turns ("parallel") and the changes panel or its
 * commit ("changes"). macOS and Linux only; on Windows (Git ships with Pi Bot) the brain answers
 * "unsupported" and the changes panel points to the official download. The click on 「安装」 is
 * the confirmation.
 */
export function GitInstallCard({
  context,
  onInstalled,
}: {
  context: "parallel" | "changes" | "command";
  onInstalled?: () => void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [status, setStatus] = useState<GitSetupStatus>();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState<"copied" | "failed">();
  const watched = useRef(false);
  const announced = useRef(false);
  const installed = useRef(onInstalled);
  installed.current = onInstalled;

  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (!peer) return;
      const next = await peer.call("changes.gitStatus", {}, { timeoutMs: 20_000, signal });
      if (!signal?.aborted) {
        setStatus(next);
        setError(false);
      }
    },
    [peer],
  );
  useEffect(() => {
    const abort = new AbortController();
    read(abort.signal).catch(() => {
      if (!abort.signal.aborted) setError(true);
    });
    return () => abort.abort();
  }, [read]);
  const state = status?.state;
  useEffect(() => {
    if (state !== "installing") return;
    watched.current = true;
    const abort = new AbortController();
    const timer = setInterval(() => {
      read(abort.signal).catch(() => {
        // A missed poll is retried on the next tick.
      });
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [state, read]);
  useEffect(() => {
    if (state !== "available" || announced.current) return;
    announced.current = true;
    installed.current?.();
  }, [state]);

  const act = async (method: "changes.gitInstall" | "changes.gitStatus") => {
    if (!peer || busy) return;
    setBusy(true);
    setError(false);
    try {
      setStatus(await peer.call(method, {}, { timeoutMs: 20_000 }));
      if (method === "changes.gitInstall") watched.current = true;
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  if (!status)
    return error || context === "command" ? (
      <section className={styles.failed} aria-label={t("changes.git.title")}>
        {context === "command" && <p>{t("changes.git.whyCommand")}</p>}
        {error && <p role="alert">{t("changes.git.checkError")}</p>}
        <Button
          variant="secondary"
          disabled={!peer || busy}
          onClick={() => void act("changes.gitStatus")}
        >
          {t("changes.git.recheck")}
        </Button>
      </section>
    ) : null;
  if (status.state === "unsupported")
    return context === "changes" ? (
      <section className={styles.failed} aria-label={t("changes.repo.noGit")}>
        <p className={styles.failedBody}>{t("changes.repo.noGitBody")}</p>
        <div className={styles.failedActions}>
          <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">
            {t("changes.repo.installGit")}
          </a>
          <Button
            variant="secondary"
            loading={busy}
            disabled={!peer || busy}
            onClick={() => {
              watched.current = true;
              void act("changes.gitStatus");
            }}
          >
            {t("changes.git.recheck")}
          </Button>
        </div>
        {error && <p role="alert">{t("changes.git.checkError")}</p>}
      </section>
    ) : null;
  const parallel = context === "parallel";
  if (status.state === "available") {
    // The changes panel only confirms an install it watched; a plan's card keeps its outcome.
    if (context === "command")
      return (
        <section className={styles.failed} aria-label={t("changes.git.title")}>
          <p role="status">{t("changes.git.commandAvailable")}</p>
          <p>{t("changes.git.commandRepairMac")}</p>
        </section>
      );
    if (!parallel && !watched.current) return null;
    const key: TranslationKey = status.version
      ? parallel
        ? "changes.git.installed"
        : "changes.git.installedPlain"
      : parallel
        ? "changes.git.installedNoVersion"
        : "changes.git.installedPlainNoVersion";
    return (
      <p className={styles.state} data-tone="ok" role="status">
        <span className={styles.dot} aria-hidden="true" />
        {t(key, { version: status.version ?? "" })}
      </p>
    );
  }
  if (status.state === "installing")
    return (
      <p className={styles.state} role="status">
        <span className={styles.dot} aria-hidden="true" />
        {t(parallel ? "changes.git.installing" : "changes.git.installingPlain")}
        {status.installer === "xcode" && (
          <span className={styles.hint}>{t("changes.git.installingMac")}</span>
        )}
      </p>
    );
  const manual = status.installer === "manual";
  if (status.state === "failed" || manual)
    // The title stays so the failure still says what it is about; another click on 重新安装
    // starts a fresh attempt (the brain still runs one installer at a time).
    return (
      <section className={styles.failed} role="alert" aria-label={t("changes.git.title")}>
        <header className={styles.failedTitle}>
          <span className={`${styles.dot} ${styles.dotDanger}`} aria-hidden="true" />
          <strong>{t("changes.git.title")}</strong>
        </header>
        <p className={styles.failedBody}>
          {manual
            ? t(
                status.manualCommand
                  ? "changes.git.manualAuthorization"
                  : "changes.git.manualInstall",
              )
            : status.reason
              ? t("changes.git.notInstalledReason", {
                  reason: t(`changes.git.reason.${status.reason}`),
                })
              : t("changes.git.notInstalled")}
        </p>
        {!manual && <p className={styles.failedBody}>{t("changes.git.failedGeneric")}</p>}
        {status.installer === "xcode" && <p>{t("changes.git.commandRepairMac")}</p>}
        {status.manualCommand && (
          <details>
            <summary>{t("changes.git.advanced")}</summary>
            <p>
              {manual ? (
                <code>{status.manualCommand}</code>
              ) : (
                <WithCommand
                  text={t("changes.git.failed", { command: MARK })}
                  command={status.manualCommand}
                />
              )}
            </p>
          </details>
        )}
        {error && (
          <p role="alert" className={approvalStyles.risk}>
            {t("changes.git.error")}
          </p>
        )}
        <div className={styles.failedActions}>
          {status.manualCommand && (
            <Button
              variant="secondary"
              onClick={() => {
                const command = status.manualCommand;
                if (!command) return;
                void navigator.clipboard.writeText(command).then(
                  () => setCopied("copied"),
                  () => setCopied("failed"),
                );
              }}
            >
              {t("commandProtection.copy")}
            </Button>
          )}
          {manual && !status.manualCommand && (
            <a href="https://git-scm.com/downloads/linux" target="_blank" rel="noreferrer">
              {t("changes.repo.installGit")}
            </a>
          )}
          <Button
            variant="secondary"
            className={styles.recheck}
            disabled={busy}
            onClick={() => void act("changes.gitStatus")}
          >
            {t("changes.git.recheck")}
          </Button>
          {copied && (
            <span role="status">
              {t(copied === "copied" ? "commandProtection.copied" : "messages.copyFailed")}
            </span>
          )}
          {!manual && (
            <Button
              className={styles.recheck}
              loading={busy}
              disabled={!peer}
              onClick={() => void act("changes.gitInstall")}
            >
              {t("changes.git.retry")}
            </Button>
          )}
        </div>
      </section>
    );
  if (dismissed) return null;
  const what = t(
    status.installer === "xcode" ? "changes.git.whatMac" : "changes.git.whatLinuxGeneric",
  );
  return (
    <section
      className={`${approvalStyles.approval} ${styles.card}`}
      data-tone="violet"
      aria-label={t("changes.git.title")}
    >
      <header>
        <span aria-hidden="true">
          <BranchIcon />
        </span>
        <strong>{t("changes.git.title")}</strong>
      </header>
      <dl className={approvalStyles.facts}>
        <div>
          <dt>{t("changes.git.why")}</dt>
          <dd>
            {t(
              parallel
                ? "changes.git.whyParallel"
                : context === "command"
                  ? "changes.git.whyCommand"
                  : "changes.git.whyChanges",
            )}
          </dd>
        </div>
        <div>
          <dt>{t("changes.git.what")}</dt>
          <dd>{what}</dd>
        </div>
        <div>
          <dt>{t("changes.git.where")}</dt>
          <dd>{t("changes.git.whereValue")}</dd>
        </div>
      </dl>
      <p className={approvalStyles.warning}>{t("changes.git.note")}</p>
      {context === "command" && status.installer === "xcode" && (
        <p>{t("changes.git.commandRepairMac")}</p>
      )}
      {status.installer === "package" && status.command && (
        <details>
          <summary>{t("changes.git.advanced")}</summary>
          <code>{status.command}</code>
        </details>
      )}
      <footer>
        {error && (
          <p role="alert" className={approvalStyles.risk}>
            {t("changes.git.error")}
          </p>
        )}
        <div className={approvalStyles.actions}>
          <Button variant="secondary" disabled={busy} onClick={() => setDismissed(true)}>
            {t(parallel ? "changes.git.later" : "changes.git.laterPlain")}
          </Button>
          <Button loading={busy} disabled={!peer} onClick={() => void act("changes.gitInstall")}>
            {t("changes.git.install")}
          </Button>
        </div>
      </footer>
    </section>
  );
}
