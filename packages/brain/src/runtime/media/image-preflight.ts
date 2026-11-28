import type { AgentRuntime } from "@pibot/agent";
import {
  type Bot,
  type ImageGenerationOptions,
  type ImageMode,
  type ModelInfo,
  RpcError,
} from "@pibot/protocol-base";
import type { PreparedAttachments } from "../../conversations/attachments/attachments.ts";
import { abortable } from "../../core/abort.ts";

import type { ImagesPort } from "./images-port.ts";
export async function requireImageModel(
  images: ImagesPort | undefined,
  selected: { provider: string; id: string } | undefined,
  mode: ImageMode | undefined,
  signal: AbortSignal,
) {
  if (!images) throw new RpcError(-32601, "images_unavailable");
  return images.requireModel(selected, mode, signal);
}

export async function attachmentModelForBot(
  agent: AgentRuntime,
  bot: Bot,
  signal: AbortSignal,
  imagePort?: ImagesPort,
): Promise<Pick<ModelInfo, "input" | "contextWindow">> {
  signal.throwIfAborted();
  // An external agent reads files itself from its folder; attached images are passed on to
  // an agent that accepts them, and the run refuses them for one that does not.
  if (bot.kind === "agent") return { input: ["text", "image"], contextWindow: 200_000 };
  if (bot.category === "image") {
    await requireImageModel(
      imagePort,
      bot.modelProvider && bot.modelId
        ? { provider: bot.modelProvider, id: bot.modelId }
        : undefined,
      undefined,
      signal,
    );
    // Image operations accept references, never extracted file text or a chat context budget.
    return {
      input: ["text", "image"],
      contextWindow: 0,
    };
  }
  // Catalog lookup starts no paid run; cancellation stops admission while the lookup settles.
  const models = await abortable(agent.listModels({ availableOnly: true }), signal);
  const model = models.find((m) => m.provider === bot.modelProvider && m.id === bot.modelId);
  signal.throwIfAborted();
  if (!model) throw new RpcError(-32010, "no_model");
  return model;
}

export async function validateImageInputs(
  _agent: AgentRuntime,
  bot: Bot,
  prepared: Pick<PreparedAttachments, "items" | "images">,
  signal: AbortSignal,
  imagePort?: ImagesPort,
  generation?: ImageGenerationOptions,
) {
  if (bot.category !== "image") return;
  if (prepared.items.some((item) => item.metadata.kind !== "image"))
    throw new RpcError(-32602, "image_mode_mismatch");
  // Structured runs select and validate every requested model together before approval.
  if (generation) return;
  await requireImageModel(
    imagePort,
    bot.modelProvider && bot.modelId ? { provider: bot.modelProvider, id: bot.modelId } : undefined,
    prepared.images.length ? "image-to-image" : undefined,
    signal,
  );
}
