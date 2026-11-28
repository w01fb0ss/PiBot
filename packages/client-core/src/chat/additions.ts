import {
  type AttachmentInput,
  type ChatAdditionMode,
  chatAddition,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { ChatSession } from "./session.ts";
import type { ChatRequestError } from "./types.ts";

export async function append(
  this: ChatSession,
  runId: string,
  mode: ChatAdditionMode,
  text: string,
  attachments: AttachmentInput[],
  attachmentIds: string[],
): Promise<boolean | "fallback_queue"> {
  const botId = this.state.bot?.id;
  const topicId = this.state.conversationId ?? this.target.topicId;
  if (!botId || !topicId) return false;
  const requestId = crypto.randomUUID();
  this.submittingAppend = { requestId, botId, topicId, runId, text, attachments, attachmentIds };
  this.earlyEvents = [];
  this.earlySize = 0;
  this.historyVersion++;
  this.patch({ pending: true, requestError: undefined, retryText: undefined });
  try {
    const message = await this.peer.call("chat.append", {
      botId,
      topicId,
      runId,
      requestId,
      mode,
      text,
      ...(attachments.length ? { attachments } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
    });
    this.applyEvent({
      kind: "message",
      payload: { botId, conversationId: topicId, runId, messageId: message.id, message },
    });
    for (const event of this.earlyEvents) this.applyEvent(event);
    const accepted = !["interrupted", "unsent"].includes(chatAddition(message)?.state ?? "");
    if (!this.disposed) this.uncertainAppend = undefined;
    this.patch({ requestError: accepted ? undefined : "append_unavailable" });
    return accepted;
  } catch (error) {
    const code = error instanceof RpcError ? error.code : undefined;
    const message = error instanceof RpcError ? error.message : "";
    // The live run cannot accept an in-run append in this phase (waiting on approval, between
    // tool calls, preparing, or already ended) and nothing was persisted; fall back to queuing
    // the message as the next turn of the same topic.
    if (code === RpcErrorCodes.busy && message === "append_unavailable") {
      for (const event of this.earlyEvents) this.applyEvent(event);
      return "fallback_queue";
    }
    const known: ChatRequestError | undefined =
      code === RpcErrorCodes.busy
        ? message === "append_full"
          ? "append_full"
          : message === "append_duplicate"
            ? "append_duplicate"
            : "append_unavailable"
        : code === RpcErrorCodes.noModel
          ? "no_model"
          : code === RpcErrorCodes.imageUnsupported
            ? "image_unsupported"
            : code === RpcErrorCodes.attachmentInvalid
              ? "attachment_invalid"
              : code === RpcErrorCodes.scannedPdfUnsupported
                ? "scanned_pdf_unsupported"
                : code === RpcErrorCodes.attachmentConversion
                  ? "attachment_conversion"
                  : code === RpcErrorCodes.invalidParams
                    ? "append_unavailable"
                    : undefined;
    if (!known)
      this.uncertainAppend = {
        requestId,
        botId,
        topicId,
        runId,
        text,
        attachments,
        attachmentIds,
      };
    this.patch({ requestError: known ?? "uncertain", appendUncertain: !known });
    await this.refreshHistory(false, true);
    return false;
  } finally {
    this.submittingAppend = undefined;
    this.earlyEvents = [];
    this.earlySize = 0;
    this.patch({ pending: false });
    void this.flushHistoryRefresh();
  }
}

export async function confirmAppend(this: ChatSession) {
  const request = this.uncertainAppend;
  if (!request || this.state.pending) return;
  this.patch({ pending: true });
  try {
    const {
      text,
      runId,
      attachments: _attachments,
      attachmentIds: _attachmentIds,
      ...params
    } = request;
    const receipt = await this.reads.read(
      `append-status:${JSON.stringify(params)}`,
      (signal) => this.peer.call("chat.appendStatus", params, { signal }),
      this.lifetime.signal,
    );
    const message = receipt.message;
    if (
      receipt.state === "accepted" &&
      message?.runId === runId &&
      message.id === request.requestId
    ) {
      this.applyEvent({
        kind: "message",
        payload: {
          botId: request.botId,
          conversationId: request.topicId,
          runId: message.runId,
          messageId: message.id,
          message,
        },
      });
      this.uncertainAppend = undefined;
      const accepted = !["interrupted", "unsent"].includes(chatAddition(message)?.state ?? "");
      this.patch({
        appendUncertain: false,
        requestError: accepted ? undefined : "append_unavailable",
      });
      if (accepted) return text;
    } else if (receipt.state === "absent") {
      this.uncertainAppend = undefined;
      this.patch({ appendUncertain: false, requestError: "append_unavailable" });
    }
    // Only the current owner can certify absence after the first preflight has ended.
  } catch {
    this.patch({ requestError: "uncertain" });
  } finally {
    for (const event of this.earlyEvents) this.applyEvent(event);
    this.earlyEvents = [];
    this.earlySize = 0;
    this.patch({ pending: false });
    void this.flushHistoryRefresh();
  }
}
