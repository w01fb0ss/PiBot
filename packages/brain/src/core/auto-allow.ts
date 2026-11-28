import { randomUUID } from "node:crypto";
import type { LocalToolCall } from "@pibot/agent";
import {
  EDITOR_SESSION_REASON,
  EDITOR_TERMINAL_READONLY_REASON,
  type PolicyResult,
  SETTINGS_SECURITY_CONFIRM,
  WINDOWS_READ_ONLY,
} from "@pibot/policy";
import type { Grant } from "@pibot/protocol-base";
import { BotsRepo } from "@pibot/storage";
import type { LocalService } from "../local-service.ts";
import { auditText, auditToolFields } from "./audit-fields.ts";
import type { ToolRunContext } from "./local-types.ts";
import { toolPermissionCategory } from "./tool-category.ts";

/**
 * Policy reasons that allow a step which used to show a card. Each is audited as an
 * automatic approval (rule 6), with the reason code saying why no one was asked; this includes
 * ACP editor-terminal commands and commands confined to the execution sandbox. The paid image
 * reasons (owner decision 2026-10-23) are a remembered paid_image grant and a routine's paid
 * pre-approval; the second is decided by the image gate, not by policy.
 */
const AUTO_ALLOW_REASONS = new Set([
  "readonly_command",
  WINDOWS_READ_ONLY,
  "sandboxed_command",
  EDITOR_TERMINAL_READONLY_REASON,
  EDITOR_SESSION_REASON,
  "public_web_read",
  "conversation_web_read",
  "run_grant_matched",
  "paid_grant_matched",
  "routine_paid_preapproved",
  "project_notes_reviewed",
]);

export function isAutoAllowed(result: PolicyResult): boolean {
  if (
    result.reason === SETTINGS_SECURITY_CONFIRM ||
    result.explanation?.some((step) => step.code === SETTINGS_SECURITY_CONFIRM)
  )
    return false;
  return result.decision === "allow" && AUTO_ALLOW_REASONS.has(result.reason);
}

/** Same record as a YOLO-resolved card (`auditYolo`), with the policy reason as `reasonCode`. */
export function auditAutoAllow(
  local: LocalService,
  context: ToolRunContext,
  call: Pick<LocalToolCall, "id" | "tool" | "input">,
  result: PolicyResult,
) {
  const { redactor } = local.deps;
  const reviewedImport = result.reason === "project_notes_reviewed";
  local.approvals.audit.append({
    botId: context.botId,
    runId: context.runId,
    kind: "approval.resolved",
    summary: reviewedImport
      ? "Allowed in import preview / 已在导入预览中允许"
      : "Allowed automatically / 自动允许",
    detail: {
      ...auditToolFields(call, redactor, result, local.deps.capabilityTools),
      botName: auditText(new BotsRepo(local.deps.db).get(context.botId)?.name ?? "Bot", redactor),
      source: context.routineSource ?? context.auditSource ?? "chat",
      ...(context.routineRunId ? { routineRunId: context.routineRunId } : {}),
      toolCallId: call.id,
      decision: "allow",
      remember: false,
      actor: reviewedImport ? "user" : "automatic",
      reasonCode: result.reason,
      risk: result.risk,
      ...(context.groupId ? { groupId: context.groupId } : {}),
    },
  });
}

/**
 * The user allowed a read or listing outside the workplace on a card. The same folder
 * (and its subfolders) is then allowed for the rest of this run, so one material folder costs
 * one card, not one per file. Reading covers listing; listing never covers reading.
 */
export function allowFolderForRun(
  local: LocalService,
  context: ToolRunContext,
  tool: string,
  result: PolicyResult,
) {
  const scope = result.grantScope;
  const category = result.category ?? toolPermissionCategory(tool, local.deps.capabilityTools);
  // Only outside the workplace: inside it, "ask" is the user's own level and stays per call.
  if (!result.canRemember || scope?.kind !== "folder" || result.path?.root) return;
  if (category !== "read_file" && category !== "list_dir") return;
  const createdAt = new Date().toISOString();
  const grants: Grant[] = (category === "read_file" ? ["read_file", "list_dir"] : ["list_dir"]).map(
    (item) => ({
      id: randomUUID(),
      botId: context.botId,
      category: item as Grant["category"],
      scope,
      createdAt,
      revokedAt: null,
    }),
  );
  context.runGrants = [...(context.runGrants ?? []), ...grants];
}
