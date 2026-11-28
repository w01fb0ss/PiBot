// Present persisted chat attachments through their format-specific preview paths.
import { type Attachment, canPreviewSvg, mediaMime, previewKind } from "@pibot/protocol";
import { RevealFileButton, useRpc, useT } from "@pibot/renderer-kit";
import { Button, CloseButton } from "@pibot/ui";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { PopupMenu } from "../../execution/PopupMenu.tsx";
import { FilePreviewContext } from "../../file-preview/context.tsx";
import { attachmentTarget } from "../../file-preview/state.ts";
import { OfficeAttachment } from "../../office/OfficeAttachment.tsx";
import { FileCard } from "../composer/Attachments.tsx";
import styles from "../composer/attachments.module.css";
import { imageKey, imagePreviewCache } from "./image-preview-cache.ts";
import { MediaAttachment } from "./MediaAttachment.tsx";
import { SvgAttachment } from "./SvgAttachment.tsx";

const zeroVersion = () => 0;

export function ImagePreview({
  attachment,
  messageId,
  className,
}: {
  attachment: Attachment;
  messageId?: string;
  className?: string;
}) {
  const t = useT();
  const { peer } = useRpc();
  const openPreview = useContext(FilePreviewContext);
  const cache = peer ? imagePreviewCache(peer) : undefined;
  const key = imageKey(attachment);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the full immutable attachment identity, not DTO allocation, owns reads
  const image = useMemo(() => attachment, [key]);
  const subscribe = useCallback(
    (fn: () => void) => (cache ? cache.subscribe(key, fn) : () => {}),
    [cache, key],
  );
  useSyncExternalStore(subscribe, cache?.version ?? zeroVersion);
  const authorityVersion = cache?.authorityVersion(image);
  const attempted = useRef<
    { cache: typeof cache; key: string; retry: number; version: number | undefined } | undefined
  >(undefined);
  const [retry, setRetry] = useState(0);
  const [original, setOriginal] = useState<{
    peer: typeof peer;
    key: string;
    revision: number;
    source: string;
  }>();
  const [originalFailed, setOriginalFailed] = useState(false);
  const [failure, setFailure] = useState<{ peer: typeof peer; key: string }>();
  const failed = failure?.peer === peer && failure.key === key;
  const [expanded, setExpanded] = useState<{ peer: typeof peer; key: string }>();
  const zoom = expanded?.peer === peer && expanded.key === key;
  const [visible, setVisible] = useState(false);
  const cachedSource = cache?.get(image, messageId, visible || zoom);
  const [retained, setRetained] = useState<{
    cache: NonNullable<typeof cache>;
    key: string;
    version: number;
    source: string;
  }>();
  const source =
    cachedSource ??
    ((visible || zoom) &&
    retained?.cache === cache &&
    retained?.key === key &&
    retained.version === authorityVersion
      ? retained.source
      : undefined);
  useEffect(() => {
    if (cache && cachedSource && authorityVersion !== undefined)
      setRetained((previous) =>
        previous?.cache === cache &&
        previous.key === key &&
        previous.version === authorityVersion &&
        previous.source === cachedSource
          ? previous
          : { cache, key, version: authorityVersion, source: cachedSource },
      );
    else if (!visible && !zoom) setRetained(undefined);
  }, [cache, cachedSource, authorityVersion, key, visible, zoom]);
  const container = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) attempted.current = undefined;
    if (!cache || !visible || source || failed) return;
    if (
      attempted.current &&
      attempted.current.cache === cache &&
      attempted.current.key === key &&
      attempted.current.retry === retry &&
      attempted.current.version === authorityVersion
    )
      return;
    attempted.current = { cache, key, retry, version: authorityVersion };
    const abort = new AbortController();
    void cache.preview(image, abort.signal, messageId).catch(() => {
      if (!abort.signal.aborted) setFailure({ peer, key });
    });
    return () => abort.abort();
  }, [cache, peer, key, image, visible, source, failed, retry, authorityVersion, messageId]);
  useEffect(() => {
    if (!zoom || !cache) {
      setOriginal(undefined);
      return;
    }
    const abort = new AbortController();
    setOriginal(undefined);
    setOriginalFailed(false);
    void cache
      .original(image, abort.signal, messageId)
      .then((image) => {
        if (abort.signal.aborted) return;
        setOriginal({
          peer,
          key,
          revision: authorityVersion as number,
          source: `data:${image.mimeType};base64,${image.data}`,
        });
      })
      .catch(() => {
        if (!abort.signal.aborted) setOriginalFailed(true);
      });
    return () => {
      abort.abort();
    };
  }, [cache, peer, key, image, zoom, authorityVersion, messageId]);
  useEffect(() => {
    if (zoom) dialog.current?.showModal();
  }, [zoom]);
  return (
    <div ref={container} data-image-attachment-id={attachment.id}>
      {source && !failed ? (
        <button
          type="button"
          className={[styles.imageButton, className].filter(Boolean).join(" ")}
          onClick={() =>
            messageId && openPreview
              ? openPreview(attachmentTarget(attachment, messageId))
              : setExpanded({ peer, key })
          }
          aria-label={t("attachments.view", { name: attachment.name })}
        >
          <img
            src={source}
            alt={attachment.name}
            className={styles.thumbnail}
            onError={() => {
              cache?.invalidate(attachment);
              setFailure({ peer, key });
            }}
            loading="lazy"
          />
        </button>
      ) : (
        <span className={styles.placeholder} role="status">
          {t(
            failed
              ? "attachments.imageFailed"
              : attempted.current &&
                  attempted.current.cache === cache &&
                  attempted.current.key === key &&
                  !cache?.reading(image)
                ? "attachments.previewReleased"
                : "common.loading",
          )}
          {(failed ||
            (attempted.current &&
              attempted.current.cache === cache &&
              attempted.current.key === key &&
              !cache?.reading(image))) && (
            <Button
              variant="ghost"
              onClick={() => {
                setFailure(undefined);
                setRetry((value) => value + 1);
              }}
            >
              {t("common.retry")}
            </Button>
          )}
        </span>
      )}
      {zoom && (
        <dialog
          ref={dialog}
          className={styles.lightbox}
          aria-label={attachment.name}
          onClose={() => setExpanded(undefined)}
        >
          <div className={styles.lightboxHeader}>
            <CloseButton label={t("attachments.close")} onClick={() => dialog.current?.close()} />
          </div>
          {original?.peer === peer &&
          original.key === key &&
          original.revision === authorityVersion &&
          !originalFailed ? (
            <img
              src={original.source}
              alt={attachment.name}
              onError={() => setOriginalFailed(true)}
            />
          ) : (
            <span role="status">
              {t(originalFailed ? "attachments.imageFailed" : "common.loading")}
            </span>
          )}
        </dialog>
      )}
    </div>
  );
}
function SavedFile({ attachment, readOnly }: { attachment: Attachment; readOnly: boolean }) {
  const { peer } = useRpc();
  const t = useT();
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={styles.fileButton}
        disabled={readOnly || opening || !peer}
        onClick={() => {
          if (!peer || readOnly) return;
          setOpening(true);
          setFailed(false);
          void peer
            .call("chat.openAttachment", { id: attachment.id })
            .catch(() => setFailed(true))
            .finally(() => setOpening(false));
        }}
        aria-label={t("attachments.open", { name: attachment.name })}
      >
        <FileCard name={attachment.name} size={attachment.size} />
      </button>
      {failed && (
        <p className={styles.error} role="alert">
          {t("attachments.openFailed")}
        </p>
      )}
    </div>
  );
}
export function MessageAttachments({
  attachments,
  messageId,
  readOnly = false,
  allowReadOnlyPreview = false,
}: {
  attachments?: Attachment[];
  messageId?: string;
  readOnly?: boolean;
  allowReadOnlyPreview?: boolean;
}) {
  const t = useT();
  if (!attachments?.length) return null;
  return (
    <div className={styles.saved}>
      {attachments.map((attachment) => (
        <div
          key={imageKey(attachment)}
          className={styles.savedItem}
          data-file-attachment-id={attachment.id}
        >
          {attachment.kind === "image" ? (
            <ImagePreview attachment={attachment} messageId={messageId} />
          ) : messageId && !readOnly && canPreviewSvg(attachment) ? (
            <SvgAttachment attachment={attachment} messageId={messageId} />
          ) : messageId && !readOnly && mediaMime(attachment.name) ? (
            <MediaAttachment
              attachment={attachment}
              messageId={messageId}
              fallback={<SavedFile attachment={attachment} readOnly={readOnly} />}
            />
          ) : !mediaMime(attachment.name) && previewKind(attachment.name) && messageId ? (
            <OfficeAttachment
              attachment={attachment}
              messageId={messageId}
              readOnly={readOnly && !allowReadOnlyPreview}
            />
          ) : (
            <SavedFile attachment={attachment} readOnly={readOnly} />
          )}
          {messageId && (
            // Maintainers 2026-11-13: only the ⋯ shows, on hover or keyboard focus, like other actions.
            <span className={styles.savedMenu}>
              <PopupMenu label={t("messages.actions")} icon="more">
                <RevealFileButton
                  source={{ attachmentId: attachment.id, messageId }}
                  disabled={readOnly}
                />
              </PopupMenu>
            </span>
          )}
          {attachment.truncated && (
            <p className={styles.warning}>
              {t("attachments.truncated", { percent: attachment.sentPercent ?? 0 })}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
