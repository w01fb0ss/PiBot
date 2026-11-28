import type { KernelMethodParams, KernelMethodResults, KernelMethods } from "@pibot/protocol-base";
export interface RpcRequestContext {
  signal: AbortSignal;
  source?: "acp";
  /** Assigned by the authenticated host port, never by request parameters. */
  desktopMain?: boolean;
  /** The paired phone sent this request; assigned by the remote kernel bridge, never by params. */
  phone?: boolean;
  phoneDeviceId?: string;
}
export type KernelRegisterRpc = <K extends keyof typeof KernelMethods>(
  method: K,
  action: (
    params: KernelMethodParams[K],
    context: RpcRequestContext,
  ) => Promise<KernelMethodResults[K]>,
) => void;

/**
 * Capability-facing registration seam. Runtime schemas come from the product composition root;
 * each capability keeps its concrete handler typing in its own contract package.
 */
export type RegisterRpc = (
  method: string,
  // biome-ignore lint/suspicious/noExplicitAny: product-composed schemas validate this erased seam.
  action: (params: any, context: RpcRequestContext) => Promise<any> | any,
) => void;

/** Internal Settings calls use only the Settings UI handlers in this list. */
export const PI_SETTINGS_METHODS = [
  "settings.get",
  "providers.list",
  "settings.set",
  "bots.update",
  "groups.update",
  "topics.workplace.get",
  "topics.workplace.set",
  "connectors.list",
  "connectors.get",
  "connectors.update",
  "connectors.tools",
  "plugins.settings",
  "plugins.updateSettings",
  "permissions.get",
  "permissions.set",
  "grants.list",
  "grants.revoke",
  "routines.settings.get",
  "routines.settings.set",
  "remote.settings.get",
  "remote.settings.set",
  "browserExtension.status",
  "browserExtension.setPreference",
  "conversations.yolo.get",
  "conversations.yolo.set",
] as const;
export type PiSettingsMethod = (typeof PI_SETTINGS_METHODS)[number];
export type PiSettingsRpc = (
  method: PiSettingsMethod,
  params: unknown,
  signal: AbortSignal,
) => Promise<unknown>;
