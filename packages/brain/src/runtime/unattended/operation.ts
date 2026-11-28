import { createHash } from "node:crypto";
import type { LocalToolCall } from "@pibot/agent";
import { mustAskNow, preauthorizableOperation } from "@pibot/policy";
import type { PreparedTool } from "../../core/local-types.ts";
import { toolPermissionCategory } from "../../core/tool-category.ts";
import type { LocalService } from "../../local-service.ts";

export function operationCategory(local: LocalService, call: LocalToolCall) {
  return toolPermissionCategory(call.tool, local.deps.capabilityTools) ?? call.tool;
}

/** "Ask every time" is answered by the person, never by a stored routine consent. */
export function connectionAsksNow(prepared: Pick<PreparedTool, "result" | "connectorPolicy">) {
  return mustAskNow(prepared.connectorPolicy) || mustAskNow(prepared.result);
}

/**
 * The operation a pre-authorization could cover for this prepared tool, or undefined when it can
 * never be pre-authorized (deny, danger, no scope, …). Pure policy: no unattended-run state.
 */
export function preauthOperation(local: LocalService, prepared: PreparedTool, isolated: boolean) {
  const { result } = prepared;
  if (connectionAsksNow(prepared)) return undefined;
  const platform = prepared.boundary?.location?.platform ?? local.deps.platform;
  return preauthorizableOperation(
    operationCategory(local, prepared.call),
    // A routine's consent stays per site; "read public pages" is a chat-card grant only.
    result.grantScope?.kind === "web_read"
      ? {
          ...result,
          ...(result.domain
            ? { grantScope: { kind: "domain" as const, domain: result.domain } }
            : { grantScope: undefined, canRemember: false }),
        }
      : result,
    prepared.boundary,
    platform,
    isolated,
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
// Persist only a versioned digest, not content. A reentry's new tool_call ID is not consent identity.
export function routineOperationHash(prepared: PreparedTool) {
  const { result } = prepared;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "routine-approval-facts-v2",
        prepared.call.tool,
        canonical(prepared.call.input),
        prepared.cwd,
        canonical({
          path: result.path,
          analysis: result.analysis,
          command: result.command,
          url: result.url,
          domain: result.domain,
          risk: result.risk,
          facts: result.facts,
          scope: result.grantScope,
          searchRecipient: prepared.searchRecipient,
          sendPaths: prepared.sendPaths,
          messageScope: prepared.messageScope,
          connector: prepared.connector,
          capabilityPolicyBinding: prepared.capabilityPolicyBinding,
          // A parked human answer binds the exact memory text, even for category-only edits.
          // The reason can change when a resumed run reloads its context; consent cannot.
          memory: prepared.memorySafety && {
            digest: prepared.memorySafety.digest,
            scope: prepared.memorySafety.scope,
          },
          roots: prepared.roots,
          // Absent (and so not hashed) unless the call opens folders outside the workplace.
          outsideWriteRoots: result.outsideWriteRoots,
        }),
      ]),
    )
    .digest("hex");
}
