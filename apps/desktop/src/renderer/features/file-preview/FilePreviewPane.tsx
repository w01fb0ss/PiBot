import { OfficeOpenControl, OfficePreviewPane, OfficeSheetTabs } from "@pibot/office/ui";
import { previewKind } from "@pibot/protocol";
import { RevealFileButton, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ViewerProps } from "./engine.ts";
import { PreviewBoundary } from "./PreviewBoundary.tsx";
import styles from "./preview.module.css";
import type { OpenFile, ReadingState } from "./state.ts";
import { usePreviewFile } from "./use-preview-file.ts";

const OfficeViewer = lazy(() => import("@pibot/office/ui/viewer"));
const PdfViewer = lazy(() => import("./PdfViewer.tsx"));
const TextViewer = lazy(() => import("./TextViewer.tsx"));
const CodeViewer = lazy(() => import("./CodeViewer.tsx"));
const MediaViewer = lazy(() => import("./MediaViewer.tsx"));
const ImageViewer = lazy(() => import("./ImageViewer.tsx"));
export function FilePreviewPane({
  file,
  update,
}: {
  file: OpenFile;
  update: ViewerProps["update"];
}) {
  const t = useT(),
    { peer } = useRpc();
  const [retry, setRetry] = useState(0),
    [engineFailed, setEngineFailed] = useState(false),
    [fallback, setFallback] = useState(false),
    [openFailed, setOpenFailed] = useState(false);
  const [info, setInfo] = useState<{ total: number; sheets?: string[] }>({ total: 0 });
  const metadata = useCallback((value: { total: number; sheets?: string[] }) => setInfo(value), []);
  const dimensions = useRef({ kind: previewKind(file.name) ?? "unknown", sizeBand: "unknown" });
  const measurement = useRef({ key: file.key, retry, started: performance.now(), reported: false });
  if (measurement.current.key !== file.key || measurement.current.retry !== retry)
    measurement.current = { key: file.key, retry, started: performance.now(), reported: false };
  const report = useCallback((outcome: string) => {
    const entry = measurement.current;
    if (entry.reported) return;
    entry.reported = true;
    console.info(
      JSON.stringify({
        module: "file-preview",
        event: "engine_ready",
        ...dimensions.current,
        outcome,
        durationMs: Math.round(performance.now() - entry.started),
      }),
    );
  }, []);
  const ready = useCallback(() => report("ok"), [report]);
  const fail = useCallback(() => {
    report("render_failed");
    setEngineFailed(true);
  }, [report]);
  const { result, error } = usePreviewFile(file, retry, update);
  if (result) {
    const bytes = result.text !== undefined ? result.text.length * 2 : result.data.length * 0.75;
    dimensions.current = {
      kind: result.kind,
      sizeBand: bytes < 262144 ? "small" : bytes < 2097152 ? "medium" : "large",
    };
  }
  useEffect(() => {
    if (error) report("read_failed");
  }, [error, report]);
  // Clicking the file again after a failed read retries it, instead of showing the old error.
  const reopened = file.reopened ?? 0;
  const lastFailed = useRef(false);
  lastFailed.current = !!error || engineFailed;
  useEffect(() => {
    if (!reopened || !lastFailed.current) return;
    setEngineFailed(false);
    setRetry((value) => value + 1);
  }, [reopened]);
  const { page, sheet, zoom } = file.reading;
  const office = result && ["docx", "xlsx", "pptx"].includes(result.kind);
  const patch = (value: Partial<ReadingState>) => update(file.key, value);
  const refresh = () => {
    patch({ revision: undefined, page: 0, sheet: 0, x: 0, y: 0, sheets: {} });
    setEngineFailed(false);
    setInfo({ total: 0 });
    setRetry((value) => value + 1);
  };
  const source =
    "officeRender" in file.source || "groupFile" in file.source ? undefined : file.source;
  const props = result ? { file, result, update, metadata, fail, ready } : undefined;
  const kind = result?.kind;
  const Viewer = office
    ? OfficeViewer
    : kind === "pdf"
      ? PdfViewer
      : kind === "markdown"
        ? TextViewer
        : kind === "code"
          ? CodeViewer
          : kind === "video" || kind === "audio"
            ? MediaViewer
            : ImageViewer;
  const failed = error || engineFailed;
  return (
    <div className={styles.reader}>
      <div className={styles.toolbar}>
        {source && <RevealFileButton source={source} />}
        {source &&
          (office ? (
            <OfficeOpenControl
              name={file.name}
              source={source}
              selectedApp={file.reading.appId}
              onSelectApp={(appId) => patch({ appId })}
            />
          ) : (
            <Button
              variant="ghost"
              title={t("preview.openSystem")}
              disabled={!peer}
              onClick={() => {
                setOpenFailed(false);
                void peer
                  ?.call("preview.open", source, { timeoutMs: 30_000 })
                  .catch(() => setOpenFailed(true));
              }}
            >
              <Icon name="arrow" size={15} />
              {t("office.open")}
            </Button>
          ))}
        <div className={styles.controls}>
          <Button
            variant="ghost"
            title={t("preview.zoomOut")}
            aria-label={t("preview.zoomOut")}
            disabled={zoom <= 0.5}
            onClick={() => patch({ zoom: Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10) })}
          >
            −
          </Button>
          <Button
            variant="ghost"
            title={t("preview.fit")}
            aria-label={t("preview.fit")}
            onClick={() => patch({ zoom: 1 })}
          >
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            variant="ghost"
            title={t("preview.zoomIn")}
            aria-label={t("preview.zoomIn")}
            disabled={zoom >= 2}
            onClick={() => patch({ zoom: Math.min(2, Math.round((zoom + 0.1) * 10) / 10) })}
          >
            +
          </Button>
          <Button
            variant="ghost"
            title={t("office.refresh")}
            aria-label={t("office.refresh")}
            onClick={refresh}
          >
            <Icon name="refresh" size={15} />
          </Button>
        </div>
      </div>
      {openFailed && (
        <p className={styles.error} role="alert">
          {t("attachments.openFailed")}
        </p>
      )}
      <div className={styles.body}>
        {failed ? (
          <div className={styles.status} role="alert">
            <p>
              {t(
                error === "office_render_expired"
                  ? "office.render.expired"
                  : error === "preview_changed"
                    ? "preview.changed"
                    : error === "preview_missing"
                      ? "preview.missing"
                      : error === "preview_limit"
                        ? "preview.limit"
                        : error === "preview_encoding"
                          ? "preview.encoding"
                          : error === "preview_unsupported"
                            ? "preview.unsupported"
                            : "preview.failed",
              )}
            </p>
            <Button variant="secondary" onClick={refresh}>
              {t("common.retry")}
            </Button>
            {office && (
              <Button variant="ghost" onClick={() => setFallback(true)}>
                {t("office.contentPreview")}
              </Button>
            )}
          </div>
        ) : !props ? (
          <p className={styles.status} role="status">
            {t("common.loading")}
          </p>
        ) : (
          <Suspense
            fallback={
              <p className={styles.status} role="status">
                {t("common.loading")}
              </p>
            }
          >
            <PreviewBoundary key={retry} fail={fail}>
              <Viewer {...props} />
            </PreviewBoundary>
          </Suspense>
        )}
        {source && fallback && <OfficePreviewPane name={file.name} source={source} />}
      </div>
      {info.sheets?.length ? (
        <OfficeSheetTabs
          names={info.sheets}
          selected={sheet}
          panelId="file-preview-panel"
          select={(next) => {
            const positions = {
              ...file.reading.sheets,
              [sheet]: { x: file.reading.x, y: file.reading.y },
            };
            patch({ sheet: next, ...(positions[next] ?? { x: 0, y: 0 }), sheets: positions });
          }}
        />
      ) : null}
      {info.total > 0 && kind !== "xlsx" && (
        <footer className={styles.footer}>
          <Button
            variant="ghost"
            title={t("office.previous")}
            aria-label={t("office.previous")}
            disabled={!page}
            onClick={() => patch({ page: page - 1, x: 0, y: 0 })}
          >
            <Icon name="back" size={15} />
          </Button>
          <span>{t("preview.page", { page: page + 1, total: info.total })}</span>
          <Button
            variant="ghost"
            title={t("office.next")}
            aria-label={t("office.next")}
            disabled={page + 1 >= info.total}
            onClick={() => patch({ page: page + 1, x: 0, y: 0 })}
          >
            <Icon name="chevronRight" size={15} />
          </Button>
        </footer>
      )}
      {office && <div className={styles.notice}>{t("preview.localNotice")}</div>}
    </div>
  );
}
