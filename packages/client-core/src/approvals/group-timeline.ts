import type { Approval, Message, MethodParams } from "@pibot/protocol";

type GroupApprovalPage = MethodParams["approvals.groupTimeline"];

export async function readGroupApprovals(
  readPage: (params: GroupApprovalPage, signal: AbortSignal) => Promise<Approval[]>,
  scope: Pick<GroupApprovalPage, "groupId" | "topicId" | "since">,
  signal: AbortSignal,
): Promise<Approval[]> {
  const approvals: Approval[] = [];
  let before: string | undefined;
  const limit = 30;
  for (;;) {
    const page = await readPage({ ...scope, before, limit }, signal);
    signal.throwIfAborted();
    approvals.push(...page);
    if (page.length < limit) return approvals;
    const next = page.at(-1)?.id;
    if (!next || next === before) throw new Error("Repeated group approval cursor");
    before = next;
  }
}

export type GroupTimelineRow =
  | { id: string; message: Message; approval?: never }
  | { id: string; approval: Approval; message?: never };

/** A card and its receipt share an identity and position, even for an invisible task thread. */
export function groupTimeline(messages: readonly Message[], approvals: readonly Approval[]) {
  const ordered = [...approvals].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const rows: GroupTimelineRow[] = [];
  let index = 0;
  const addApproval = (approval: Approval) =>
    rows.push({ id: `approval:${approval.id}`, approval });
  for (const message of messages) {
    let next = ordered[index];
    while (next && next.createdAt < message.createdAt) {
      addApproval(next);
      next = ordered[++index];
    }
    rows.push({ id: message.id, message });
  }
  for (const approval of ordered.slice(index)) addApproval(approval);
  return rows;
}
