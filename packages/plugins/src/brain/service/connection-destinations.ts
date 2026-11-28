import type { ConnectionDestination } from "@pibot/plugins-contract/full";
import { ConnectionDestinationSchema } from "@pibot/plugins-contract/full";
import type { ConnectionActivityRepo, ConnectorsRepo, PluginsRepo } from "../../store/index.ts";
import type { PluginRegistry } from "../apps/registry.ts";
import { connectorWebsites } from "./connector-network.ts";

type Category = ConnectionDestination["categories"][number];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const latest = (...values: (string | null)[]) =>
  values.reduce<string | null>(
    (max, value) => (value && (!max || value > max) ? value : max),
    null,
  );

/**
 * "Where the data goes" of one connection: the hosts its saved configuration may reach
 * (the MCP URL, the declared network domains the sandbox allows, a built-in app's trusted REST
 * host) or this computer when there is none, with the categories of data that leave and the last
 * recorded use. A configuration inventory plus recorded times, not a capture of network traffic:
 * the same projection as the remote settings' outbound list.
 */
export function connectionDestinations(
  deps: {
    connectors: ConnectorsRepo;
    plugins: PluginsRepo;
    registry: PluginRegistry;
    activity: ConnectionActivityRepo;
    platform?: NodeJS.Platform;
  },
  id: string,
): { items: ConnectionDestination[] } {
  const server = deps.connectors.configuration(id);
  const connector = deps.connectors.get(id);
  if (!connector) return { items: [] };
  const tools = deps.connectors.toolPolicyStates(id);
  const last = deps.activity.lastUse(id);
  // A read-only connection can still show writes it sent before the mode changed.
  const writes =
    !!last.sent ||
    (connector.confirmationMode !== "read_only" &&
      [...tools.values()].some((tool) => tool.enabled && !tool.readOnly));
  const credential = server.auth.kind === "bearer" || server.auth.kind === "oauth";
  const categories = (remote: boolean): Category[] => [
    "requests",
    ...(writes ? (["written_content"] as const) : []),
    ...(remote && credential ? (["credential"] as const) : []),
  ];
  const lastAt = latest(last.call, last.sent);
  const websites = connectorWebsites(deps, connector);
  if (websites.mode === "unisolated") return { items: [] };
  if (websites.mode === "remote" && !websites.remote.allowed) return { items: [] };
  const hosts = new Set<string>();
  let local = false;
  if (server.transport === "http") {
    const host = new URL(server.url).hostname.toLowerCase();
    if (LOOPBACK.has(host)) local = true;
    else hosts.add(host);
  }
  if (websites.mode === "sandbox")
    for (const site of [...websites.declared, ...websites.domains]) hosts.add(site);
  // A local process with no declared domain is kept off the network by the command sandbox.
  if (server.transport !== "http" && hosts.size === 0) local = true;
  const items: ConnectionDestination[] = [
    ...(local
      ? [{ destination: { kind: "this_computer" as const }, categories: categories(false), lastAt }]
      : []),
    ...[...hosts].map((domain) => ({
      destination: { kind: "domain" as const, domain },
      categories: categories(true),
      lastAt,
    })),
  ];
  return { items: items.map((item) => ConnectionDestinationSchema.parse(item)) };
}
