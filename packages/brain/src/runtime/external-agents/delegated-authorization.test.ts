import { yoloMustAsk } from "@pibot/policy";
import { expect, it, vi } from "vitest";
import { askForUnmappedAction, authorizeDelegatedAction } from "./delegated-authorization.ts";

const prepare = vi.hoisted(() => vi.fn());
vi.mock("../tools/local-prepare.ts", () => ({ prepareTool: prepare }));
vi.mock("../../core/yolo.ts", () => ({ runYolo: () => false }));

const signal = new AbortController().signal;
const context = { signal } as Parameters<typeof authorizeDelegatedAction>[1];
const options = { signal, title: () => "Review external command", unisolated: true };
const command = { id: "command", tool: "run_command", input: { command: "Write-Output hi" } };

it("carries Windows isolation risk to the approval in the delegating topic", async () => {
  const approval = vi.fn().mockResolvedValue("denied");
  const local = {
    deps: { platform: "win32" },
    approvals: { request: approval },
  } as unknown as Parameters<typeof authorizeDelegatedAction>[0];
  prepare.mockResolvedValue({
    result: {
      decision: "ask",
      reason: "windows_ordinary_command",
      risk: "normal",
      facts: [],
      canRemember: false,
      explanation: [],
    },
  });
  const cardContext = { ...context, language: "zh" as const };

  await expect(
    authorizeDelegatedAction(local, context, command, { ...options, cardContext }),
  ).resolves.toEqual({ allowed: false, reason: "denied" });

  expect(approval.mock.calls[0]?.slice(0, 4)).toEqual([
    expect.objectContaining({ language: "zh" }),
    command,
    expect.objectContaining({ decision: "ask", reason: "windows_unisolated" }),
    { available: false, reason: "windows_unisolated" },
  ]);
});

it("requires explicit confirmation and disclosure for a Windows command without a mapped input", async () => {
  const approval = vi.fn().mockResolvedValue("denied");
  const local = {
    deps: { platform: "win32" },
    approvals: { request: approval },
  } as unknown as Parameters<typeof askForUnmappedAction>[0];
  await askForUnmappedAction(
    local,
    context,
    { id: "command", tool: "external_agent", input: {} },
    {
      ...options,
      detail: "Run a command",
      unisolatedCommand: true,
    },
  );
  const args = approval.mock.calls[0];
  expect(args?.[3]).toEqual({ available: false, reason: "windows_unisolated" });
  expect(yoloMustAsk(args?.[2])).toBe(true);
});
