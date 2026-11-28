import type {
  CapabilityId,
  ConnectionAvailability,
  ConnectionTarget,
  Connector,
  ConnectorAccess,
  ConnectorCommand,
  ConnectorNetworkApproval,
  ConnectorTool,
  PluginInstallation,
} from "@pibot/protocol-base";
import type {
  ConnectorCallInput,
  ConnectorDiscoverInput,
  PreparedConnector,
} from "./connector-tools.ts";

/**
 * What the run engine asks the connectors capability. The kernel's tool runner, approvals,
 * send drafts and unattended runs all reason about connected apps, so the kernel owns this shape
 * and the capability provides it at register time; absent means connected apps are unavailable.
 * Connector entities stay in protocol-base for the same reason.
 */
export interface ConnectorsPort {
  /** Include unavailable names so a longer, inaccessible command cannot select a shorter one. */
  commandCandidates?(target: ConnectionTarget): {
    command: Omit<ConnectorCommand, "token">;
    available: boolean;
  }[];
  availability?(
    target: ConnectionTarget,
    connection: string,
    tool?: string,
  ): ConnectionAvailability;
  unavailable?(target: ConnectionTarget): ConnectionAvailability[];
  get(id: string): Connector | undefined;
  /** Throws when the connector does not exist. */
  access(id: string): ConnectorAccess;
  tool(connectorId: string, catalogVersion: number, toolName: string): ConnectorTool | undefined;
  plugin(installationId: string): PluginInstallation | undefined;
  /** Read-only classification of a built-in app's tool (never a remote annotation). */
  getConnector(input: { id: string }): { connector: Connector; access: ConnectorAccess };
  discoverToolsForBot(
    botId: string,
    input: ConnectorDiscoverInput,
    readOnly?: boolean,
    groupId?: string,
  ): { items: ConnectorTool[]; nextCursor: string | null };
  /** Trusted suggestions derived from the connector's current atomic catalog. */
  capabilitySuggestions(connectorId: string): readonly CapabilityId[];
  /** Enabled connections mapping this capability (any Bot): native apps first, then oldest. */
  capabilityConnectors(capabilityId: CapabilityId): readonly string[];
  /** Enabled mapped tools visible to this Bot, from the current atomic catalog only. */
  capabilityTools(
    botId: string,
    connectorId: string,
    capabilityId: CapabilityId,
    groupId?: string,
  ): readonly ConnectorTool[];
  /** Trusted target resolution; runs before policy and again at dispatch. */
  resolveTool(botId: string, input: ConnectorCallInput, groupId?: string): PreparedConnector;
  dispatch(
    botId: string,
    input: ConnectorCallInput,
    approved: PreparedConnector,
    signal: AbortSignal,
    authorize: () => void,
    networkApproval?: ConnectorNetworkApproval,
  ): Promise<unknown>;
  /** Dispatch a trusted, read-only capability adapter operation rather than a raw connector call. */
  dispatchCapability(
    botId: string,
    input: ConnectorCallInput,
    approved: PreparedConnector,
    signal: AbortSignal,
    authorize: () => void,
    networkApproval?: ConnectorNetworkApproval,
  ): Promise<unknown>;
  dispatchDraft(
    approvalId: string,
    botId: string,
    input: ConnectorCallInput,
    approved: PreparedConnector,
    signal: AbortSignal,
    authorize: () => void,
    networkApproval?: ConnectorNetworkApproval,
  ): Promise<unknown>;
}
