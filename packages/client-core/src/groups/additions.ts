import {
  type AttachmentInput,
  type ChatAdditionMode,
  chatAddition,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { groupRequestError } from "./request-error.ts";
import type { GroupSession } from "./session.ts";

export async function append(
  this: GroupSession,
  text: string,
  attachments: AttachmentInput[],
  run: { id: string; botId: string },
  mode: ChatAdditionMode,
  targetBotId?: string,
  onUnavailable?: () => Promise<boolean>,
) {
  if (
    !this.active ||
    !this.state.confirmed ||
    this.state.sending ||
    this.uncertainAppend ||
    this.target.draftId
  )
    return false;
  const requestId = crypto.randomUUID(),
    generation = this.generation;
  const params = {
    groupId: this.target.groupId,
    conversationId: this.target.conversationId,
    botId: run.botId,
    runId: run.id,
    requestId,
    mode,
    text,
    targetBotId,
    ...(attachments.length ? { attachments } : {}),
  };
  this.publish({ sending: true, requestError: undefined });
  let fallback = false;
  try {
    const message = await this.peer.call("groups.append", params, {
      signal: this.lifetime.signal,
      timeoutMs: 35000,
    });
    if (generation !== this.generation || !this.active) return false;
    if (
      message.id !== requestId ||
      message.runId !== run.id ||
      message.conversationId !== this.target.conversationId
    )
      throw new Error("Wrong addition receipt");
    const accepted = !["interrupted", "unsent"].includes(chatAddition(message)?.state ?? "");
    this.publish({
      messages: [...this.state.messages.filter((m) => m.id !== message.id), message].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
      requestError: accepted ? undefined : "append_unavailable",
    });
    this.schedule();
    return accepted;
  } catch (error) {
    if (generation !== this.generation || this.lifetime.signal.aborted) return false;
    // Live run cannot accept an in-run append in this phase and nothing persisted: release the
    // sending flag first, then queue the message as the next turn of the same group topic.
    if (
      onUnavailable &&
      error instanceof RpcError &&
      error.code === RpcErrorCodes.busy &&
      error.message === "append_unavailable"
    ) {
      fallback = true;
    } else {
      const known =
        error instanceof RpcError &&
        new Set<number>([
          RpcErrorCodes.busy,
          RpcErrorCodes.invalidParams,
          RpcErrorCodes.noModel,
          RpcErrorCodes.imageUnsupported,
          RpcErrorCodes.attachmentInvalid,
          RpcErrorCodes.scannedPdfUnsupported,
          RpcErrorCodes.attachmentConversion,
        ]).has(error.code);
      if (!known)
        this.uncertainAppend = {
          groupId: params.groupId,
          conversationId: params.conversationId,
          botId: params.botId,
          requestId,
        };
      const reason =
        error instanceof RpcError &&
        ["append_full", "append_duplicate", "append_target_required"].includes(error.message)
          ? (error.message as "append_full" | "append_duplicate" | "append_target_required")
          : error instanceof RpcError &&
              error.code !== RpcErrorCodes.busy &&
              error.code !== RpcErrorCodes.invalidParams
            ? groupRequestError(error)
            : "append_unavailable";
      this.publish({ requestError: known ? reason : "uncertain", appendUncertain: !known });
      this.schedule();
      return false;
    }
  } finally {
    if (generation === this.generation) this.publish({ sending: false });
  }
  if (fallback && onUnavailable) return onUnavailable();
  return false;
}

export async function confirmAppend(this: GroupSession) {
  const params = this.uncertainAppend;
  if (!params || this.state.sending) return false;
  this.publish({ sending: true });
  const generation = this.generation;
  try {
    const receipt = await this.peer.call("groups.appendStatus", params, {
      signal: this.lifetime.signal,
      timeoutMs: 10000,
    });
    if (generation !== this.generation || this.lifetime.signal.aborted) return false;
    if (receipt.state === "preparing") return false;
    this.uncertainAppend = undefined;
    const accepted =
      receipt.state === "accepted" &&
      receipt.message &&
      !["interrupted", "unsent"].includes(chatAddition(receipt.message)?.state ?? "");
    this.publish({
      appendUncertain: false,
      requestError: accepted ? undefined : "append_unavailable",
    });
    await this.refresh();
    return accepted ? receipt.message?.content : undefined;
  } catch {
    return false;
  } finally {
    if (generation === this.generation) this.publish({ sending: false });
  }
}
