import {
  type AttachmentInput,
  type ChatAdditionMode,
  type ExecutionMode,
  type Message,
  RpcError,
  RpcErrorCodes,
  slashHelpRequest,
} from "@pibot/protocol";
import { activeRun } from "./selectors.ts";
import type { ChatSession } from "./session.ts";

export async function send(
  this: ChatSession,
  text: string,
  attachments: AttachmentInput[] = [],
  attachmentIds: string[] = [],
  mode?: ChatAdditionMode | "queue",
  initialMode?: ExecutionMode,
  replyToMessageId?: string,
): Promise<boolean> {
  const bot = this.state.bot;
  if (
    !bot ||
    (!text.trim() && !attachments.length && !attachmentIds.length) ||
    this.state.loading ||
    !this.state.historyReady ||
    this.state.historyError ||
    this.state.metadataLoading ||
    this.state.metadataError ||
    this.state.pending ||
    (activeRun(this.state) && !mode) ||
    this.uncertainAppend ||
    (this.state.requestError === "uncertain" && this.state.historyError)
  )
    return false;
  const currentRun = activeRun(this.state);
  if (currentRun && mode && bot.category === "image" && mode === "steer") {
    this.patch({ requestError: "image_steer_unsupported" });
    return false;
  }
  // Image HTTP requests have no live session; followUp is a new queued run.
  // A pending approval keeps the current run alive; a new request belongs to the durable
  // run queue, never the SDK steering buffer that may discard input when a tool is refused.
  // When chat.append reports append_unavailable (phase cannot append and nothing persisted),
  // fall through to chat.send so the message queues as the next turn of the same topic.
  if (
    currentRun &&
    mode &&
    mode !== "queue" &&
    bot.category !== "image" &&
    !replyToMessageId &&
    (bot.kind === "agent" || attachments.length || attachmentIds.length || !slashHelpRequest(text))
  ) {
    const appended = await this.append(currentRun, mode, text, attachments, attachmentIds);
    if (appended !== "fallback_queue") return appended;
    if (this.disposed) return false;
  }
  this.earlyEvents = [];
  this.earlySize = 0;
  // An older history request can return a checkpoint of the newly accepted send.
  this.historyVersion++;
  this.patch({ pending: true, requestError: undefined, retryText: undefined, stopError: false });
  try {
    const result = await this.peer.call("chat.send", {
      ...this.route(),
      ...(this.target.draftId && !this.state.conversationId && initialMode ? { initialMode } : {}),
      text,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
    });
    const now = new Date().toISOString();
    const base = {
      // Empty legacy sends lack identity until authoritative history; never invent a Bot UUID as conversation ID.
      conversationId:
        result.conversationId ?? this.target.topicId ?? this.state.conversationId ?? "",
      runId: result.localReply ? null : result.runId,
      errorCode: null,
      usage: null,
      createdAt: now,
      updatedAt: now,
    };
    const existingIds = new Set(this.state.messages.map((message) => message.id));
    const accepted: Message[] = [
      {
        ...base,
        id: result.userMessageId,
        role: "user",
        ...(result.quote ? { usage: { messageQuote: result.quote } } : {}),
        botId: null,
        content: text,
        status: "done",
        ...(result.attachments ? { attachments: result.attachments } : {}),
      },
      result.localReply ?? {
        ...base,
        id: result.assistantMessageId,
        usage: { chatReplyTo: result.userMessageId },
        role: "assistant",
        botId: bot.id,
        content: "",
        status: "streaming",
      },
    ];
    this.patch({
      conversationId: base.conversationId || undefined,
      messages: [
        ...this.state.messages,
        ...accepted.filter((message) => !existingIds.has(message.id)),
      ],
    });
    for (const event of this.earlyEvents) this.applyEvent(event);
    this.earlyEvents = [];
    this.earlySize = 0;
    this.patch({ pending: false });
    void this.flushHistoryRefresh();
    return true;
  } catch (error) {
    const code = error instanceof RpcError ? error.code : undefined;
    const imageError =
      error instanceof RpcError && bot.category === "image"
        ? error.message === "image_reference_required"
          ? "image_input_required"
          : error.message === "image_mode_mismatch"
            ? "image_mode_mismatch"
            : error.message === "image_model_unavailable"
              ? "no_model"
              : undefined
        : undefined;
    this.patch({
      requestError:
        (error instanceof RpcError && error.message === "message_quote_unavailable"
          ? "quote_unavailable"
          : undefined) ??
        imageError ??
        (code === RpcErrorCodes.noModel
          ? "no_model"
          : code === RpcErrorCodes.busy
            ? "busy"
            : code === RpcErrorCodes.imageUnsupported
              ? "image_unsupported"
              : code === RpcErrorCodes.attachmentInvalid
                ? "attachment_invalid"
                : code === RpcErrorCodes.scannedPdfUnsupported
                  ? "scanned_pdf_unsupported"
                  : code === RpcErrorCodes.attachmentConversion
                    ? "attachment_conversion"
                    : "uncertain"),
      retryText: text,
    });
    // An RPC timeout can still have accepted the request. Recover before allowing a retry.
    if (
      this.target.draftId &&
      !this.state.conversationId &&
      this.state.requestError === "uncertain"
    )
      this.patch({ historyError: true });
    else await this.refreshHistory(false, true);
    if (code === RpcErrorCodes.noModel) await this.refreshMetadata();
    const ended = this.earlyEvents.some(
      (event) => event.kind !== "delta" && event.kind !== "attachments",
    );
    // History has no event-sequence cutoff: replaying buffered deltas could duplicate a checkpoint.
    // Discard them during recovery; a missing tail is restored by the terminal history refresh.
    this.earlyEvents = [];
    this.earlySize = 0;
    this.patch({ pending: false });
    if (ended) this.historyRefreshPending = true;
    await this.flushHistoryRefresh();
    return false;
  }
}

export async function abort(this: ChatSession) {
  const runId = activeRun(this.state);
  if (!runId || this.state.stopping) return;
  this.patch({ stopping: true, stopError: false });
  try {
    await this.peer.call("chat.abort", { runId });
    await this.refreshHistory();
  } catch {
    this.patch({ stopError: true });
  } finally {
    this.patch({ stopping: false });
  }
}
