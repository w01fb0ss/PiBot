import { createHash } from "node:crypto";
import type { LocalToolCall } from "@pibot/agent";
import type { PolicyResult } from "@pibot/policy";
import type { Approval } from "@pibot/protocol-base";
import type { ToolRunContext } from "./local-types.ts";

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
function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function approvalCallHash(call: LocalToolCall) {
  return digest([call.tool, call.input]);
}
export function approvalFactsHash(
  context: ToolRunContext,
  call: LocalToolCall,
  result: PolicyResult,
  isolation: Approval["isolation"],
  binding?: string,
) {
  // Explanations/decision can change on reentry; authority, target and disclosed facts cannot.
  const { explanation: _explanation, decision: _decision, ...facts } = result;
  return digest([
    approvalCallHash(call),
    context.botId,
    context.conversationId,
    context.groupId,
    context.executionDevice,
    context.runWorkplace,
    facts,
    isolation,
    ...(binding === undefined ? [] : [binding]),
  ]);
}
