import {
  type LocalToolActivity,
  type LocalToolCall,
  type LocalToolResult,
  toolErrorLog,
} from "@pibot/agent";
import type { ToolStatus } from "@pibot/protocol-base";
import { transaction } from "@pibot/storage";
import { auditToolFields } from "../../../core/audit-fields.ts";
import { codeAnalysisOf } from "../../review/code-analysis.ts";
import { observeDelivery } from "../../review/delivery-observer.ts";
import { observeWorkQuality } from "../../review/work-quality-run.ts";
import type { LocalRunOperations } from "../local-run.ts";
import { logToolResult } from "../tool-diagnostics.ts";
import {
  questionPendingFailure,
  toolInputFailure,
  toolNotLoadedFailure,
  toolSummary,
} from "../tools.ts";
import { PRECONDITION_CODES, type State } from "./local-run-shared.ts";

export function emitStep(
  this: LocalRunOperations,
  state: State,
  phase: LocalToolActivity["phase"],
  extra: {
    output?: string;
    status?: ToolStatus;
    exitCode?: number;
    durationMs?: number;
    waitingFor?: string;
    /** A card-less refusal's own code, so the live row names its reason too. */
    denialReason?: string;
  } = {},
): void {
  if (phase === "end" && state.directRunSaveRequested) {
    this.local.approvals.audit.append({
      botId: this.context.botId,
      runId: this.context.runId,
      kind: "permissions.changed",
      summary: "Direct-run permission was not saved / 未保存直接运行授权",
      detail: {
        actor: "system",
        reasonCode: "sandbox_outside_remember_not_saved",
        approvalId: state.directRunSaveRequested,
        toolCallId: state.call.id,
      },
    });
    state.directRunSaveRequested = undefined;
  }
  if (phase === "end" && extra.status) logToolResult(this, state, extra.status);
  // Only a failure reads its exit code; a "done" step may legitimately exit 1 (a search
  // with no matches). Counting that as a failed step would punish the exact behaviour we want.
  if (phase === "end" && extra.status && this.context.quality)
    observeWorkQuality(
      this.context.quality,
      state.call,
      extra.status,
      extra.status === "error" ? extra.exitCode : undefined,
    );
  if (this.context.executionTaskId) return;
  if (phase === "start" && extra.status === "running")
    this.context.runActivity?.(state.messageId, {
      phase: "executing_tool",
      tool: state.call.tool,
    });
  else if (phase === "end") {
    const active = [...this.states.values()].findLast((item) => item.started && !item.finished);
    this.context.runActivity?.(
      active?.messageId ?? state.messageId,
      active ? { phase: "executing_tool", tool: active.call.tool } : { phase: "waiting_model" },
    );
  }
  this.local.deps.peer.emit("chat.tool", {
    botId: this.context.botId,
    ...(this.context.conversationId ? { conversationId: this.context.conversationId } : {}),
    ...(this.context.groupId ? { groupId: this.context.groupId } : {}),
    ...(this.context.threadId ? { threadId: this.context.threadId } : {}),
    runId: this.context.runId,
    messageId: state.messageId,
    toolCallId: state.call.id,
    tool: state.call.tool,
    phase,
    summary:
      state.result?.summary ??
      toolSummary(state.call, this.local.deps.redactor, this.local.deps.capabilityTools),
    ...(codeAnalysisOf(state.result) ? { codeAnalysis: codeAnalysisOf(state.result) } : {}),
    ...(state.settingsAction ? { settingsAction: state.settingsAction } : {}),
    ...(state.inputTranslation ? { inputTranslation: state.inputTranslation } : {}),
    ...(state.yolo ? { yolo: { risk: state.yolo } } : {}),
    ...extra,
  });
}

export function failInputStep(
  this: LocalRunOperations,
  state: State,
  failure: NonNullable<State["inputFailure"]>,
): void {
  if (state.finished) return;
  const stopped = this.context.signal.aborted;
  const status = stopped ? "aborted" : "error";
  const reason = stopped ? "已停止 / Stopped" : failure.text;
  state.failureReason = reason;
  transaction(this.local.deps.db, () => {
    this.local.approvals.audit.append({
      botId: this.context.botId,
      runId: this.context.runId,
      kind: "policy.denied",
      summary: "Tool input rejected / 工具输入已拒绝",
      detail: {
        ...auditToolFields(
          { tool: state.call.tool, input: {} },
          this.local.deps.redactor,
          undefined,
          this.local.deps.capabilityTools,
        ),
        source: this.context.routineSource ?? this.context.auditSource ?? "chat",
        ...(this.context.routineRunId ? { routineRunId: this.context.routineRunId } : {}),
        toolCallId: state.call.id,
        reasonCode: stopped ? "stopped" : failure.code,
        policySteps: [stopped ? "stopped" : "invalid_tool_input"],
        // A not-yet-loaded tool never reached the permission gate, and the Bot resolves it
        // itself by calling tool_discover next. Keeping the row out of the default list stops it
        // from reading as a refusal the person has to act on.
        ...((failure.code === "tool_not_loaded" || failure.code === "question_pending") && !stopped
          ? { internal: true }
          : {}),
        ...(stopped ? { stopped: true } : {}),
      },
    });
    this.local.tools.update(state.recordId, {
      status,
      finishedAt: new Date().toISOString(),
      performance: state.timing.finish(),
    });
  });
  state.finished = true;
  if (!stopped && failure.code === "question_pending" && this.context.todoRun)
    this.context.todoRun.afterQuestionCalls = (this.context.todoRun.afterQuestionCalls ?? 0) + 1;
  else if (!stopped && this.context.executionClock)
    this.local.budgets.rejectedInput(this.context, state.call, failure.fingerprint ?? failure.code);
  this.emit(state, "end", { status, output: reason });
}

export function blockedStep(
  this: LocalRunOperations,
  call: LocalToolCall,
  reason: string,
  failed = false,
): void {
  if (this.context.isParking?.()) return;
  if (this.closed) return;
  const state = this.state(call);
  if (state.finished) return;
  // Not a permission decision: the step cannot run yet (no page open, no saved account). Shown
  // as failed with its reason, so "已拒绝" never appears in a YOLO conversation for these.
  const precondition = PRECONDITION_CODES.has(state.auditFacts?.reasonCode ?? "");
  const status = this.context.signal.aborted
    ? "aborted"
    : precondition || failed
      ? "error"
      : "blocked";
  // The refusal itself recorded the code; the record keeps it so a card-less refusal can
  // name its reason after a reload instead of only "Denied".
  const reasonCode = state.auditFacts?.reasonCode;
  state.failureReason = reason;
  transaction(this.local.deps.db, () => {
    this.local.approvals.audit.append({
      botId: this.context.botId,
      runId: this.context.runId,
      kind: "policy.denied",
      summary: "Tool blocked / 工具已拦截",
      detail: {
        ...(state.auditFacts ??
          auditToolFields(
            call,
            this.local.deps.redactor,
            undefined,
            this.local.deps.capabilityTools,
          )),
        source: this.context.routineSource ?? this.context.auditSource ?? "chat",
        ...(this.context.routineRunId ? { routineRunId: this.context.routineRunId } : {}),
        ...(state.preauthId ? { preauthId: state.preauthId } : {}),
        toolCallId: call.id,
        reason,
        ...(reasonCode ? { reasonCode } : {}),
        policySteps: state.auditFacts?.policySteps ??
          state.prepared?.result.explanation.map((step) => step.code) ?? [
            "tool_authorization_refused",
          ],
      },
    });
    this.local.tools.update(state.recordId, {
      status,
      finishedAt: new Date().toISOString(),
      performance: state.timing.finish(),
      ...(status === "blocked" && reasonCode ? { denialReason: reasonCode } : {}),
      ...(state.settingsAction ? { settingsAction: state.settingsAction } : {}),
    });
  });
  state.finished = true;
  this.emit(state, "end", {
    status,
    output: this.local.deps.redactor.redact(reason),
    ...(status === "blocked" && reasonCode ? { denialReason: reasonCode } : {}),
  });
}

/** The gate never ran: name the inactive load group instead of reporting a refusal. */
function notLoadedFailure(run: LocalRunOperations, name: string) {
  const tool = run.ports.definitions.find((entry) => entry.name === name);
  if (!tool?.loadGroup || run.owner.toolGroups().active.includes(tool.loadGroup.id)) return;
  return toolNotLoadedFailure(name, tool.loadGroup.id);
}

export function activityStep(this: LocalRunOperations, event: LocalToolActivity): void {
  if (this.context.isParking?.()) return;
  if (this.closed) return;
  if (typeof event.id !== "string" || !event.id.trim() || typeof event.tool !== "string") return;
  const state =
    this.states.get(event.id) ?? this.state({ id: event.id, tool: event.tool, input: {} });
  if (state.finished) return;
  if (event.phase === "start") {
    state.startSeen = true;
    if (Object.hasOwn(event, "input"))
      state.inputFailure = this.ports.definitions.some((tool) => tool.name === event.tool)
        ? toolInputFailure(
            event.tool,
            event.input,
            this.local.deps.capabilityTools,
            undefined,
            this.context.modelMaxTokens,
          )
        : this.context.todoRun?.paused?.question &&
            this.local.toolDefinitions.some((tool) => tool.name === event.tool)
          ? questionPendingFailure()
          : toolInputFailure("unknown_tool", undefined, this.local.deps.capabilityTools);
    if (state.prepared) this.start(state);
  } else if (event.phase === "output") {
    this.emit(state, "output", { output: this.local.deps.redactor.redact(event.output ?? "") });
  } else {
    if (event.failure === "not_authorized" && !state.result) {
      state.auditFacts = {
        ...state.auditFacts,
        reasonCode: state.auditFacts?.reasonCode ?? "tool_authorization_refused",
      };
      this.blocked(state.call, "工具未获授权 / Tool was not authorized");
      return;
    }
    if (!state.prepared) {
      const failure = state.inputFailure ?? notLoadedFailure(this, state.call.tool);
      if (failure) {
        this.failInput(state, failure);
        return;
      }
      state.auditFacts = {
        ...state.auditFacts,
        reasonCode: state.auditFacts?.reasonCode ?? "tool_authorization_refused",
      };
      this.blocked(state.call, "工具未获授权 / Tool was not authorized");
      return;
    }
    const details = state.result?.details;
    if (details?.settingsAction) state.settingsAction = details.settingsAction;
    const status = this.context.signal.aborted
      ? "aborted"
      : details?.userRejected
        ? "blocked"
        : event.isError || state.result?.isError
          ? "error"
          : "done";
    // A dispatch check can fail after a card was approved. Keep the execution outcome (error)
    // and record the check independently; the operation might have partially run.
    const executionCheck = status === "error" ? details?.executionCheck : undefined;
    const measured = state.timing.finish();
    this.local.tools.update(state.recordId, {
      performance: measured,
      ...(state.result?.summary ? { summary: state.result.summary } : {}),
      ...(codeAnalysisOf(state.result) ? { codeAnalysis: codeAnalysisOf(state.result) } : {}),
      ...(state.settingsAction ? { settingsAction: state.settingsAction } : {}),
      status,
      finishedAt: new Date().toISOString(),
      exitCode: details?.exitCode ?? null,
      durationMs: measured.durationMs,
      ...(details?.logPath ? { logPath: details.logPath } : {}),
      ...(executionCheck ? { denialReason: executionCheck } : {}),
    });
    observeDelivery(this.local, this.context, () =>
      this.local.evidence.observeTool(this.context, state.recordId),
    );
    state.finished = true;
    this.emit(state, "end", {
      status,
      ...(details?.exitCode != null ? { exitCode: details.exitCode } : {}),
      durationMs: measured.durationMs,
      ...(executionCheck ? { denialReason: executionCheck } : {}),
    });
  }
}

/**
 * A step Pi Bot itself starts in this run (the automatic check). It takes exactly the
 * path of a model's tool call — the same gate, card, YOLO, write lock, execution, audit and
 * step record — so there is no second way to run a command.
 */
export async function runSyntheticStep(
  this: LocalRunOperations,
  call: LocalToolCall,
  signal: AbortSignal,
): Promise<{ allowed: true; result: LocalToolResult } | { allowed: false; reason: string }> {
  const combined = AbortSignal.any([signal, this.context.signal]);
  this.activity({ id: call.id, tool: call.tool, phase: "start", input: call.input });
  // Synthetic hooks run inside their parent's slot; waiting on that barrier would deadlock.
  const state = this.states.get(call.id);
  if (state) state.synthetic = true;
  let decision: { allow: boolean; reason?: string };
  try {
    decision = await this.ports.authorize(call, combined);
  } catch (error) {
    // Same fallback text and the same single redacted log line as the SDK gate.
    if (!combined.aborted)
      this.ports.logError?.(toolErrorLog("tool_authorization_failed", call, error));
    decision = {
      allow: false,
      reason: combined.aborted ? "已停止 / Stopped" : "无法完成工具审批 / Tool approval failed",
    };
  }
  if (!decision.allow || combined.aborted) {
    const reason = combined.aborted
      ? "已停止 / Stopped"
      : (decision.reason ?? "工具未获授权 / Tool was not authorized");
    // A synthetic step has no card and never passes `authorizeStep`'s refuse(), so it records the
    // code here; without it the audit could only guess from the display text.
    const target = this.state(call);
    target.auditFacts = {
      ...target.auditFacts,
      reasonCode:
        target.auditFacts?.reasonCode ??
        (combined.aborted ? "stopped" : "tool_authorization_refused"),
    };
    this.blocked(call, reason);
    return { allowed: false, reason };
  }
  const started = performance.now();
  const result = await this.ports.execute(call, combined, (text) =>
    this.activity({ id: call.id, tool: call.tool, phase: "output", output: text }),
  );
  this.activity({
    id: call.id,
    tool: call.tool,
    phase: "end",
    isError: result.isError === true,
    durationMs: Math.round(performance.now() - started),
  });
  return { allowed: true, result };
}
