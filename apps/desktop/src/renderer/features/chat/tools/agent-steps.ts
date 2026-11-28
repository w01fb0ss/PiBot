import { agentTurnFacts } from "@pibot/external-agents-contract";
import { createContext, useContext } from "react";

/**
 * An external agent's steps are Pi Bot step records without Pi Bot's command logs. Their
 * output, when the agent reports one, lives in the turn reply's `usage.externalAgent.stepDetails`,
 * which can sit on a later bubble than the step; the history hands the conversation's outputs
 * down so each step row finds its own, and says plainly when the agent reported none.
 */
export interface AgentStepDetail {
  /** The command or path it ran on. */
  input?: string;
  output?: string;
}
export interface AgentSteps {
  /** Bot names also identify live steps that have no stored turn facts yet. */
  agentName?: string;
  agentNames?: ReadonlyMap<string, string>;
  details: ReadonlyMap<string, ReadonlyMap<string, AgentStepDetail>>;
}
export const AgentStepsContext = createContext<AgentSteps>({ details: new Map() });
export const useAgentSteps = () => useContext(AgentStepsContext);

const cache = new WeakMap<readonly unknown[], AgentSteps["details"]>();
/** Built once per message list (the history re-renders often; the list identity rarely changes). */
export function agentStepDetails(
  messages: readonly { usage: unknown; role: string; runId: string | null }[],
): AgentSteps["details"] {
  const known = cache.get(messages);
  if (known) return known;
  const details = new Map<string, Map<string, AgentStepDetail>>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.runId) continue;
    const steps = agentTurnFacts(message.usage)?.stepDetails;
    if (!steps?.length) continue;
    const run = details.get(message.runId) ?? new Map<string, AgentStepDetail>();
    details.set(message.runId, run);
    for (const detail of steps)
      run.set(detail.toolCallId, {
        ...(detail.input ? { input: detail.input } : {}),
        ...(detail.output ? { output: detail.output } : {}),
      });
  }
  cache.set(messages, details);
  return details;
}
