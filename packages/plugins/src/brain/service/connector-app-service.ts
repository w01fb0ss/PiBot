import { randomUUID } from "node:crypto";
import { abortable, connectorDigest } from "@pibot/brain/kit";
import type { BuiltinAppConnect } from "@pibot/plugins-contract/full";
import {
  type Connector,
  type ConnectorConnectionFactory,
  type ConnectorOAuthStorage,
  type ConnectorServer,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import type { AuditRepo, SecretStore } from "@pibot/storage";
import { z } from "zod";
import type { ConnectorOperationsRepo, ConnectorsRepo, PluginsRepo } from "../../store/index.ts";
import type { PluginRegistry } from "../apps/registry.ts";
import { importSecretPrefix, USER_SECRET_SCOPE } from "./connector-import.ts";
import { connectorWebsites } from "./connector-network.ts";

interface AppDeps {
  registry: PluginRegistry;
  plugins: PluginsRepo;
  connectors: ConnectorsRepo;
  operations: ConnectorOperationsRepo;
  secrets: SecretStore;
  audit: AuditRepo;
  actorBotId: string;
  factory: ConnectorConnectionFactory;
  platform?: string;
  cancellationTimeoutMs?: number;
  openExternal?(url: string): Promise<void>;
  registerSecret?(value: string): void;
  commitInteractiveOAuth?(connectorId: string, commit: () => void): void;
  beforeEnable(connector: Connector): Promise<void>;
  start(operation: ReturnType<ConnectorOperationsRepo["request"]>): Promise<void>;
  changed(connectorId: string): void;
  pluginChanged(installationId: string): void;
  needsAuth?(connectorId: string): void;
  authorizeBuiltinOAuth?(
    connectorId: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<void>;
}
const storedOAuth = z.strictObject({ origin: z.string(), state: z.string() });
const storedRemoteKey = z.strictObject({ endpoint: z.string(), token: z.string().min(1) });

export const canConfigureRemoteKey = (server: ConnectorServer) =>
  server.transport === "http" &&
  server.auth.kind === "none" &&
  !Object.keys(server.headers).some((name) => name.toLowerCase() === "authorization");

const unavailable = () =>
  new RpcError(RpcErrorCodes.connectorUnavailable, "Connector authorization unavailable");
type AuthorizationStatus = "succeeded" | "failed" | "cancelled";

/** Every `${secret:NAME}` a connection's configuration reads (headers, env, URL). */
function referencedSecretNames(server: ConnectorServer | undefined): Set<string> {
  const names = new Set(server?.auth.secretNames ?? []);
  const fields =
    server?.transport === "http" ? server.headers : server?.transport === "stdio" ? server.env : {};
  for (const value of Object.values(fields))
    for (const match of value.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g))
      if (match[1]) names.add(match[1]);
  if (server?.transport === "http")
    for (const match of server.url.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g))
      if (match[1]) names.add(match[1]);
  return names;
}

function importedTokenName(connector: Connector, server: ConnectorServer, name: string) {
  const referenced = referencedSecretNames(server);
  const imported = `${importSecretPrefix(connector.pluginInstallationId)}${name}`;
  if (referenced.has(imported)) return imported;
  return referenced.has(name) ? name : undefined;
}

function authorizationReference(server: ConnectorServer) {
  if (server.transport !== "http") return;
  const headers = Object.entries(server.headers).filter(
    ([key]) => key.toLowerCase() === "authorization",
  );
  if (headers.length !== 1) return;
  const match = /^(?:(Bearer|Basic|Token|ApiKey) +)?\$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/i.exec(
    headers[0]?.[1] ?? "",
  );
  if (match?.[2]) return { scheme: match[1], name: match[2] };
}

function replacementTokenName(
  connector: Connector,
  server: ConnectorServer,
  definition: ReturnType<PluginRegistry["fromInstallation"]>,
): string | undefined {
  let name: string | undefined;
  if (server.transport === "http") {
    name = authorizationReference(server)?.name;
    const references = Object.values(server.headers).flatMap((value) =>
      [...value.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g)].map((match) => match[1]),
    );
    if (new Set(references).size !== 1) return;
  } else if (definition?.mcp && server.auth.kind === "bearer") {
    if (server.transport === "builtin") name = server.auth.secretNames[0];
    else if (server.transport === "stdio") {
      const references = Object.values(server.env).flatMap((value) =>
        [...value.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g)].map((match) => match[1]),
      );
      if (new Set(references).size !== 1) return;
      name = references[0];
    }
  }
  if (
    !name?.startsWith(`IMPORT_${connector.pluginInstallationId.replaceAll("-", "").toUpperCase()}_`)
  )
    return;
  if (
    server.auth.secretNames.length &&
    (server.auth.secretNames.length !== 1 || server.auth.secretNames[0] !== name)
  )
    return;
  return name;
}

/** User-facing setup only; model calls never enter this service's authorization methods. */
export class ConnectorAppService {
  private readonly authorizations = new Map<
    string,
    { connectorId: string; controller: AbortController; promise: Promise<AuthorizationStatus> }
  >();
  private readonly authorizationOutcomes = new Map<
    string,
    { status: AuthorizationStatus; expiresAt: number }
  >();
  private readonly connecting = new Set<string>();
  constructor(private readonly deps: AppDeps) {}

  list() {
    return {
      items: this.deps.registry.list((this.deps.platform ?? process.platform) as NodeJS.Platform),
    };
  }

  async connect(input: BuiltinAppConnect) {
    const definition = this.deps.registry.get(input.appId);
    const mcp = definition?.mcp;
    const card = this.list().items.find((entry) => entry.id === input.appId);
    if (
      !definition ||
      !mcp ||
      !card?.supported ||
      !card.modes.some((entry) => entry.id === input.mode)
    )
      throw unavailable();
    if (this.connecting.has(input.appId))
      throw new RpcError(RpcErrorCodes.busy, "Application setup in progress");
    this.connecting.add(input.appId);
    try {
      // Builtin account connections are singletons. Imported MCP installations remain independent.
      for (let cursor: string | undefined; ; ) {
        const page = this.deps.plugins.list({ cursor, limit: 100 });
        for (const item of page.items) {
          if (
            item.sourceKind !== "builtin" ||
            item.pluginId !== `pibot.${input.appId}` ||
            item.status === "removed"
          )
            continue;
          const connectors = this.deps.plugins.connections(item.id);
          if (!connectors.length) continue;
          // A declined native prompt leaves the installation intact. Retry only the same
          // credential-free configuration, never replace an account or enable an edited server.
          const needsBuiltinOAuth = input.mode === "oauth" && mcp.oauthStartTool !== undefined;
          if (
            !input.enable ||
            input.token ||
            mcp.authorizeOnEnable ||
            mcp.requiresToken?.(input.mode)
          )
            throw new RpcError(RpcErrorCodes.busy, "Application already connected");
          const expected = this.deps.registry.manifest(input);
          const presets = new Map(expected.servers.map((server) => [server.id, server]));
          if (
            connectors.length !== expected.servers.length ||
            connectors.some((connector) => {
              const server = this.deps.connectors.configuration(connector.id);
              const preset = presets.get(connector.serverId);
              return (
                connector.enabled ||
                connector.status !== "disabled" ||
                !server ||
                !preset ||
                connectorDigest(server) !== connectorDigest(preset)
              );
            })
          )
            throw new RpcError(RpcErrorCodes.busy, "Application already connected");
          await this.enable(connectors, needsBuiltinOAuth || Boolean(mcp.authorizeOnEnable));
          return {
            installation: this.deps.plugins.get(item.id) ?? item,
            connectors: connectors.map((row) => this.deps.connectors.get(row.id) ?? row),
          };
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const installationId = randomUUID();
      const requiresToken = mcp.requiresToken?.(input.mode) === true;
      const gmailPassword = input.appId === "gmail" && input.mode === "app-password";
      if (input.email && !gmailPassword)
        throw new RpcError(RpcErrorCodes.invalidParams, "Unexpected account address");
      if (
        gmailPassword &&
        (!input.email || !/^[A-Za-z0-9]{16}$/.test((input.token ?? "").replace(/ /g, "")))
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "Gmail address and app password required");
      if (requiresToken && !input.token)
        throw new RpcError(RpcErrorCodes.invalidParams, "Access token required");
      if (!requiresToken && input.token)
        throw new RpcError(
          RpcErrorCodes.invalidParams,
          "This connection does not use an access token",
        );
      const credentialName = requiresToken
        ? `IMPORT_${installationId.replaceAll("-", "").toUpperCase()}_TOKEN`
        : undefined;
      const commit =
        credentialName && input.token
          ? await this.deps.secrets.prepareSet(
              USER_SECRET_SCOPE,
              credentialName,
              gmailPassword
                ? JSON.stringify({ email: input.email, appPassword: input.token.replace(/ /g, "") })
                : input.token,
            )
          : undefined;
      const manifest = this.deps.registry.manifest(input, credentialName);
      const receipt = this.deps.plugins.install({
        id: installationId,
        manifest,
        digest: connectorDigest(manifest),
        sourceKind: "builtin",
        actorBotId: this.deps.actorBotId,
        commitSecrets: commit,
      });
      this.deps.pluginChanged(installationId);
      if (input.enable)
        await this.enable(
          receipt.connectors,
          (input.mode === "oauth" && mcp.oauthStartTool !== undefined) ||
            Boolean(mcp.authorizeOnEnable),
        );
      return {
        installation: this.deps.plugins.get(installationId) ?? receipt.installation,
        connectors: receipt.connectors.map((item) => this.deps.connectors.get(item.id) ?? item),
      };
    } finally {
      this.connecting.delete(input.appId);
    }
  }

  private async enable(connectors: Connector[], authorize: boolean) {
    for (const connector of connectors) {
      if (authorize) {
        await this.authorize({ id: connector.id, expectedRevision: connector.revision });
      } else {
        await this.deps.beforeEnable(connector);
        const operation = this.deps.operations.request(
          { id: connector.id, expectedRevision: connector.revision, kind: "enable" },
          this.deps.actorBotId,
        );
        void this.deps.start(operation);
      }
    }
  }

  oauthStorage(
    connectorId: string,
    endpoint: string,
    verify: () => void = () => undefined,
    interactive = false,
  ): ConnectorOAuthStorage {
    const origin = new URL(endpoint).origin;
    const register = (value: string) => {
      const state = JSON.parse(value) as {
        tokens?: { access_token?: string; refresh_token?: string };
        client?: { client_secret?: string };
      };
      for (const secret of [
        state.tokens?.access_token,
        state.tokens?.refresh_token,
        state.client?.client_secret,
      ])
        if (secret) this.deps.registerSecret?.(secret);
      return Boolean(state.tokens?.access_token);
    };
    return {
      load: async () => {
        verify();
        const value = await this.deps.secrets.get(`connector:${connectorId}`, "oauth");
        verify();
        if (!value) return;
        try {
          const grant = storedOAuth.safeParse(JSON.parse(value));
          // A legacy grant has no verified destination and may predate a source update.
          if (!grant.success || grant.data.origin !== origin) return;
          register(grant.data.state);
          return grant.data.state;
        } catch {
          // A corrupt stored grant is unusable; a fresh sign-in replaces it.
          return;
        }
      },
      save: async (value) => {
        verify();
        // Register individual credentials as well as the encrypted blob before any SDK diagnostics.
        const hasTokens = register(value);
        const commit = await this.deps.secrets.prepareSet(
          `connector:${connectorId}`,
          "oauth",
          JSON.stringify({ origin, state: value }),
        );
        verify();
        if (interactive && hasTokens && this.deps.commitInteractiveOAuth)
          this.deps.commitInteractiveOAuth(connectorId, commit);
        else commit();
      },
    };
  }

  async remoteKey(connectorId: string, endpoint: string) {
    const value = await this.deps.secrets.get(`connector:${connectorId}`, "remote-bearer");
    if (!value) return;
    try {
      const entry = storedRemoteKey.safeParse(JSON.parse(value));
      if (entry.success && entry.data.endpoint === new URL(endpoint).href) {
        this.deps.registerSecret?.(entry.data.token);
        return entry.data.token;
      }
    } catch {
      // Invalid stored data is never forwarded to a service.
    }
  }

  async authorize(input: {
    id: string;
    expectedRevision: number;
    token?: string;
    tokenName?: string;
    fresh?: boolean;
  }) {
    const connector = this.deps.connectors.get(input.id);
    const server = connector && this.deps.connectors.configuration(connector.id);
    if (!connector || !server || connector.revision !== input.expectedRevision) throw unavailable();
    if (server.transport === "http") {
      const websites = connectorWebsites(this.deps, connector);
      if (websites.mode === "remote" && !websites.remote.allowed)
        throw new RpcError(
          RpcErrorCodes.connectorUnavailable,
          "connector_website_approval_required",
        );
    }
    if ([...this.authorizations.values()].some((item) => item.connectorId === input.id))
      throw new RpcError(RpcErrorCodes.busy, "Authorization in progress");
    const authorizationId = randomUUID();
    const controller = new AbortController();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const installation = this.deps.plugins.get(connector.pluginInstallationId);
    // 访问令牌: a brought-over connection can read several imported tokens (e.g. through
    // its environment); the dialog names the one to replace, and only a name the
    // configuration actually reads is accepted.
    const tokenName = input.tokenName
      ? importedTokenName(connector, server, input.tokenName)
      : replacementTokenName(connector, server, this.deps.registry.fromInstallation(installation));
    const canRecover = canConfigureRemoteKey(server);
    const remoteBearer =
      server.transport === "http" && canRecover && !input.tokenName && input.token;
    if (remoteBearer && /[\s\0]/.test(remoteBearer))
      throw new RpcError(RpcErrorCodes.invalidParams, "connector_paste_keyRequired");
    const remoteOAuth =
      server.transport === "http" &&
      (server.auth.kind === "oauth" ||
        (canRecover && connector.status === "needs_auth" && !input.token));
    if (
      server.auth.kind !== "oauth" &&
      !remoteOAuth &&
      !remoteBearer &&
      (!input.token || !tokenName)
    )
      throw new RpcError(
        RpcErrorCodes.connectorUnavailable,
        "connector_credential_requires_secret_settings",
      );
    const builtinOauth =
      server.auth.kind === "oauth" &&
      server.transport === "stdio" &&
      !!installation &&
      !!this.deps.registry.fromInstallation(installation)?.mcp?.oauthStartTool;
    if (
      (server.auth.kind === "oauth" || remoteOAuth) &&
      (input.token ||
        (!builtinOauth &&
          (server.transport !== "http" ||
            !this.deps.factory.authorizeOAuth ||
            !this.deps.openExternal)))
    )
      throw unavailable();
    if (builtinOauth && !this.deps.authorizeBuiltinOAuth) throw unavailable();
    const preserveWorking = Boolean(
      input.fresh &&
        server.auth.kind === "oauth" &&
        server.transport === "http" &&
        connector.enabled &&
        (connector.status === "ready" || connector.status === "idle"),
    );
    const job = Promise.resolve()
      .then(async (): Promise<AuthorizationStatus> => {
        let operation: ReturnType<ConnectorOperationsRepo["request"]> | undefined;
        const outcome = (): AuthorizationStatus => {
          if (controller.signal.aborted) return "cancelled";
          const live = this.deps.connectors.get(input.id);
          return live?.enabled && (live.status === "ready" || live.status === "idle")
            ? "succeeded"
            : "failed";
        };
        try {
          if (preserveWorking && server.transport === "http") {
            // Re-authorizing an already signed-in connection must not disrupt its active status or
            // tokens until new tokens are actually issued; cancelling keeps the existing login intact.
            const verifyWorking = () => {
              controller.signal.throwIfAborted();
              const live = this.deps.connectors.get(input.id);
              if (!live?.enabled || live.revision !== connector.revision) throw unavailable();
              return live;
            };
            await this.deps.factory.authorizeOAuth?.({
              url: server.url,
              storage: this.oauthStorage(input.id, server.url, verifyWorking, true),
              signal: controller.signal,
              openExternal: (url) => this.deps.openExternal?.(url) ?? Promise.reject(unavailable()),
              fresh: true,
            });
            const live = verifyWorking();
            operation = this.deps.operations.request(
              {
                id: input.id,
                expectedRevision: live.revision,
                kind: "restart",
              },
              this.deps.actorBotId,
            );
            this.deps.changed(input.id);
            await this.deps.start(operation);
            return outcome();
          }
          let replacement = input.token;
          const reference = authorizationReference(server);
          if (
            replacement &&
            reference &&
            reference.name === tokenName &&
            tokenName.startsWith(importSecretPrefix(connector.pluginInstallationId))
          ) {
            // Older imports stored the entire header in the encrypted value. Keep that format
            // on rotation; newer imports carry the scheme in the header template instead.
            const storedScheme =
              !reference.scheme &&
              /^(Bearer|Basic|Token|ApiKey) +/i.exec(
                (await this.deps.secrets.get(USER_SECRET_SCOPE, tokenName)) ?? "",
              );
            const scheme = reference.scheme ?? (storedScheme ? storedScheme[1] : undefined);
            if (scheme) {
              const supplied = /^(Bearer|Basic|Token|ApiKey) +/i.exec(replacement);
              if (supplied?.[1]?.toLowerCase() === scheme.toLowerCase())
                replacement = replacement.slice(supplied[0].length);
              if (storedScheme) replacement = `${storedScheme[0]}${replacement}`;
            }
          }
          const credential =
            remoteBearer && server.transport === "http"
              ? {
                  scope: `connector:${connector.id}`,
                  name: "remote-bearer",
                  value: JSON.stringify({
                    endpoint: new URL(server.url).href,
                    token: remoteBearer,
                  }),
                }
              : replacement && tokenName
                ? { scope: USER_SECRET_SCOPE, name: tokenName, value: replacement }
                : undefined;
          // Encrypt first; the lifecycle CAS and credential write then happen without an await.
          const commit = credential
            ? await this.deps.secrets.prepareSet(
                credential.scope,
                credential.name,
                credential.value,
              )
            : undefined;
          controller.signal.throwIfAborted();
          operation = this.deps.operations.request(
            {
              id: input.id,
              expectedRevision: input.expectedRevision,
              kind: connector.enabled ? "restart" : "enable",
            },
            this.deps.actorBotId,
          );
          if (commit && credential) {
            commit();
            if (remoteBearer) this.deps.registerSecret?.(remoteBearer);
            else
              this.deps.secrets.registerCommittedImport(
                credential.scope,
                credential.name,
                credential.value,
              );
          }
          this.deps.changed(input.id);
          const activeOperation = operation;
          const verify = () => {
            controller.signal.throwIfAborted();
            this.deps.operations.current(activeOperation.id, activeOperation.revision);
          };
          if (builtinOauth) {
            await this.deps.start(operation);
            controller.signal.throwIfAborted();
            const completed = this.deps.operations.get(operation.id);
            const ready = this.deps.connectors.get(connector.id);
            if (completed?.state !== "done" || !ready?.enabled || ready.status !== "ready")
              throw unavailable();
            // Catalog publishing and built-in defaults can advance the connector revision.
            // Pin the live receipt after startup, not an assumed +1.
            await this.deps.authorizeBuiltinOAuth?.(
              connector.id,
              ready.revision,
              controller.signal,
            );
          } else if (remoteOAuth) {
            await this.deps.factory.authorizeOAuth?.({
              url: server.url,
              storage: this.oauthStorage(input.id, server.url, verify, true),
              signal: controller.signal,
              openExternal: (url) => this.deps.openExternal?.(url) ?? Promise.reject(unavailable()),
              ...(input.fresh ? { fresh: true } : {}),
            });
            verify();
            this.deps.secrets.remove(`connector:${connector.id}`, "remote-bearer");
          }
          if (!builtinOauth) await this.deps.start(operation);
          return outcome();
        } catch {
          if (operation) {
            try {
              const current = this.deps.operations.get(operation.id);
              this.deps.operations.fail(
                operation.id,
                current?.revision ?? operation.revision,
                controller.signal.aborted ? "cancelled" : "auth_required",
                this.deps.actorBotId,
              );
            } catch {
              /* A newer stop/uninstall owns the row and must not be overwritten. */
            }
          }
          this.deps.changed(input.id);
          if (!preserveWorking && !controller.signal.aborted) this.deps.needsAuth?.(input.id);
          return controller.signal.aborted ? "cancelled" : "failed";
        }
      })
      .then((status) => {
        // The browser may finish before the renderer starts waiting. Keep a bounded receipt
        // separate from connection state so a failed reauthorization leaves a good login alone.
        const now = Date.now();
        for (const [id, item] of this.authorizationOutcomes)
          if (item.expiresAt <= now) this.authorizationOutcomes.delete(id);
        const oldest = this.authorizationOutcomes.keys().next().value;
        if (oldest && this.authorizationOutcomes.size >= 200)
          this.authorizationOutcomes.delete(oldest);
        this.authorizationOutcomes.set(authorizationId, { status, expiresAt: now + 5 * 60_000 });
        return status;
      })
      .finally(() => this.authorizations.delete(authorizationId));
    this.authorizations.set(authorizationId, { connectorId: input.id, controller, promise: job });
    return { authorizationId, expiresAt };
  }

  async waitAuthorization(authorizationId: string, signal: AbortSignal) {
    const active = this.authorizations.get(authorizationId);
    if (active) return { status: await abortable(active.promise, signal) };
    const completed = this.authorizationOutcomes.get(authorizationId);
    if (!completed || completed.expiresAt <= Date.now()) throw unavailable();
    return { status: completed.status };
  }

  /** 访问令牌: connections whose single token Pi Bot stores; bounded to the first 200. */
  tokens() {
    const items: {
      connectorId: string;
      connectorName: string;
      connectorRevision: number;
      installationId: string;
      name: string;
      hasValue: boolean;
    }[] = [];
    let cursor: string | undefined;
    do {
      const page = this.deps.connectors.list({ cursor, limit: 100 });
      for (const connector of page.items) {
        const server = this.deps.connectors.configuration(connector.id);
        const installation = this.deps.plugins.get(connector.pluginInstallationId);
        if (!server || installation?.status !== "installed") continue;
        const primary = replacementTokenName(
          connector,
          server,
          this.deps.registry.fromInstallation(installation),
        );
        // Stored names carry the installation prefix; the rest is the name the other tool used.
        const prefix = importSecretPrefix(installation.id);
        // Second-Mac test: a brought-over stdio server reads its key through env with no bearer
        // auth, so the single-token rule found nothing and the token was invisible.
        const names = primary
          ? [primary]
          : [...referencedSecretNames(server)].filter((name) => name.startsWith(prefix));
        for (const name of names)
          items.push({
            connectorId: connector.id,
            connectorName: connector.name,
            connectorRevision: connector.revision,
            installationId: installation.id,
            name:
              name.startsWith(prefix) && name.length > prefix.length
                ? name.slice(prefix.length)
                : name,
            hasValue: this.deps.secrets.has(USER_SECRET_SCOPE, name),
          });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && items.length < 200);
    return items.slice(0, 200);
  }

  canReplaceCredential(connectorId: string): boolean {
    const connector = this.deps.connectors.get(connectorId);
    if (!connector) return false;
    const installation = this.deps.plugins.get(connector.pluginInstallationId);
    return (
      replacementTokenName(
        connector,
        this.deps.connectors.configuration(connectorId),
        this.deps.registry.fromInstallation(installation),
      ) !== undefined
    );
  }

  cancel(authorizationId: string) {
    this.authorizations.get(authorizationId)?.controller.abort();
    return { ok: true as const };
  }
  cancelConnector(connectorId: string) {
    for (const item of this.authorizations.values())
      if (item.connectorId === connectorId) item.controller.abort();
  }
  async cancelAndDrain(connectorId: string): Promise<void> {
    this.cancelConnector(connectorId);
    const pending = [...this.authorizations.values()]
      .filter((item) => item.connectorId === connectorId)
      .map((item) => item.promise);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RpcError(RpcErrorCodes.connectorUnavailable, "Authorization cleanup timed out"),
              ),
            this.deps.cancellationTimeoutMs ?? 10_000,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async dispose() {
    for (const item of this.authorizations.values()) item.controller.abort();
    await Promise.all([...this.authorizations.values()].map((item) => item.promise));
    this.authorizationOutcomes.clear();
  }

  removeCredentials(connector: Connector) {
    const server = this.deps.connectors.configurationForCleanup(
      connector.id,
      connector.pluginInstallationId,
    );
    this.deps.secrets.remove(`connector:${connector.id}`, "oauth");
    this.deps.secrets.remove(`connector:${connector.id}`, "remote-bearer");
    this.deps.secrets.remove(`connector:${connector.id}`, "windows-ack");
    const prefix = `IMPORT_${connector.pluginInstallationId.replaceAll("-", "").toUpperCase()}_`;
    for (const name of referencedSecretNames(server ?? undefined))
      if (name.startsWith(prefix)) this.deps.secrets.remove(USER_SECRET_SCOPE, name);
  }
}
