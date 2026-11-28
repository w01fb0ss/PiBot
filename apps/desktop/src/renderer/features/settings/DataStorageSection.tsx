import type { MethodResults } from "@pibot/protocol";
import {
  hostPlatform,
  SettingsRow,
  SettingsSection,
  TaskStatus,
  useRpc,
  useSettings,
  useTask,
} from "@pibot/renderer-kit";
import { Button, TextField } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import { useStartupDisplay } from "../../app/startup-display.tsx";
import styles from "./DataStorageSection.module.css";
import { SetupError } from "./operations.ts";

type EstimateState =
  | { status: "idle" }
  | { status: "loading"; days: number; version: number }
  | { status: "ready"; days: number; version: number; data: MethodResults["runs.cleanupEstimate"] }
  | { status: "error"; days: number; version: number };

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DataStorageSection({ disabled }: { disabled: boolean }) {
  const { peer } = useRpc();
  const { t } = useSettings();
  const dataTask = useTask();
  const cleanupTask = useTask();
  const startupDisplay = useStartupDisplay();

  const [info, setInfo] = useState<MethodResults["app.getInfo"]>();
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState(false);
  const [storage, setStorage] = useState<MethodResults["app.storageInfo"]>();
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState(false);

  const [cleanupDays, setCleanupDays] = useState("30");
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [estimateState, setEstimateState] = useState<EstimateState>({ status: "idle" });
  const [estimateVersion, setEstimateVersion] = useState(0);

  const parsedCleanupDays = Number(cleanupDays);
  const cleanupDaysValid =
    Number.isInteger(parsedCleanupDays) && parsedCleanupDays >= 1 && parsedCleanupDays <= 36_500;

  const loadInfo = useCallback(
    async (signal?: AbortSignal) => {
      if (!peer) return;
      setInfoLoading(true);
      setInfoError(false);
      try {
        const result = await peer.call("app.getInfo", undefined, { signal, timeoutMs: 15_000 });
        if (!signal?.aborted) setInfo(result);
      } catch {
        if (!signal?.aborted) setInfoError(true);
      } finally {
        if (!signal?.aborted) setInfoLoading(false);
      }
    },
    [peer],
  );

  const loadStorage = useCallback(
    async (signal?: AbortSignal) => {
      if (!peer) return;
      setStorageLoading(true);
      setStorageError(false);
      try {
        const result = await peer.call("app.storageInfo", undefined, { signal, timeoutMs: 20_000 });
        if (!signal?.aborted) setStorage(result);
      } catch {
        if (!signal?.aborted) setStorageError(true);
      } finally {
        if (!signal?.aborted) setStorageLoading(false);
      }
    },
    [peer],
  );

  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    void loadInfo(controller.signal);
    void loadStorage(controller.signal);
    return () => controller.abort();
  }, [peer, loadInfo, loadStorage]);

  useEffect(() => {
    setCleanupConfirmed(false);
    if (!peer || !cleanupDaysValid) {
      setEstimateState({ status: "idle" });
      return;
    }
    const days = parsedCleanupDays;
    const version = estimateVersion;
    // Drop any previous day count's estimate immediately so confirmation never acts on stale numbers.
    setEstimateState({ status: "loading", days, version });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void peer
        .call(
          "runs.cleanupEstimate",
          { olderThanDays: days },
          { signal: controller.signal, timeoutMs: 15_000 },
        )
        .then((result) => {
          if (!controller.signal.aborted)
            setEstimateState({ status: "ready", days, version, data: result });
        })
        .catch(() => {
          if (!controller.signal.aborted) setEstimateState({ status: "error", days, version });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [peer, cleanupDaysValid, parsedCleanupDays, estimateVersion]);

  const clearDisplay = async () => {
    try {
      if (!startupDisplay) throw new Error("startup_cache_unavailable");
      await startupDisplay.clear();
    } catch {
      throw new SetupError("startup.clearFailed");
    }
  };

  const platform = info?.platform ?? hostPlatform();
  const openDirLabel =
    platform === "darwin"
      ? t("settings.openDataDir.darwin")
      : platform === "win32"
        ? t("settings.openDataDir.win32")
        : t("settings.openDataDir.linux");

  const storageSummary = storage
    ? `${t("settings.storageUsageSummary", {
        total: formatBytes(storage.totalBytes),
        chats: formatBytes(storage.categories.databaseBytes + storage.categories.botsAndMediaBytes),
        runtimes: formatBytes(storage.categories.runtimesBytes),
        logs: formatBytes(storage.categories.logsAndCacheBytes),
        other: formatBytes(storage.categories.otherBytes),
      })}${storage.truncated ? t("settings.storageUsageTruncated") : ""}`
    : undefined;

  const estimateCurrent =
    cleanupDaysValid &&
    estimateState.status !== "idle" &&
    estimateState.days === parsedCleanupDays &&
    estimateState.version === estimateVersion;
  const estimateSettled =
    estimateCurrent && (estimateState.status === "ready" || estimateState.status === "error");

  return (
    <>
      <SettingsSection title={t("settings.data")}>
        <SettingsRow
          icon="folder"
          tone="blue"
          label={t("settings.dataLocation")}
          note={
            <>
              <span>{t("settings.dataLocationNote")}</span>
              {info?.dataDir ? (
                <code className={styles.path} dir="ltr">
                  {info.dataDir}
                </code>
              ) : infoError ? (
                <div className={styles.errorRow} role="alert">
                  <span>{t("settings.dataLocationError")}</span>
                  {peer && (
                    <button
                      type="button"
                      className={styles.link}
                      disabled={infoLoading}
                      onClick={() => void loadInfo()}
                    >
                      {t("common.retry")}
                    </button>
                  )}
                </div>
              ) : peer ? (
                <div className={styles.usageRow}>
                  <span>{t("settings.dataLocationLoading")}</span>
                </div>
              ) : null}
              <div className={styles.usageRow}>
                {peer && !storageSummary && !storageError ? (
                  <span>{t("settings.storageUsageLoading")}</span>
                ) : storageError ? (
                  <span className={styles.inlineError} role="alert">
                    {t("settings.storageUsageError")}
                  </span>
                ) : (
                  <span>{storageSummary ?? ""}</span>
                )}
                {peer && (
                  <button
                    type="button"
                    className={styles.link}
                    disabled={storageLoading}
                    onClick={() => void loadStorage()}
                  >
                    {t(storageError ? "common.retry" : "settings.storageUsageRefresh")}
                  </button>
                )}
              </div>
            </>
          }
        >
          <Button
            variant="secondary"
            loading={dataTask.busy}
            disabled={!peer || dataTask.busy}
            onClick={() => {
              if (!peer) return;
              void dataTask.run(async () => {
                await peer.call("app.openDataDir", undefined).catch(() => {
                  throw new SetupError("settings.openDataDirError");
                });
              });
            }}
          >
            {openDirLabel}
          </Button>
        </SettingsRow>

        <SettingsRow
          icon="trash"
          tone="pink"
          label={t("startup.clear")}
          note={t("startup.clearNote")}
        >
          <Button
            variant="secondary"
            disabled={disabled || dataTask.busy}
            onClick={() =>
              void dataTask.run(async () => {
                await clearDisplay();
              })
            }
          >
            {t("startup.clear")}
          </Button>
        </SettingsRow>

        <SettingsRow
          icon="clock"
          tone="amber"
          label={t("settings.runCleanup")}
          note={
            <>
              <span>{t("settings.runCleanupNote")}</span>
              {peer &&
                cleanupDaysValid &&
                (!estimateCurrent || estimateState.status === "loading") && (
                  <p className={styles.estimate} role="status">
                    {t("settings.runCleanupEstimateLoading", { days: parsedCleanupDays })}
                  </p>
                )}
              {estimateCurrent && estimateState.status === "ready" && (
                <p className={styles.estimate} role="status">
                  {!estimateState.data.incomplete &&
                  estimateState.data.runs === 0 &&
                  estimateState.data.files === 0
                    ? t("settings.runCleanupEstimateEmpty", { days: parsedCleanupDays })
                    : t("settings.runCleanupEstimate", {
                        size: formatBytes(estimateState.data.bytes),
                        runs: estimateState.data.runs,
                        files: estimateState.data.files,
                      })}
                </p>
              )}
              {estimateCurrent &&
                (estimateState.status === "error" ||
                  (estimateState.status === "ready" && estimateState.data.incomplete)) && (
                  <div className={styles.errorRow} role="alert">
                    <span>
                      {t(
                        estimateState.status === "ready"
                          ? "settings.runCleanupEstimateIncomplete"
                          : "settings.runCleanupEstimateError",
                      )}
                    </span>
                    {peer && (
                      <button
                        type="button"
                        className={styles.link}
                        disabled={cleanupTask.busy}
                        onClick={() => {
                          setCleanupConfirmed(false);
                          setEstimateVersion((n) => n + 1);
                        }}
                      >
                        {t("settings.runCleanupEstimateRetry")}
                      </button>
                    )}
                  </div>
                )}
            </>
          }
        >
          <div className={styles.cleanupControls}>
            <TextField
              label={t("settings.runCleanupDays")}
              type="number"
              min={1}
              max={36_500}
              step={1}
              value={cleanupDays}
              disabled={cleanupTask.busy}
              error={
                cleanupDays.length > 0 && !cleanupDaysValid
                  ? t("settings.runCleanupInvalid")
                  : undefined
              }
              style={{ width: 104 }}
              onChange={(event) => {
                setCleanupDays(event.currentTarget.value);
                setEstimateVersion((n) => n + 1);
                setCleanupConfirmed(false);
              }}
            />
            <Button
              loading={cleanupTask.busy}
              disabled={
                disabled || cleanupTask.busy || !peer || !cleanupDaysValid || !estimateSettled
              }
              variant={cleanupConfirmed ? "primary" : "secondary"}
              onClick={() => {
                if (disabled || cleanupTask.busy || !peer || !cleanupDaysValid || !estimateSettled)
                  return;
                if (!cleanupConfirmed) {
                  setCleanupConfirmed(true);
                  return;
                }
                void cleanupTask
                  .run(async () => {
                    await clearDisplay();
                    const result = await peer
                      .call("runs.cleanup", {
                        olderThanDays: parsedCleanupDays,
                        confirmed: true,
                      })
                      .catch(() => {
                        throw new SetupError("settings.runCleanupError");
                      });
                    cleanupTask.setSuccess(
                      t("settings.runCleanupDone", {
                        runs: result.runs,
                        files: result.sessionFiles + result.resultFiles,
                        size: formatBytes(result.freedBytes ?? 0),
                      }),
                    );
                  })
                  .finally(() => {
                    setCleanupConfirmed(false);
                    setEstimateVersion((n) => n + 1);
                    void loadStorage();
                  });
              }}
            >
              {t(
                cleanupTask.busy
                  ? "settings.runCleaning"
                  : cleanupConfirmed
                    ? "settings.runCleanupConfirm"
                    : "settings.runCleanupAction",
              )}
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>
      <TaskStatus task={dataTask} />
      <TaskStatus task={cleanupTask} />
    </>
  );
}
