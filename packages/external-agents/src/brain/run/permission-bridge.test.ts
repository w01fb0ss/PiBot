import { type RequestPermissionParams, requestPermissionParams } from "@pibot/acp-schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerPermission,
  type PermissionScope,
  PIBOT_BRIDGE_GATED,
  TurnPermissionCalls,
} from "./permission-bridge.ts";

const { authorize, ask } = vi.hoisted(() => ({ authorize: vi.fn(), ask: vi.fn() }));
vi.mock("@pibot/brain/kit", () => ({
  auditText: (value: string) => value,
  authorizeDelegatedAction: authorize,
  askForUnmappedAction: ask,
}));

const signal = new AbortController().signal;
function request(
  toolCall: RequestPermissionParams["toolCall"],
  ...kinds: RequestPermissionParams["options"][number]["kind"][]
): RequestPermissionParams {
  return {
    sessionId: "session",
    toolCall,
    options: kinds.map((kind) => ({ kind, optionId: kind, name: kind })),
  };
}

function scope() {
  return {
    local: { deps: { redactor: {} } } as PermissionScope["local"],
    context: {} as PermissionScope["context"],
    agentName: "Test agent",
    cwd: "/workspace",
    unisolated: false,
    announcedCalls: new TurnPermissionCalls(),
    beforeWrite: vi.fn(),
    audit: vi.fn(),
  } satisfies PermissionScope;
}

const command = {
  toolCallId: "command",
  kind: "execute",
  rawInput: { command: "echo ready" },
} as const;
const bridge = { toolCallId: "bridge", kind: "other", title: "mcp.pibot.browser_open" } as const;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ACP permission answers", () => {
  it.each([command, bridge])("refuses a lasting-only grant for $toolCallId", async (call) => {
    const run = scope();
    await expect(
      answerPermission(run, request(call, "allow_always", "reject_once"), signal),
    ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    expect(run.audit).toHaveBeenCalledExactlyOnceWith(
      { allowed: false, reason: "external_agent_explicit_always_required" },
      call.kind,
      true,
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(run.beforeWrite).not.toHaveBeenCalled();
  });

  it("cancels a parsed request with a single lasting grant and an opaque ID", async () => {
    const params = requestPermissionParams.parse({
      ...request(command),
      options: [{ kind: "allow_always", name: "Always allow", optionId: "opaque-id" }],
    });
    const run = scope();
    await expect(answerPermission(run, params, signal)).resolves.toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(run.audit).toHaveBeenCalledExactlyOnceWith(
      { allowed: false, reason: "external_agent_explicit_always_required" },
      "execute",
      true,
    );
  });

  it("rejects a wire request with an unknown option kind", () => {
    const params = request(command, "allow_always");
    expect(
      requestPermissionParams.safeParse({
        ...params,
        options: [...params.options, { kind: "custom", name: "Custom", optionId: "opaque-id" }],
      }).success,
    ).toBe(false);
  });

  it("cancels when the grant and rejection are both lasting", async () => {
    await expect(
      answerPermission(scope(), request(command, "allow_always", "reject_always"), signal),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels when an option ID can refer to either a one-time or lasting grant", async () => {
    const params = request(command, "allow_once", "allow_always", "reject_once");
    params.options[1] = { kind: "allow_always", name: "Always allow", optionId: "allow_once" };
    const run = scope();
    await expect(answerPermission(run, params, signal)).resolves.toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(run.audit).toHaveBeenCalledExactlyOnceWith(
      { allowed: false, reason: "external_agent_ambiguous_options" },
      "execute",
      true,
    );
    expect(authorize).not.toHaveBeenCalled();
  });

  it("selects the one-time option after policy allows the action", async () => {
    authorize.mockResolvedValue({ allowed: true, reason: "approved" });
    const run = scope();
    await expect(
      answerPermission(run, request(command, "allow_always", "allow_once"), signal),
    ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
    expect(authorize).toHaveBeenCalledOnce();
    expect(run.audit).toHaveBeenCalledExactlyOnceWith(
      { allowed: true, reason: "approved" },
      "execute",
      true,
    );
  });

  it("honors a policy denial even when both allow options are present", async () => {
    authorize.mockResolvedValue({ allowed: false, reason: "permission_never" });
    await expect(
      answerPermission(
        scope(),
        request(command, "allow_always", "allow_once", "reject_once"),
        signal,
      ),
    ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
  });

  it("preserves pending command facts when a long turn reaches its announcement limit", async () => {
    const run = { ...scope(), unisolated: true };
    run.announcedCalls.record({ sessionUpdate: "tool_call", ...command, kind: "search" });
    for (let i = 0; i < 510; i++)
      run.announcedCalls.record({
        sessionUpdate: "tool_call",
        toolCallId: `read-${i}`,
        kind: "read",
      });
    authorize.mockResolvedValue({ allowed: true, reason: "approved" });

    const late = request({ toolCallId: "command", kind: "search" }, "allow_once", "reject_once");
    await expect(answerPermission(run, late, signal)).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(
      run.local,
      run.context,
      expect.objectContaining({
        tool: "run_command",
        input: { command: "echo ready", cwd: run.cwd },
      }),
      expect.objectContaining({ unisolated: true }),
    );

    const incomplete = request(
      { toolCallId: "read-509", kind: "search" },
      "allow_once",
      "reject_once",
    );
    await expect(answerPermission(run, incomplete, signal)).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(run.audit).toHaveBeenLastCalledWith(
      { allowed: false, reason: "authorization_failed" },
      "other",
      false,
    );
  });

  it("authorizes the announced Windows command when the request only names its call ID", async () => {
    const run = { ...scope(), unisolated: true };
    run.announcedCalls.record({ sessionUpdate: "tool_call", ...command });
    run.announcedCalls.record({
      sessionUpdate: "tool_call_update",
      toolCallId: command.toolCallId,
      rawInput: { command: ["cmd.exe", "/c", "ver"] },
    });
    run.announcedCalls.record({
      sessionUpdate: "tool_call_update",
      toolCallId: command.toolCallId,
      kind: "other",
    });
    authorize.mockResolvedValue({ allowed: true, reason: "approved" });

    await expect(
      answerPermission(run, request({ toolCallId: command.toolCallId }, "allow_once"), signal),
    ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(
      run.local,
      run.context,
      {
        id: "acp-command",
        tool: "run_command",
        input: { command: "cmd.exe /c ver", cwd: run.cwd },
      },
      expect.objectContaining({ unisolated: true }),
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it.each(["read", "search"] as const)(
    "uses command policy on the first Windows permission request labeled %s",
    async (kind) => {
      const run = { ...scope(), unisolated: true };
      authorize.mockResolvedValue({ allowed: false, reason: "permission_never" });
      const call = {
        ...command,
        kind,
        title: bridge.title,
        rawInput: { cmd: "Write-Output ready", path: "/workspace/file.txt" },
      };

      await expect(
        answerPermission(run, request(call, "allow_once", "reject_once"), signal),
      ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
      expect(authorize).toHaveBeenCalledExactlyOnceWith(
        run.local,
        run.context,
        {
          id: "acp-command",
          tool: "run_command",
          input: { command: call.rawInput.cmd, cwd: run.cwd },
        },
        expect.objectContaining({ unisolated: true }),
      );
      expect(run.audit).toHaveBeenCalledExactlyOnceWith(
        { allowed: false, reason: "permission_never" },
        "execute",
        true,
      );
      expect(ask).not.toHaveBeenCalled();
    },
  );

  it("uses command policy when a semantic call update adds command input", async () => {
    const run = { ...scope(), unisolated: true };
    run.announcedCalls.record({ sessionUpdate: "tool_call", ...bridge, kind: "search" });
    run.announcedCalls.record({
      sessionUpdate: "tool_call_update",
      toolCallId: bridge.toolCallId,
      kind: "read",
      rawInput: command.rawInput,
    });
    const params = request({ toolCallId: bridge.toolCallId, kind: "search" }, "allow_once");
    params._meta = { is_mcp_tool_approval: true };
    authorize.mockResolvedValue({ allowed: true, reason: "approved" });

    await expect(answerPermission(run, params, signal)).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(
      run.local,
      run.context,
      { id: "acp-bridge", tool: "run_command", input: { ...command.rawInput, cwd: run.cwd } },
      expect.objectContaining({ unisolated: true }),
    );
    expect(run.audit).toHaveBeenCalledExactlyOnceWith(
      { allowed: true, reason: "approved" },
      "execute",
      true,
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    { toolCallId: command.toolCallId, kind: "read" as const, rawInput: {} },
    { ...command, rawInput: { command: "x".repeat(100_001) } },
  ])("declines a command whose full input is unavailable to policy ($kind)", async (call) => {
    const run = { ...scope(), unisolated: true };
    run.announcedCalls.record({ sessionUpdate: "tool_call", ...command, kind: "read" });
    run.announcedCalls.record({
      sessionUpdate: "tool_call_update",
      toolCallId: command.toolCallId,
      kind: "search",
      rawInput: {},
    });

    await expect(
      answerPermission(run, request(call, "allow_once", "reject_once"), signal),
    ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    expect(run.audit).toHaveBeenCalledExactlyOnceWith(
      { allowed: false, reason: "authorization_failed" },
      "execute",
      false,
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([undefined, "execute"] as const)(
    "requires a Windows risk disclosure for an unmapped request (kind %s)",
    async (kind) => {
      const run = { ...scope(), unisolated: true };
      ask.mockResolvedValue({ allowed: false, reason: "denied" });

      await expect(
        answerPermission(
          run,
          request({ toolCallId: "unknown", kind }, "allow_once", "reject_once"),
          signal,
        ),
      ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
      expect(ask).toHaveBeenCalledExactlyOnceWith(
        run.local,
        run.context,
        expect.objectContaining({ tool: "external_agent" }),
        expect.objectContaining({ unisolatedCommand: true }),
      );
      expect(authorize).not.toHaveBeenCalled();
    },
  );

  it("recognizes an adapter-marked Pi Bot bridge approval by call ID", async () => {
    const run = { ...scope(), unisolated: true };
    expect(
      run.announcedCalls.record({
        sessionUpdate: "tool_call",
        ...bridge,
        kind: "execute",
        rawInput: { server: "pibot", tool: "browser_open" },
        _meta: { is_mcp_tool_call: true },
      }),
    ).toBe(true);
    const params = request({ toolCallId: bridge.toolCallId }, "allow_once");
    params._meta = { is_mcp_tool_approval: true };

    await expect(answerPermission(run, params, signal)).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(run.audit).toHaveBeenCalledExactlyOnceWith(
      { allowed: true, reason: PIBOT_BRIDGE_GATED },
      "execute",
      true,
    );
    expect(ask).not.toHaveBeenCalled();
  });
});
