import {
  type BuiltinApp,
  CAPABILITIES,
  type CapabilityId,
  CONNECTOR_STARTUP_MAX_SECONDS,
  type Connector,
  type ConnectorAccess,
  ConnectorFailureCodeSchema,
} from "@pibot/plugins-contract/full";
import {
  hostPlatform,
  type Peer,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useRpc,
  useRpcEvent,
  useSettings,
  useWorkspace,
} from "@pibot/renderer-kit";
import { Button, Chip, Icon } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import { operationPending, type useConnectorOperations } from "../shell/operations.ts";
import { useConnectorAction, useConnectorPage, useConnectorRead } from "../shell/remote.ts";
import { ConnectionAccessProposal } from "./ConnectionAccessProposal.tsx";
import { ConnectorAccessEditor } from "./ConnectorAccessEditor.tsx";
import { ConnectorDataDestinations } from "./ConnectorDataDestinations.tsx";
import { ConnectorFeedback, OperationStatus } from "./ConnectorFeedback.tsx";
import { ConnectorNetworkSummary } from "./ConnectorNetworkSummary.tsx";
import { ConnectorPanel } from "./ConnectorPanel.tsx";
import { ConnectorRecentUse } from "./ConnectorRecentUse.tsx";
import { ConnectorRecovery } from "./ConnectorRecovery.tsx";
import { ConnectorStartFailureView } from "./ConnectorSandbox.tsx";
import {
  connectionFailureCode,
  connectorSwitchChecked,
  runsOutsideSandbox,
} from "./connection-state.ts";
import { DrawerHero, DrawerTabs } from "./connections/DrawerParts.tsx";
import drawerStyles from "./connections/drawer.module.css";
import styles from "./connectors.module.css";
import { DirectToolGrants } from "./DirectToolGrants.tsx";
import { AdvancedTab, type SourceUpdate } from "./details/AdvancedTab.tsx";
import { PluginSettingsFields, usePluginSettings } from "./details/PluginSettings.tsx";
import { ToolKindRows, ToolsTab, useToolLabels } from "./details/ToolsTab.tsx";
import { ImportedSkillAssignment } from "./ImportedSkillAssignment.tsx";
import { connectorName } from "./presentation.ts";

type Operations = ReturnType<typeof useConnectorOperations>;
type Tab = "access" | "tools" | "confirm" | "activity" | "advanced";
const MODES = ["read_write", "always_ask", "read_only"] as const;

function relativeTime(at: string, language: "zh" | "en") {
  const seconds = Math.round((Date.parse(at) - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return format.format(value, unit);
    value = Math.round(value / size);
  }
  return format.format(value, "year");
}

/**
 * A connection's detail drawer: a hero (status, key, last use, 测试连接 / 断开) and five tabs —
 * 谁能用 · 能做什么 · 确认方式 · 记录 · 高级. The controls call the same RPCs as before; only the
 * presentation is new.
 */
export function ConnectorDetails({
  id,
  initialSection,
  requestedTarget,
  apps,
  snapshot,
  operations,
  suggestedCapabilities = [],
  remove,
  openTokens,
  changed,
  close,
}: {
  id: string;
  initialSection?: "access" | "advanced";
  requestedTarget?: { kind: "bot" | "group"; id: string };
  apps?: BuiltinApp[];
  snapshot: number;
  operations: Operations;
  /** Confirmed catalog mappings; only overlaps with a built-in tool are worth telling the user. */
  suggestedCapabilities?: readonly CapabilityId[];
  /** Removes the package this connection came from (高级 → 删除). */
  remove?(): void;
  /** Opens the Access tokens dialog, optionally focused on one shared token name. */
  openTokens?(secretName?: string): void;
  changed(): void;
  close(): void;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const workspace = useWorkspace();
  const load = useCallback(
    (peer: Peer, signal: AbortSignal) => peer.call("connectors.get", { id }, { signal }),
    [id],
  );
  const detail = useConnectorRead(load);
  useRpcEvent("connectors.changed", (event) => {
    if (event.connectorId === id) detail.refresh();
  });
  const catalog = useConnectorRead(
    useCallback(
      (peer: Peer, signal: AbortSignal) =>
        apps ? Promise.resolve({ items: apps }) : peer.call("apps.list", {}, { signal }),
      [apps],
    ),
  );
  const loadTools = useCallback(
    (peer: Peer, signal: AbortSignal, cursor?: string) =>
      peer.call("connectors.tools", { id, cursor, limit: 50 }, { signal }),
    [id],
  );
  const tools = useConnectorPage(loadTools, snapshot);
  // The sandbox switch and the last start failure (desktop-only RPC).
  const diagnostics = useConnectorRead(
    useCallback(
      (peer: Peer, signal: AbortSignal) => peer.call("connectors.diagnostics", { id }, { signal }),
      [id],
    ),
  );
  // Names and presence only; a key's value never reaches this window.
  const tokens = useConnectorRead(
    useCallback(
      (peer: Peer, signal: AbortSignal) => peer.call("connections.tokens", {}, { signal }),
      [],
    ),
  );
  const lastUse = useConnectorRead(
    useCallback(
      (peer: Peer, signal: AbortSignal) =>
        peer.call("connectors.recentUse", { id, limit: 1 }, { signal }),
      [id],
    ),
  );
  const refreshDetail = detail.refresh;
  const refreshDiagnostics = diagnostics.refresh;
  const refreshTokens = tokens.refresh;
  const refreshLastUse = lastUse.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: All connector events retire the selected detail snapshot.
  useEffect(() => {
    refreshDetail();
    refreshDiagnostics();
    refreshTokens();
    refreshLastUse();
  }, [snapshot, refreshDetail, refreshDiagnostics, refreshTokens, refreshLastUse]);
  useRpcEvent("chat.done", refreshLastUse);
  useRpcEvent("connectors.changed", (event) => {
    if (event.connectorId === id && (event.status === "needs_auth" || event.status === "error"))
      setAuthorization(undefined);
  });
  const refresh = () => {
    detail.refresh();
    diagnostics.refresh();
    tools.refresh();
    tokens.refresh();
    changed();
  };
  const action = useConnectorAction(refresh);
  const connector = detail.value?.connector;
  const pluginSettings = usePluginSettings(connector?.pluginInstallationId, snapshot);
  const name = connector
    ? connectorName(connector, catalog.value?.items ?? [], language)
    : t("connectors.title");
  const app = catalog.value?.items.find((row) => row.id === connector?.appId);
  const localApp = app?.category === "local";
  const labels = useToolLabels(connector?.name ?? "", tools.value?.items);
  const [tab, setTab] = useState<Tab>(
    initialSection === "advanced"
      ? "advanced"
      : initialSection === "access" || requestedTarget
        ? "access"
        : "tools",
  );
  const connectionFailed =
    connector && ["needs_setup", "needs_auth", "error"].includes(connector.status);
  const failure = ConnectorFailureCodeSchema.safeParse(
    connectionFailureCode(connector?.statusDetailCode, detail.value?.auth === "system"),
  );
  const latest = operations.rows
    .filter(
      (row) =>
        row.connectorId === id ||
        (row.connectorId === null && row.installationId === connector?.pluginInstallationId),
    )
    .at(-1);
  const pendingRows = operations.rows.filter(
    (row) =>
      (row.connectorId === id ||
        (row.connectorId === null && row.installationId === connector?.pluginInstallationId)) &&
      operationPending(row),
  );
  const pending = pendingRows.length > 0;
  const blocked = action.disabled || detail.loading || !!detail.error || !connector;
  const disabled = blocked || pending;
  // Capabilities are not a user-facing concept (maintainers 2026-10-24): GitHub / Notion / Figma are
  // just connections, and where a connection overlaps a built-in tool the built-in one is used.
  const overlapNames = suggestedCapabilities.flatMap((capabilityId) => {
    const definition = CAPABILITIES.find(({ id }) => id === capabilityId);
    return definition?.hasBuiltin ? [definition.name[language]] : [];
  });
  // Restart keeps the connector "stopping" until discovery completes. The
  // operation, rather than that snapshot status, identifies a cancellable start.
  const stopAvailable =
    pending &&
    pendingRows.every(({ operation }) =>
      operation
        ? (operation.kind === "enable" || operation.kind === "restart") &&
          (operation.state === "pending" || operation.state === "running") &&
          operation.phase !== "draining"
        : connector?.status === "starting",
    );
  const stopDisabled = blocked || (pending && !stopAvailable);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const targetKey = requestedTarget ? `${requestedTarget.kind}:${requestedTarget.id}` : "";
  const [confirmedTarget, setConfirmedTarget] = useState<string>();
  const targetConfirmed = confirmedTarget === targetKey;
  const [authorization, setAuthorization] = useState<{
    authorizationId: string;
    expiresAt: string;
  }>();
  const [token, setToken] = useState("");
  const [sourceUpdate, setSourceUpdate] = useState<SourceUpdate>();
  const updateFromSource = async (confirmed: boolean) => {
    if (!connector || disabled) return;
    const result = await action.run(
      (peer, signal) =>
        peer.call(
          "connectors.updateFromSource",
          {
            id,
            expectedRevision: connector.revision,
            confirmed,
            ...(confirmed && sourceUpdate?.sourceDigest
              ? { expectedDigest: sourceUpdate.sourceDigest }
              : {}),
          },
          { signal },
        ),
      330_000,
    );
    if (!result) {
      setSourceUpdate(undefined);
      return;
    }
    if (result.state === "preview") setSourceUpdate(result);
    else if (result.state === "source_not_found") setSourceUpdate(result);
    else if (result.state === "updated") {
      setSourceUpdate(result);
      refresh();
    }
  };
  useEffect(() => {
    if (connector?.status === "ready" || connector?.status === "idle") setAuthorization(undefined);
  }, [connector?.status]);
  const authorize = async (useKey = false) => {
    if (!connector || action.disabled) return;
    const submitted = useKey ? token.trim() : "";
    setToken("");
    const result = await action.run((peer, signal) =>
      peer.call(
        "connectors.authorize",
        {
          id,
          expectedRevision: connector.revision,
          ...(submitted ? { token: submitted } : {}),
        },
        { signal },
      ),
    );
    if (result && !submitted) setAuthorization(result);
  };
  // Same path as 访问令牌's replace: the new value is checked by reconnecting.
  const replaceToken = async (tokenName: string, value: string) => {
    if (!connector) return false;
    const result = await action.run((peer, signal) =>
      peer.call(
        "connectors.authorize",
        { id, expectedRevision: connector.revision, token: value, tokenName },
        { signal },
      ),
    );
    return !!result;
  };
  const [waitingNative, setWaitingNative] = useState(false);
  const lifecycle = async (kind: "enable" | "disable" | "restart" | "disconnect") => {
    const gate = kind === "enable" || kind === "restart" ? disabled : stopDisabled;
    if (!connector || gate) return;
    const mayConfirm =
      (kind === "enable" || kind === "restart") &&
      (hostPlatform() === "win32" || connector.outsideSandbox);
    setWaitingNative(mayConfirm);
    const value = await action.run(
      (peer, signal) => {
        const params = { id, expectedRevision: connector.revision };
        if (kind === "enable" || kind === "disable")
          return peer.call(
            "connectors.setEnabled",
            { ...params, enabled: kind === "enable" },
            { signal },
          );
        return peer.call(
          kind === "restart" ? "connectors.restart" : "connectors.disconnect",
          params,
          { signal },
        );
      },
      mayConfirm ? 330_000 : 30_000,
    );
    setWaitingNative(false);
    if (value) {
      operations.track(value.operationId, connector.pluginInstallationId, id);
      setConfirmDisconnect(false);
    }
  };
  const setOutsideSandbox = async (enabled: boolean) => {
    if (!connector || disabled) return;
    setWaitingNative(enabled);
    const value = await action.run(
      (peer, signal) =>
        peer.call(
          "connectors.setOutsideSandbox",
          { id, expectedRevision: connector.revision, enabled },
          { signal },
        ),
      enabled ? 330_000 : 30_000,
    );
    setWaitingNative(false);
    if (value?.operationId) operations.track(value.operationId, connector.pluginInstallationId, id);
  };
  const saveStartup = async (seconds: number | null, retry = false) => {
    if (!connector || disabled) return;
    const mayConfirm = retry && (hostPlatform() === "win32" || connector.outsideSandbox);
    setWaitingNative(mayConfirm);
    const result = await action.run(
      async (peer, signal) => {
        const saved = await peer.call(
          "connectors.update",
          { id, expectedRevision: connector.revision, startupTimeoutSec: seconds },
          { signal },
        );
        if (!retry) return undefined;
        const params = { id, expectedRevision: saved.revision };
        if (connector.outsideSandbox && hostPlatform() !== "win32")
          return peer.call(
            "connectors.setOutsideSandbox",
            { ...params, enabled: true },
            { signal },
          );
        return peer.call("connectors.restart", params, { signal });
      },
      mayConfirm ? 330_000 : 30_000,
    );
    setWaitingNative(false);
    if (result?.operationId)
      operations.track(result.operationId, connector.pluginInstallationId, id);
  };
  const currentWait = detail.value?.startup?.seconds;
  const retryWithMoreTime =
    currentWait !== undefined && currentWait < CONNECTOR_STARTUP_MAX_SECONDS
      ? () => void saveStartup(Math.min(CONNECTOR_STARTUP_MAX_SECONDS, currentWait + 60), true)
      : undefined;
  const authorizeInline =
    !authorization &&
    detail.value?.canAuthorizeInBrowser &&
    (connector?.status === "needs_auth" || (failure.success && failure.data === "auth_required"));
  const canEnterKey = detail.value?.canAddRemoteKey && connector?.status === "needs_auth";
  const showTokenInput = !!(detail.value?.canReplaceCredential || canEnterKey);
  const update = (
    patch: {
      networkDomains?: string[];
      access?: ConnectorAccess;
      confirmationMode?: Connector["confirmationMode"];
      tools?: { tool: string; enabled: boolean; readOnly: boolean }[];
    },
    resolveAccess?: (peer: Peer, signal: AbortSignal) => Promise<ConnectorAccess>,
  ) => {
    if (!connector || disabled) return Promise.resolve(undefined);
    return action.run(async (peer, signal) =>
      peer.call(
        "connectors.update",
        {
          id,
          expectedRevision: connector.revision,
          ...patch,
          ...(resolveAccess ? { access: await resolveAccess(peer, signal) } : {}),
        },
        { signal },
      ),
    );
  };
  const ownTokens = (tokens.value?.items ?? []).filter((row) => row.connectorId === id);
  const toolItems = tools.value?.items ?? [];
  const access = detail.value?.access;
  const bots = workspace.bots.filter((bot) => !bot.archivedAt);
  const accessCount = !access
    ? undefined
    : access.mode === "all"
      ? bots.length
      : access.mode === "selected"
        ? access.bots.length + access.groups.length
        : undefined;
  const healthy = connector?.status === "ready" || connector?.status === "idle";
  const statusChip = connector && (
    <Chip
      className={drawerStyles.statusChip}
      tone={
        healthy
          ? "ok"
          : connectionFailed
            ? "warn"
            : connector.status === "disabled"
              ? "neutral"
              : "blue"
      }
    >
      {healthy && <Icon name="check" size={11} strokeWidth={3} />}
      {t(
        healthy
          ? "connections.drawer.status.ok"
          : connectionFailed
            ? "connections.drawer.status.attention"
            : connector.status === "disabled"
              ? "connections.drawer.status.off"
              : `connectors.status.${connector.status}`,
      )}
    </Chip>
  );
  const keyHint = ownTokens.length
    ? t(
        ownTokens.every((row) => row.hasValue)
          ? "connections.drawer.keySaved"
          : "connections.drawer.keyMissing",
      )
    : undefined;
  const used = lastUse.value?.items[0]?.at;
  const heroNote = [
    keyHint,
    lastUse.value &&
      (used
        ? t("connections.drawer.lastUsed", { time: relativeTime(used, language) })
        : t("connections.drawer.neverUsed")),
  ]
    .filter(Boolean)
    .join(" · ");
  const heroActions = connector && (
    <>
      {connector.status === "disabled" ? (
        <Button disabled={disabled} onClick={() => void lifecycle("enable")}>
          {t("connections.drawer.enable")}
        </Button>
      ) : (
        <Button
          variant="secondary"
          title={t("connections.drawer.testNote")}
          disabled={disabled || connector.status === "starting"}
          onClick={() => void lifecycle("restart")}
        >
          {t("connections.drawer.test")}
        </Button>
      )}
      {!localApp && connector.status !== "disabled" && (
        <Button variant="ghost" disabled={stopDisabled} onClick={() => setConfirmDisconnect(true)}>
          {t("connectors.disconnect")}
        </Button>
      )}
    </>
  );
  return (
    <ConnectorPanel title={name} close={close} busy={action.busy}>
      <div className={drawerStyles.drawer}>
        {waitingNative && (
          <p role="status" className={styles.note}>
            {t("connectors.nativeConfirmationWaiting")}
          </p>
        )}
        <ConnectorFeedback
          loading={detail.loading}
          error={detail.error ?? action.error}
          retry={refresh}
        />
        {connector && (
          <>
            <DrawerHero
              name={name}
              status={statusChip}
              note={heroNote}
              chips={
                runsOutsideSandbox(connector, hostPlatform()) ? (
                  <Chip tone="warn">{t("connectors.outsideSandbox.badge")}</Chip>
                ) : undefined
              }
              actions={heroActions}
            />
            {confirmDisconnect && (
              <SettingsSection title={t("connectors.disconnect")}>
                <SettingsLine dot="warn" role="alert">
                  {t("connectors.disconnectConfirm")}
                </SettingsLine>
                <div className={drawerStyles.stackedControl}>
                  <div className={drawerStyles.inlineActions}>
                    <Button
                      variant="secondary"
                      disabled={action.busy}
                      onClick={() => setConfirmDisconnect(false)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      className={styles.dangerButton}
                      disabled={stopDisabled}
                      onClick={() => void lifecycle("disconnect")}
                    >
                      {t("connectors.disconnect")}
                    </Button>
                  </div>
                </div>
              </SettingsSection>
            )}
            {(["needs_setup", "needs_auth", "error"] as Connector["status"][]).includes(
              connector.status,
            ) &&
              !(diagnostics.value?.needsReconfirm && !diagnostics.value.lastFailure) &&
              (diagnostics.value?.lastFailure ? (
                <ConnectorStartFailureView failure={diagnostics.value.lastFailure}>
                  <ConnectorRecovery
                    key={`${id}:${connector.revision}`}
                    diagnostics={diagnostics.value}
                    disabled={disabled}
                    askRunAsMe={() => void setOutsideSandbox(true)}
                    retry={() => void lifecycle("restart")}
                    retryWithMoreTime={retryWithMoreTime}
                  />
                </ConnectorStartFailureView>
              ) : (
                <div className={`${styles.warn} ${styles.stack}`} role="status">
                  <p>
                    {failure.success
                      ? t(`connectors.failure.${failure.data}`)
                      : t("connectors.setupNote")}
                    {connector.kind === "mcp_stdio" &&
                      connector.status === "error" &&
                      !authorizeInline && <> {t("connectors.startFailure.restartToSee")}</>}
                  </p>
                  {authorizeInline && detail.value?.hasSavedOAuth && (
                    <p>{t("connectors.recovery.oauthRenewal")}</p>
                  )}
                  {authorizeInline && (
                    <Button
                      variant="secondary"
                      disabled={action.disabled}
                      onClick={() => void authorize()}
                    >
                      {t("connectors.recovery.authorize")}
                    </Button>
                  )}
                  {failure.success && failure.data === "timeout" && retryWithMoreTime && (
                    <Button variant="secondary" disabled={disabled} onClick={retryWithMoreTime}>
                      {t("connectors.recovery.extend")}
                    </Button>
                  )}
                </div>
              ))}
            {diagnostics.value?.needsReconfirm && !diagnostics.value.lastFailure && (
              <div className={`${styles.warn} ${styles.stack}`} role="status">
                <p>{t("connectors.outsideSandbox.reconfirm")}</p>
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => void setOutsideSandbox(true)}
                >
                  {t("connectors.recovery.reconfirm")}
                </Button>
              </div>
            )}
            {connector.status === "starting" && detail.value?.startup?.packageRunner && (
              <p className={styles.note} role="status">
                {t("connectors.recovery.downloading")}
              </p>
            )}
            {hostPlatform() === "win32" && connector.kind === "mcp_stdio" && (
              <p className={styles.warn}>{t("connectors.windowsWarning")}</p>
            )}
            {(connector.status === "needs_auth" ||
              connector.status === "needs_setup" ||
              connector.status === "disabled") &&
              (showTokenInput ||
                (detail.value?.auth === "oauth" && !authorizeInline) ||
                !!authorization) && (
                <SettingsSection title={t("connections.drawer.fill")}>
                  {showTokenInput && (
                    <label className={drawerStyles.field}>
                      <span className={drawerStyles.fieldLabel}>{t("connectors.appToken")}</span>
                      <span className={drawerStyles.inputBox}>
                        <Icon name="key" size={16} />
                        <input
                          type="password"
                          value={token}
                          autoComplete="new-password"
                          disabled={action.disabled}
                          maxLength={16384}
                          onChange={(event) => setToken(event.currentTarget.value)}
                        />
                      </span>
                      <span className={drawerStyles.fieldNote}>
                        {t("connections.drawer.secretNote")}
                      </span>
                    </label>
                  )}
                  <div className={drawerStyles.stackedControl}>
                    <div className={drawerStyles.inlineActions}>
                      {authorization ? (
                        <>
                          <span role="status" className={drawerStyles.fieldNote}>
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
                        </>
                      ) : (
                        <Button
                          disabled={action.disabled || (showTokenInput && !token.trim())}
                          onClick={() => void authorize(showTokenInput)}
                        >
                          {t(
                            canEnterKey
                              ? "connectors.recovery.saveRemoteKey"
                              : "connectors.reauthorize",
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </SettingsSection>
              )}
            {!!detail.value?.sharedSecretNames?.length && (
              <div className={drawerStyles.inlineNotice}>
                <p className={styles.note}>{t("connectors.sharedCredentialNote")}</p>
                {openTokens && (
                  <div className={drawerStyles.inlineActions}>
                    {detail.value.sharedSecretNames.map((secretName) => (
                      <Button
                        key={secretName}
                        variant="secondary"
                        onClick={() => openTokens(secretName)}
                      >
                        {t("connectors.openAccessTokenNamed", { name: secretName })}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {detail.value?.auth === "bearer" &&
              detail.value.canReplaceCredential === false &&
              ownTokens.length > 0 && (
                <div className={drawerStyles.inlineNotice}>
                  <p className={styles.note}>{t("connectors.privateCredentialsNote")}</p>
                  <Button variant="secondary" onClick={() => setTab("advanced")}>
                    {t("connectors.advanced")}
                  </Button>
                </div>
              )}
            <OperationStatus
              // A finished operation is already told by the hero's status chip; a bare
              // 「操作成功」 under it read as a stray line.
              row={latest?.operation?.state === "done" && !latest.unknown ? undefined : latest}
              check={operations.check}
              systemAuth={detail.value?.auth === "system"}
            />
            {detail.value?.networkMode && detail.value.networkMode !== "none" && (
              <ConnectorNetworkSummary
                mode={detail.value.networkMode}
                declared={detail.value.declaredNetworkDomains ?? []}
                blockedRemoteSite={detail.value.blockedRemoteSite}
                blocked={detail.value.blockedNetworkSites ?? []}
                disabled={disabled}
                revokeRemote={
                  detail.value.canEditNetworkDomains
                    ? () => void update({ networkDomains: [] })
                    : undefined
                }
                resolve={(site, choice) =>
                  void action.run((peer, signal) =>
                    peer.call(
                      "connectors.network.resolve",
                      { id, host: site, action: choice },
                      { signal },
                    ),
                  )
                }
              />
            )}
            <DrawerTabs<Tab>
              label={name}
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "access", label: t("connections.drawer.tab.access"), count: accessCount },
                {
                  value: "tools",
                  label: t("connections.drawer.tab.tools"),
                  count: tools.value
                    ? `${toolItems.length}${tools.next || tools.previous ? "+" : ""}`
                    : undefined,
                },
                { value: "confirm", label: t("connections.drawer.tab.confirm") },
                { value: "activity", label: t("connections.drawer.tab.activity") },
                { value: "advanced", label: t("connections.drawer.tab.advanced") },
              ]}
            />
            <div role="tabpanel" className={drawerStyles.drawer}>
              {tab === "access" &&
                detail.value &&
                (requestedTarget && !targetConfirmed && detail.value.access.mode !== "all" ? (
                  <ConnectionAccessProposal
                    key={`${targetKey}:${connector.revision}`}
                    access={detail.value.access}
                    target={requestedTarget}
                    disabled={disabled}
                    confirm={(access) => {
                      void update({ access }).then((saved) => {
                        if (saved) setConfirmedTarget(targetKey);
                      });
                    }}
                  />
                ) : (
                  <>
                    <ConnectorAccessEditor
                      access={detail.value.access}
                      disabled={disabled}
                      resolveAndSave={(resolve) => void update({}, resolve)}
                      save={(access) => {
                        void update({ access });
                      }}
                    />
                    {detail.value.access.mode === "ask_first" && (
                      <SettingsLine>{t("connections.drawer.firstUse")}</SettingsLine>
                    )}
                  </>
                ))}
              {tab === "tools" && (
                <ToolsTab
                  tools={tools}
                  connector={connector}
                  product={connector.name}
                  disabled={disabled}
                  note={
                    overlapNames.length > 0 ? (
                      <SettingsLine>
                        {t("capabilities.builtinOverlap", {
                          capabilities: overlapNames.join(language === "zh" ? "、" : ", "),
                        })}
                      </SettingsLine>
                    ) : undefined
                  }
                  save={(patch) => void update({ tools: [patch] })}
                />
              )}
              {tab === "confirm" && (
                <>
                  <SettingsSection title={t("connections.drawer.tab.confirm")}>
                    {MODES.map((mode, index) => (
                      <label key={mode} className={drawerStyles.radioRow}>
                        <SettingsRow
                          icon={(["eye", "shield", "eye"] as const)[index]}
                          tone={(["blue", "orange", "neutral"] as const)[index]}
                          label={t(`connections.drawer.confirm.${mode}`)}
                          note={t(`connections.drawer.confirm.${mode}Note`)}
                        >
                          <input
                            type="radio"
                            className={drawerStyles.radio}
                            name={`confirmation-${id}`}
                            value={mode}
                            disabled={disabled}
                            checked={connector.confirmationMode === mode}
                            onChange={() => void update({ confirmationMode: mode })}
                          />
                        </SettingsRow>
                      </label>
                    ))}
                  </SettingsSection>
                  <SettingsLine>{t("connections.drawer.confirmNote")}</SettingsLine>
                  <DirectToolGrants
                    id={id}
                    toolLabel={(tool) =>
                      labels.title(toolItems.find((row) => row.tool === tool) ?? { tool })
                    }
                  />
                </>
              )}
              {tab === "activity" && (
                <>
                  <ConnectorRecentUse id={id} snapshot={snapshot} />
                  <ConnectorDataDestinations id={id} snapshot={snapshot} />
                </>
              )}
              {tab === "advanced" && (
                <AdvancedTab
                  connector={connector}
                  switchChecked={connectorSwitchChecked(connector)}
                  switchDisabled={
                    !!connectionFailed || (connector.enabled ? stopDisabled : disabled)
                  }
                  toggle={(enabled) => void lifecycle(enabled ? "enable" : "disable")}
                  disabled={disabled}
                  restart={() => void lifecycle("restart")}
                  sourceUpdate={sourceUpdate}
                  updateFromSource={
                    detail.value?.canUpdateFromSource
                      ? (confirmed) => void updateFromSource(confirmed)
                      : undefined
                  }
                  tokens={ownTokens}
                  replaceToken={replaceToken}
                  settings={
                    pluginSettings.value?.editable ? (
                      <PluginSettingsFields
                        settings={pluginSettings.value}
                        disabled={disabled}
                        changed={() => {
                          pluginSettings.refresh();
                          refresh();
                        }}
                        saved={(operationIds) => {
                          for (const operationId of operationIds)
                            operations.track(operationId, connector.pluginInstallationId, null);
                        }}
                      />
                    ) : undefined
                  }
                  network={
                    detail.value?.networkMode === "sandbox" && detail.value.canEditNetworkDomains
                      ? {
                          domains: detail.value.networkDomains ?? [],
                          editable: !!detail.value.canEditNetworkDomains,
                          save: (networkDomains) => void update({ networkDomains }),
                        }
                      : undefined
                  }
                  diagnostics={diagnostics.value}
                  startup={detail.value?.startup}
                  saveStartup={(seconds) => void saveStartup(seconds)}
                  setOutsideSandbox={(enabled) => void setOutsideSandbox(enabled)}
                  toolKinds={
                    <ToolKindRows
                      tools={tools}
                      product={connector.name}
                      disabled={disabled}
                      save={(patch) => void update({ tools: [patch] })}
                    />
                  }
                  skills={
                    !connector.appId ? (
                      <ImportedSkillAssignment
                        installationId={connector.pluginInstallationId}
                        changed={changed}
                      />
                    ) : undefined
                  }
                  remove={remove}
                />
              )}
            </div>
            {tab === "advanced" && (
              <SettingsSection title={t("connections.drawer.run")}>
                <SettingsRow
                  icon="terminal"
                  tone="teal"
                  label={t(
                    localApp
                      ? "connections.drawer.run.builtin"
                      : connector.kind === "mcp_stdio"
                        ? detail.value?.bundledNode
                          ? "connections.drawer.run.node"
                          : "connections.drawer.chip.local"
                        : "connections.drawer.chip.remote",
                  )}
                  note={t(
                    connector.identity === "user"
                      ? "connectors.userIdentity"
                      : "connectors.botIdentity",
                  )}
                />
              </SettingsSection>
            )}
          </>
        )}
        {!peer && <p role="status">{t("connectors.offline")}</p>}
      </div>
    </ConnectorPanel>
  );
}
