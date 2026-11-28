import type { Bot } from "@pibot/protocol";
import type { ChatSession } from "./session.ts";

export async function start(this: ChatSession) {
  if (this.disposed) return;
  if (this.started) {
    if (this.initialization) {
      await this.initialization;
      return;
    }
    await this.reload(false);
    return;
  }
  this.started = true;
  this.subscriptions = [
    this.peer.on("execution.question.answered", (event) => {
      if (this.state.conversationId && event.conversationIds.includes(this.state.conversationId))
        void this.refreshHistory();
    }),
    this.peer.on("chat.message", (payload) => this.receive({ kind: "message", payload })),
    this.peer.on("chat.delta", (payload) => this.receive({ kind: "delta", payload })),
    this.peer.on("chat.attachments", (payload) => this.receive({ kind: "attachments", payload })),
    this.peer.on("chat.done", (payload) => this.receive({ kind: "done", payload })),
    this.peer.on("chat.error", (payload) => this.receive({ kind: "error", payload })),
    this.peer.on("chat.status", (event) => {
      // ACP and other clients can create a run without this controller's chat.send receipt.
      // Load its persisted message before tools or approvals need that message's UI owner.
      if (this.matches(event)) void this.refreshHistory();
    }),
    this.peer.on("approval.resolved", (event) => {
      void this.reads.approvals.route(event.id).then((route) => {
        // A resolution can beat the initial pending snapshot. Only a visible chat may use the
        // unknown-owner fallback; parked sessions never all reload because of a missed event.
        if (!this.disposed && (route ? this.matches(route) : this.listeners.size > 0))
          void this.refreshHistory();
      });
    }),
    this.peer.on("sidebar.changed", (event) => {
      // A phone's offline turns joining this Bot's topic arrive with no run, so
      // the import's sidebar change is the only sign the open thread has new messages.
      const botId = this.target.botId ?? this.state.bot?.id;
      if (
        botId &&
        event.conversationKey === `dm:${botId}` &&
        (!this.state.pending || event.resetHistory)
      )
        void this.refreshHistory(false, false, event.resetHistory);
    }),
    this.peer.on("bots.changed", (event) => {
      if (event.botId === (this.target.botId ?? this.state.bot?.id)) void this.refreshMetadata();
    }),
    this.peer.on("chat.tool", (event) => {
      if (this.matches(event) && event.phase === "end") void this.refreshHistory();
    }),
    this.peer.on("providers.changed", () => {
      // A second metadata request must not invalidate the initial Bot lookup.
      void (this.initialization ?? Promise.resolve()).then(() => this.refreshMetadata());
    }),
  ];
  this.initialization = this.reload();
  await this.initialization;
  this.initialization = undefined;
}

export function dispose(this: ChatSession) {
  // Port replacement cannot certify that a submitted RPC was rejected by its former owner.
  if (this.submittingAppend) this.uncertainAppend = this.submittingAppend;
  this.disposed = true;
  clearTimeout(this.frame);
  this.metadataRead?.abort();
  this.lifetime.abort();
  this.retire?.();
  for (const unsubscribe of this.subscriptions) unsubscribe();
  this.listeners.clear();
  this.earlyEvents = [];
  this.earlySize = 0;
  this.state = { ...this.state, messages: [], models: [], imageModels: [] };
}

export function updateBot(this: ChatSession, bot: Bot) {
  if (
    this.disposed ||
    (bot.id !== (this.target.botId ?? this.state.bot?.id) &&
      !(bot.isMain && !this.target.botId && !this.state.bot))
  )
    return;
  // A confirmed save must survive metadata reads that began before the save.
  this.botVersion++;
  this.metadataRead?.abort();
  const previous = this.state.bot;
  this.patch({
    bot,
    metadataError: false,
    metadataLoading: bot.category === "image",
    ...(bot.category === "image" ? { imageModels: [] } : {}),
  });
  // Only a real model change can make the topic too long for the new window; a rename
  // or avatar save must not trigger a session read.
  if (previous?.modelProvider !== bot.modelProvider || previous?.modelId !== bot.modelId)
    void this.checkContextHint();
  if (bot.category === "image") void this.refreshMetadata(bot);
}
