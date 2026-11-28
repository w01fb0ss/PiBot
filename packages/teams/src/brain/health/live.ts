// What is really alive right now, read from the services that own it (not from the database):
// the run queue's entries, the approval waiters, the background jobs this process owns.
import { createHash } from "node:crypto";
import type { CapabilityContext } from "@pibot/brain/kit";
import type { PiHealthItem } from "@pibot/teams-contract";

export interface LiveState {
  /** Runs a queue entry owns (queued, running or still draining). */
  runs: Set<string>;
  conversations: Set<string>;
  groups: Set<string>;
  /** Approvals a live run is waiting on in memory. */
  approvals: Set<string>;
  /** Background commands this process owns. */
  background(id: string): boolean;
  /** An open paused card whose run can never resume (the paused-approval fix's own check). */
  pauseMovedOn(id: string): boolean;
}

export function liveState(ctx: CapabilityContext): LiveState {
  const contexts = ctx.chat.queue.resources().contexts;
  return {
    runs: new Set(contexts.map((entry) => entry.runId)),
    conversations: new Set(contexts.map((entry) => entry.conversationId)),
    groups: new Set(contexts.flatMap((entry) => (entry.groupId ? [entry.groupId] : []))),
    approvals: new Set(ctx.local.approvals.waitingIn(() => true).map((approval) => approval.id)),
    background: (id) => ctx.local.background.owns(id),
    pauseMovedOn: (id) => ctx.approvalRepair.pauseMovedOn(id),
  };
}

/** A short program fingerprint of the facts an item was judged on (never shown to people). */
export function fingerprint(...facts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
}

/** An item before names are filled in: ids only, so detection never formats text. */
export type DraftItem = Omit<PiHealthItem, "where"> & {
  where: { botId?: string; groupId?: string; conversationId?: string; title?: string };
};

export const olderThan = (at: string | null | undefined, ms: number, now: number) =>
  !!at && Date.parse(at) <= now - ms;
