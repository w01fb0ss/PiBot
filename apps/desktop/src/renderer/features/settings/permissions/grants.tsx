import { topicGrantLabel } from "@pibot/client-core";
import { createTranslator } from "@pibot/i18n";
import { credentialSiteLabel, type GrantListItem } from "@pibot/protocol";
import { useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FoldHeading } from "../FoldHeading.tsx";
import { usePagedList } from "../use-paged-list.ts";
import styles from "./permissions.module.css";

export function grantLabel(grant: GrantListItem, t = createTranslator("en")): string {
  const topic = topicGrantLabel(grant, t);
  if (topic) return topic;
  switch (grant.scope.kind) {
    case "programs":
      return `${grant.scope.programs.join(", ")} · ${t("permissions.singleRootScope", { root: grant.scope.root })}`;
    case "folder":
      return grant.scope.path;
    case "workplace":
      return t("permissions.singleRootScope", { root: grant.scope.root });
    case "domain":
      return grant.scope.domain;
    case "send_target":
      return `${grant.scope.target} · ${grant.scope.tool}`;
    case "connector_tool":
      return grant.scope.tool;
    case "connector":
      return grant.scope.connectorId;
    // Routine preauthorization of operating the computer (app IDs); names may come later.
    case "apps":
      return grant.scope.apps.join(", ");
    // Automatic login with a saved account on this site.
    case "login":
      return credentialSiteLabel(grant.scope.site);
    // Submitting forms on this site (and its subdomains) in the Bot browser.
    case "submit":
      return grant.scope.domain;
    // Reading public pages by web_fetch; call sites show the localized label.
    case "web_read":
      return "*";
    // Named user secrets are referenced by name only; the value never reaches the renderer.
    case "secret":
      return grant.scope.name;
    // Owner decision 2026-10-23: paid image generation with this exact model.
    case "paid_image":
      return paidImageModel(grant.scope, grant.providerName);
  }
}
/** How a paid image scope names its model on cards and grant lists. */
export function paidImageModel(scope: { provider: string; model: string }, providerName?: string) {
  return `${providerName || scope.provider} / ${scope.model}`;
}
/**
 * One Bot's remembered "always allow" grants, shown only in that Bot's profile panel
 * (owner decision 2026-10-14: global settings no longer list per-Bot grants).
 */
export function GrantsList({ botId }: { botId: string }) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const [open, setOpen] = useState(true);
  const contentId = useId();
  const fetchPage = useCallback(
    (before?: string) =>
      peer
        ? peer.call("grants.list", {
            limit: 50,
            botId,
            ...(before ? { before } : {}),
          })
        : Promise.reject(new Error("Disconnected")),
    [peer, botId],
  );
  const list = usePagedList(fetchPage);
  useRpcEvent("approval.resolved", () => {
    void list.load();
  });
  useRpcEvent("permissions.changed", (event) => {
    if (!event.botId || event.botId === botId) void list.load();
  });
  useRpcEvent("changes.changed", (event) => {
    if (event.reason !== "folder") return;
    if (!event.conversationKey || event.conversationKey === `dm:${botId}`) void list.load();
  });
  useRpcEvent("sidebar.changed", () => {
    void list.load();
  });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState(false);
  const alive = useRef(0);
  const locked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate in-flight revocations when the peer changes
  useEffect(() => {
    alive.current++;
    locked.current = false;
    setBusy(undefined);
    return () => {
      alive.current++;
    };
  }, [peer, botId]);
  const revoke = async (id: string) => {
    if (!peer || locked.current) return;
    const version = alive.current;
    locked.current = true;
    setBusy(id);
    setError(false);
    try {
      await peer.call("grants.revoke", { id });
      if (version === alive.current) await list.load();
    } catch {
      if (version === alive.current) setError(true);
    } finally {
      if (version === alive.current) {
        locked.current = false;
        setBusy(undefined);
      }
    }
  };
  const count =
    list.loading && !list.items.length
      ? undefined
      : `${list.items.length}${list.hasMore ? "+" : ""}`;
  return (
    <section>
      <FoldHeading
        title={t("permissions.grants")}
        count={count}
        open={open}
        toggle={() => setOpen((value) => !value)}
        controls={contentId}
      />
      <div id={contentId} hidden={!open} className={styles.foldBody}>
        <p className={styles.note}>{t("workspace.grantsNote")}</p>
        <div className={styles.panel}>
          {list.items.map((grant) => (
            <div className={styles.row} key={grant.id}>
              <div>
                <strong>
                  {grant.scope.kind === "login"
                    ? t("credentials.grantLabel", { site: grantLabel(grant, t) })
                    : grant.scope.kind === "submit"
                      ? `${t(`permissions.category.${grant.category}`)} · ${t("permissions.submitScope", { site: grantLabel(grant, t) })}`
                      : grant.scope.kind === "web_read"
                        ? `${t(`permissions.category.${grant.category}`)} · ${t("permissions.webReadScope")}`
                        : grant.scope.kind === "paid_image"
                          ? t("permissions.paidImageScope", { model: grantLabel(grant, t) })
                          : `${t(`permissions.category.${grant.category}`)} · ${grantLabel(grant, t)}`}
                </strong>
                <small>
                  <time dateTime={grant.createdAt}>
                    {new Date(grant.createdAt).toLocaleString(language === "zh" ? "zh-CN" : "en")}
                  </time>
                </small>
              </div>
              <Button
                variant="ghost"
                className={styles.danger}
                disabled={!peer || !!busy || list.loading}
                loading={busy === grant.id}
                onClick={() => void revoke(grant.id)}
              >
                {t("permissions.revoke")}
              </Button>
            </div>
          ))}
          {!list.items.length && !list.loading && !list.error && (
            <div className={styles.row}>
              <p className={styles.note}>{t("permissions.noGrants")}</p>
            </div>
          )}
        </div>
        {(list.error || error) && (
          <p role="alert" className={styles.danger}>
            {t("permissions.grantsError")}{" "}
            <Button
              variant="ghost"
              disabled={list.loading || !!busy}
              onClick={() => {
                setError(false);
                void list.load();
              }}
            >
              {t("common.retry")}
            </Button>
          </p>
        )}
        {list.loading && <p role="status">{t("common.loading")}</p>}
        {list.hasMore && (
          <Button
            variant="ghost"
            disabled={list.loading || !!busy}
            onClick={() => void list.load(true)}
          >
            {t("permissions.loadMore")}
          </Button>
        )}
      </div>
    </section>
  );
}
