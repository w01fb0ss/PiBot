import type { Params, Payload, Result } from "@pibot/protocol-base";
import { ConnectorActivityMethods } from "./api/activity.ts";
import { DiscoveryMethods } from "./api/discovery.ts";
import { type KnowledgeEvents, KnowledgeMethods } from "./api/knowledge.ts";
import {
  ConnectorAppMethods,
  type ConnectorEvents,
  ConnectorImportMethods,
  ConnectorMethods,
} from "./api/methods.ts";

export * from "./api/activity.ts";
export * from "./api/audit-events.ts";
export * from "./api/discovery.ts";
export * from "./api/knowledge.ts";
export * from "./api/methods.ts";
export * from "./import/credential-detection.ts";
export * from "./import/plugin-config.ts";
export * from "./import/unsupported-components.ts";
export * from "./tools/index.ts";

export const PluginContractMethods = {
  ...ConnectorMethods,
  ...ConnectorAppMethods,
  ...ConnectorImportMethods,
  ...ConnectorActivityMethods,
  ...DiscoveryMethods,
  ...KnowledgeMethods,
} as const;
export type PluginMethodParams = {
  [K in keyof typeof PluginContractMethods]: Params<typeof PluginContractMethods, K>;
};
export type PluginMethodResults = {
  [K in keyof typeof PluginContractMethods]: Result<typeof PluginContractMethods, K>;
};
export type PluginEventPayloads = {
  [K in keyof typeof ConnectorEvents | keyof typeof KnowledgeEvents]: Payload<
    typeof ConnectorEvents & typeof KnowledgeEvents,
    K
  >;
};
