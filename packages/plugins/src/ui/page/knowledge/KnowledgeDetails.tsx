import type { TranslationKey } from "@pibot/i18n";
import type {
  ConnectorAccess,
  KnowledgeAccount,
  KnowledgeFolderSummary,
  KnowledgeSource,
  NotionWriteAction,
  PluginMethodResults,
} from "@pibot/plugins-contract/full";
import type { Peer } from "@pibot/renderer-kit";
import { SettingsFold, useRpc, useSettings, useWorkspace } from "@pibot/renderer-kit";
import { Button, Chip, IconTile, Switch } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import { useConnectorAction, useConnectorRead } from "../../shell/remote.ts";
import { ConnectorFeedback } from "../ConnectorFeedback.tsx";
import { ConnectorPanel } from "../ConnectorPanel.tsx";
import { flipAccess } from "../connections/access-grant.ts";
import styles from "../connections/connections.module.css";
import { FacePicker } from "../connections/Faces.tsx";
import { knowledgeError } from "./errors.ts";
import { KIND_ICON, KIND_TONE } from "./kinds.ts";

/** Statuses where the Notion connection still needs the person's browser sign-in. */
const NEEDS_SIGN_IN = ["needs_setup", "needs_auth", "error", "disabled"];

/**
 * One knowledge source — where it reads from, who may use it, read/write permissions, and how to
 * forget it. A Notion source owns a remote MCP connection, so signing in and enabling write tools
 * stay here instead of sending the person to the MCP tab.
 */
export function KnowledgeDetails({
  id,
  alreadyAdded,
  snapshot,
  changed,
  close,
  removed,
}: {
  id: string;
  alreadyAdded: boolean;
  snapshot: number;
  changed(): void;
  close(): void;
  removed(name: string): void;
}) {
  const { t, language } = useSettings();
  const workspace = useWorkspace();
  const { peer } = useRpc();
  const detail = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot re-reads the saved targets.
    useCallback(
      (peer: Peer, signal: AbortSignal) => peer.call("knowledge.get", { id }, { signal }),
      [id, snapshot],
    ),
    knowledgeError,
  );
  const bots = workspace.bots.filter((bot) => !bot.archivedAt);
  const groups = workspace.groups.filter((group) => !group.archivedAt);
  const source = detail.value?.source;
  const origin = detail.value?.origin;
  const notionWriteTools = detail.value?.notionWriteTools;
  const isLocal = origin?.kind === "obsidian" || origin?.kind === "folder";
  const connectorId = origin?.kind === "notion" ? origin.connectorId : undefined;
  const connection = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot re-reads the connection's status.
    useCallback(
      (peer: Peer, signal: AbortSignal) =>
        connectorId
          ? peer.call("connectors.get", { id: connectorId }, { signal })
          : Promise.resolve(undefined),
      [connectorId, snapshot],
    ),
    knowledgeError,
  );
  const inspection = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot re-reads after repoint.
    useCallback(
      (peer: Peer, signal: AbortSignal) =>
        isLocal ? peer.call("knowledge.inspect", { id }, { signal }) : Promise.resolve(undefined),
      [id, isLocal, snapshot],
    ),
    knowledgeError,
  );
  const action = useConnectorAction(changed, knowledgeError);
  const [confirming, setConfirming] = useState(false);
  const [confirmingNotionWrite, setConfirmingNotionWrite] = useState<{
    actions: NotionWriteAction[];
    revision: number;
  }>();
  const [folderChoice, setFolderChoice] =
    useState<PluginMethodResults["knowledge.repoint"]["preview"]>();
  const [repointed, setRepointed] = useState(false);
  const [repointConflict, setRepointConflict] = useState<string>();
  const [authorization, setAuthorization] = useState<{
    authorizationId: string;
    fresh: boolean;
  }>();
  const [failedAuthorization, setFailedAuthorization] = useState<"initial" | "fresh">();
  const status = connection.value?.connector.status;
  // A sign-in finished here re-reads the account even when one is stored (a different
  // workspace may have been chosen); 重试 does the same.
  const [force, setForce] = useState(0);
  const retryAccount = useCallback(() => setForce((n) => n + 1), []);
  useEffect(() => {
    if (!authorization || !peer) return;
    const controller = new AbortController();
    const finish = (outcome: "succeeded" | "failed" | "cancelled") => {
      if (controller.signal.aborted) return;
      setAuthorization(undefined);
      if (outcome === "succeeded") retryAccount();
      if (outcome === "failed") setFailedAuthorization(authorization.fresh ? "fresh" : "initial");
    };
    void peer
      .call(
        "connectors.waitAuthorization",
        { authorizationId: authorization.authorizationId },
        { signal: controller.signal, timeoutMs: 330_000 },
      )
      .then(
        (result) => finish(result.status),
        () => finish("failed"),
      );
    return () => controller.abort();
  }, [authorization, peer, retryAccount]);
  const authorize = async (fresh = false) => {
    const row = connection.value?.connector;
    if (!row || action.disabled) return;
    setFailedAuthorization(undefined);
    // The host waits for native consent; both deadlines must outlive that wait.
    const timeoutMs = 660_000;
    const result = await action.run(
      (peer, signal) =>
        peer.call(
          "connectors.authorize",
          { id: row.id, expectedRevision: row.revision, ...(fresh ? { fresh: true } : {}) },
          { signal, timeoutMs },
        ),
      timeoutMs,
    );
    if (result) setAuthorization({ authorizationId: result.authorizationId, fresh });
  };
  const reconnectNotion = async () => {
    if (!source || action.disabled) return;
    await action.run((peer, signal) => peer.call("knowledge.addNotion", {}, { signal }));
  };
  const switchToAskWrites = async () => {
    const row = connection.value?.connector;
    if (!row || action.disabled) return;
    await action.run((peer, signal) =>
      peer.call(
        "connectors.update",
        { id: row.id, expectedRevision: row.revision, confirmationMode: "read_write" },
        { signal },
      ),
    );
  };
  const enableNotionRead = async () => {
    const row = connection.value?.connector;
    const tool = notionWriteTools?.readToolToEnable;
    if (!row || !tool || action.disabled) return;
    await action.run((peer, signal) =>
      peer.call(
        "connectors.update",
        {
          id: row.id,
          expectedRevision: row.revision,
          tools: [{ tool, enabled: true, readOnly: true }],
        },
        { signal },
      ),
    );
  };
  const repoint = async (confirmationToken?: string) => {
    if (!source || action.disabled) return;
    setFolderChoice(undefined);
    setRepointed(false);
    setRepointConflict(undefined);
    const timeoutMs = confirmationToken ? 30_000 : 660_000;
    const result = await action.run(
      (peer, signal) =>
        peer.call("knowledge.repoint", { id: source.id, confirmationToken }, { signal, timeoutMs }),
      timeoutMs,
    );
    setRepointConflict(result?.conflict?.name);
    setFolderChoice(result?.preview);
    setRepointed(Boolean(result?.source));
  };
  const requestNotionConsent = () => {
    if (!notionWriteTools) return;
    setConfirmingNotionWrite({
      actions: notionWriteTools.availableWrites,
      revision: notionWriteTools.revision,
    });
  };
  const saveWritable = (writable: boolean) => {
    if (!source || action.disabled) return;
    const consent = writable ? confirmingNotionWrite : undefined;
    setConfirmingNotionWrite(undefined);
    void action.run((peer, signal) =>
      peer.call(
        "knowledge.update",
        {
          id: source.id,
          name: source.name,
          targets: source.targets,
          writable,
          notionWriteActions: consent?.actions,
          notionConnectorRevision: consent?.revision,
        },
        { signal },
      ),
    );
  };
  // 「所有 Bot」 is one stored flag; the picker shows it as every Bot switched on and
  // the first click that removes one writes the explicit list, exactly like MCP's who-can-use.
  const access: ConnectorAccess = source
    ? {
        mode: source.targets.all ? "all" : "selected",
        bots: source.targets.bots,
        groups: source.targets.groups,
      }
    : { mode: "selected", bots: [], groups: [] };
  const toggle = (kind: "bot" | "group", targetId: string) => {
    if (!source || action.disabled) return;
    const next = flipAccess(
      access,
      bots.map((bot) => bot.id),
      { kind, id: targetId },
    );
    void action.run((peer, signal) =>
      peer.call(
        "knowledge.update",
        {
          id: source.id,
          name: source.name,
          targets: { all: false, bots: next.bots, groups: next.groups },
        },
        { signal },
      ),
    );
  };
  const remove = async () => {
    if (!source || action.disabled) return;
    const result = await action.run((peer, signal) =>
      peer.call("knowledge.remove", { id: source.id }, { signal }),
    );
    if (result) removed(source.name);
  };
  const lastUsed = (value: KnowledgeSource) =>
    value.lastUsedAt
      ? t("knowledge.lastUsed", { time: new Date(value.lastUsedAt).toLocaleString(language) })
      : t("knowledge.neverUsed");
  const signedIn = status === "ready" || status === "idle";
  const hasTargets = source
    ? source.targets.all || source.targets.bots.length > 0 || source.targets.groups.length > 0
    : true;
  const targetsKey = source
    ? JSON.stringify([
        source.targets.all,
        [...source.targets.bots].sort(),
        [...source.targets.groups].sort(),
      ])
    : "";
  const folderSummary = inspection.value?.summary ?? null;
  const vaultChanged =
    folderSummary?.status === "changed" ||
    action.error === "knowledge.error.vault_changed" ||
    inspection.error === "knowledge.error.vault_changed";
  const notionReadOnlyMode =
    origin?.kind === "notion" &&
    (connection.value?.connector.confirmationMode === "read_only" ||
      notionWriteTools?.readOnlyMode === true);
  const notionWriteToolsUnavailable =
    signedIn && !notionReadOnlyMode && (notionWriteTools?.missingWrites.length ?? 0) > 0;
  const notionReadUnavailable =
    signedIn && !notionReadOnlyMode && notionWriteTools?.readAvailable === false;
  const notionWriteToolsMissing =
    origin?.kind === "notion" &&
    source?.writable &&
    signedIn &&
    !notionReadOnlyMode &&
    notionWriteTools !== undefined &&
    !notionReadUnavailable &&
    notionWriteTools.enabled < notionWriteTools.total;
  const notionWriteBlocked =
    origin?.kind === "notion" &&
    (!signedIn ||
      notionReadOnlyMode ||
      !notionWriteTools ||
      notionWriteTools.total === 0 ||
      notionReadUnavailable);
  const notionConnectorMissing =
    origin?.kind === "notion" && !connection.loading && !connection.value && !!connection.error;
  const formatList = (items: string[]) => new Intl.ListFormat(language).format(items);
  const formatActions = (actions: NotionWriteAction[]) =>
    formatList(actions.map((action) => t(`knowledge.notionAction.${action}`)));
  const chosenRecipients = folderChoice?.recipients.map(({ kind, name, archived }) => {
    if (name === null) return t(`knowledge.repointUnknownRecipient.${kind}`);
    const label = kind === "group" ? t("knowledge.repointGroupRecipient", { name }) : name;
    return archived ? t("knowledge.repointArchivedRecipient", { name: label }) : label;
  });

  return (
    <ConnectorPanel
      title={source?.name ?? t("knowledge.category")}
      close={close}
      busy={action.busy}
    >
      <ConnectorFeedback
        loading={detail.loading}
        error={detail.error ?? action.error}
        retry={detail.refresh}
      />
      {source && (
        <>
          <div className={styles.panelHead}>
            <IconTile icon={KIND_ICON[source.kind]} tone={KIND_TONE[source.kind]} size="lg" />
            <div className={styles.tileText}>
              <small>{t(`knowledge.kind.${source.kind}`)}</small>
            </div>
            {status && (
              <Chip tone={signedIn ? "ok" : "warn"}>{t(`connectors.status.${status}`)}</Chip>
            )}
          </div>
          {repointConflict && (
            <p className={styles.quiet} role="alert">
              {t("knowledge.repointConflict", { name: repointConflict })}
            </p>
          )}
          {repointed && <p role="status">{t("knowledge.repointSuccess")}</p>}
          {isLocal && vaultChanged && (
            <div className={styles.softCard} data-tint="amber" role="alert">
              <div className={styles.tileRow}>
                <IconTile icon="folder" tone="amber" size="lg" />
                <span className={styles.tileText}>
                  <b>{t("knowledge.vaultChangedTitle")}</b>
                  <small>{t("knowledge.vaultChangedNote")}</small>
                </span>
              </div>
            </div>
          )}
          <section className={styles.block}>
            <h3 className={styles.blockTitle}>
              <span>{t("knowledge.origin")}</span>
            </h3>
            <div className={styles.softCard}>
              <div className={styles.tileRow}>
                <IconTile icon={KIND_ICON[source.kind]} tone={KIND_TONE[source.kind]} size="lg" />
                <span className={styles.tileText}>
                  {origin?.kind === "obsidian" || origin?.kind === "folder" ? (
                    <>
                      <b>{source.name}</b>
                      <small>{t(`knowledge.kind.${origin.kind}`)}</small>
                    </>
                  ) : (
                    <b>{t("knowledge.origin.notion")}</b>
                  )}
                </span>
                {isLocal && !folderChoice && (
                  <Button
                    variant="secondary"
                    disabled={action.disabled}
                    onClick={() => void repoint()}
                  >
                    {t("knowledge.reselectFolder")}
                  </Button>
                )}
              </div>
              {folderChoice && (
                <div className={styles.tileRow}>
                  <span className={styles.tileText}>
                    <b>{t("knowledge.repointConfirmTitle", { name: folderChoice.source.name })}</b>
                    <small>{folderChoice.path}</small>
                    <small>
                      {t("knowledge.repointRecipients", {
                        recipients: folderChoice.source.targets.all
                          ? t("knowledge.repointAllRecipients")
                          : chosenRecipients?.length
                            ? formatList(chosenRecipients)
                            : t("knowledge.repointNoRecipients"),
                      })}
                    </small>
                    {folderChoice.recipients.some((recipient) => recipient.name === null) && (
                      <small>{t("knowledge.repointUnknownAssignmentsKept")}</small>
                    )}
                    <small>
                      {t(
                        folderChoice.source.writable
                          ? "knowledge.repointWritable"
                          : "knowledge.repointReadOnly",
                      )}
                    </small>
                  </span>
                  <Button variant="secondary" onClick={() => setFolderChoice(undefined)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={action.disabled}
                    onClick={() => void repoint(folderChoice.token)}
                  >
                    {t("knowledge.repointConfirmAction")}
                  </Button>
                </div>
              )}
              {isLocal && (
                <FolderSummaryRow
                  loading={inspection.loading}
                  error={inspection.error}
                  summary={folderSummary}
                  onRetry={inspection.refresh}
                />
              )}
              {notionConnectorMissing && (
                <div className={styles.tileRow}>
                  <IconTile icon="key" tone="amber" size="lg" />
                  <span className={styles.tileText}>
                    <small>{t("knowledge.notionConnectorMissing")}</small>
                  </span>
                  <Button
                    variant="secondary"
                    loading={action.busy}
                    disabled={action.disabled}
                    onClick={() => void reconnectNotion()}
                  >
                    {t("knowledge.notionReconnect")}
                  </Button>
                </div>
              )}
              {origin?.kind === "notion" &&
                (authorization ? (
                  <div className={styles.tileRow}>
                    <span className={styles.tileText} role="status">
                      {t("connectors.authorizing")}
                    </span>
                    <Button
                      variant="secondary"
                      disabled={action.disabled}
                      onClick={() =>
                        void action.run(async (peer, signal) => {
                          await peer.call(
                            "connectors.cancelAuthorization",
                            { authorizationId: authorization.authorizationId },
                            { signal },
                          );
                          setAuthorization(undefined);
                        })
                      }
                    >
                      {t("connectors.cancelAuth")}
                    </Button>
                  </div>
                ) : (
                  !failedAuthorization &&
                  status &&
                  NEEDS_SIGN_IN.includes(status) && (
                    <div className={styles.tileRow}>
                      <IconTile icon="key" tone="violet" size="lg" />
                      <span className={styles.tileText}>
                        <small>{t("knowledge.notionNote")}</small>
                      </span>
                      <Button
                        variant="secondary"
                        loading={action.busy}
                        disabled={action.disabled || !connection.value}
                        onClick={() => void authorize()}
                      >
                        {t("knowledge.notionConnect")}
                      </Button>
                    </div>
                  )
                ))}
              {failedAuthorization && (
                <div className={styles.tileRow} role="alert">
                  <span className={styles.tileText}>
                    <small>
                      {t(
                        failedAuthorization === "fresh" && signedIn
                          ? "knowledge.notionReauthFailed"
                          : "knowledge.notionAuthFailed",
                      )}
                    </small>
                  </span>
                  <Button
                    variant="secondary"
                    loading={action.busy}
                    disabled={action.disabled || !connection.value}
                    onClick={() => void authorize(failedAuthorization === "fresh")}
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              )}
            </div>
            {origin?.kind === "notion" &&
              !authorization &&
              !(status && NEEDS_SIGN_IN.includes(status)) && (
                <p className={styles.quiet}>{t("knowledge.notionNote")}</p>
              )}
          </section>
          {origin?.kind === "notion" && (
            <NotionAccount
              id={source.id}
              status={status}
              connectorRevision={connection.value?.connector.revision}
              targetsKey={targetsKey}
              force={force}
              retry={retryAccount}
            />
          )}
          <section className={styles.block}>
            <h3 className={styles.blockTitle} data-mark="violet">
              <span>{t("connections.panel.who")}</span>
            </h3>
            {alreadyAdded && (
              <p className={styles.quiet} role="status">
                {t("knowledge.add.alreadyAdded")}
              </p>
            )}
            {!hasTargets && (
              <div className={styles.softCard} data-tint="amber" role="status">
                <div className={styles.tileRow}>
                  <IconTile icon="user" tone="amber" size="lg" />
                  <span className={styles.tileText}>
                    <b>{t("knowledge.assignPromptTitle")}</b>
                    <small>{t("knowledge.assignPromptNote")}</small>
                  </span>
                </div>
              </div>
            )}
            <div className={styles.softCard}>
              <div className={styles.tileRow}>
                <FacePicker
                  bots={bots}
                  groups={groups}
                  isOn={(kind, faceId) =>
                    kind === "bot"
                      ? source.targets.all || source.targets.bots.includes(faceId)
                      : !source.targets.all && source.targets.groups.includes(faceId)
                  }
                  toggle={toggle}
                  disabled={action.disabled}
                />
              </div>
            </div>
            <p className={styles.quiet}>{t("connections.panel.whoNote")}</p>
          </section>
          <section className={styles.block}>
            <h3 className={styles.blockTitle} data-mark="amber">
              <span>{t("knowledge.permissions")}</span>
            </h3>
            <div className={styles.softCard}>
              <div className={styles.tileRow}>
                <IconTile icon="edit" tone="amber" size="lg" />
                <span className={styles.tileText}>
                  <b>{t("knowledge.writable")}</b>
                  <small>
                    {t(isLocal ? "knowledge.writableNote.local" : "knowledge.writableNote")}
                  </small>
                </span>
                <Switch
                  checked={source.writable || confirmingNotionWrite !== undefined}
                  label={t("knowledge.writable")}
                  disabled={action.disabled || (notionWriteBlocked && !source.writable)}
                  onCheckedChange={(writable) => {
                    if (writable && origin?.kind === "notion" && !source.writable) {
                      if (notionWriteBlocked) return;
                      requestNotionConsent();
                      return;
                    }
                    setConfirmingNotionWrite(undefined);
                    saveWritable(writable);
                  }}
                />
              </div>
              {notionReadOnlyMode && (
                <div className={styles.tileRow} role="alert">
                  <span className={styles.tileText}>
                    <small>{t("knowledge.notionReadOnlyBlocked")}</small>
                  </span>
                  <Button
                    variant="secondary"
                    loading={action.busy}
                    disabled={action.disabled || !connection.value}
                    onClick={() => void switchToAskWrites()}
                  >
                    {t("knowledge.notionSwitchToAskWrites")}
                  </Button>
                </div>
              )}
              {confirmingNotionWrite && (
                <div className={styles.tileRow}>
                  <span className={styles.tileText}>
                    <b>{t("knowledge.writableConfirmTitle")}</b>
                    <small>
                      {t("knowledge.writableConfirmNote", {
                        actions: formatActions(confirmingNotionWrite.actions),
                      })}
                    </small>
                  </span>
                  <Button
                    variant="secondary"
                    disabled={action.busy}
                    onClick={() => setConfirmingNotionWrite(undefined)}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    loading={action.busy}
                    disabled={action.disabled || notionWriteBlocked}
                    onClick={() => saveWritable(true)}
                  >
                    {t("knowledge.writableConfirmAction")}
                  </Button>
                </div>
              )}
              {notionWriteToolsMissing && !confirmingNotionWrite && (
                <div className={styles.tileRow}>
                  <span className={styles.tileText}>
                    <small>{t("knowledge.notionWriteToolsMissing")}</small>
                  </span>
                  <Button
                    variant="secondary"
                    loading={action.busy}
                    disabled={action.disabled}
                    onClick={requestNotionConsent}
                  >
                    {t("knowledge.notionWriteToolsEnable")}
                  </Button>
                </div>
              )}
              {notionWriteToolsUnavailable && (
                <div className={styles.tileRow}>
                  <span className={styles.tileText}>
                    <small>
                      {t("knowledge.notionWriteToolsUnavailable", {
                        actions: formatActions(notionWriteTools?.missingWrites ?? []),
                      })}
                    </small>
                  </span>
                </div>
              )}
              {notionReadUnavailable && (
                <div className={styles.tileRow}>
                  <span className={styles.tileText}>
                    <small>{t("knowledge.notionReadUnavailable")}</small>
                  </span>
                  {notionWriteTools?.readToolToEnable && (
                    <Button
                      variant="secondary"
                      loading={action.busy}
                      disabled={action.disabled}
                      onClick={() => void enableNotionRead()}
                    >
                      {t("knowledge.notionEnableRead")}
                    </Button>
                  )}
                </div>
              )}
              {origin?.kind === "notion" &&
                !notionReadOnlyMode &&
                (source.writable || (notionWriteTools?.total ?? 0) > 0) &&
                signedIn &&
                !authorization &&
                !failedAuthorization && (
                  <div className={styles.tileRow}>
                    <span className={styles.tileText}>
                      <small>{t("knowledge.notionNote")}</small>
                    </span>
                    <Button
                      variant="secondary"
                      loading={action.busy}
                      disabled={action.disabled || !connection.value}
                      onClick={() => void authorize(true)}
                    >
                      {t("knowledge.notionReauthPages")}
                    </Button>
                  </div>
                )}
            </div>
          </section>
          {(origin?.kind === "obsidian" || origin?.kind === "folder") && (
            <SettingsFold
              title={t("connections.drawer.tab.advanced")}
              summary={t("knowledge.advancedNote")}
              icon="folder"
              tone="neutral"
            >
              <div className={styles.softCard}>
                <div className={styles.tileRow}>
                  <span className={styles.tileText}>
                    <b>{t("knowledge.advancedPath")}</b>
                    <small className={styles.mono}>{origin.path}</small>
                  </span>
                </div>
              </div>
            </SettingsFold>
          )}
          <section className={styles.block}>
            <h3 className={styles.blockTitle} data-mark="teal">
              <span>{t("connectors.recentUse")}</span>
            </h3>
            <div className={styles.softCard}>
              <div className={styles.tileRow}>
                <IconTile icon="clock" tone="teal" size="lg" />
                <span className={styles.tileText}>{lastUsed(source)}</span>
              </div>
            </div>
          </section>
          <div className={styles.softCard}>
            {confirming ? (
              <div className={styles.tileRow}>
                <IconTile icon="trash" tone="red" size="lg" />
                <span className={styles.tileText}>
                  <b>{t("knowledge.removeConfirm", { name: source.name })}</b>
                  <small>{t("knowledge.removeNote")}</small>
                </span>
                <Button
                  variant="secondary"
                  disabled={action.busy}
                  onClick={() => setConfirming(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  className={styles.dangerButton}
                  loading={action.busy}
                  disabled={action.disabled}
                  onClick={() => void remove()}
                >
                  {t("knowledge.remove")}
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className={`${styles.tileRow} ${styles.tileAction}`}
                data-danger=""
                onClick={() => setConfirming(true)}
              >
                <IconTile icon="trash" tone="red" size="lg" />
                <span className={styles.tileText}>
                  <b>{t("knowledge.remove")}</b>
                  <small>{t("knowledge.removeNote")}</small>
                </span>
              </button>
            )}
          </div>
        </>
      )}
    </ConnectorPanel>
  );
}

function FolderSummaryRow({
  loading,
  error,
  summary,
  onRetry,
}: {
  loading: boolean;
  error?: TranslationKey;
  summary: KnowledgeFolderSummary | null;
  onRetry(): void;
}) {
  const { t } = useSettings();
  if (loading && !summary && !error) {
    return (
      <div className={styles.tileRow}>
        <span className={styles.tileText} role="status">
          <small>{t("knowledge.summary.scanning")}</small>
        </span>
      </div>
    );
  }
  if (error) {
    if (error === "knowledge.error.vault_changed") return null;
    return (
      <div className={styles.tileRow} role="alert">
        <span className={styles.tileText}>
          <b>{t("knowledge.summary.failed")}</b>
          <small>{t(error)}</small>
        </span>
        <Button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (!summary || summary.status === "changed") return null;
  if (summary.status === "timeout") {
    return (
      <div className={styles.tileRow}>
        <span className={styles.tileText}>
          <small>{t("knowledge.summary.timeout")}</small>
        </span>
        <Button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (summary.status === "unreadable" || summary.status === "denied") {
    return (
      <div className={styles.tileRow} role="alert">
        <span className={styles.tileText}>
          <small>
            {t(
              summary.status === "denied"
                ? "knowledge.summary.denied"
                : "knowledge.error.vault_unreadable",
            )}
          </small>
        </span>
        <Button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  const hasSkippedOther =
    summary.scannedPdf > 0 ||
    summary.skippedLarge > 0 ||
    summary.skippedUnreadable > 0 ||
    summary.unexamined > 0;
  const text =
    summary.supported === 0 && summary.unsupported === 0 && !hasSkippedOther && !summary.truncated
      ? t("knowledge.summary.empty")
      : summary.unsupported > 0
        ? t("knowledge.summary.withUnsupported", {
            supported: summary.supported,
            unsupported: summary.unsupported,
          })
        : t("knowledge.summary.allSupported", { supported: summary.supported });
  const notes: string[] = [];
  if (summary.scannedPdf > 0)
    notes.push(t("knowledge.summary.scannedPdf", { count: summary.scannedPdf }));
  if (summary.skippedLarge > 0)
    notes.push(t("knowledge.summary.skippedLarge", { count: summary.skippedLarge }));
  if (summary.skippedUnreadable > 0)
    notes.push(t("knowledge.summary.skippedUnreadable", { count: summary.skippedUnreadable }));
  if (summary.unexamined > 0)
    notes.push(t("knowledge.summary.unexamined", { count: summary.unexamined }));
  if (summary.truncated) notes.push(t("knowledge.summary.truncated"));
  return (
    <div className={styles.tileRow}>
      <span className={styles.tileText}>
        <small>{text}</small>
        {notes.length > 0 && <small>{notes.join(" · ")}</small>}
      </span>
      <Chip tone={summary.supported > 0 ? "ok" : "warn"}>{summary.supported}</Chip>
      {summary.truncated && (
        <Button variant="secondary" loading={loading} onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

/**
 * Which Notion account the source is signed in as. Read lazily when the panel opens (the
 * brain answers the stored account, or asks Notion once), again when the sign-in status or
 * assigned Bot targets change, and with `refresh` after a sign-in finished here or on 重试.
 */
function NotionAccount({
  id,
  status,
  connectorRevision,
  targetsKey,
  force,
  retry,
}: {
  id: string;
  status?: string;
  connectorRevision?: number;
  targetsKey: string;
  force: number;
  retry(): void;
}) {
  const { t } = useSettings();
  const { peer } = useRpc();
  const [state, setState] = useState<{ account?: KnowledgeAccount | null; failed?: boolean }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: targetsKey and connectorRevision reload account state on assignment and sign-in.
  useEffect(() => {
    if (!peer || !status) return;
    const owner = new AbortController();
    setState(undefined);
    // The brain bounds the remote call at 30 s; this deadline only has to outlive it.
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(45_000)]);
    void peer
      .call("knowledge.account", { id, refresh: force > 0 }, { signal, timeoutMs: 45_000 })
      .then(
        (result) => {
          if (!owner.signal.aborted) setState({ account: result.account });
        },
        () => {
          if (!owner.signal.aborted) setState({ failed: true });
        },
      );
    return () => owner.abort();
  }, [peer, id, status, connectorRevision, targetsKey, force]);
  const account = state?.account;
  if (account === null) return null;
  const reason = state?.failed
    ? "failed"
    : account?.status === "unavailable"
      ? account.reason
      : null;
  return (
    <section className={styles.block}>
      <h3 className={styles.blockTitle} data-mark="green">
        <span>{t("knowledge.account")}</span>
      </h3>
      <div className={styles.softCard}>
        {!state ? (
          <div className={styles.tileRow}>
            <IconTile icon="user" tone="neutral" size="lg" />
            <span className={styles.tileText} role="status">
              <small>{t("knowledge.account.loading")}</small>
            </span>
          </div>
        ) : account?.status === "ok" ? (
          <div className={styles.tileRow}>
            <IconTile icon="user" tone="green" size="lg" />
            <dl className={`${styles.facts} ${styles.tileText}`}>
              {account.workspace && (
                <>
                  <dt>{t("knowledge.account.workspace")}</dt>
                  <dd>{account.workspace}</dd>
                </>
              )}
              {account.name && (
                <>
                  <dt>{t("knowledge.account.name")}</dt>
                  <dd>{account.name}</dd>
                </>
              )}
              {account.email && (
                <>
                  <dt>{t("knowledge.account.email")}</dt>
                  <dd>{account.email}</dd>
                </>
              )}
            </dl>
          </div>
        ) : reason === "no_bot" || reason === "signin" ? (
          <div className={styles.tileRow}>
            <IconTile icon="user" tone="neutral" size="lg" />
            <span className={styles.tileText}>
              <small>{t(`knowledge.account.reason.${reason}`)}</small>
            </span>
          </div>
        ) : (
          <div className={styles.tileRow}>
            <IconTile icon="user" tone="neutral" size="lg" />
            <span className={styles.tileText}>
              <b>{t("knowledge.account.unavailable")}</b>
              {reason && <small>{t(`knowledge.account.reason.${reason}`)}</small>}
            </span>
            <Button variant="secondary" onClick={retry}>
              {t("common.retry")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
