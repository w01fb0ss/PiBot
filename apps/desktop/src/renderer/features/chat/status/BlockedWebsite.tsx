import { type MethodParams, RpcError } from "@pibot/protocol";
import { actionError, Overlay, useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "../chat.module.css";
import type { BlockWarning } from "./SandboxNotices.tsx";

type Scope = MethodParams["permissions.allowBlockedWebsite"]["scope"];

export function BlockedWebsite({ notice }: { notice: BlockWarning }) {
  const t = useT();
  const { peer } = useRpc();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<Scope>();
  const [retried, setRetried] = useState(false);
  const website = notice.sandbox.website;
  const current = website?.groupId ? "group" : "bot";
  const [scope, setScope] = useState<Scope>(current);
  const retryUntil = website?.retryUntil;
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!retryUntil) return;
    const remaining = Date.parse(retryUntil) - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [retryUntil]);
  const canRetry = !!retryUntil && !expired && !saved;
  if (!website) return null;
  const confirm = async (retry = false) => {
    const chosen = retry ? current : scope;
    if (!peer) return;
    const result = await action.run(
      (signal) =>
        peer.call(
          "permissions.allowBlockedWebsite",
          { noticeId: notice.id, scope: chosen, ...(retry ? { retry: true } : {}) },
          { signal, timeoutMs: 60000 },
        ),
      (error) => {
        if (error instanceof RpcError) {
          if (error.message === "website_retry_expired") {
            setExpired(true);
            return "tool.website.retryExpired";
          }
          if (error.message === "website_permission_list_full") return "tool.website.full";
          if (
            ["website_permission_scope_changed", "website_permission_unavailable"].includes(
              error.message,
            )
          )
            return "tool.website.unavailable";
        }
        return actionError(error);
      },
    );
    if (result?.network.domains.includes(website.domain)) {
      setSaved(chosen);
      setRetried(result.retryStarted === true);
      setOpen(false);
    } else if (result) {
      action.setError("workspace.failed");
    }
  };
  const dismiss = async () => {
    if (!peer) return;
    const result = await action.run(
      (signal) =>
        peer.call(
          "permissions.allowBlockedWebsite",
          { noticeId: notice.id, scope: current, retry: "dismiss" },
          { signal },
        ),
      actionError,
    );
    if (result) setExpired(true);
  };
  if (canRetry)
    return (
      <span>
        {t("tool.website.domain", { domain: website.domain })}{" "}
        {t(current === "group" ? "tool.website.retryGroupScope" : "tool.website.retryBotScope")}{" "}
        {t(
          notice.sandbox.rule === "proxy_denied"
            ? "tool.website.retryRan"
            : "tool.website.retryHelp",
        )}{" "}
        <button
          type="button"
          className={styles.sandboxLink}
          disabled={!peer || action.busy}
          onClick={() => void confirm(true)}
        >
          {t("tool.website.retryConfirm")}
        </button>{" "}
        <button
          type="button"
          className={styles.sandboxLink}
          disabled={!peer || action.busy}
          onClick={() => void dismiss()}
        >
          {t("tool.website.retrySkip")}
        </button>
        {action.error && <span role="alert"> {t(action.error)}</span>}
      </span>
    );
  return (
    <>
      <button
        type="button"
        className={styles.sandboxLink}
        disabled={!peer || action.busy}
        onClick={() => {
          setScope(saved ?? current);
          action.setError(undefined);
          setOpen(true);
        }}
      >
        {t(
          retried ? "tool.website.retryStarted" : saved ? "tool.website.saved" : "tool.website.add",
          { domain: website.domain },
        )}
      </button>
      {!open && action.error && <span role="alert"> {t(action.error)}</span>}
      {open && (
        <div className={styles.sandboxWebsiteDialog}>
          <Overlay
            title={t("tool.website.title")}
            icon="globe"
            tone="green"
            busy={action.busy}
            close={() => setOpen(false)}
            footer={
              <>
                <Button variant="secondary" disabled={action.busy} onClick={() => setOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button loading={action.busy} disabled={!peer} onClick={() => void confirm()}>
                  {t("tool.website.confirm")}
                </Button>
              </>
            }
          >
            <p>{t("tool.website.domain", { domain: website.domain })}</p>
            <SegmentedControl<Scope>
              label={t("tool.website.scope")}
              value={scope}
              disabled={action.busy}
              onValueChange={setScope}
              options={[
                {
                  value: current,
                  label: t(current === "group" ? "tool.website.group" : "tool.website.bot"),
                },
                { value: "global", label: t("tool.website.global") },
              ]}
            />
            <p>
              {t(
                scope === "global"
                  ? "tool.website.globalHelp"
                  : current === "group"
                    ? "tool.website.groupHelp"
                    : "tool.website.botHelp",
              )}
            </p>
            <p>{t("tool.website.noRetry")}</p>
            {action.error && <p role="alert">{t(action.error)}</p>}
          </Overlay>
        </div>
      )}
    </>
  );
}
