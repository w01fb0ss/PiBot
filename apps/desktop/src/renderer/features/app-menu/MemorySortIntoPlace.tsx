import { type MethodResults, memoryFailureNeedsSettings, RpcError } from "@pibot/protocol";
import { useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { MemoryFallbackNotice } from "../workspace/memory/MemoryFallbackNotice.tsx";
import styles from "../workspace/memory/settings/memory-settings.module.css";
import menuStyles from "./app-menu.module.css";
import { startMemorySort } from "./memory-sort-run.ts";

type Result = MethodResults["memory.sortIntoPlace"];
type Run = ReturnType<typeof startMemorySort> & { cancelRequested: boolean };

/** This entry exists only in About you; no automatic or agent-facing trigger shares it. */
export function MemorySortIntoPlace() {
  const t = useT();
  const { peer } = useRpc();
  const lock = useRef<Run | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0, moves: 0 });
  const latestProgress = useRef(progress);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<"busy" | "failed">();
  useEffect(() => {
    setBusy(false);
    setCancelling(false);
    setResult(undefined);
    setError(undefined);
    if (!peer) return;
    return () => {
      const current = lock.current;
      if (current) {
        // GUI transport cancellation only detaches the reply. Cancel the owner run explicitly too.
        void current.cancel().catch(() => {
          /* A disconnected owner still has the five-minute run deadline. */
        });
      }
      lock.current = null;
    };
  }, [peer]);
  useRpcEvent("memory.sortProgress", (value) => {
    if (lock.current) {
      latestProgress.current = value;
      setProgress(value);
    }
  });
  const run = async () => {
    if (!peer || lock.current) return;
    const controller: Run = Object.assign(startMemorySort(peer), {
      cancelRequested: false,
    });
    lock.current = controller;
    setBusy(true);
    setResult(undefined);
    setError(undefined);
    latestProgress.current = { processed: 0, total: 0, moves: 0 };
    setProgress(latestProgress.current);
    try {
      const value = await controller.result;
      if (lock.current === controller) setResult(value);
    } catch (failure) {
      if (lock.current === controller && !controller.cancelRequested)
        setError(
          failure instanceof RpcError && failure.message === "memory_sort_busy" ? "busy" : "failed",
        );
    } finally {
      // Explicit cancellation owns the lock until the owner confirms drain and usage settlement.
      if (lock.current === controller && !controller.cancelRequested) {
        lock.current = null;
        setBusy(false);
        setCancelling(false);
      }
    }
  };
  const cancel = async () => {
    const current = lock.current;
    if (!peer || !current || current.cancelRequested) return;
    current.cancelRequested = true;
    setCancelling(true);
    try {
      await current.cancel();
      if (lock.current === current) setResult({ ...latestProgress.current, status: "cancelled" });
    } catch {
      if (lock.current === current) setError("failed");
    } finally {
      if (lock.current === current) {
        lock.current = null;
        setBusy(false);
        setCancelling(false);
      }
    }
  };
  const reason = result?.failureReason ?? "failed";
  const failureText = () => {
    if (reason === "busy") return t("memorySettings.sort.busyProvider");
    if (reason === "network") return t("memorySettings.sort.network");
    if (reason === "no_model") return t("memorySettings.sort.noModel");
    if (reason === "local_only_no_model") return t("memorySettings.sort.localOnlyNoModel");
    if (memoryFailureNeedsSettings(reason)) return t("memorySettings.sort.failed");
    return t("memorySettings.sort.unknown", { reason: t(`memorySettings.maintenance.${reason}`) });
  };
  return (
    <div className={`${styles.card} ${menuStyles.sortCard}`} aria-busy={busy}>
      <div className={menuStyles.sortHead}>
        <IconTile icon="refresh" tone="pink" />
        <p className={styles.meta}>{t("memorySettings.sortLead")}</p>
        <div className={styles.toolbar}>
          {busy && (
            <Button
              variant="ghost"
              className={styles.small}
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              {t("common.cancel")}
            </Button>
          )}
          <Button
            variant="pill"
            className={styles.small}
            disabled={!peer || busy}
            onClick={() => void run()}
          >
            {t("memorySettings.sortIntoPlace")}
          </Button>
        </div>
      </div>
      <div role="status" aria-live="polite">
        {busy && !result && (
          <p className={styles.meta}>{t("memorySettings.sortProgress", progress)}</p>
        )}
        {result && (
          <>
            {result.moves > 0 && <p>{t("memorySettings.sortResult", { count: result.moves })}</p>}
            {result.status === "done" && result.moves === 0 && (
              <p>{t("memorySettings.sortEmpty")}</p>
            )}
            {result.status === "failed" && <p>{failureText()}</p>}
            {(result.status === "limited" || result.status === "cancelled") && (
              <p>{t(`memorySettings.sort.${result.status}`)}</p>
            )}
            {result.fallback && (
              <MemoryFallbackNotice fallback={result.fallback} partial={result.status !== "done"} />
            )}
          </>
        )}
        {error && (
          <p role="alert">{error === "busy" ? t("memorySettings.sortBusy") : failureText()}</p>
        )}
      </div>
    </div>
  );
}
