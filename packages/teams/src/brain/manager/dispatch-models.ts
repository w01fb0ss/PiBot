import type { CapabilityContext } from "@pibot/brain/kit";
import { dispatchModelProblem, dispatchThinkingLevel } from "@pibot/brain/kit";
import type {
  ApprovalFact,
  Bot,
  DispatchModel,
  DispatchModelNeeds,
  DispatchModelReason,
  DispatchModelRoute,
  ModelOverride,
} from "@pibot/protocol";
import { DispatchModelRoutesRepo } from "@pibot/storage";
import type { piManagerTools } from "@pibot/teams-contract";
import { findBot, findGroup, oneLine, say } from "./lookup.ts";

export type DispatchArgs =
  | ReturnType<typeof piManagerTools.send_to_bot.schema.parse>
  | ReturnType<typeof piManagerTools.send_to_group.schema.parse>;

interface ModelChoice {
  bot: Bot;
  model: ModelOverride;
  needs: DispatchModelNeeds;
  modelReason?: string;
  stepId?: string;
}

export interface PreparedDispatchModels {
  choices: (ModelChoice & {
    catalogModel?: DispatchModel;
    issue?: DispatchModelReason;
    destination?: string;
  })[];
  error?: "step_owner" | "image_batch";
  needsConfirmation: boolean;
}

export function dispatchModelChoices(ctx: CapabilityContext, args: DispatchArgs) {
  const choices: ModelChoice[] = [];
  let error: PreparedDispatchModels["error"];
  if ("bot" in args) {
    const bot = findBot(ctx.db, args.bot);
    if (args.model && args.imageGeneration) error = "image_batch";
    else if (bot && args.model)
      choices.push({
        bot,
        model: args.model,
        needs: args.needs ?? {},
        modelReason: args.modelReason,
      });
  } else {
    const group = findGroup(ctx.db, args.group);
    for (const step of args.steps ?? []) {
      const bot = findBot(ctx.db, step.bot);
      if (!bot || bot.archivedAt || !group?.members.some(({ botId }) => botId === bot.id)) {
        error = "step_owner";
        break;
      }
      choices.push({ ...step, bot, needs: step.needs ?? {} });
    }
  }
  return {
    choices,
    error,
    needsConfirmation: choices.some(({ bot, model }) => bot.modelProvider !== model.provider),
  };
}

export async function prepareDispatchModels(
  ctx: CapabilityContext,
  input: ReturnType<typeof dispatchModelChoices>,
  signal: AbortSignal,
): Promise<PreparedDispatchModels> {
  const port = ctx.local.models;
  const models = input.choices.length ? ((await port?.dispatchModels?.(signal)) ?? []) : [];
  return {
    ...input,
    choices: input.choices.map((choice) => {
      const { bot, model, needs } = choice;
      const catalogModel = models.find(
        ({ provider, id }) => provider === model.provider && id === model.id,
      );
      return {
        ...choice,
        catalogModel,
        issue: dispatchModelProblem(bot, model, needs, catalogModel),
        destination: port?.dispatchDestination?.(model.provider),
      };
    }),
  };
}

export function dispatchModelError(
  models: PreparedDispatchModels | undefined,
  language: "zh" | "en",
) {
  if (models?.error === "step_owner")
    return say(
      language,
      "请给每个步骤指定该群的有效成员。",
      "Choose an active member of the group for each step.",
    );
  if (models?.error === "image_batch")
    return say(
      language,
      "话题模型和批量或对比出图选项请选其一。",
      "Choose either a topic model or the image batch/comparison options.",
    );
  const issue = models?.choices.find((choice) => choice.issue);
  if (issue)
    return say(
      language,
      `${issue.model.provider}/${issue.model.id} 无法用于该任务（${issue.issue}）。请用 team_directory 重新选择。`,
      `${issue.model.provider}/${issue.model.id} cannot run this task (${issue.issue}). Choose again using team_directory.`,
    );
}

export function recordDispatchModels(
  ctx: CapabilityContext,
  models: PreparedDispatchModels,
  dispatchId: string,
  conversationId: string,
  piRunId: string,
  groupId?: string,
) {
  const routes = new DispatchModelRoutesRepo(ctx.db);
  for (const { model, needs, bot, stepId, destination } of models.choices) {
    const route: DispatchModelRoute = { dispatchId, botId: bot.id, model, needs, destination };
    routes.set(conversationId, stepId ? `step:${stepId}` : "topic", route);
    ctx.local.approvals.audit.append({
      botId: bot.id,
      runId: piRunId,
      kind: "pi.dispatch_model",
      summary: "Pi selected a dispatch model / Pi 已选择派发模型",
      detail: {
        actor: "automatic",
        reasonCode: "selected",
        conversationId,
        providerId: model.provider,
        modelId: model.id,
        ...(model.thinkingLevel ? { dispatchThinking: model.thinkingLevel } : {}),
        ...(groupId ? { groupId } : {}),
        ...(stepId ? { stepId } : {}),
      },
    });
  }
}

/** A first-turn estimate: the task text plus prompt/history allowance, and a reply budget.
 * Excludes later tool calls and continuations. Prices are USD per million tokens. */
export function dispatchCost(model: DispatchModel, task: string) {
  const { input, output } = model.pricePerMillion;
  if (input === null || output === null) return undefined;
  const estimatedTaskTokens = Math.ceil(Buffer.byteLength(task, "utf8") / 3);
  const price = (inputTokens: number, outputTokens: number) =>
    ((input * inputTokens + output * outputTokens) / 1_000_000).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  return `${price(estimatedTaskTokens + 2000, 500)}–${price(estimatedTaskTokens + 8000, 3000)}`;
}

export function dispatchModelFacts(
  ctx: Pick<CapabilityContext, "redactor">,
  prepared: PreparedDispatchModels | undefined,
  language: "zh" | "en",
  task: string,
  defaultReason?: string,
) {
  const label = (zh: string, en: string) => say(language, zh, en);
  const clean = (text: string) => oneLine(ctx.redactor.redact(text), 200) || "—";
  const row = (label: string, value: string): ApprovalFact => ({
    kind: "write",
    label: label.slice(0, 80),
    value,
  });
  return (prepared?.choices ?? []).flatMap(({ bot, stepId, model, catalogModel, modelReason }) => {
    const prefix = stepId ? `${stepId} · ${clean(bot.name).slice(0, 14)} · ` : "";
    const selected = catalogModel ? dispatchThinkingLevel(bot, model, catalogModel) : "off";
    const level = {
      off: label("关闭", "Off"),
      low: label("低", "Low"),
      medium: label("中", "Medium"),
      high: label("高", "High"),
    }[selected];
    const reason = modelReason ?? defaultReason;
    const imagePrice = bot.category === "image" ? catalogModel?.imagePrice : undefined;
    const cost = imagePrice
      ? imagePrice.perImage.toLocaleString("en-US", {
          style: "currency",
          currency: imagePrice.currency,
          maximumFractionDigits: 6,
        })
      : catalogModel && dispatchCost(catalogModel, task);
    return [
      row(
        prefix + label("模型", "Model"),
        clean(`${model.provider}/${model.id} · ${catalogModel?.name ?? model.id}`),
      ),
      row(prefix + label("思考等级", "Thinking"), level),
      ...(reason ? [row(prefix + label("难度与模型", "Difficulty and model"), clean(reason))] : []),
      ...(cost ? [row(prefix + label("首轮费用估算", "First-turn cost estimate"), cost)] : []),
    ];
  });
}
