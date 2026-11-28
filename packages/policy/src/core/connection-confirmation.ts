import {
  type Connector,
  type ConnectorAccess,
  type ConnectorConfirmationMode,
  type ConnectorTool,
  connectionConfirmation,
} from "@pibot/protocol-base";
import {
  DISPATCH_FOLDER_CONFIRM,
  DISPATCH_MODEL_CONFIRM,
  PRIVATE_NETWORK_REASON,
  SETTINGS_SECURITY_CONFIRM,
  WINDOWS_FILE_READ_CONFIRMATION,
  WINDOWS_ORDINARY_COMMAND,
  WINDOWS_REQUIRES_APPROVAL,
} from "./confirmation-reasons.ts";
import { CONNECTOR_NETWORK_CONFIRMATION } from "./connector-network.ts";
import { GIT_CONFIGURATION_CONFIRMATION_REASON } from "./git-configuration-policy.ts";
import { GIT_ENTRY_CONFIRMATION_REASON } from "./git-entry-policy.ts";
import { GIT_HOOK_CONFIRMATION_REASON } from "./git-hook-policy.ts";
import { GIT_HOOKS_PATH_CONFIRMATION_REASON } from "./git-hooks-path-policy.ts";
import { LISTED_OUTSIDE_SANDBOX_REASON, OUTSIDE_SANDBOX_REASON } from "./outside-sandbox.ts";
import { OUTSIDE_WRITE_REASON } from "./outside-write.ts";
import type { PolicyRequest, PolicyResult } from "./types.ts";

// The mode → decision mapping lives in the contract so the renderer can show the same answer;
// policy owns the request built from it and the reason codes it produces.
export { connectionConfirmation, connectionWriteRememberable } from "@pibot/protocol-base";

/** Fixed reason of a call the person must answer now; nothing remembered or automatic answers it. */
export const CONNECTION_CONFIRMATION_REASON = "connector_confirmation_required";
/** Fixed reason of a write tool on a connection set to read only. */
export const CONNECTION_READ_ONLY_REASON = "connector_read_only_mode";
/** Showing a file manager is a visible side effect; ambiguous intent needs a present person. */
export const REVEAL_CONFIRMATION_REASON = "reveal_confirmation_required";

/** Whether a call without a person present (routine, trigger) may proceed on this connection. */
export function connectionUnattendedAllowed(
  mode: ConnectorConfirmationMode,
  write: boolean,
): boolean {
  return connectionConfirmation(mode, write) === "normal";
}

/**
 * A policy result the person must answer; YOLO and automatic release leave it pending, and no
 * routine consent answers it. This includes dangerous calls, Windows isolation confirmation,
 * connections set to "ask every time" and writes outside every workplace.
 */
export function mustAskNow(
  result:
    | (Pick<PolicyResult, "decision" | "reason"> & Partial<Pick<PolicyResult, "risk">>)
    | undefined,
) {
  return (
    result?.decision === "ask" &&
    (result.risk === "danger" ||
      result.reason === "browser_sensitive_confirmation" ||
      result.reason === "browser_secret_confirmation" ||
      result.reason === WINDOWS_REQUIRES_APPROVAL ||
      result.reason === WINDOWS_FILE_READ_CONFIRMATION ||
      result.reason === WINDOWS_ORDINARY_COMMAND ||
      result.reason === "windows_unisolated" ||
      result.reason === "command_network_confirmation" ||
      result.reason === CONNECTOR_NETWORK_CONFIRMATION ||
      result.reason === "command_install_confirmation" ||
      result.reason === "command_background_confirmation" ||
      result.reason === CONNECTION_CONFIRMATION_REASON ||
      result.reason === GIT_CONFIGURATION_CONFIRMATION_REASON ||
      result.reason === GIT_HOOKS_PATH_CONFIRMATION_REASON ||
      result.reason === OUTSIDE_SANDBOX_REASON ||
      result.reason === LISTED_OUTSIDE_SANDBOX_REASON ||
      result.reason === "local_service_once" ||
      result.reason === "system_service_once" ||
      result.reason === GIT_HOOK_CONFIRMATION_REASON ||
      result.reason === GIT_ENTRY_CONFIRMATION_REASON ||
      result.reason === REVEAL_CONFIRMATION_REASON ||
      result.reason === "video_generation_confirmation" ||
      result.reason === "project_notes_confirmation" ||
      result.reason === "knowledge_write_confirmation" ||
      result.reason === SETTINGS_SECURITY_CONFIRM ||
      result.reason === DISPATCH_FOLDER_CONFIRM ||
      result.reason === DISPATCH_MODEL_CONFIRM ||
      result.reason === "memory_after_untrusted" ||
      result.reason === "memory_sensitive" ||
      result.reason === OUTSIDE_WRITE_REASON ||
      result.reason === PRIVATE_NETWORK_REASON)
  );
}

/**
 * Command consents a conversation's YOLO switch may answer (owner decision: YOLO turns every
 * non-danger question into allow). Grants and routine pre-approvals still cannot answer them, so
 * without YOLO they keep asking each time. Maintainers 2026-11-08: an unattended dev Bot in YOLO was
 * stopped by these cards for `pnpm check:changed` in the background and `pnpm exec`.
 */
const YOLO_RELEASABLE = new Set([
  "command_install_confirmation",
  "command_background_confirmation",
  "command_network_confirmation",
]);

/** `mustAskNow` as seen by YOLO: the same list minus the command consents above. */
export function yoloMustAsk(
  result:
    | (Pick<PolicyResult, "decision" | "reason"> & Partial<Pick<PolicyResult, "risk">>)
    | undefined,
) {
  return (
    mustAskNow(result) && (result?.risk === "danger" || !YOLO_RELEASABLE.has(result?.reason ?? ""))
  );
}

/**
 * The mode that applies to a connection now. A legacy ask_first access row that the connection-permissions
 * migration has not settled yet is judged as "ask every time", the meaning that migration gives
 * it, so a run racing the migration never opens it silently.
 */
export function effectiveConfirmationMode(target: {
  connector: Pick<Connector, "confirmationMode">;
  access: Pick<ConnectorAccess, "mode">;
}): ConnectorConfirmationMode {
  return target.access.mode === "ask_first" ? "always_ask" : target.connector.confirmationMode;
}

export interface ConnectorCallTarget {
  connector: Pick<Connector, "id" | "confirmationMode">;
  access: Pick<ConnectorAccess, "mode">;
  tool: Pick<ConnectorTool, "tool" | "readOnly">;
}

/** The single builder of a connector call's policy request (raw `connector_call` and app adapters). */
export function connectorCallRequest(target: ConnectorCallTarget): PolicyRequest {
  return {
    category: "connector",
    operation: "call",
    connectorId: target.connector.id,
    tool: target.tool.tool,
    visible: true,
    readOnly: target.tool.readOnly,
    confirmationMode: effectiveConfirmationMode(target),
  };
}
