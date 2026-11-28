import { approvalExplanation, connectorToolLabel, toolDisplayName } from "@pibot/client-core";
import {
  type Approval,
  connectionWriteRememberable,
  type DraftStatus,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import {
  ApprovalExplanation,
  approvalStyles as styles,
  useRpc,
  useRpcEvent,
  useSettings,
} from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { CalendarDraftDetails, calendarDraftContent } from "./CalendarDraftDetails.tsx";
import lively from "./lively.module.css";

/** Content is fetched only by an explicit local UI action, never from list events. */
export function DraftCard({
  approval,
  conversationId,
  refresh,
  inbox = false,
}: {
  approval: Approval;
  conversationId?: string;
  refresh(): Promise<void>;
  inbox?: boolean;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const draft = approval.draft;
  const calendar = draft?.operation === "calendar_create";
  const [calendarName, setCalendarName] = useState<string>();
  const [calendarTimeZone, setCalendarTimeZone] = useState<string>();
  const [content, setContent] = useState<string>();
  const [editing, setEditing] = useState(false);
  const original = useRef<string | undefined>(undefined);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);
  const [remember, setRemember] = useState(false);
  const [rememberTool, setRememberTool] = useState(false);
  const [canRememberTool, setCanRememberTool] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  useRpcEvent("connectors.changed", (event) => {
    if (event.connectorId === draft?.connectorId) {
      setCanRememberTool(false);
      setRememberTool(false);
      setConnectionRevision((value) => value + 1);
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: connector events invalidate the authority snapshot even when the draft identity is unchanged.
  useEffect(() => {
    setCanRememberTool(false);
    if (!peer || draft?.identity !== "bot" || !draft.canRememberTool) return;
    const abort = new AbortController();
    void peer
      .call(
        "connectors.get",
        { id: draft.connectorId },
        { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) },
      )
      .then((value) => {
        if (!abort.signal.aborted)
          setCanRememberTool(connectionWriteRememberable(value.connector.confirmationMode));
      })
      .catch(() => {
        /* The option stays hidden when current authority cannot be confirmed. */
      });
    return () => abort.abort();
  }, [peer, draft?.connectorId, draft?.identity, draft?.canRememberTool, connectionRevision]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<DraftStatus | undefined>(
    approval.status === "pending" ? "pending" : undefined,
  );
  const statusEpoch = useRef(0);
  const [statusCheck, setStatusCheck] = useState(0);
  // Read only the persisted status: mounting a historical card must not fetch its body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: approval changes and explicit rechecks invalidate the persisted-status read.
  useEffect(() => {
    if (!peer || !conversationId) return;
    const abort = new AbortController();
    const epoch = statusEpoch.current;
    void peer
      .call(
        "drafts.status",
        { approvalId: approval.id, conversationId },
        {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        },
      )
      .then((value) => {
        if (!abort.signal.aborted && statusEpoch.current === epoch) {
          setStatus(value.status);
          setError(undefined);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted && statusEpoch.current === epoch) setError("load");
      });
    return () => abort.abort();
  }, [peer, conversationId, approval.id, approval.status, statusCheck]);
  const [error, setError] = useState<
    "load" | "changed" | "invalid" | "denied" | "failed" | "uncertain"
  >();
  const [now, setNow] = useState(Date.now);
  const owner = useRef(new AbortController());
  const locked = useRef(false);
  useEffect(() => {
    owner.current = new AbortController();
    return () => owner.current.abort();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useRpcEvent("drafts.changed", (event) => {
    if (event.approvalId !== approval.id) return;
    statusEpoch.current++;
    setStatus(event.status);
    if (event.status !== "pending") {
      setContent(undefined);
      setEditing(false);
    }
    void refresh().catch(() => setError("load"));
  });
  const expired = now >= Date.parse(approval.expiresAt);
  useEffect(() => {
    if (expired && status === "pending") {
      setStatus("expired");
      setContent(undefined);
      void refresh().catch(() => setError("load"));
    }
  }, [expired, status, refresh]);
  const active = status === "pending" && approval.status === "pending" && !expired;
  const event = calendarDraftContent(calendar ? content : undefined);
  const invalid =
    content !== undefined &&
    (new TextEncoder().encode(content).byteLength > 65536 || (calendar && !event));
  const load = async () => {
    if (!peer || !conversationId || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    const lifetime = owner.current;
    try {
      const view = await peer.call(
        "drafts.get",
        {
          approvalId: approval.id,
          conversationId,
        },
        { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]) },
      );
      if (lifetime.signal.aborted) return;
      setStatus(view.status);
      if (view.status === "pending") {
        setContent(view.content);
        setCalendarName(view.calendarName);
        setCalendarTimeZone(view.calendarTimeZone);
        original.current = view.content;
      }
    } catch {
      if (!lifetime.signal.aborted) setError("load");
    } finally {
      locked.current = false;
      if (!lifetime.signal.aborted) setBusy(false);
    }
  };
  const resolve = async (action: "send" | "discard") => {
    if (
      !peer ||
      locked.current ||
      !active ||
      (action === "send" && (invalid || content === undefined))
    )
      return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    const lifetime = owner.current;
    try {
      const result = await peer.call(
        "drafts.resolve",
        {
          approvalId: approval.id,
          action,
          ...(action === "send" && draft?.identity === "bot" && canRememberTool
            ? { rememberTool }
            : {}),
          ...(action === "send" && draft?.editable ? { content } : {}),
          ...(action === "send" && draft?.identity === "bot" && draft.canRememberTarget
            ? { rememberTarget: remember }
            : {}),
        },
        { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]) },
      );
      if (lifetime.signal.aborted) return;
      statusEpoch.current++;
      setStatus(result.status);
      setContent(undefined);
      setEditing(false);
      await refresh().catch(() => setError("load"));
    } catch (failure) {
      if (lifetime.signal.aborted) return;
      if (failure instanceof RpcError) {
        if (failure.code === RpcErrorCodes.draftExpired) setStatus("expired");
        else if (failure.code === RpcErrorCodes.draftContentInvalid) setError("invalid");
        else if (failure.code === RpcErrorCodes.draftDenied) setError("denied");
        else if (failure.code === RpcErrorCodes.draftExecutionFailed) {
          const unknown = failure.message === "draft_execution_uncertain";
          setStatus(unknown ? "unknown" : "failed");
          setError(unknown ? "uncertain" : "failed");
        } else if (
          failure.code === RpcErrorCodes.draftChanged ||
          failure.code === RpcErrorCodes.draftResolved ||
          failure.code === RpcErrorCodes.draftUnavailable
        ) {
          setError("changed");
          setStatus("unknown");
        } else {
          setStatus("unknown");
          setError("uncertain");
        }
      } else {
        setStatus("unknown");
        setError("uncertain");
      }
      statusEpoch.current++;
      setStatusCheck((value) => value + 1);
      // A lost send acknowledgement never enables a second send. A fresh read
      // displays the persisted outcome without replaying the operation.
      setContent(undefined);
      void refresh().catch(() => setError("uncertain"));
    } finally {
      locked.current = false;
      if (!lifetime.signal.aborted) setBusy(false);
    }
  };
  if (!draft) return null;
  const displayedStatus = expired && status === "pending" ? "expired" : status;
  return (
    <section
      id={`approval-${approval.id}`}
      tabIndex={-1}
      className={`${styles.approval} ${inbox ? styles.inbox : lively.card}`}
      data-tone={calendar ? "blue" : "violet"}
      aria-label={t(calendar ? "draft.calendar.title" : "draft.title")}
    >
      <header>
        <Icon name="arrow" />
        <strong>{t(calendar ? "draft.calendar.title" : "draft.title")}</strong>
      </header>
      <ApprovalExplanation {...approvalExplanation(approval, t)} />
      {!calendar && (
        <dl className={styles.facts}>
          <div>
            <dt>{t("draft.target")}</dt>
            <dd>
              {draft.connectorName ? `${draft.connectorName} · ${draft.target}` : draft.target}
            </dd>
          </div>
          <div>
            <dt>{t("draft.identity")}</dt>
            <dd>{t(draft.identity === "user" ? "draft.user" : "draft.bot")}</dd>
          </div>
          <div>
            <dt>{t("draft.tool")}</dt>
            <dd>
              {(() => {
                const connector = connectorToolLabel({ tool: draft.tool }, language, t);
                return connector !== draft.tool ? connector : toolDisplayName(draft.tool, t);
              })()}
            </dd>
          </div>
        </dl>
      )}
      {draft.identity === "user" && (
        <p className={styles.warning}>
          {draft.operation === "calendar_create"
            ? t("draft.calendar.userNote", { name: calendarName ?? t("draft.calendar.unnamed") })
            : t("draft.userNote")}
        </p>
      )}
      {!conversationId && (
        <p role="alert" className={styles.warning}>
          {t(calendar ? "draft.calendar.error.unavailable" : "draft.error.unavailable")}
        </p>
      )}
      {active && content === undefined && (
        <div className={styles.command}>
          <p>{t("draft.reviewFirst")}</p>
          <Button
            variant="secondary"
            loading={busy}
            disabled={!peer || !conversationId || busy}
            onClick={() => void load()}
          >
            {t(calendar ? "draft.calendar.view" : "draft.view")}
          </Button>
        </div>
      )}
      {calendar && event && (
        <CalendarDraftDetails
          event={event}
          calendarName={calendarName}
          timeZone={calendarTimeZone}
        />
      )}
      {!calendar &&
        content !== undefined &&
        (editing ? (
          <textarea
            ref={editor}
            className={`${styles.command} ${styles.draftEditor}`}
            aria-label={t("draft.content")}
            value={content}
            disabled={busy}
            onChange={(event) => setContent(event.currentTarget.value)}
          />
        ) : (
          <pre className={styles.command}>{content}</pre>
        ))}
      <footer>
        {!active && (
          <p role="status">
            {displayedStatus
              ? t(
                  calendar
                    ? `draft.calendar.status.${displayedStatus}`
                    : `draft.status.${displayedStatus}`,
                )
              : t("common.loading")}
          </p>
        )}
        {(error || invalid) && (
          <p role="alert" className={styles.risk}>
            {t(
              calendar
                ? `draft.calendar.error.${invalid ? "invalid" : (error ?? "load")}`
                : `draft.error.${invalid ? "invalid" : (error ?? "load")}`,
            )}
          </p>
        )}
        {active && (
          <>
            {draft.identity === "bot" && canRememberTool && (
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={rememberTool}
                  disabled={busy}
                  onChange={(event) => setRememberTool(event.currentTarget.checked)}
                />
                {t("connectors.rememberTool")}
              </label>
            )}
            {draft.identity === "bot" && draft.canRememberTarget && (
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={busy}
                  onChange={(event) => setRemember(event.currentTarget.checked)}
                />
                {t("draft.remember")}
              </label>
            )}
            <div className={styles.actions}>
              <Button
                loading={busy}
                disabled={!peer || busy || content === undefined || invalid}
                onClick={() => void resolve("send")}
              >
                {t(calendar ? "draft.calendar.create" : "draft.send")}
              </Button>
              {draft.editable && content !== undefined && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (editing) setContent(original.current);
                    setEditing((value) => !value);
                  }}
                >
                  {t(editing ? "draft.doneEdit" : "draft.edit")}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={!peer || busy}
                onClick={() => void resolve("discard")}
              >
                {t(calendar ? "draft.calendar.discard" : "draft.discard")}
              </Button>
            </div>
          </>
        )}
        {!active && (!status || status === "unknown" || status === "sending") && (
          <Button
            variant="secondary"
            disabled={busy || !peer}
            loading={busy}
            onClick={() => void load()}
          >
            {t(calendar ? "draft.calendar.check" : "draft.check")}
          </Button>
        )}
      </footer>
    </section>
  );
}
