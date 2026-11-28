import type { LocalToolCall } from "@pibot/agent";
import {
  applyWindowsCommandConsent,
  applyYolo,
  explainPolicyResult,
  type PolicyResult,
  WINDOWS_READ_ONLY,
  WINDOWS_REQUIRES_APPROVAL,
} from "@pibot/policy";
import type { ApprovalFact } from "@pibot/protocol-base";
import { SettingsRepo } from "@pibot/storage";
import { auditAutoAllow } from "../../core/auto-allow.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runYolo } from "../../core/yolo.ts";
import type { LocalService } from "../../local-service.ts";
import { prepareTool } from "../tools/local-prepare.ts";

export interface DelegatedDecision {
  allowed: boolean;
  /** Fixed reason code for the audit and the agent's step; never display text. */
  reason: string;
}

function requestedFacts(call: LocalToolCall, result: PolicyResult): ApprovalFact[] {
  const path = typeof call.input.path === "string" ? call.input.path : undefined;
  const command = typeof call.input.command === "string" ? call.input.command : undefined;
  return result.facts.map((fact) => {
    if (fact.kind !== "read" && fact.kind !== "write") return fact;
    if (path && fact.value === result.path?.path) return { ...fact, value: path };
    // realpath resolves /proc/self in the brain, although the agent executes in its own process.
    // Only restore a spelling actually present in this request; never rewrite policy facts.
    const prefix = `/proc/${process.pid}/`;
    const original = fact.value.startsWith(prefix)
      ? `/proc/self/${fact.value.slice(prefix.length)}`
      : undefined;
    return original && command?.includes(original) ? { ...fact, value: original } : fact;
  });
}

/**
 * An external agent runs its own tools, but whenever it asks first
 * (`session/request_permission`) the answer goes through Pi Bot's ordinary gate. The action is
 * judged as the Pi Bot tool it resembles (a command as `run_command`, an edit as `write_file`,
 * …), so the Bot's permission levels, remembered grants, YOLO limits, danger rules, the card and
 * the audit are exactly those of a Pi Bot Bot doing the same thing. Pi Bot only answers: the
 * agent performs the action itself, inside the agent's outer sandbox (none on Windows).
 */
export async function authorizeDelegatedAction(
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
  options: {
    /** Windows: no sandbox around the agent; a command can never be allowed silently. */
    unisolated: boolean;
    signal: AbortSignal;
    title(language: "zh" | "en"): string;
    /** The delegating Bot's run, whose topic shows the card (see `cardScope`). */
    cardContext?: ToolRunContext;
  },
): Promise<DelegatedDecision> {
  const { signal } = options;
  const judge = async (): Promise<PolicyResult> => {
    const prepared = await prepareTool(local, { ...context, signal }, call, signal);
    if (!options.unisolated || call.tool !== "run_command" || prepared.result.decision === "deny")
      return prepared.result;
    if (prepared.result.reason === WINDOWS_READ_ONLY) {
      // The ACP agent owns the shell and its startup state. The native PowerShell proof
      // does not describe that process.
      return explainPolicyResult(
        { ...prepared.result, decision: "ask", reason: WINDOWS_REQUIRES_APPROVAL },
        "boundary",
        WINDOWS_REQUIRES_APPROVAL,
      );
    }
    const consent =
      runYolo(local, context) &&
      new SettingsRepo(local.deps.db).get().yoloUnisolatedCommands === true;
    if (local.deps.platform === "win32")
      return applyWindowsCommandConsent(prepared.result, consent);
    return applyYolo(
      explainPolicyResult(
        { ...prepared.result, decision: "ask", reason: "windows_unisolated", canRemember: false },
        "boundary",
        "windows_unisolated",
      ),
      consent,
      { unisolatedCommands: true },
    );
  };
  const result = await judge();
  if (result.decision === "deny") return { allowed: false, reason: result.reason };
  if (result.decision === "allow") {
    auditAutoAllow(local, context, call, result);
    return { allowed: true, reason: result.reason };
  }
  let answeredByYolo = false;
  const isolation =
    options.unisolated && call.tool === "run_command" && local.deps.platform === "win32"
      ? { available: false, reason: "windows_unisolated" }
      : { available: !options.unisolated };
  const status = await local.approvals.request(
    cardScope(context, options.cardContext, signal),
    call,
    options.cardContext ? { ...result, canRemember: false } : result,
    isolation,
    judge,
    undefined,
    {
      requested() {},
      resolved: (_approval, by) => {
        answeredByYolo = by === "yolo";
      },
    },
    undefined,
    { title: options.title, facts: requestedFacts(call, result) },
  );
  if (
    status === "allowed" &&
    options.unisolated &&
    local.deps.platform === "win32" &&
    answeredByYolo &&
    (await judge()).reason !== "yolo"
  )
    return { allowed: false, reason: "changed" };
  return { allowed: status === "allowed", reason: status === "allowed" ? "approved" : status };
}

/**
 * An agent request Pi Bot cannot map to one of its tools (mode switches, the agent's own MCP
 * tools, unknown kinds) always asks a person: there is no policy to judge it by, so neither a
 * remembered grant nor YOLO answers it.
 */
export async function askForUnmappedAction(
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
  options: {
    signal: AbortSignal;
    title(language: "zh" | "en"): string;
    detail: string;
    cwd?: string;
    unisolatedCommand?: boolean;
    cardContext?: ToolRunContext;
  },
): Promise<DelegatedDecision> {
  const windowsDirectRun = options.unisolatedCommand && local.deps.platform === "win32";
  const reason = windowsDirectRun ? WINDOWS_REQUIRES_APPROVAL : "external_agent_request";
  const result: PolicyResult = explainPolicyResult(
    {
      decision: "ask",
      reason,
      risk: "normal",
      category: "run_command",
      facts: [
        ...(options.detail
          ? [{ kind: "warning" as const, value: options.detail.slice(0, 500) }]
          : []),
        ...(options.cwd ? [{ kind: "cwd" as const, value: options.cwd }] : []),
      ],
      canRemember: false,
      explanation: [],
    },
    "boundary",
    reason,
  );
  const status = await local.approvals.request(
    cardScope(context, options.cardContext, options.signal),
    call,
    result,
    windowsDirectRun ? { available: false, reason: "windows_unisolated" } : { available: true },
    async () => result,
    undefined,
    undefined,
    undefined,
    { title: options.title },
  );
  return { allowed: status === "allowed", reason: status === "allowed" ? "approved" : status };
}

/**
 * An agent working on a hand-off from another Bot asks in the topic it was handed the
 * work from, so the person who is watching that topic answers it. The decision above was made on
 * the agent's own context (its permissions and folders); only the card moves. It never remembers
 * a grant (the delegating Bot's grants are not the agent's) and never pauses the delegating run:
 * an unanswered card simply refuses this one request.
 */
function cardScope(
  context: ToolRunContext,
  card: ToolRunContext | undefined,
  signal: AbortSignal,
): ToolRunContext {
  if (!card) return { ...context, signal };
  const { pauseForApproval: _pause, ...rest } = card;
  return { ...rest, signal: AbortSignal.any([signal, card.signal]) };
}
