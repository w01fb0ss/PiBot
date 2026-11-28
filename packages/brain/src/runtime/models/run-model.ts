import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import {
  type Bot,
  type ModelOverride,
  ModelOverrideSchema,
  RpcError,
  RpcErrorCodes,
  resolveThinkingLevel,
} from "@pibot/protocol-base";
import { type Conversation, ConversationsRepo } from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import { requireImageModel } from "../media/image-preflight.ts";
import type { ImagesPort } from "../media/images-port.ts";

export interface RunModelScope {
  conversationId: string;
  groupId?: string | null;
  taskId?: string | null;
}

export function runModelOverride(db: DatabaseSync, bot: Bot, scope: RunModelScope) {
  if (bot.kind === "agent") return undefined;
  return new ConversationsRepo(db).runModelOverride({ ...scope, botId: bot.id });
}

export function withModelOverride(bot: Bot, override?: ModelOverride): Bot {
  if (!override) return bot;
  return {
    ...bot,
    modelProvider: override.provider,
    modelId: override.id,
    thinkingLevel: override.thinkingLevel ?? bot.thinkingLevel,
    thinkingPreference: override.thinkingLevel ?? bot.thinkingPreference,
  };
}

export async function validateModelOverride(
  deps: {
    agent: AgentRuntime;
    images?: ImagesPort;
    credentials?: (provider: string) => Promise<void>;
  },
  bot: Bot,
  input: ModelOverride,
  hasImages: () => boolean,
  signal: AbortSignal,
) {
  if (bot.kind === "agent")
    throw new RpcError(RpcErrorCodes.unsupported, "model_override_external_agent");
  const override = ModelOverrideSchema.parse(input);
  await abortable(deps.credentials?.(override.provider) ?? Promise.resolve(), signal);
  if (bot.category === "image") {
    const model = await requireImageModel(deps.images, override, undefined, signal);
    if (!model.configured || !model.output.includes("image"))
      throw new RpcError(RpcErrorCodes.invalidParams, "model_override_unavailable");
    if (hasImages() && !model.modes.includes("image-to-image"))
      throw new RpcError(RpcErrorCodes.invalidParams, "model_override_image_input_required");
    return { ...withModelOverride(bot, override), thinkingLevel: "off" as const };
  }

  const models = await abortable(deps.agent.listModels({ availableOnly: true }), signal);
  const model = models.find(
    ({ provider, id }) => provider === override.provider && id === override.id,
  );
  if (!model?.input.includes("text"))
    throw new RpcError(RpcErrorCodes.invalidParams, "model_override_unavailable");
  if (hasImages() && !model.input.includes("image"))
    throw new RpcError(RpcErrorCodes.invalidParams, "model_override_image_input_required");
  return {
    ...withModelOverride(bot, override),
    thinkingLevel: resolveThinkingLevel(
      model,
      override.thinkingLevel ??
        (bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference),
    ),
  };
}

/** Shared by admission checks that must agree with the next session's model. */
export function topicModel(bot: Bot, topic: Conversation) {
  return withModelOverride(bot, bot.kind === "agent" ? undefined : topic.modelOverride);
}
