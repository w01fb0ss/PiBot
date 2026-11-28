import { randomUUID } from "node:crypto";
import type { BackgroundStartOptions, IsolationStatus } from "../core/types.ts";
import { ExecError } from "../core/types.ts";
import { prepareSandboxHost } from "../sandbox/sandbox-host-launch.ts";
import { verifyCommandAliases, verifyWorkspace } from "../sandbox/workspace.ts";
import {
  type CommandDependencies,
  type CommandResources,
  type CommandStage,
  commandIsolation,
  commandLog,
  commandResources,
  invalidBoundary,
  tempCommand,
} from "./command-context.ts";
import { commandFailure } from "./command-diagnostics.ts";
import { verifyScriptInterpreters } from "./script-interpreters.ts";
import { verifyScriptPins } from "./script-pins.ts";
import { windowsPowerShellArgs } from "./windows-shell.ts";

interface Startup {
  deps: CommandDependencies;
  input: BackgroundStartOptions;
  signal: AbortSignal;
  state: CommandStage;
  resources: CommandResources;
  logPath: string;
}
async function isolatedBackground(s: Startup) {
  const { deps, input, signal, resources: r } = s;
  const denied = input.denyWriteRoots ?? [];
  s.state.stage = "alias_scan";
  const aliases = await verifyCommandAliases(
    [...input.writeRoots, r.temp, ...(r.commandHome ? [r.commandHome] : [])],
    denied,
    signal,
    deps.options.aliasFileSystem,
    input.rootIdentities?.some((root) => root.role === "readonly"),
  );
  s.state.stage = "profile";
  const config = await deps.sandbox.config(
    input.writeRoots,
    input.network,
    signal,
    {
      dataDir: input.dataDir,
      botHome: input.botHome,
      commandHome: r.commandHome !== undefined,
      skillGroupId: input.skillGroupId,
      skillPackageIds: input.skillPackageIds,
      skillEnvIds: input.skillEnv ? [input.skillEnv.id] : undefined,
      managedSkillPython: Boolean(input.skillEnv?.python),
    },
    {
      tempDir: r.temp,
      localBinding: true,
      denyWriteRoots: [...denied, ...aliases],
      readonlyReferences: input.rootIdentities?.some((root) => root.role === "readonly"),
      readRoots: input.rootIdentities?.map((root) => root.canonicalPath),
    },
  );
  s.state.stage = "dispatch";
  const host = await prepareSandboxHost({
    tempDir: deps.options.tempDir,
    systemHome: deps.options.systemHome,
    args: deps.options.helperArgs?.sandbox,
  });
  try {
    signal.throwIfAborted();
    await verifyWorkspace(input.rootIdentities, signal);
    return await deps.background.start({
      id: input.jobId,
      toolCallId: input.toolCallId,
      shell: host.executable,
      args: host.args,
      cwd: r.cwd,
      env: host.env,
      logPath: s.logPath,
      callbacks: input.callbacks ?? {},
      host: {
        payload: host.payload({
          config,
          allowAll: input.network.allowAll,
          privateNetworkHosts: input.privateNetworkHosts ?? [],
          command: tempCommand(input.command, r.temp),
          commandId: randomUUID(),
          cwd: r.cwd,
          env: r.env,
          waitForDispatch: true,
          stdinPipe: true,
        }),
        signal,
        dispatch: () => input.assertAuthorized?.(),
        async prepared() {
          await verifyWorkspace(input.rootIdentities, signal);
          await verifyScriptPins(input.scriptPins, signal);
          await verifyScriptInterpreters(
            input.scriptInterpreters,
            {
              ...r,
              writeRoots: [...input.writeRoots, ...(r.commandHome ? [r.commandHome] : [])],
              rootIdentities: input.rootIdentities,
            },
            signal,
          );
          signal.throwIfAborted();
          input.assertAuthorized?.();
          await input.confirmDispatch?.();
          signal.throwIfAborted();
        },
        cleanup: host.cleanup,
      },
    });
  } catch (error) {
    if (!(error instanceof ExecError && error.reason === "cleanup_failed")) await host.cleanup();
    throw error;
  }
}
async function backgroundProcess(s: Startup, isolation: IsolationStatus) {
  if (isolation.available) return isolatedBackground(s);
  const { deps, input, signal, resources: r } = s;
  signal.throwIfAborted();
  await verifyWorkspace(input.rootIdentities, signal);
  return deps.background.start({
    id: input.jobId,
    toolCallId: input.toolCallId,
    shell: r.env.SHELL as string,
    args:
      deps.options.platform === "win32"
        ? windowsPowerShellArgs(input.command, r.env.PATH ?? r.env.Path)
        : ["--noprofile", "--norc", "-c", input.command],
    cwd: r.cwd,
    env: r.env,
    logPath: s.logPath,
    callbacks: input.callbacks ?? {},
    async beforeSpawn() {
      await verifyScriptPins(input.scriptPins, signal);
      await verifyScriptInterpreters(
        input.scriptInterpreters,
        {
          ...r,
          writeRoots: [...input.writeRoots, ...(r.commandHome ? [r.commandHome] : [])],
          rootIdentities: input.rootIdentities,
        },
        signal,
      );
      signal.throwIfAborted();
      input.assertAuthorized?.();
      await input.confirmDispatch?.();
      signal.throwIfAborted();
    },
  });
}
export function createCommandLauncher(deps: CommandDependencies) {
  return async (input: BackgroundStartOptions) => {
    if (input.gitHook || input.hostSsh || input.gitOutput) throw new ExecError("invalid_input");
    if (invalidBoundary(input, input.jobId)) throw new ExecError("invalid_input");
    const signal = AbortSignal.any([
      input.signal,
      deps.lifetime.signal,
      AbortSignal.timeout(60_000),
    ]);
    const state: CommandStage = { stage: "workspace" };
    let temp: string | undefined;
    try {
      await verifyWorkspace(input.rootIdentities, signal);
      const isolation = await commandIsolation(deps, input, signal, state);
      state.stage = "environment";
      temp = await deps.temps.forJob();
      const resources = await commandResources(deps, input, temp, signal);
      state.stage = "log";
      const logPath = await commandLog(resources.home, "background", input.jobId);
      const job = await backgroundProcess(
        { deps, input, signal, state, resources, logPath },
        isolation,
      );
      const owned = temp;
      temp = undefined;
      void job.ended.then(() => deps.temps.remove(owned));
      return job;
    } catch (error) {
      commandFailure(
        deps.options,
        {
          runId: input.runId ?? input.jobId,
          stage: state.stage,
          readonlyRoots: input.denyWriteRoots?.length ?? 0,
        },
        error,
      );
      if (error instanceof ExecError && error.reason === "cleanup_failed") {
        deps.failDrain(error, input.jobId);
        temp = undefined;
      }
      if (error instanceof ExecError) throw error;
      throw new ExecError("command_failed");
    } finally {
      if (temp) await deps.temps.remove(temp);
    }
  };
}
