import {
  type ConnectorAccess,
  type Level,
  type MethodResults,
  Methods,
  type Permissions,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { RemoteKernelPort } from "./port.ts";
import {
  PHONE_UNLOCK_KEY,
  type PhoneWriteFacts,
  settingsWriteFacts,
} from "./settings-allowlist.ts";

type NetworkSettings = Permissions["network"];
const rank: Record<Level, number> = { never: 0, ask: 1, always: 2 };
function widerNetwork(next: NetworkSettings, current: NetworkSettings) {
  // Image services use exact hosts, and restricted automatic commands use the list even with allowAll.
  return (
    (next.allowAll && !current.allowAll) ||
    next.domains.some((domain) => !current.domains.includes(domain))
  );
}
/** Removing Bots from a selected list, or replacing "all" by a list, never gives anyone more. */
function narrowerAccess(next: ConnectorAccess, current: ConnectorAccess) {
  if (next.mode !== "selected") return false;
  if (current.mode === "all") return true;
  return (
    current.mode === "selected" &&
    next.bots.every((bot) => current.bots.includes(bot)) &&
    next.groups.every((group) => current.groups.includes(group))
  );
}
interface GuardOptions {
  kernel: RemoteKernelPort;
  deviceId: string;
  signal: AbortSignal;
  audit(method: string, outcome: string, facts?: PhoneWriteFacts): void;
}
/**
 * Settings checks that need the computer's current state, run on the phone gateway before the
 * request reaches the kernel. A permission widening needs the phone's local-unlock mark; connector
 * access may only shrink from the phone. Reads go through the same kernel wrapper as the request.
 */
export function phoneSettingsGuard(options: GuardOptions) {
  const read = async <K extends "permissions.get" | "connectors.get">(
    method: K,
    params: unknown,
    signal: AbortSignal,
  ) =>
    Methods[method].result.parse(
      await options.kernel.dispatch(method, params, { deviceId: options.deviceId, signal }),
    ) as MethodResults[K];
  async function permissions(params: Record<string, unknown>, signal: AbortSignal) {
    const unlocked = params[PHONE_UNLOCK_KEY] === true;
    const { [PHONE_UNLOCK_KEY]: _mark, ...request } = params;
    const input = Methods["permissions.set"].params.parse(request);
    const [scoped, global] = await Promise.all([
      read("permissions.get", { botId: input.botId }, signal),
      read("permissions.get", undefined, signal),
    ]);
    signal.throwIfAborted();
    const current = scoped.effective ?? scoped;
    const levels = Object.entries(input.levels ?? {}) as [
      keyof typeof current.levels,
      Level | null,
    ][];
    const wider =
      levels.some(
        ([category, level]) =>
          level !== undefined &&
          rank[level ?? global.levels[category]] > rank[current.levels[category]],
      ) ||
      (input.network === null && widerNetwork(global.network, current.network)) ||
      (!!input.network &&
        widerNetwork(
          {
            allowAll: input.network.allowAll ?? current.network.allowAll,
            domains: input.network.domains ?? current.network.domains,
          },
          current.network,
        ));
    // Distinct from the ordinary request record, so a widening from the phone is easy to find.
    if (wider)
      options.audit(
        "permissions.set",
        unlocked ? "permission_widened" : "unlock_required",
        settingsWriteFacts("permissions.set", request),
      );
    if (wider && !unlocked) throw new RpcError(RpcErrorCodes.unsupported, "remote_unlock_required");
    return request;
  }
  async function connectorAccess(params: Record<string, unknown>, signal: AbortSignal) {
    const input = Methods["connectors.update"].params.parse(params);
    if (!input.access && !input.confirmationMode) return params;
    const { access, connector } = await read("connectors.get", { id: input.id }, signal);
    if (input.confirmationMode && input.confirmationMode !== connector.confirmationMode)
      throw new RpcError(RpcErrorCodes.unsupported, "remote_connector_confirmation_desktop_only");
    signal.throwIfAborted();
    if (input.access && !narrowerAccess(input.access, access))
      throw new RpcError(RpcErrorCodes.unsupported, "remote_connector_access_desktop_only");
    return params;
  }
  return async (
    method: keyof typeof Methods,
    params: unknown,
    requestSignal: AbortSignal,
  ): Promise<unknown> => {
    const signal = AbortSignal.any([options.signal, requestSignal]);
    signal.throwIfAborted();
    if (!params || typeof params !== "object") return params;
    if (method === "permissions.set") return permissions(params as Record<string, unknown>, signal);
    if (method === "connectors.update")
      return connectorAccess(params as Record<string, unknown>, signal);
    return params;
  };
}
