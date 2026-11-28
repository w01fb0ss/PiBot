import {
  type ConnectorNetworkAttempt,
  connectorNetworkRefusal,
  connectorNetworkSite,
} from "@pibot/execution";
import {
  type Connector,
  type ConnectorBlockedSite,
  type ConnectorNetworkApproval,
  ConnectorNetworkRefusalSchema,
  ConnectorNetworkSiteSchema,
  connectorAuditEvents,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { connectorSandboxEn, connectorSandboxZh } from "@pibot/plugins-contract/i18n";
import { CONNECTOR_NETWORK_CONFIRMATION, connectorNetworkPolicy } from "@pibot/policy";
import { remoteNetworkSite } from "../../store/plugin-settings.ts";
import type { ConnectorNetworkCall } from "./connector-runtime.ts";
import type { ConnectorServiceOperations } from "./connector-service.ts";

const PROMPTS_PER_CALL = 2;
const PROMPTS_PER_WINDOW = 4;
const PROMPT_WINDOW_MS = 60_000;

export function connectorWebsites(
  deps: Pick<ConnectorServiceOperations["deps"], "connectors" | "plugins" | "platform"> &
    Pick<ConnectorServiceOperations, "registry">,
  connector: Connector,
) {
  const stored = deps.connectors.configuration(connector.id);
  const installation = deps.plugins.get(connector.pluginInstallationId);
  const effective = deps.registry.effectiveServer(installation, stored);
  const declaredServer = deps.plugins
    .manifest(connector.pluginInstallationId)
    ?.servers.find(({ id }) => id === stored.id);
  const denied = new Set(deps.connectors.networkDenials(connector.id));
  if (effective.transport === "http") {
    const endpoint = remoteNetworkSite(effective, declaredServer, denied);
    const sites = endpoint.allowed ? [endpoint.site] : [];
    return { declared: sites, domains: sites, mode: "remote", remote: endpoint } as const;
  }
  const domains = (
    installation?.sourceKind === "builtin" ? effective : stored
  ).networkDomains.filter(
    (site) => !denied.has(site) && !connectorNetworkRefusal(site.split(":")[0] ?? ""),
  );
  const declared = [
    ...new Set([
      ...(declaredServer?.networkDomains ?? []),
      ...(installation?.sourceKind === "builtin" ? effective.networkDomains : []),
    ]),
  ].filter((site) => domains.includes(site));
  const platform = deps.platform ?? process.platform;
  const mode =
    effective.transport !== "stdio"
      ? "none"
      : platform === "win32" || (connector.outsideSandbox && installation?.sourceKind !== "builtin")
        ? "unisolated"
        : "sandbox";
  return { declared, domains, mode } as const;
}

export function allowConnectorWebsite(
  ops: ConnectorServiceOperations,
  connector: Connector,
  host: string,
) {
  const sites = connectorWebsites({ ...ops.deps, registry: ops.registry }, connector);
  if (sites.domains.includes(host)) return;
  ops.deps.connectors.allowNetworkSite(connector.id, host, ops.deps.actorBotId, sites.domains);
}

export async function connectorNetworkDecision(
  ops: ConnectorServiceOperations,
  connectorId: string,
  generation: number,
  attempt: ConnectorNetworkAttempt,
  signal: AbortSignal,
  call?: ConnectorNetworkCall,
) {
  const approval = call?.approval;
  const host = connectorNetworkSite(
    attempt.host.includes(":") ? `[${attempt.host}]` : attempt.host,
    attempt.port,
  );
  const key = `${connectorId}/${host}`;
  const get = () => {
    const current = ops.deps.connectors.get(connectorId);
    if (!current?.enabled || ops.targets.get(connectorId)?.generation !== generation)
      return undefined;
    if (!ops.deps.plugins.get(current.pluginInstallationId)?.enabled) return undefined;
    return current;
  };
  const evaluate = (rateLimited = false) => {
    const current = get();
    const sites = current && connectorWebsites({ ...ops.deps, registry: ops.registry }, current);
    return connectorNetworkPolicy({
      host,
      refusal: attempt.refusal,
      allowed: sites?.domains.includes(host) === true,
      denied: ops.deniedNetworkSites.has(key),
      attended: approval?.available() === true,
      full: !!sites && sites.domains.length >= 64,
      rateLimited,
      valid: sites?.mode === "sandbox",
    });
  };
  const audit = (outcome: "ask" | "allow" | "deny", reason: string) => {
    ops.deps.audit.append({
      botId: ops.deps.actorBotId,
      kind: "connector.changed",
      summary: connectorAuditEvents.network,
      detail: {
        connectorId,
        domain: host,
        ...(outcome === "ask" ? {} : { decision: outcome }),
        reasonCode: `connector_network_${reason}`,
      },
    });
  };
  const reject = (reason: string) => {
    const parsed = ConnectorNetworkRefusalSchema.safeParse(reason);
    if (parsed.success) {
      const site: ConnectorBlockedSite = { host, reason: parsed.data };
      if (call && (!call.blocked || call.blocked.reason === "rate_limit")) call.blocked = site;
      // Transient throttling must not crowd actionable denials out of Settings.
      if (
        reason !== "rate_limit" &&
        get() &&
        ops.deps.connectors.recordBlockedSite(connectorId, site)
      )
        ops.emitConnectorChanged(connectorId);
    }
    audit("deny", reason);
    return false;
  };

  const now = performance.now();
  const prompts = ops.networkPrompts.get(connectorId) ?? { live: false, started: [] };
  prompts.started = prompts.started.filter((started) => now - started < PROMPT_WINDOW_MS);
  const result = evaluate(
    prompts.live ||
      (call?.asks ?? 0) >= PROMPTS_PER_CALL ||
      prompts.started.length >= PROMPTS_PER_WINDOW,
  );
  if (result.decision === "allow") return true;
  if (result.decision === "deny" || !call || !approval)
    return reject(
      result.reason === "denied" ? (ops.deniedNetworkSites.get(key) ?? "denied") : result.reason,
    );
  if (signal.aborted) return reject("timeout");
  const row = get();
  const name = row && ops.deps.plugins.manifest(row.pluginInstallationId)?.name;
  const text = (dictionary: typeof connectorSandboxEn, locale: "zh" | "en") => ({
    title: dictionary["connectors.network.requestTitle"].replace(
      "{name}",
      () => name?.[locale] || row?.name || dictionary["connectors.network.connection"],
    ),
    lead: dictionary["connectors.network.requestNote"],
  });
  // Reserve before awaiting so concurrent hosts, including across connector generations, share the cap.
  call.asks++;
  call.waitingHost = host;
  prompts.live = true;
  prompts.started.push(now);
  ops.networkPrompts.set(connectorId, prompts);
  let answer: Awaited<ReturnType<ConnectorNetworkApproval["request"]>>;
  try {
    audit("ask", "ask");
    answer = await approval.request({
      host,
      signal,
      text: { zh: text(connectorSandboxZh, "zh"), en: text(connectorSandboxEn, "en") },
      save: () => {
        signal.throwIfAborted();
        const current = get();
        const latest = evaluate();
        if (!current || latest.decision === "deny")
          throw new RpcError(RpcErrorCodes.invalidParams, "connector_network_site_changed");
        if (latest.reason === CONNECTOR_NETWORK_CONFIRMATION)
          allowConnectorWebsite(ops, current, host);
      },
    });
  } catch {
    // A failed approval or persistence operation must refuse egress; records contain codes only.
    answer = "timeout";
  } finally {
    call.waitingHost = undefined;
    prompts.live = false;
  }
  if (signal.aborted && answer !== "denied" && answer !== "unattended") answer = "timeout";
  if ((answer === "denied" || answer === "timeout") && get())
    ops.deniedNetworkSites.set(key, answer);
  if (answer !== "allowed") return reject(answer);
  ops.emitConnectorChanged(connectorId);
  audit("allow", "allowed");
  return true;
}

export function resolveBlockedWebsite(
  ops: ConnectorServiceOperations,
  input: { id: string; host: string; action: "allow" | "reset" },
) {
  const { id, host, action } = input;
  const connector = ops.deps.connectors.get(id);
  const deps = { ...ops.deps, registry: ops.registry };
  const websites = connector && connectorWebsites(deps, connector);
  if (
    action === "allow" &&
    connector &&
    websites?.mode === "remote" &&
    !websites.remote.allowed &&
    websites.remote.site === host &&
    ConnectorNetworkSiteSchema.safeParse(host).success
  ) {
    ops.deps.connectors.allowNetworkSite(id, host, ops.deps.actorBotId, [], "remote");
    ops.emitConnectorChanged(id);
    return { ok: true as const };
  }
  const blocked = ops.deps.connectors.blockedSites(id).find((site) => site.host === host);
  if (!connector || !blocked || websites?.mode !== "sandbox")
    throw new RpcError(RpcErrorCodes.invalidParams, "connector_network_site_changed");
  if (action === "allow") {
    const safe = ConnectorNetworkSiteSchema.safeParse(host);
    if (
      !safe.success ||
      connectorNetworkRefusal(host.split(":")[0] ?? "") ||
      !["denied", "unattended", "timeout"].includes(blocked.reason) ||
      connectorNetworkPolicy({
        host,
        allowed: websites.domains.includes(host),
        denied: false,
        attended: true,
        full: websites.domains.length >= 64,
        valid: true,
      }).decision === "deny"
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "connector_network_site_denied");
    allowConnectorWebsite(ops, connector, host);
  }
  ops.deniedNetworkSites.delete(`${id}/${host}`);
  ops.deps.connectors.clearBlockedSite(id, host, ops.deps.actorBotId, action);
  ops.emitConnectorChanged(id);
  return { ok: true as const };
}
