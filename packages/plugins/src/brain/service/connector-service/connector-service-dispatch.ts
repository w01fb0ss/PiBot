import type { ConnectorNetworkApproval } from "@pibot/plugins-contract/full";
// Brain-side connector orchestration: the 13 registered RPCs, lifecycle
// operations, the connection pool and tool catalog publishing live here. The
// pool borrows connections; dispatch permissions are enforced per call and
// never inherited from a plugin manifest.

import {
  type ConnectorCallInput,
  type ConnectorDiscoverInput,
  ConnectorToolError,
  connectorDigest,
  type PreparedConnector,
  type SecretUse,
  validateConnectorArgs,
} from "@pibot/brain/kit";
import {
  accessAllows,
  ConnectorAuthenticationError,
  ConnectorCallError,
  ConnectorNetworkBlockedError,
  connectorNativeDiagnostics,
  connectorResultCount,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { connectionConfirmation } from "@pibot/policy";
import type { z } from "zod";
import { isManagedNotionRead } from "../../../store/notion-tools.ts";
import { connectionAvailability } from "../connection-availability.ts";
import { connectorSecretUses } from "../connector-secrets.ts";
import type { ConnectorServiceOperations } from "../connector-service.ts";
import { discoveryCursor } from "./connector-service-shared.ts";

/** Metadata only: never opens a transport or imports plugin code. */
export function discoverToolsForBotStep(
  this: ConnectorServiceOperations,
  botId: string,
  input: ConnectorDiscoverInput,
  readOnly = false,
  groupId?: string,
  knowledgeWrite = false,
) {
  let cursor: z.output<typeof discoveryCursor> | undefined;
  if (input.cursor && /^[A-Za-z0-9_-]+$/.test(input.cursor)) {
    try {
      const decoded = Buffer.from(input.cursor, "base64url");
      if (decoded.toString("base64url") === input.cursor)
        cursor = discoveryCursor.safeParse(JSON.parse(decoded.toString("utf8"))).data;
    } catch {
      // A missing or malformed token starts discovery from the first page.
    }
  }
  const scopeParts = [botId, groupId, input.connectorId, input.query, readOnly];
  if (knowledgeWrite) scopeParts.push(true);
  const scope = connectorDigest(scopeParts);
  if (cursor?.scope && cursor.scope !== scope) cursor = undefined;
  const discoverPage = (after?: number) =>
    this.deps.connectors.discover(botId, groupId, { ...input, after, readOnly });
  let page = discoverPage(cursor?.after);
  // Older tokens mix scope and versions in one digest. A mismatch cannot tell us what changed.
  if (
    cursor &&
    !cursor.scope &&
    cursor.snapshot !== connectorDigest([...scopeParts, page.versions])
  )
    page = discoverPage();
  const snapshot = connectorDigest(page.versions);
  if (cursor?.scope && cursor.snapshot !== snapshot)
    throw new ConnectorToolError("connector_catalog_changed");
  const items = page.items.flatMap((tool) => {
    const connector = this.deps.connectors.get(tool.connectorId);
    if (!connector) return [];
    const plugin = this.deps.plugins.get(connector.pluginInstallationId);
    const writable = this.deps.connectors.managedKnowledgeWriteAllowed(
      connector,
      knowledgeWrite ? tool.tool : undefined,
    );
    const trustedRead =
      writable !== undefined
        ? isManagedNotionRead(tool.tool)
        : plugin?.sourceKind !== "builtin" ||
          this.registry.toolPolicy(plugin.pluginId, tool.tool).readOnly;
    const effective = trustedRead || !tool.readOnly ? tool : { ...tool, readOnly: false };
    return (readOnly && !effective.readOnly) ||
      (!effective.readOnly && writable === false) ||
      connectionConfirmation(connector.confirmationMode, !effective.readOnly) === "blocked"
      ? []
      : [effective];
  });
  return {
    items,
    nextCursor:
      page.after === undefined
        ? null
        : Buffer.from(JSON.stringify({ scope, snapshot, after: page.after })).toString("base64url"),
  };
}

/** Trusted target resolution precedes policy. A plugin hint is never a read grant. */
export function resolveToolStep(
  this: ConnectorServiceOperations,
  botId: string,
  input: ConnectorCallInput,
  groupId?: string,
  knowledgeWrite = false,
): PreparedConnector {
  const availability = connectionAvailability(
    { ...this.deps, registry: this.registry, platform: this.deps.platform ?? process.platform },
    groupId ? { kind: "group", id: groupId } : { kind: "bot", id: botId },
    input.connectorId,
    input.tool,
    knowledgeWrite,
  );
  if (availability.reason !== "available")
    throw new ConnectorToolError(
      availability.reason === "tool_disabled" || availability.reason === "read_only_mode"
        ? "connector_tool_denied"
        : "connector_unavailable",
    );
  const connector = this.deps.connectors.get(input.connectorId);
  const plugin = connector ? this.deps.plugins.get(connector.pluginInstallationId) : undefined;
  if (
    !connector ||
    !plugin?.enabled ||
    plugin.status !== "installed" ||
    !connector.enabled ||
    !["ready", "idle"].includes(connector.status) ||
    !["mcp_remote", "mcp_stdio", "builtin", "rest"].includes(connector.kind)
  )
    throw new ConnectorToolError("connector_unavailable");
  const server = this.deps.connectors.configuration(connector.id);
  if (!server) throw new ConnectorToolError("connector_unavailable");
  let secretUses: SecretUse[];
  try {
    secretUses = connectorSecretUses(
      server,
      connector.pluginInstallationId,
      this.deps.userSecrets,
      botId,
    );
  } catch {
    throw new ConnectorToolError("connector_secret_denied");
  }
  if (
    this.secretBindings.has(connector.id) &&
    connectorDigest(secretUses) !== connectorDigest(this.secretBindings.get(connector.id))
  )
    throw new ConnectorToolError("connector_secret_denied");
  const access = this.deps.connectors.access(connector.id);
  if (!accessAllows(access, botId, groupId)) throw new ConnectorToolError("connector_unavailable");
  if (connector.catalogVersion !== input.catalogVersion)
    throw new ConnectorToolError("connector_catalog_changed");
  const persistedTool = this.deps.connectors.tool(
    connector.id,
    connector.catalogVersion,
    input.tool,
  );
  if (!persistedTool?.enabled) throw new ConnectorToolError("connector_tool_denied");
  // Runtime authorization uses the persisted user policy. Trusted builtin metadata may only add
  // the draft target and argument validator; it cannot silently restore a manifest default.
  const writable = this.deps.connectors.managedKnowledgeWriteAllowed(
    connector,
    knowledgeWrite ? input.tool : undefined,
  );
  const tool =
    plugin.sourceKind === "builtin"
      ? {
          ...persistedTool,
          readOnly:
            persistedTool.readOnly &&
            this.registry.toolPolicy(plugin.pluginId, persistedTool.tool).readOnly,
          draftBinding: this.registry.toolPolicy(
            plugin.pluginId,
            persistedTool.tool,
            persistedTool.schema,
            input.args,
          ).draftBinding,
        }
      : writable !== undefined && !isManagedNotionRead(persistedTool.tool)
        ? { ...persistedTool, readOnly: false }
        : persistedTool;
  // Dispatch repeats the policy's read-only decision; nothing between them may reopen a write.
  if (
    (!tool.readOnly && writable === false) ||
    connectionConfirmation(connector.confirmationMode, !tool.readOnly) === "blocked"
  )
    throw new ConnectorToolError("connector_tool_denied");
  if (plugin.sourceKind === "builtin" && this.deps.factory.validateArguments) {
    const validation = this.deps.factory.validateArguments(tool.schema, input.args);
    if (validation !== "valid")
      throw new ConnectorToolError(
        validation === "invalid" ? "connector_args_invalid" : "connector_schema_unsupported",
      );
  } else validateConnectorArgs(tool.schema, input.args);
  return {
    ...(groupId ? { groupId } : {}),
    secretUses,
    ...(plugin.sourceKind === "builtin" &&
      plugin.pluginId === "image-inspiration" &&
      connector.serverId === "image-inspiration" &&
      tool.tool === "inspiration_search" &&
      tool.readOnly && { translateImageInspirationQuery: true as const }),
    pluginRevision: plugin.revision,
    pluginDigest: plugin.digest,
    connector,
    access,
    tool,
    argsDigest: connectorDigest(input.args),
  };
}

export async function dispatchDraftStep(
  this: ConnectorServiceOperations,
  approvalId: string,
  botId: string,
  input: ConnectorCallInput,
  approved: PreparedConnector,
  signal: AbortSignal,
  authorize: () => void,
  networkApproval?: ConnectorNetworkApproval,
): Promise<unknown> {
  const draft = this.deps.drafts?.get(approvalId);
  if (
    draft?.view.status !== "sending" ||
    draft.view.botId !== botId ||
    draft.view.draft.connectorId !== input.connectorId ||
    draft.view.draft.tool !== input.tool ||
    draft.view.draft.catalogVersion !== input.catalogVersion
  )
    throw new RpcError(RpcErrorCodes.draftDenied, "draft_dispatch_denied");
  const args =
    draft.payload.contentField === null
      ? draft.payload.args
      : { ...draft.payload.args, [draft.payload.contentField]: draft.payload.content };
  if (connectorDigest(args) !== connectorDigest(input.args) || approved.tool.readOnly)
    throw new RpcError(RpcErrorCodes.draftChanged, "draft_arguments_changed");
  this.deps.drafts?.beginDispatch(approvalId);
  // The journal key of the tool call that made the draft (else the draft's own id, which is
  // equally sent at most once) travels as request `_meta`.
  const key = draft.payload.origin?.idempotencyKey ?? approvalId;
  return this.dispatchChecked(
    botId,
    input,
    approved,
    signal,
    authorize,
    true,
    key,
    networkApproval,
  );
}

export async function dispatchStep(
  this: ConnectorServiceOperations,
  botId: string,
  input: ConnectorCallInput,
  approved: PreparedConnector,
  signal: AbortSignal,
  authorize: () => void,
  networkApproval?: ConnectorNetworkApproval,
): Promise<unknown> {
  if (!approved.tool.readOnly) throw new ConnectorToolError("connector_tool_denied");
  return this.dispatchChecked(
    botId,
    input,
    approved,
    signal,
    authorize,
    false,
    undefined,
    networkApproval,
  );
}

export async function dispatchCheckedStep(
  this: ConnectorServiceOperations,
  botId: string,
  input: ConnectorCallInput,
  approved: PreparedConnector,
  signal: AbortSignal,
  authorize: () => void,
  draft: boolean,
  idempotencyKey?: string,
  networkApproval?: ConnectorNetworkApproval,
  knowledgeWrite = false,
): Promise<unknown> {
  let authorizedSnapshot = approved;
  const verify = () => {
    signal.throwIfAborted();
    authorize();
    const current = resolveToolStep.call(this, botId, input, approved.groupId, knowledgeWrite);
    if (connectorDigest(current) !== connectorDigest(authorizedSnapshot))
      throw new ConnectorToolError("connector_catalog_changed");
  };
  verify();
  // A target exists only after a successful user-enabled lifecycle. Do not turn
  // arbitrary model calls into a new server-start authorization path.
  if (draft && !this.targets.has(input.connectorId))
    this.targets.set(input.connectorId, this.buildTarget(approved.connector));
  const target = this.targets.get(input.connectorId);
  if (!target) throw new ConnectorToolError("connector_unavailable");
  const started = performance.now();
  const report = (ok: boolean, errorCode: string | null, count: number | null, value?: unknown) =>
    this.deps.logCallResult?.({
      botId,
      connectorId: approved.connector.id,
      tool: approved.tool.tool,
      ok,
      errorCode,
      count,
      status: connectorNativeDiagnostics(value)?.status ?? null,
      containerCount: connectorNativeDiagnostics(value)?.containerCount ?? null,
      durationMs: Math.round(performance.now() - started),
    });
  let dispatched = false;
  let dispatchSignal: AbortSignal | undefined;
  try {
    const value = await this.deps.pool.run(
      target,
      async (connection, pooledSignal) => {
        verify();
        this.subscribeToolChanges(input.connectorId, connection);
        // Reconnects can change tools without a notification. Publish only after
        // revalidation, but reject this old permit even if the called tool stayed unchanged.
        const live = await this.discoverTools(input.connectorId, connection, pooledSignal);
        pooledSignal.throwIfAborted();
        verify();
        if (this.targets.get(input.connectorId) !== target)
          throw new ConnectorToolError("connector_catalog_changed");
        if (
          !this.deps.catalog.matches(input.connectorId, approved.connector.catalogVersion, live)
        ) {
          const published = this.deps.catalog.publish({
            connectorId: input.connectorId,
            expectedRevision: approved.connector.revision,
            tools: live,
            actorBotId: this.deps.actorBotId,
          });
          this.applyBuiltinDefaults(input.connectorId, live);
          this.emitConnectorChanged(input.connectorId);
          this.emitToolsChanged(this.deps.connectors.get(input.connectorId) ?? published);
          throw new ConnectorToolError("connector_catalog_changed");
        }
        dispatched = true;
        dispatchSignal = pooledSignal;
        const result = await connection.callTool({
          tool: input.tool,
          args: input.args,
          signal: pooledSignal,
          ...(networkApproval
            ? {
                networkApproval: {
                  available: networkApproval.available,
                  request: (request) =>
                    networkApproval.request({
                      ...request,
                      save: () => {
                        verify();
                        request.save();
                        // Saving this host advances the settings revision without retiring the process.
                        authorizedSnapshot = resolveToolStep.call(
                          this,
                          botId,
                          input,
                          approved.groupId,
                          knowledgeWrite,
                        );
                      },
                    }),
                },
              }
            : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        pooledSignal.throwIfAborted();
        // A successful acknowledgement remains a fact even if access or the catalog changed
        // during the remote call. Every subsequent operation obtains a fresh permit.
        return result;
      },
      signal,
    );
    report(true, null, connectorResultCount(value), value);
    return value;
  } catch (error) {
    report(
      false,
      error instanceof ConnectorCallError
        ? (error.reason ??
            (error.outcome === "unknown" ? "outcome_unknown" : "connector_tool_failed"))
        : error instanceof ConnectorToolError
          ? error.code
          : signal.aborted
            ? "cancelled"
            : "connector_call_failed",
      null,
      error,
    );
    if (error instanceof ConnectorNetworkBlockedError) throw error;
    if (dispatched && dispatchSignal?.aborted) throw new ConnectorCallError("unknown");
    if (error instanceof ConnectorCallError) throw error;
    if (error instanceof ConnectorAuthenticationError) {
      try {
        await this.markNeedsAuth(input.connectorId);
      } catch (transitionError) {
        if (dispatched) throw new ConnectorCallError("unknown");
        throw transitionError;
      }
      if (dispatched) throw new ConnectorCallError("unknown");
      throw new ConnectorToolError("connector_auth_required");
    }
    // Cancellation or loss of a response cannot prove that the remote write had no effect.
    if (dispatched) throw new ConnectorCallError("unknown");
    signal.throwIfAborted();
    if (
      error instanceof ConnectorToolError ||
      (error instanceof RpcError &&
        error.code <= RpcErrorCodes.draftUnavailable &&
        error.code >= RpcErrorCodes.draftExecutionFailed)
    )
      throw error;
    // Never forward arbitrary transport messages (which can contain URLs/credentials).
    throw new ConnectorToolError("connector_call_failed");
  }
}
