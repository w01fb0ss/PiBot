import type { Approval, Message } from "@pibot/protocol";
import { expect, it } from "vitest";
import { groupTimeline } from "../src/approvals/group-timeline.ts";

it("inserts task approvals by request time and replaces them in place with receipts", () => {
  const message = (id: string, createdAt: string): Message => ({
    id,
    createdAt,
    updatedAt: createdAt,
    conversationId: "topic",
    botId: null,
    runId: null,
    role: "user",
    status: "done",
    content: "Cover sketch",
    errorCode: null,
    usage: null,
  });
  const before = message("before", "2026-01-01T00:00:00.000Z");
  const after = message("after", "2026-01-01T00:00:05.000Z");
  const card: Approval = {
    id: "card",
    createdAt: "2026-01-01T00:00:02.000Z",
    expiresAt: "2026-01-01T00:10:02.000Z",
    conversationId: "task-thread",
    messageId: "hidden-message",
    runId: "task-run",
    botId: "member",
    toolCallId: "request",
    category: "run_command",
    risk: "normal",
    title: "Create cover",
    facts: [],
    canRemember: false,
    isolation: { available: true },
    status: "pending",
    resolvedAt: null,
    remembered: false,
  };
  const receipt: Approval = {
    ...card,
    status: "expired",
    superseded: true,
    resolvedAt: "2026-01-01T00:12:00.000Z",
  };
  const pending = groupTimeline([before, after], [card]);
  const answered = groupTimeline([before, after], [receipt]);
  expect(pending.map((row) => row.id)).toEqual(["before", "approval:card", "after"]);
  expect(answered.map((row) => row.id)).toEqual(pending.map((row) => row.id));
  expect(answered[1]?.approval).toBe(receipt);
});
