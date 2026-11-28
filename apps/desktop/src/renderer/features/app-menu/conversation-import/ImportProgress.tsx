import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import styles from "./conversation-import.module.css";
import {
  importErrorForSource,
  importedTopicAction,
  localSources,
  type Status,
} from "./import-state.ts";
import type { useImportJob } from "./use-import-job.ts";

type Distillation = NonNullable<Status["distillation"]>;

function distillationMessage(distillation: Distillation, t: ReturnType<typeof useT>) {
  const { state, conversations: count, memories, reason } = distillation;
  if (state === "completed") {
    return memories !== undefined
      ? t("conversationImport.distillation.completedWithMemories", { count, memories })
      : t("conversationImport.distillation.completed", { count });
  }
  if (state === "budget") {
    return memories !== undefined
      ? t("conversationImport.distillation.budgetWithMemories", { count, memories })
      : t("conversationImport.distillation.budget", { count });
  }
  const why = t(`conversationImport.distillationReason.${reason ?? "internal"}`);
  if (count > 0) {
    return memories
      ? t("conversationImport.distillation.failedPartialWithMemories", {
          reason: why,
          count,
          memories,
        })
      : t("conversationImport.distillation.failedPartial", { reason: why, count });
  }
  return t("conversationImport.distillation.failed", { reason: why });
}

type Props = {
  running: ReturnType<typeof useImportJob>;
  confirmUndo(status: Status): void;
  restart(): void;
  openInbox(): void;
  openTopics(status: Status): void;
  close(): void;
};

export function ImportProgress({
  running,
  confirmUndo,
  restart,
  openInbox,
  openTopics,
  close,
}: Props) {
  const t = useT();
  const { job, busy, connected, error, cancel, undo } = running;
  if (!job) return null;
  const { status } = job;
  if (!status)
    return (
      <p className={styles.intro} role="status">
        {t(connected ? "conversationImport.confirmingNote" : "conversationImport.reconnectNote")}
      </p>
    );
  const retryCleanup = status.cleanupBlocked || (status.state === "undoing" && !status.cleanup);
  const topicAction = importedTopicAction(status);
  const closeable =
    status.state === "undone" || status.state === "failed" || status.state === "cancelled";
  const local = status.source !== "fixture" && localSources.has(status.source);
  const anotherLabel = local ? "conversationImport.backToSources" : "conversationImport.another";
  const showProjectApproval =
    job.hasProject && (status.cleanup === "discarding" || !!status.cleanupBlocked);
  return (
    <>
      <p role="status" className={styles.intro}>
        {t("conversationImport.resultCounts", {
          source: t(`conversationImport.source.${status.source}`),
          topics: status.topics,
          messages: status.messages,
        })}
        {status.state === "completed" && job.elapsedMs !== undefined
          ? ` · ${t("conversationImport.elapsed", { count: Math.max(1, Math.round(job.elapsedMs / 1000)) })}`
          : ""}
      </p>
      {status.state === "completed" && !!status.skippedTooLong && (
        <p role="status" className={styles.intro}>
          {t("conversationImport.skippedTooLong", { count: status.skippedTooLong })}
        </p>
      )}
      {status.state === "completed" &&
      (status.memories || status.persona || status.projectFiles || status.folders) ? (
        <div className={styles.card}>
          {!!status.memories && (
            <p>{t("conversationImport.addedMemories", { count: status.memories })}</p>
          )}
          {status.persona && <p>{t("conversationImport.personaChanged")}</p>}
          {!!status.folders && (
            <p>{t("conversationImport.foldersCreated", { count: status.folders })}</p>
          )}
          {!!status.projectFiles && (
            <p>{t("conversationImport.projectChanged", { count: status.projectFiles })}</p>
          )}
        </div>
      ) : null}
      {status.state === "completed" && status.distillation && (
        <p
          role={status.distillation.state === "failed" ? "alert" : "status"}
          className={status.distillation.state === "failed" ? styles.error : styles.intro}
        >
          {distillationMessage(status.distillation, t)}
        </p>
      )}
      {status.removed && (
        <div role="status" className={styles.card}>
          <p>{t("conversationImport.removed", status.removed)}</p>
          {!!status.removed.memories && (
            <p>{t("conversationImport.removedMemories", { count: status.removed.memories })}</p>
          )}
          {!!status.removed.projectFiles && (
            <p>
              {t("conversationImport.removedProjectNotes", { count: status.removed.projectFiles })}
            </p>
          )}
        </div>
      )}
      {(!!status.keptProjectFiles || !!status.keptFolders) && (
        <div className={styles.card}>
          {!!status.keptProjectFiles && (
            <p>{t("conversationImport.projectKept", { count: status.keptProjectFiles })}</p>
          )}
          {!!status.keptFolders && (
            <p>{t("conversationImport.foldersKept", { count: status.keptFolders })}</p>
          )}
        </div>
      )}
      {showProjectApproval && (
        <div className={styles.card}>
          <p>{t("conversationImport.compensationNote")}</p>
          <Button variant="secondary" onClick={openInbox}>
            {t("conversationImport.openInbox")}
          </Button>
        </div>
      )}
      {status.state === "running" && !status.cleanup && job.cancelRequested && (
        <p role="status" className={styles.intro}>
          {t("conversationImport.cancelling")}
        </p>
      )}
      {status.reason && (
        <p role="alert" className={styles.error}>
          {t(importErrorForSource(`conversationImport.error.${status.reason}`, status.source))}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(importErrorForSource(error, status.source))}
        </p>
      )}
      <div className={styles.actions}>
        {status.state === "running" && !status.cleanup && !job.cancelRequested && (
          <Button variant="secondary" disabled={!!busy || !connected} onClick={cancel}>
            {t("conversationImport.cancel")}
          </Button>
        )}
        {status.state === "completed" && (
          <>
            <Button variant="ghost" disabled={!!busy} onClick={restart}>
              {t(anotherLabel)}
            </Button>
            <Button
              variant="secondary"
              disabled={!!busy || !connected}
              onClick={() => confirmUndo(status)}
            >
              {t("conversationImport.undo")}
            </Button>
            {topicAction ? (
              <Button disabled={!!busy} onClick={() => openTopics(status)}>
                {t(topicAction)}
              </Button>
            ) : (
              <Button disabled={!!busy} onClick={close}>
                {t("appMenu.close")}
              </Button>
            )}
          </>
        )}
        {retryCleanup && (
          <Button variant="secondary" disabled={!!busy || !connected} onClick={undo}>
            {t("conversationImport.retryCleanup")}
          </Button>
        )}
        {closeable && (
          <Button disabled={!!busy} onClick={restart}>
            {t(
              status.reason === "project_review_changed"
                ? "conversationImport.reviewAgain"
                : anotherLabel,
            )}
          </Button>
        )}
      </div>
    </>
  );
}
