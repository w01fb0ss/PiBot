import { type Attachment, mediaMime } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { type ReactNode, useEffect, useState } from "react";
import { MediaPlayer } from "../../file-preview/MediaPlayer.tsx";
import styles from "./video-job.module.css";

export function MediaAttachment({
  attachment,
  messageId,
  fallback,
}: {
  attachment: Attachment;
  messageId: string;
  fallback: ReactNode;
}) {
  const { peer } = useRpc();
  const t = useT();
  const [requested, setRequested] = useState(false);
  const [loaded, setLoaded] = useState<{ peer: typeof peer; id: string; data: string }>();
  const [failed, setFailed] = useState(false);
  const mime = mediaMime(attachment.name);
  useEffect(() => {
    if (!requested || !peer) return;
    const abort = new AbortController();
    setFailed(false);
    void peer
      .call(
        "preview.read",
        { attachmentId: attachment.id, messageId, requestId: crypto.randomUUID() },
        { signal: abort.signal, timeoutMs: 30_000 },
      )
      .then((result) => {
        if (!abort.signal.aborted && (result.kind === "video" || result.kind === "audio"))
          setLoaded({ peer, id: attachment.id, data: result.data });
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, [attachment.id, messageId, peer, requested]);
  const data =
    loaded && loaded.peer === peer && loaded.id === attachment.id ? loaded.data : undefined;
  return (
    <div className={styles.media}>
      {fallback}
      {failed ? (
        <small role="status">{t("attachments.mediaFailed")}</small>
      ) : data && mime ? (
        <MediaPlayer
          data={data}
          mime={mime}
          name={attachment.name}
          onError={() => setFailed(true)}
        />
      ) : (
        <Button variant="ghost" disabled={!peer || requested} onClick={() => setRequested(true)}>
          {requested ? t("common.loading") : t("attachments.playMedia", { name: attachment.name })}
        </Button>
      )}
    </div>
  );
}
