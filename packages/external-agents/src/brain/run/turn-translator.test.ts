import { EXTERNAL_AGENT_EXPLICIT_ALWAYS_REQUIRED } from "@pibot/policy";
import { expect, it, vi } from "vitest";
import { TurnTranslator } from "./turn-translator.ts";

vi.mock("@pibot/brain/kit", () => ({ auditText: (text: string) => text }));

const reason = EXTERNAL_AGENT_EXPLICIT_ALWAYS_REQUIRED;

it("records and emits one extra permission refusal when the tool history is full", () => {
  const tools = {
    create: vi.fn(({ toolCallId }: { toolCallId: string }) => ({ id: toolCallId })),
    update: vi.fn(),
  };
  const emit = vi.fn();
  const turn = new TurnTranslator(
    { tools, deps: { peer: { emit } } } as unknown as ConstructorParameters<
      typeof TurnTranslator
    >[0],
    { botId: "bot", messageId: "message", runId: "run" } as ConstructorParameters<
      typeof TurnTranslator
    >[1],
    { event: vi.fn() } as unknown as ConstructorParameters<typeof TurnTranslator>[2],
  );
  for (let index = 0; index < 500; index++) {
    turn.update({ sessionUpdate: "tool_call", toolCallId: `step-${index}`, status: "completed" });
  }
  turn.update({ sessionUpdate: "tool_call", toolCallId: "over-limit" });
  expect(tools.create).toHaveBeenCalledTimes(500);
  emit.mockClear();
  tools.update.mockClear();

  turn.permissionRefused(
    { toolCallId: "refused", kind: "execute", title: "Check version" },
    reason,
  );
  turn.permissionRefused({ toolCallId: "another-refusal", kind: "execute" }, reason);
  turn.update({ sessionUpdate: "tool_call", toolCallId: "still-over-limit" });

  expect(tools.create).toHaveBeenCalledTimes(501);
  const fallbackId = tools.create.mock.lastCall?.[0].toolCallId;
  expect(tools.update).toHaveBeenCalledExactlyOnceWith(
    fallbackId,
    expect.objectContaining({ status: "blocked", denialReason: reason }),
  );
  expect(emit).toHaveBeenCalledTimes(2);
  expect(emit).toHaveBeenLastCalledWith(
    "chat.tool",
    expect.objectContaining({
      toolCallId: fallbackId,
      phase: "end",
      status: "blocked",
      denialReason: reason,
    }),
  );
});
