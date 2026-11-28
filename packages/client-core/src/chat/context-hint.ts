import type { ModelOverride } from "@pibot/protocol";
import type { ChatSession } from "./session.ts";

/**
 * Ask the brain whether the topic already exceeds the new model's background compaction
 * line. The token estimate never happens here; the renderer only shows the answer.
 *
 * Only a started session asks: switching a Bot's model would otherwise make every cached topic
 * (up to 32) race the brain with a full session read for a notice nobody is looking at.
 */
export async function checkContextHint(this: ChatSession) {
  const botId = this.state.bot?.id ?? this.target.botId;
  const conversationId = this.state.conversationId;
  if (this.disposed || !this.started || !botId || !conversationId) return;
  const version = ++this.hintVersion;
  try {
    const result = await this.peer.call(
      "chat.contextHint",
      { botId, conversationId },
      { signal: this.lifetime.signal },
    );
    if (this.disposed || version !== this.hintVersion) return;
    this.patch({ contextHint: result.show });
  } catch {
    // The hint is advice, not conversation state; a failed read must not become an error banner.
  }
}

/** Records 「不用」 for this topic and model, and hides the notice immediately. */
export async function dismissContextHint(this: ChatSession, override?: ModelOverride) {
  const botId = this.state.bot?.id ?? this.target.botId;
  const conversationId = this.state.conversationId;
  const bot = this.state.bot;
  this.patch({ contextHint: false });
  if (!botId || !conversationId) return;
  try {
    await this.peer.call(
      "chat.contextHint",
      {
        botId,
        conversationId,
        dismiss: true,
        // Name the model that was on screen: a save racing this click must not file the refusal
        // under the next model.
        ...(override
          ? { modelProvider: override.provider, modelId: override.id }
          : bot?.modelProvider && bot.modelId
            ? { modelProvider: bot.modelProvider, modelId: bot.modelId }
            : {}),
      },
      { signal: this.lifetime.signal },
    );
  } catch {
    // Only a lost receipt is at stake: the notice may return after the next metadata reload.
  }
}
