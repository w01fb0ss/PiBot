import { runErrorText } from "@pibot/i18n";
import { type InboxItem, memoryFailureNeedsSettings, memoryFailureReason } from "@pibot/protocol";
import { useNavigation, useRpc, useSettings } from "@pibot/renderer-kit";
import { useRoutineNavigation } from "@pibot/routines/ui";
import { Button } from "@pibot/ui";
import { useState } from "react";
import styles from "./inbox.module.css";

export type BackgroundTaskInboxItem = Extract<InboxItem, { kind: "background_task" }>;

/**
 * The card that turns a silent background failure into something the person can act on.
 * It shows the task and current object name alongside a fixed reason and next step.
 */
export function BackgroundTaskInboxCard({ item }: { item: BackgroundTaskInboxItem }) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const [busy, setBusy] = useState(false);
  const { openAudit, openSettings } = useNavigation();
  const { openRoutines } = useRoutineNavigation();
  const { task, subject, subjectName, reasonCode, streak, firstFailedAt } = item.health;
  const title = t("workspace.backgroundTask");
  const model = task === "memory_extraction" || task === "memory_organization";
  const memoryReason = model ? memoryFailureReason(reasonCode) : undefined;
  const checkModels = memoryReason && memoryFailureNeedsSettings(memoryReason);
  const retry = memoryReason === "busy" || memoryReason === "network";
  return (
    <article className={styles.card} aria-label={title}>
      <header className={styles.cardHeader}>
        <div className={styles.heading}>
          <strong>{title}</strong>
          {subjectName && <div>{subjectName}</div>}
        </div>
        <span className={styles.badge}>{t(`workspace.backgroundTask.task.${task}`)}</span>
      </header>
      <div className={styles.memoryBody}>
        <p>
          {t("workspace.backgroundTask.streak", { count: streak })} ·{" "}
          {t("workspace.backgroundTask.since", {
            time: new Date(firstFailedAt).toLocaleString(language),
          })}
        </p>
        <p>
          {t("workspace.backgroundTask.reason", {
            code: memoryReason
              ? t(`memorySettings.maintenance.${memoryReason}`)
              : (runErrorText(reasonCode, t) ?? t("errors.genericFailure")),
          })}
        </p>
        {retry && <p>{t("workspace.backgroundTask.memoryRetry")}</p>}
        {checkModels && memoryReason !== "local_only_no_model" && (
          <p>{t("workspace.backgroundTask.memoryCheck")}</p>
        )}
        {task !== "memory_extraction" && task !== "memory_organization" && (
          <p>{t(`workspace.backgroundTask.action.${task}`)}</p>
        )}
        <p>{t("workspace.backgroundTask.note")}</p>
      </div>
      <div className={styles.links}>
        <Button
          variant="ghost"
          disabled={busy || !peer}
          title={t("workspace.backgroundTaskDismissHint")}
          onClick={() => {
            if (!peer) return;
            setBusy(true);
            void peer
              .call("inbox.dismissBackgroundTask", { task, subject, reasonCode })
              .finally(() => setBusy(false));
          }}
        >
          {t("workspace.backgroundTaskDismiss")}
        </Button>
        {checkModels ? (
          <Button onClick={() => openSettings("models")}>
            {t("workspace.backgroundTaskModels")}
          </Button>
        ) : task === "routine_run" ? (
          <Button onClick={() => openRoutines(subjectName ? subject : undefined)}>
            {t("workspace.backgroundTaskRoutines")}
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => openAudit()}>
            {t("media.multi.actionLogs")}
          </Button>
        )}
      </div>
    </article>
  );
}
