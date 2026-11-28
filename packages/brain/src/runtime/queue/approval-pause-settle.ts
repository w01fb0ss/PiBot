import type { DatabaseSync } from "node:sqlite";
import type { KernelEvents, KernelMethods, Message, Peer } from "@pibot/protocol-base";
import {
  ApprovalPausesRepo,
  type AuditRepo,
  MessagesRepo,
  type SupersededPause,
  transaction,
} from "@pibot/storage";

/**
 * Why a paused approval was closed as out of date (audit `reasonCode`): answered after the
 * conversation moved on, closed by a newer run in its conversation, or found stuck at startup.
 */
export type PauseSupersedeReason =
  | "approval_pause_superseded"
  | "approval_pause_superseded_by_new_run"
  | "approval_pause_superseded_on_start"
  // The person asked the default Pi to settle it (its health-check repair).
  | "approval_settled_by_pi";

/** A row another tool edited by hand no longer parses; a resume would refuse it forever too. */
export function unreadableRow(error: unknown) {
  return error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError");
}

/**
 * Closes one out-of-date pause with its audit entry, in one transaction. A user's deny stays a
 * deny; anything else ends `expired`, because nothing was allowed to run. Undefined when the card
 * was answered or closed meanwhile, so a second click or a second window is harmless.
 */
export function supersedePause(
  db: DatabaseSync,
  audit: AuditRepo,
  approvalId: string,
  input: {
    actor: "user" | "system";
    decision?: "allow" | "deny";
    reasonCode: PauseSupersedeReason;
    target?: string;
  },
): SupersededPause | undefined {
  return transaction(db, () => {
    const settled = new ApprovalPausesRepo(db).supersede(
      approvalId,
      input.decision === "deny" ? "denied" : "expired",
    );
    if (!settled) return undefined;
    audit.append({
      botId: settled.botId,
      runId: settled.runId,
      kind: "approval.resolved",
      summary: "Paused approval out of date; nothing ran / 暂停的审批已过时，未执行",
      detail: {
        approvalId,
        actor: input.actor,
        decision: input.decision ?? "deny",
        status: settled.status,
        remember: false,
        reasonCode: input.reasonCode,
        ...(input.target ? { target: input.target } : {}),
      },
    });
    return settled;
  });
}

/**
 * Tells every window and the phone after the commit: the card, the inbox, the reply's pause band
 * and the conversation's "waiting for you" mark. A reply that no longer parses only misses its
 * live update; the next history read shows the settled card.
 */
export function announceSuperseded(
  db: DatabaseSync,
  peer: Peer<typeof KernelMethods, typeof KernelEvents>,
  settled: readonly SupersededPause[],
) {
  if (!settled.length) return;
  const messages = new MessagesRepo(db);
  const groups = new Set<string>();
  const bots = new Set<string>();
  for (const pause of settled) {
    peer.emit("approval.resolved", {
      id: pause.approvalId,
      status: pause.status,
      remembered: false,
      superseded: true,
    });
    let message: Message | undefined;
    try {
      message = messages.get(pause.messageId);
    } catch (error) {
      if (!unreadableRow(error)) throw error;
    }
    if (message?.runId === pause.runId && message.botId)
      peer.emit("chat.message", {
        botId: message.botId,
        conversationId: message.conversationId,
        runId: pause.runId,
        messageId: message.id,
        message,
      });
    if (pause.groupId) groups.add(pause.groupId);
    else bots.add(pause.botId);
  }
  for (const groupId of groups) {
    peer.emit("groups.changed", { groupId, reason: "updated" });
    peer.emit("sidebar.changed", { conversationKey: `group:${groupId}` });
  }
  for (const botId of bots) peer.emit("sidebar.changed", { conversationKey: `dm:${botId}` });
  peer.emit("inbox.changed", {});
}
