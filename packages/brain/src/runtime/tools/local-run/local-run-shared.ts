import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import { type AuditDetail, writeFileTools } from "@pibot/protocol-base";
import type { PreparedTool } from "../../../core/local-types.ts";
import type { ToolTimer } from "../../../core/tool-timing.ts";
import type { questionPendingFailure, toolInputFailure, toolNotLoadedFailure } from "../tools.ts";

export const isCommandCall = (tool: string) => tool === "run_command" || tool === "write_stdin";

/**
 * Tools whose success leaves a deliverable file on disk. The delivery check uses this to tell a
 * reply that
 * is itself the document from one that already saved it. It is derived from each tool's declared
 * attributes: the copied list had missed office_template_fill and office_convert.
 */
export const WRITE_FILE_TOOLS: ReadonlySet<string> = writeFileTools();

/** Refusals that are a missing precondition of the step, not a permission decision. */
export const PRECONDITION_CODES = new Set([
  "browser_no_page",
  "browser_login_no_account",
  // No desktop to show a folder on; a missing capability, not a refusal.
  "reveal_unsupported",
  // F5: the runner's link dropped before or while the step ran; a connection failure.
  "runner_disconnected",
]);

export const PLAN_READ_ONLY =
  "当前话题为只读规划模式，此操作不会执行；切换到执行模式后重试 / This topic is in read-only Plan mode; switch to execution mode before retrying this operation";

/**
 * A bridge call made in a delegated agent turn shows its card in the delegating topic (the
 * Rule), decided with the agent's own context. The card then runs under the delegating
 * Bot's context, so it must never offer "remember": that grant would land on a Bot that did not
 * make the call.
 */
export function approvalContext(
  context: import("../../../core/local-types.ts").ToolRunContext,
  signal: AbortSignal,
) {
  const card = context.approvalCardContext;
  if (!card) return { ...context, signal };
  const { pauseForApproval: _pause, approvalCardContext: _nested, ...rest } = card;
  return { ...rest, signal: AbortSignal.any([signal, card.signal]) };
}

/** The policy result as the card offers it: no "remember" when the card is shown elsewhere. */
export function approvalResult<T extends { canRemember?: boolean }>(
  context: import("../../../core/local-types.ts").ToolRunContext,
  result: T,
): T {
  return context.approvalCardContext ? { ...result, canRemember: false } : result;
}

export interface State {
  inputTranslation?: string;
  settingsAction?: import("@pibot/protocol-base").ToolSettingsAction;
  timing: ToolTimer;
  call: LocalToolCall;
  recordId: string;
  messageId: string;
  prepared?: PreparedTool;
  fingerprint?: string;
  /** The SDK still executes the original call after the user picks a different model. */
  modelCallInput?: string;
  auditFacts?: AuditDetail;
  directRunSaveRequested?: string;
  unisolatedApproved: boolean;
  startSeen: boolean;
  started: boolean;
  finished: boolean;
  result?: LocalToolResult;
  onceDomains: Set<string>;
  onceUrls: Set<string>;
  failureReason?: string;
  isolated?: boolean;
  preauthId?: string;
  preauthWriteRoot?: string;
  /**
   * Roots outside every workplace a person allowed for this call; execution adds them to
   * this call's sandbox / file write roots only. Set only from that person's answer.
   */
  outsideWriteRoots?: string[];
  inputFailure?:
    | ReturnType<typeof toolInputFailure>
    | ReturnType<typeof toolNotLoadedFailure>
    | ReturnType<typeof questionPendingFailure>;
  /** The step (or an operation derived from it) was allowed by YOLO, with this risk. */
  yolo?: "normal" | "danger";
  /** Automatic check started by Pi Bot itself (runSynthetic); not journalled. */
  synthetic?: boolean;
  /** Admission classification only; execution revalidates the policy proof after waiting. */
  batchParallel?: boolean;
  /** fetchPage asks about its initial URL again before the first HTTP request. */
  initialPageYolo?: string;
}

export class ToolAuthorizationError extends Error {}
