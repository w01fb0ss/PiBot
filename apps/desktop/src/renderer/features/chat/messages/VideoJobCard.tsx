import type { Message, VideoJob } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "./video-job.module.css";

const errorText = {
  timeout: "video.timeoutError",
  size_limit: "video.sizeError",
  auth_failed: "video.authError",
  billing: "video.billingError",
  provider_rejected: "video.rejectedError",
  network: "video.networkError",
  provider_error: "video.providerError",
  provider_changed: "video.changedError",
  interrupted_create: "video.interruptedError",
  delivery_failed: "video.deliveryError",
} as const;

export function VideoJobCard({ message, readOnly }: { message: Message; readOnly: boolean }) {
  const id =
    message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
      ? message.usage.videoJobId
      : undefined;
  return typeof id === "string" ? <Job id={id} messageId={message.id} readOnly={readOnly} /> : null;
}

function Job({ id, messageId, readOnly }: { id: string; messageId: string; readOnly: boolean }) {
  const { peer } = useRpc();
  const t = useT();
  const [job, setJob] = useState<VideoJob>();
  const [cancelled, setCancelled] = useState<VideoJob>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!peer) return;
    const lifetime = new AbortController();
    let sequence = 0;
    const refresh = () => {
      const current = ++sequence;
      void peer
        .call("videos.get", { id, messageId }, { signal: lifetime.signal })
        .then((value) => {
          if (current === sequence && !lifetime.signal.aborted) setJob(value);
        })
        .catch(() => {
          // Reconnection or the next status event reloads durable state.
        });
    };
    const unsubscribe = peer.on("videos.changed", (event) => {
      if (event.id === id && event.messageId === messageId) refresh();
    });
    refresh();
    return () => {
      lifetime.abort();
      unsubscribe();
    };
  }, [id, messageId, peer]);
  const info =
    cancelled?.id === id && cancelled.status === "cancelled"
      ? cancelled
      : job?.id === id
        ? job
        : undefined;
  if (!info) return null;
  const active =
    info.status === "queued" || info.status === "generating" || info.status === "downloading";
  const statusText = t(
    info.status === "queued" && info.queueFull ? "video.queueFull" : `video.${info.status}`,
  );
  return (
    <div className={styles.card} data-video-status={info.status}>
      <div role="status">
        <strong>{statusText}</strong>
        <small>{info.model}</small>
        {info.error && <small>{t(errorText[info.error])}</small>}
        {info.status === "done" && info.workspaceSaved === false && (
          <small>{t("video.workspaceFailed")}</small>
        )}
      </div>
      {active && <progress max={100} value={info.progress} aria-label={statusText} />}
      {active && !readOnly && (
        <Button
          variant="ghost"
          disabled={!peer || busy}
          onClick={() => {
            if (!peer || busy) return;
            setBusy(true);
            setFailed(false);
            void peer
              .call("videos.cancel", { id, messageId })
              .then(setCancelled)
              .catch(() => setFailed(true))
              .finally(() => setBusy(false));
          }}
        >
          {t("video.cancel")}
        </Button>
      )}
      {failed && <small role="alert">{t("video.cancelFailed")}</small>}
    </div>
  );
}
