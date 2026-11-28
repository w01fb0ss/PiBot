import type { ExecutionTarget } from "@pibot/execution";
import { createPolicy } from "@pibot/policy";
import { PermissionsSettingsSchema } from "@pibot/protocol-base";
import { DEFAULT_PERMISSIONS } from "@pibot/storage";
import { executeRunCommand } from "@pibot/tools/command";
import type { ToolRuntime } from "@pibot/tools/runtime";
import { expect, it, vi } from "vitest";
import type { PreparedTool } from "../../core/local-types.ts";
import { outsideSandboxFacts, outsideSandboxPermit } from "./outside-sandbox.ts";

it.each([
  ["node", "example.js"],
  ["python", "example.py"],
])("dispatches a settings-listed %s skill after confirmation", async (program, script) => {
  const cwd = "/work";
  const dataDir = "/pibot";
  const botId = "00000000-0000-4000-8000-000000000001";
  const platform = "darwin";
  const args = { command: `${program} ./skills/${script}` };
  const patterns = [args.command];
  const settings = PermissionsSettingsSchema.parse(DEFAULT_PERMISSIONS);
  const signal = new AbortController().signal;
  const policy = await createPolicy({
    platform,
    userHome: "/user",
    fs: { realpath: async (path) => path },
  });
  try {
    const result = await policy.evaluate({
      botId,
      request: { category: "run_command", ...args },
      commandIsolation: async () => true,
      outsideSandbox: outsideSandboxFacts({
        platform,
        local: true,
        args,
        recipe: false,
        readonlyRoots: false,
        strict: false,
        listed: patterns,
        registry: undefined,
      }),
      settings,
      workplace: { home: cwd, folders: [], currentId: "home" },
      signal,
    });
    expect(result).toMatchObject({
      decision: "ask",
      reason: "sandbox_outside_command",
      canRemember: false,
    });

    const prepared: PreparedTool = {
      call: { id: "skill-call", tool: "run_command", input: args },
      result,
      settings,
      roots: [cwd],
      cwd,
      home: cwd,
      authorization: "current",
      commandSkill: { environment: { id: "skill-env", dir: `${dataDir}/skill-env`, bin: "bin" } },
    };
    const runCommand = vi.fn<ExecutionTarget["runCommand"]>().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      stopped: false,
      durationMs: 0,
      logPath: "",
      truncatedOutput: "",
    });
    const commandSkillSecrets = vi.fn<NonNullable<ToolRuntime["commandSkillSecrets"]>>();
    const noop = () => undefined;
    const target: Pick<ExecutionTarget, "isolationStatus" | "runCommand"> = {
      isolationStatus: async () => ({ available: true }),
      runCommand,
    };
    const runtime: Partial<ToolRuntime> = {
      context: { botId, runId: "run", language: "en" },
      target: target as ExecutionTarget,
      platform,
      dataDir,
      authorizationMatches: () => true,
      assertDispatch: noop,
      commandSecretEnvironment: async () => ({}),
      commandSkillSecrets,
      commandSkillEnvironment: async () => prepared.commandSkill?.environment,
      outsideSandboxPermit: (current) =>
        outsideSandboxPermit(current as PreparedTool, undefined, { patterns, platform }),
      auditCommand: noop,
      watchCommandRoots: async () => undefined,
      beginCommandCheck: async () => undefined,
      finishCommandCheck: async () => undefined,
      commandGroupId: noop,
      writeRoots: () => [cwd],
      commandReadGuidance: noop,
      commandBrowserOpenGuidance: noop,
    };
    const execute = (call: PreparedTool) =>
      executeRunCommand(runtime as ToolRuntime, call, args, {}, signal, noop);

    await expect(execute(prepared)).rejects.toThrow("authorization_changed");
    expect(runCommand).not.toHaveBeenCalled();

    const confirmed = { ...prepared, confirmedNow: true as const };
    await execute(confirmed);
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command: args.command,
        cwd,
        outsideSandbox: { command: args.command, cwd, filters: [] },
        secretEnv: {},
      }),
    );
    expect(runCommand.mock.calls[0]?.[0]).not.toHaveProperty("skillEnv");

    runCommand.mockClear();
    commandSkillSecrets.mockResolvedValueOnce({ env: { TEST_TOKEN: "test" }, values: [] });
    await expect(execute(confirmed)).rejects.toThrow("invalid_input");
    expect(runCommand).not.toHaveBeenCalled();
  } finally {
    policy.dispose();
  }
});
