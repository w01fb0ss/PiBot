import type { LocalToolCall } from "@pibot/agent";
import { connectorNetworkPolicy } from "@pibot/policy";
import type { ConnectorNetworkApproval } from "@pibot/protocol-base";
import { MessagesRepo, RunsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";

export function connectorNetworkApproval(
  local: LocalService,
  context: ToolRunContext,
  call: Pick<LocalToolCall, "id" | "tool">,
  guard: () => void,
  desktopSend = false,
): ConnectorNetworkApproval | undefined {
  const chat = context.approvalCardContext ?? context;
  if (!chat.conversationId || context.routineRunId || context.routineSource) return undefined;
  function attended() {
    const { db } = local.deps;
    const run = new RunsRepo(db).get(chat.runId);
    if (!run?.userMessageId || run.automatic || run.kind === "wake" || run.kind === "routine")
      return false;
    const usage = new MessagesRepo(db).get(run.userMessageId)?.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
    if (usage.inputOrigin === "phone") {
      // A desktop Send keeps this draft attended even if its originating phone went offline.
      if (desktopSend) return local.deps.interactiveAttached?.() === true;
      return (
        typeof usage.phoneDeviceId === "string" &&
        local.endpoints?.phoneOnline?.(usage.phoneDeviceId) === true
      );
    }
    return usage.inputOrigin === "user" && local.deps.interactiveAttached?.() === true;
  }
  return {
    available: attended,
    async request({ host, signal, text, save }) {
      if (!attended()) return "unattended";
      if (signal.aborted) return "timeout";
      const evaluate = () => {
        let valid = !signal.aborted && attended();
        if (valid) {
          try {
            guard();
          } catch {
            // The original tool lost its authority while the request was waiting.
            valid = false;
          }
        }
        return connectorNetworkPolicy({
          host,
          valid,
          attended: true,
          allowed: false,
          denied: false,
          full: false,
        });
      };
      const result = evaluate();
      if (result.decision !== "ask") return "timeout";
      let explicitlyDenied = false;
      const presence = new AbortController();
      const timer = setInterval(() => {
        if (!attended()) presence.abort();
      }, 500);
      timer.unref();
      try {
        const status = await local.approvals.request(
          {
            ...chat,
            signal: AbortSignal.any([signal, chat.signal, presence.signal]),
            pauseForApproval: undefined,
          },
          { ...call, input: {} },
          result,
          { available: true },
          async () => evaluate(),
          save,
          {
            requested() {},
            resolved(approval, by) {
              explicitlyDenied =
                by === "user" &&
                approval.status === "denied" &&
                !approval.explanation?.some(
                  (step) => step.axis === "boundary" && step.effect === "deny",
                );
            },
          },
          undefined,
          {
            connectorNetworkSite: host,
            waitMs: 20_000,
            text: (language) => ({ ...text[language], facts: result.facts }),
          },
        );
        if (presence.signal.aborted) return "unattended";
        return status === "allowed" ? "allowed" : explicitlyDenied ? "denied" : "timeout";
      } finally {
        clearInterval(timer);
      }
    },
  };
}
