/**
 * Fixed `connector.changed` / `plugin.changed` audit summaries. The records page maps them to
 * localized text, and older rows carry only this English summary, so producer and presenter
 * share these constants instead of free text.
 */
import { legacyInternalConnectorSummaries } from "@pibot/protocol-base";

export const connectorAuditEvents = {
  intent: legacyInternalConnectorSummaries[0],
  catalog: legacyInternalConnectorSummaries[1],
  drained: legacyInternalConnectorSummaries[2],
  recovered: "Recovered failed uninstall status",
  failed: "Connector operation failed",
  access: "Connector access or tools updated",
  network: "Connector allowed websites updated",
  startupTimeout: "Connector startup wait updated",
  confirmationRestored: "Connection confirmation restored to the default",
  windows: "Windows unisolated connector acknowledged",
  /** The person confirmed in the native dialog that this MCP runs as them. */
  outsideSandboxOn: "Local MCP set to run outside the sandbox",
  outsideSandboxOff: "Local MCP returned to the sandbox",
  plugin: "Plugin imported",
  pluginLifecycle: "Plugin enabled or disabled",
  /** Plain settings of an installed package changed (names only in the detail). */
  settings: "Plugin settings changed",
  secretBackfill: "Plugin secret references backfilled during upgrade",
  secretBackfillFailed: "Plugin secret reference backfill requires reconfiguration",
  /** One item brought over from another AI tool (tool, kind, name and outcome only). */
  broughtOver: "Brought over from another AI tool",
} as const;
export type ConnectorAuditEvent = keyof typeof connectorAuditEvents;

/** Two-phase bookkeeping steps of one user action; shown only with "show internal events". */
export const internalConnectorAuditEvents: ReadonlySet<ConnectorAuditEvent> = new Set([
  "intent",
  "catalog",
  "drained",
]);

export function connectorAuditEvent(summary: string): ConnectorAuditEvent | undefined {
  for (const [event, text] of Object.entries(connectorAuditEvents))
    if (text === summary) return event as ConnectorAuditEvent;
  return undefined;
}
