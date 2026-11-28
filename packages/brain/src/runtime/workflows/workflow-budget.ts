import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import type { Bot, BudgetSnapshot, ExecutionLimits } from "@pibot/protocol-base";
import { SettingsRepo } from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import type { WorkflowRun } from "./workflow-prepare.ts";

/**
 * A workflow's budget only ever lowers the conversation's execution limits. Its cost cap
 * applies only when every model the run may use has known prices: the budget refuses unpriced
 * requests under a cost cap (fail-closed), which would make a workflow unusable on a local or
 * subscription model. Without prices the request and time limits still apply.
 */
export function workflowLimits(
  limits: ExecutionLimits,
  workflow: Pick<WorkflowRun, "contract"> | undefined,
  priced: boolean,
): ExecutionLimits {
  const budget = workflow?.contract.budget;
  if (!budget) return limits;
  const lower = (current: number, value?: number) =>
    value === undefined ? current : Math.min(current, value);
  return {
    ...limits,
    modelRequests: lower(limits.modelRequests, budget.modelRequests),
    activeSeconds: lower(limits.activeSeconds, budget.activeSeconds),
    costUsd:
      budget.costUsd === undefined || !priced
        ? limits.costUsd
        : Math.min(limits.costUsd ?? budget.costUsd, budget.costUsd),
  };
}

type ModelRef = { provider?: string | null; id?: string | null } | null | undefined;

/**
 * Whether each model has catalogue prices. False when the lookup fails or is slow: the catalogue
 * is cached, and a miss only means a cost cap is not relied on for this model.
 */
async function pricedModels(
  agent: AgentRuntime,
  refs: readonly ModelRef[],
  signal: AbortSignal,
): Promise<boolean> {
  let models: Awaited<ReturnType<AgentRuntime["listModels"]>>;
  try {
    models = await abortable(
      agent.listModels({ availableOnly: true }),
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
  return refs.every((ref) => {
    const model = ref && models.find((m) => m.provider === ref.provider && m.id === ref.id);
    return (
      !!model &&
      Object.values(model.cost).some((v) => typeof v === "number" && Number.isFinite(v) && v > 0)
    );
  });
}

/** Whether the run's model (and the auxiliary one for a `cheap` tier) has catalogue prices. */
export async function workflowPriced(
  deps: { agent: AgentRuntime; db: DatabaseSync },
  bot: Bot,
  workflow: Pick<WorkflowRun, "contract"> | undefined,
  signal: AbortSignal,
  hasOverride = false,
): Promise<boolean> {
  if (!workflow?.contract.budget?.costUsd) return false;
  // An external agent's turns are billed to its own account and never count against Pi
  // Bot's cost budget, so its step is not blocked for an unknown price.
  if (bot.kind === "agent") return true;
  const auxiliary =
    !hasOverride && workflow.contract.model?.tier === "cheap"
      ? new SettingsRepo(deps.db).get().auxiliaryModel
      : undefined;
  return pricedModels(
    deps.agent,
    [{ provider: bot.modelProvider, id: bot.modelId }, ...(auxiliary ? [auxiliary] : [])],
    signal,
  );
}

/** An auxiliary model is configured, so a workflow may hand mechanical steps to it. */
export function cheapChildrenAvailable(db: DatabaseSync): boolean {
  return !!new SettingsRepo(db).get().auxiliaryModel;
}

/**
 * The tier a `task_spawn model: "cheap"` child actually runs on. Under a cost cap every
 * request must be priced (the ledger refuses unpriced ones and would stop the whole workflow),
 * so an unpriced auxiliary model runs the child on the main model instead; the child's reply and
 * the parent's receipt then name the main model.
 */
export async function childModelTier(
  deps: { agent: AgentRuntime; db: DatabaseSync },
  budget: BudgetSnapshot | undefined,
  signal: AbortSignal,
): Promise<"cheap" | undefined> {
  const auxiliary = new SettingsRepo(deps.db).get().auxiliaryModel;
  if (!auxiliary) return undefined;
  if (budget?.limits.costUsd == null) return "cheap";
  return (await pricedModels(deps.agent, [auxiliary], signal)) ? "cheap" : undefined;
}
