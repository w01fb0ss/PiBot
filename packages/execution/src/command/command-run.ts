import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import type { Writable } from "node:stream";
import { sameFile } from "../core/file-identity.ts";
import {
  type CommandResult,
  ExecError,
  type IsolationStatus,
  type RunCommandOptions,
} from "../core/types.ts";
import { verifyDockerConnection } from "../docker/docker.ts";
import { BinaryPublicationError } from "../files/binary-files.ts";
import { prepareGitHookExecution } from "../git/git-hook-execution.ts";
import { prepareGitInitialization } from "../git/git-init.ts";
import { type GitInitialization, gitInitArguments } from "../git/git-init-args.ts";
import { runGitInitialization } from "../git/git-init-run.ts";
import { stageGitOutput, validGitOutputPlan } from "../git/git-output.ts";
import { findGit } from "../git/git-process.ts";
import { credentialToolItems } from "../sandbox/credential-tools.ts";
import {
  clientPortHints,
  listeningLoopbackPorts,
  namedLoopbackServices,
} from "../sandbox/loopback-probe.ts";
import { classifySandboxBlock } from "../sandbox/sandbox-block.ts";
import { verifyCommandAliases, verifyWorkspace } from "../sandbox/workspace.ts";
import { verifyPreparedHostSsh } from "../ssh/ssh-config.ts";
import { HostSshError } from "../ssh/ssh-types.ts";
import {
  type CommandDependencies,
  type CommandResources,
  type CommandStage,
  commandIsolation,
  commandLog,
  commandResources,
  dockerResources,
  invalidBoundary,
  openCommandLog,
  tempCommand,
} from "./command-context.ts";
import { commandFailure } from "./command-diagnostics.ts";
import { removeHeredocLeftovers } from "./command-temp.ts";
import { executeHostedCommand } from "./foreground-host.ts";
import { runPromotableCommand } from "./foreground-promotion.ts";
import { PERMISSION_OUTPUT_NOTICE, timeoutOutput } from "./output-notices.ts";
import { consumeOutsideSandboxPermit, pinSystemFilters } from "./outside-sandbox.ts";
import { cleanupRecord, executeProcess, type ProcessControl } from "./process.ts";
import { createRollingCommandLog } from "./rolling-command-log.ts";
import { verifyScriptInterpreters } from "./script-interpreters.ts";
import { verifyScriptPins } from "./script-pins.ts";
import { commandMonitorEnvironment } from "./secret-env.ts";
import { windowsPowerShellArgs } from "./windows-shell.ts";

type Input = RunCommandOptions & {
  gitInitialization?: GitInitialization;
  onProcess?(control: import("./process.ts").ProcessControl, logPath: string): void;
  onExit?(code: number | null): void;
};
type Git = Awaited<ReturnType<typeof prepareGitInitialization>>;
type Phase = "directories" | "initialize" | "reinitialize";
interface Execution {
  deps: CommandDependencies;
  input: Input;
  resources: CommandResources;
  signal: AbortSignal;
  state: CommandStage;
  isolation: IsolationStatus;
  docker?: Awaited<ReturnType<typeof dockerResources>>;
  git?: Git;
  hook?: Awaited<ReturnType<typeof prepareGitHookExecution>>;
  output?: Awaited<ReturnType<NonNullable<Input["gitOutput"]>["stage"]>>;
  logPath: string;
  logIdentity?: BigIntStats;
  rolling: boolean;
  segment: { toolCallId: string; startedAt: string };
}
async function dispatchReady(e: Execution, phase?: Phase) {
  const { input, signal, deps, git } = e;
  await verifyWorkspace(input.rootIdentities, signal);
  await e.hook?.check();
  await e.output?.check();
  if (git) {
    await git.check();
    if (phase === "initialize") await git.checkFreshConfig();
    if (phase === "directories") git.dispatchSetup();
    else git.dispatch();
  }
  if (input.docker) {
    await verifyDockerConnection(deps.options.platform, deps.options.systemHome, input.docker);
    input.assertDockerAuthorized?.();
  }
  if (input.hostSsh) {
    try {
      await verifyPreparedHostSsh(input.hostSsh, signal);
    } catch (error) {
      if (error instanceof HostSshError) throw new ExecError("authorization_changed");
      throw error;
    }
  }
  await verifyScriptPins(input.scriptPins, signal);
  await verifyScriptInterpreters(
    input.scriptInterpreters,
    {
      ...e.resources,
      writeRoots: [
        ...input.writeRoots,
        ...(e.resources.commandHome ? [e.resources.commandHome] : []),
      ],
      rootIdentities: input.rootIdentities,
    },
    signal,
  );
  signal.throwIfAborted();
  input.assertAuthorized?.();
  await input.confirmDispatch?.();
  signal.throwIfAborted();
}
async function phaseConfig(e: Execution, roots: string[], phase?: Phase) {
  const { input, resources, deps, signal } = e;
  const snapshot = e.hook?.snapshot;
  // Linux's builder scans aliases after automatic Git denies; private proof is not a user deny.
  const denied = [
    ...(input.denyWriteRoots ?? []),
    ...(snapshot ? [] : (e.hook?.denyWriteRoots ?? [])),
  ];
  e.state.stage = "alias_scan";
  const aliases = await verifyCommandAliases(
    [
      ...roots,
      ...(phase ? [] : [resources.temp, ...(resources.commandHome ? [resources.commandHome] : [])]),
    ],
    denied,
    signal,
    deps.options.aliasFileSystem,
    input.rootIdentities?.some((r) => r.role === "readonly"),
  );
  e.state.stage = "profile";
  const config = await deps.sandbox.config(
    roots,
    input.network,
    signal,
    {
      dataDir: input.dataDir,
      botHome: input.botHome,
      commandHome: resources.commandHome !== undefined,
      skillGroupId: input.skillGroupId,
      skillPackageIds: input.skillPackageIds,
      skillEnvIds: input.skillEnv ? [input.skillEnv.id] : undefined,
      managedSkillPython: Boolean(input.skillEnv?.python),
      skillPythonPreparation: input.skillPythonPreparation,
      skillNodePreparation: input.skillNodePreparation?.envId,
    },
    {
      tempDir: resources.temp,
      ...(snapshot ? { hookSnapshot: snapshot } : {}),
      ...(phase && phase !== "reinitialize" && e.git
        ? { git: { phase, gitDirectory: e.git.gitDir } }
        : {}),
      ...(input.docker?.socket ? { dockerSocket: input.docker.socket } : {}),
      ...(input.systemServices ? { systemServices: input.systemServices } : {}),
      ...(input.localServices ? { localServices: input.localServices } : {}),
      denyWriteRoots: [...denied, ...aliases, ...(input.hostSsh ? [input.hostSsh.home] : [])],
      readonlyReferences: input.rootIdentities?.some((r) => r.role === "readonly"),
      readRoots: input.rootIdentities?.map((root) => root.canonicalPath),
    },
  );
  if (input.hostSsh) {
    config.filesystem.allowRead ??= [];
    config.filesystem.allowRead.push(
      ...[input.hostSsh.identity, input.hostSsh.knownHosts].map((path) => ({
        path,
        literal: true as const,
      })),
    );
  }
  return config;
}
async function executePhase(
  e: Execution,
  command: string,
  phase?: Phase,
  roots = e.input.writeRoots,
  cwd = e.resources.cwd,
): Promise<Pick<CommandResult, "exitCode" | "truncatedOutput" | "sandboxBlock" | "pinnedFilters">> {
  const { input, resources: r, signal, deps } = e;
  let file: FileHandle | undefined;
  let log: Writable | undefined;
  let rolling: Awaited<ReturnType<typeof createRollingCommandLog>> | undefined;
  // The tree this command spawned. If its cleanup cannot be confirmed, the pause must retain this
  // tree only: other background commands keep running.
  let control: ProcessControl | undefined;
  const capture = (value: ProcessControl) => {
    control = value;
    input.onProcess?.(value, e.logPath);
  };
  try {
    if (e.rolling) {
      rolling = await createRollingCommandLog(e.logPath);
      log = rolling.stream;
      log.write(`\n[PiBot command start] ${JSON.stringify(e.segment)}\n`);
    } else {
      file = await open(e.logPath, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
      const identity = await file.stat({ bigint: true });
      if (!e.logIdentity || !sameFile(identity, e.logIdentity))
        throw new ExecError("output_failed");
      log = file.createWriteStream({ autoClose: false });
    }
    if (phase === "directories")
      log.write("Git directory preparation in sandbox / 沙箱内准备Git目录\n");
    const directDocker = deps.options.platform !== "darwin" ? e.docker : undefined;
    const outside = input.outsideSandbox;
    let executed = command;
    let pinnedFilters = 0;
    if (outside) {
      // Recipes depend on SRT's rules for their own guarantees; they never run without it.
      if (phase || e.docker || e.output || e.hook || e.git || input.hostSsh || input.promotion)
        throw new ExecError("invalid_input");
      // Without SRT nothing would keep a read-only reference folder read-only (as on Windows).
      if (
        input.denyWriteRoots?.length ||
        input.rootIdentities?.some((root) => root.role === "readonly")
      )
        throw new ExecError("isolation_unavailable");
      consumeOutsideSandboxPermit(outside, {
        command: input.command,
        cwd: r.cwd,
        platform: deps.options.platform,
      });
      // Filter offsets refer to the approved text; recipes that rewrite it never run outside.
      if (command !== input.command) throw new ExecError("invalid_input");
      // The approved text stays the user's; only the line handed to the shell is pinned.
      executed = await pinSystemFilters(command, outside.filters, r.env.PATH);
      pinnedFilters = outside.filters.length;
    }
    if (e.isolation.available && !directDocker && !outside) {
      const config = await phaseConfig(e, roots, phase);
      // SRT pins the ancestors of the host cwd's literal .git/hooks deny.
      // Anchor the fixed Git phases in scratch so that rule permits the setup mkdir.
      const hostCwd = phase && deps.options.platform === "darwin" ? r.temp : cwd;
      e.state.stage = "dispatch";
      const commandId = randomUUID();
      // Started alongside the host's own startup, so a ready stream costs the command nothing.
      const tracker = deps.violations.track(commandId);
      const hosted = await executeHostedCommand({
        options: deps.options,
        config,
        allowAll: input.network.allowAll,
        // A hostname from Permissions is a public website, even on a confirmed command.
        privateNetworkHosts: input.privateNetworkHosts ?? [],
        command: phase ? command : tempCommand(command, r.temp),
        commandId,
        commandText: input.command,
        ...(input.hostSsh
          ? {
              hostSsh: {
                hostname: input.hostSsh.hostname,
                user: input.hostSsh.user,
                port: input.hostSsh.port,
                identity: input.hostSsh.identity,
                knownHosts: input.hostSsh.knownHosts,
                remoteCommand: input.hostSsh.intent.remoteCommand,
                ...(input.hostSsh.connectTimeout
                  ? { connectTimeout: input.hostSsh.connectTimeout }
                  : {}),
                ...(input.hostSsh.intent.options.quiet ? { quiet: true } : {}),
              },
            }
          : {}),
        cwd: hostCwd,
        env: r.env,
        signal,
        log,
        onOutput: input.onOutput,
        onProcess: capture,
        onExit:
          phase === "directories" || (phase && e.git?.remainder)
            ? (code) => {
                if (code !== 0) input.onExit?.(code);
              }
            : input.onExit,
        prepared: async () => {
          // Bounded inside the tracker: an unavailable monitor never holds the command back.
          await tracker?.ready;
          await dispatchReady(e, phase);
        },
        dispatch: () => input.assertAuthorized?.(),
      }).catch(async (error: unknown) => {
        // Released on failure too, so the shared stream can idle out.
        await tracker?.finish();
        throw error;
      });
      // The hosted call includes its bounded child-session grace and real tree cleanup; retain
      // commandId attribution throughout, then allow the monitor's normal 10 ms delivery settle.
      const reported = (await tracker?.finish()) ?? [];
      const { denials, violations: proxied, loginMissing, ...result } = hosted;
      const violations = [...reported, ...(proxied ?? [])];
      // Only a failure or a "no login" message makes a credential tool's run worth naming. The
      // SSH and Docker recipes bring their own identity/config, so their failures are not this.
      const credentials =
        result.exitCode !== null &&
        !signal.aborted &&
        !input.hostSsh &&
        !e.docker &&
        // Combined output can contain a filter's own error text, and a redirect can fail before
        // the program starts. Neither login phrases nor status prove a missing login there.
        input.credentialProgram?.ownsStatus &&
        (loginMissing || result.exitCode !== 0)
          ? await credentialToolItems({
              program: input.credentialProgram.program,
              userHome: deps.options.systemHome,
              botHome: r.commandHome ?? r.home,
            })
          : [];
      const listening =
        violations.length && !signal.aborted
          ? await listeningLoopbackPorts(violations, signal)
          : undefined;
      // Linux runs the command in its own network namespace, so a local service is simply not
      // there (connection refused) and no denial is reported. On macOS a client's report can be
      // port-less (adb binds `*:0` before connecting; its server's `*:5037` report arrives after
      // the command ended). A failed command whose line or output names a loopback port something
      // on this computer answers on was after that service.
      // A known client (adb) cannot reach its server from the sandbox at all, and its own reports
      // may all arrive after the command ended, so its failure alone is enough to look.
      const hints = clientPortHints(input.command, r.env);
      const namespaced =
        result.exitCode !== 0 &&
        !signal.aborted &&
        (deps.options.platform === "linux" ||
          (deps.options.platform === "darwin" &&
            (hints.length > 0 ||
              violations.some((line) => /\bnetwork-(?:bind|outbound)\b/.test(line)))))
          ? await namedLoopbackServices(
              `${input.command}\n${hints}\n${result.truncatedOutput}`,
              signal,
            )
          : [];
      const sandboxBlock =
        result.exitCode !== null &&
        !signal.aborted &&
        (denials || violations.length || credentials.length || namespaced.length)
          ? classifySandboxBlock({
              candidates: denials?.paths ?? [],
              signals: [...(denials?.signals ?? []), ...namespaced],
              violations,
              ...(listening ? { listening } : {}),
              credentials,
              homes: [deps.options.systemHome, r.commandHome ?? r.home],
              succeeded: result.exitCode === 0,
              command: input.command,
              cwd,
              profileCwd: hostCwd,
              config,
              platform: deps.options.platform,
            })
          : undefined;
      if (!sandboxBlock) return result;
      // The scan notice ("rest is complete") would misdescribe a write the sandbox refused.
      const truncatedOutput = result.truncatedOutput.startsWith(PERMISSION_OUTPUT_NOTICE)
        ? result.truncatedOutput.slice(PERMISSION_OUTPUT_NOTICE.length)
        : result.truncatedOutput;
      return { ...result, truncatedOutput, sandboxBlock };
    }
    if (input.hostSsh) throw new ExecError("isolation_unavailable");
    const readOnly =
      input.windowsReadOnly && deps.options.platform === "win32" && !directDocker
        ? { git: /\bgit(?:\.exe)?\b/i.test(command) ? await findGit(deps.options) : undefined }
        : undefined;
    if (readOnly) await restrictWindowsReadEnvironment(r, input, signal);
    if (readOnly?.git) {
      // A partial clone or replacement refs must never turn an approved read into a fetch.
      r.env.GIT_NO_LAZY_FETCH = "1";
      r.env.GIT_CONFIG_NOSYSTEM = "1";
      // The entry check binds the Bot workspace's Git config. The shell's separate
      // command-home config can be edited by ordinary commands and is not in that plan.
      r.env.GIT_CONFIG_GLOBAL = win32.join(r.home, ".gitconfig");
    }
    e.state.stage = "dispatch";
    await dispatchReady(e, phase);
    // Outside the sandbox there is nothing to attribute a denial or a missing login to.
    const {
      denials: _unclassified,
      loginMissing: _login,
      violations: _violations,
      ...direct
    } = await executeProcess({
      shell: directDocker?.program ?? (r.env.SHELL as string),
      args: directDocker
        ? directDocker.args
        : deps.options.platform === "win32"
          ? windowsPowerShellArgs(command, r.env.PATH ?? r.env.Path, readOnly)
          : ["--noprofile", "--norc", "-c", executed],
      cwd: r.cwd,
      env: r.env,
      monitorEnv: commandMonitorEnvironment(r.env, input.secretEnv),
      platform: deps.options.platform,
      signal,
      log,
      redactor: deps.options.redactor,
      onOutput: input.onOutput,
      onProcess: capture,
      onExit: input.onExit,
      beforeSpawn() {
        input.assertDockerAuthorized?.();
        input.assertAuthorized?.();
      },
    });
    return pinnedFilters ? { ...direct, pinnedFilters } : direct;
  } catch (error) {
    if (error instanceof ExecError && error.reason === "cleanup_failed")
      // The error's own record also covers a tree whose snapshots all timed out before `control`
      // was published, which left the Windows pause unprovable until a restart.
      deps.failDrain(error, undefined, cleanupRecord(error) ?? control?.record(), input.runId);
    throw error;
  } finally {
    log?.destroy();
    await rolling?.close();
    await file?.close();
  }
}

async function restrictWindowsReadEnvironment(
  resources: CommandResources,
  input: RunCommandOptions,
  signal: AbortSignal,
) {
  const { env, cwd, commandHome, home } = resources;
  const roots = [cwd, ...input.writeRoots, ...(input.denyWriteRoots ?? [])];
  const entries = await Promise.all(
    (env.PATH ?? "").split(";").map(async (entry) => {
      if (!/^[a-z]:[\\/]/i.test(entry)) return;
      signal.throwIfAborted();
      try {
        const path = await realpath(entry);
        if (!/^[a-z]:[\\/]/i.test(path) || path.includes(";")) return;
        if (
          roots.some((root) => {
            const relative = win32.relative(root, path);
            return !win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\");
          })
        )
          return;
        return path;
      } catch {
        signal.throwIfAborted();
        // A PATH entry whose backing directory is unknown cannot name a no-card executable.
      }
    }),
  );
  env.PATH = entries.filter(Boolean).join(";");
  // The Windows npm shim resolves its global CLI before it forwards --version.
  env.npm_config_prefix = commandHome ?? home;
  env.npm_config_global = "true";
  env.npm_config_ignore_scripts = "true";
}
async function closeLoggedCommand(
  runId: string,
  e: Execution | undefined,
  file: FileHandle | undefined,
  publication: { path: string; bytes: number; revision: string } | undefined,
) {
  let failure: unknown;
  let failed = false;
  const close = async (action: () => Promise<unknown> | undefined) => {
    try {
      await action();
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
  };
  if (e && !e.deps.drainFailed(runId)) {
    await close(() => e.git?.close());
    await close(() => e.hook?.close());
    await close(() => e.output?.close());
  }
  await close(() => file?.close());
  if (failed) {
    // Later stage/log cleanup failures cannot erase a preceding visible publication.
    if (publication) throw new BinaryPublicationError(publication);
    throw failure;
  }
}
async function loggedCommand(
  deps: CommandDependencies,
  input: Input,
  r: CommandResources,
  signal: AbortSignal,
  state: CommandStage,
  isolation: IsolationStatus,
) {
  const docker = await dockerResources(deps, input, r, signal);
  state.stage = "log";
  const rolling =
    !!input.promotion &&
    !input.docker &&
    !(
      input.gitInitialization &&
      gitInitArguments(input.gitInitialization.argv, r.cwd, input.gitInitialization.program)
    );
  const logPath = await commandLog(
    r.home,
    rolling ? "background" : "runs",
    rolling ? (input.promotion?.id ?? input.runId) : input.runId,
  );
  const file = rolling ? undefined : await openCommandLog(logPath);
  let e: Execution | undefined;
  let outputFile: { path: string; bytes: number; revision: string } | undefined;
  try {
    const segmentStartedAt = new Date().toISOString();
    const segmentId =
      input.toolCallId && /^[a-zA-Z0-9_.:-]{1,128}$/.test(input.toolCallId)
        ? input.toolCallId
        : "unavailable";
    await file?.write(
      `\n[PiBot command start] ${JSON.stringify({ toolCallId: segmentId, startedAt: segmentStartedAt })}\n`,
    );
    const logIdentity = await file?.stat({ bigint: true });
    if (logIdentity && !logIdentity.isFile()) throw new ExecError("output_failed");
    e = {
      deps,
      input,
      resources: r,
      signal,
      state,
      isolation,
      docker,
      logPath,
      logIdentity,
      rolling,
      segment: { toolCallId: segmentId, startedAt: segmentStartedAt },
    };
    if (input.gitOutput) {
      if (!isolation.available) throw new ExecError("isolation_unavailable");
      e.output = await stageGitOutput(input.gitOutput, input, r.temp, signal);
    }
    if (input.gitHook) {
      if (!isolation.available) throw new ExecError("isolation_unavailable");
      e.hook = await prepareGitHookExecution(input, r, signal);
    }
    if (
      !input.docker &&
      input.gitInitialization &&
      gitInitArguments(input.gitInitialization.argv, r.cwd, input.gitInitialization.program)
    ) {
      if (!isolation.available) throw new ExecError("isolation_unavailable");
      e.git = await prepareGitInitialization(
        input.gitInitialization,
        { ...input, cwd: r.cwd },
        deps.options,
        signal,
      );
    }
    const execution = e;
    let result: Awaited<ReturnType<typeof executePhase>>;
    if (e.git) {
      result = await runGitInitialization(e.git, input, signal, {
        execute: (command, phase, roots) => executePhase(execution, command, phase, roots),
      });
      if (e.git.remainder && result.exitCode === 0) {
        if (signal.aborted) result = { ...result, exitCode: null };
        else {
          const next = await executePhase(
            e,
            e.git.remainder,
            undefined,
            input.writeRoots,
            e.git.cwd,
          );
          result = {
            ...next,
            truncatedOutput: [result.truncatedOutput, next.truncatedOutput]
              .filter(Boolean)
              .join("\n"),
            sandboxBlock: next.sandboxBlock ?? result.sandboxBlock,
          };
        }
      }
    } else {
      signal.throwIfAborted();
      await verifyWorkspace(input.rootIdentities, signal);
      const spawnedAt = Date.now();
      // macOS still goes through SRT; only the program selection changes, never its arguments.
      const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
      const command =
        docker && deps.options.platform === "darwin"
          ? [docker.program, ...docker.args].map(quote).join(" ")
          : (e.output?.command ?? e.hook?.command ?? input.command);
      result = await executePhase(e, command);
      if (deps.options.platform === "darwin" && (signal.aborted || result.exitCode === null))
        await removeHeredocLeftovers(r.cwd, spawnedAt);
    }
    outputFile =
      e.output && result.exitCode === 0 && !signal.aborted ? await e.output.publish() : undefined;
    const segmentFile = rolling
      ? await open(logPath, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW)
      : undefined;
    try {
      await (file ?? segmentFile)?.write(
        `\n[PiBot command end] ${JSON.stringify({ toolCallId: segmentId, startedAt: segmentStartedAt, exitCode: result.exitCode, interrupted: signal.aborted })}\n`,
      );
    } finally {
      await segmentFile?.close();
    }
    const truncatedOutput = result.truncatedOutput.replace(
      /(\[省略 [^\n]+characters omitted\])/,
      (marker) => `${marker}\n[完整日志 / Full log: ${deps.options.redactor.redact(logPath)}]`,
    );
    return { ...result, truncatedOutput, logPath, ...(outputFile ? { outputFile } : {}) };
  } catch (error) {
    if (error instanceof BinaryPublicationError) outputFile = error.publication;
    throw error;
  } finally {
    await closeLoggedCommand(input.runId, e, file, outputFile);
  }
}
export function createCommandRunner(deps: CommandDependencies) {
  return async (input: Input) => {
    const timeoutSec = input.timeoutSec ?? 120;
    if (
      invalidBoundary(input, input.runId) ||
      (input.gitOutput &&
        (!validGitOutputPlan(input.gitOutput) ||
          !["darwin", "linux"].includes(deps.options.platform) ||
          input.promotion ||
          input.docker ||
          input.gitInitialization ||
          input.gitHook ||
          input.hostSsh ||
          input.writeRoots.length ||
          !input.assertAuthorized ||
          Object.keys(input.secretEnv ?? {}).length)) ||
      !Number.isInteger(timeoutSec) ||
      timeoutSec < 1 ||
      timeoutSec > 600 ||
      (input.gitHook &&
        (input.promotion ||
          input.docker ||
          input.gitInitialization ||
          input.hostSsh ||
          input.gitOutput))
    )
      throw new ExecError("invalid_input");
    if (
      input.hostSsh &&
      (input.gitHook ||
        deps.options.platform !== "darwin" ||
        process.platform !== "darwin" ||
        input.promotion ||
        input.docker ||
        input.gitInitialization ||
        !input.assertAuthorized ||
        Object.keys(input.secretEnv ?? {}).length ||
        input.command !== `ssh ${input.hostSsh.intent.alias} <remote command>` ||
        input.writeRoots.length > 0)
    )
      throw new ExecError("invalid_input");
    if (
      input.promotion &&
      !input.docker &&
      !(
        input.gitInitialization &&
        gitInitArguments(input.gitInitialization.argv, input.cwd, input.gitInitialization.program)
      )
    ) {
      return runPromotableCommand(deps, input, async (signal, onProcess, onOutput, onExit) => {
        const state: CommandStage = { stage: "workspace" };
        await verifyWorkspace(input.rootIdentities, signal);
        const isolation = await commandIsolation(deps, input, signal, state);
        const resources = await commandResources(
          deps,
          input,
          await deps.temps.forRun(input.runId),
          signal,
        );
        return loggedCommand(
          deps,
          { ...input, onProcess, onOutput, onExit },
          resources,
          signal,
          state,
          isolation,
        );
      });
    }
    const state: CommandStage = { stage: "workspace" };
    const started = performance.now(),
      timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutSec * 1000);
    const signal = AbortSignal.any([input.signal, deps.lifetime.signal, timeout.signal]);
    const clear = () => clearTimeout(timer);
    signal.addEventListener("abort", clear, { once: true });
    if (signal.aborted) clear();
    try {
      signal.throwIfAborted();
      await verifyWorkspace(input.rootIdentities, signal);
      const isolation = await commandIsolation(deps, input, signal, state);
      state.stage = "environment";
      const r = await commandResources(deps, input, await deps.temps.forRun(input.runId), signal);
      const result = await loggedCommand(
        deps,
        { ...input, onExit: clear },
        r,
        signal,
        state,
        isolation,
      );
      const timedOut = timeout.signal.aborted && result.exitCode === null;
      return {
        ...result,
        truncatedOutput:
          timedOut && !input.signal.aborted && !deps.lifetime.signal.aborted
            ? timeoutOutput(result.truncatedOutput, timeoutSec)
            : result.truncatedOutput,
        timedOut,
        stopped: input.signal.aborted || deps.lifetime.signal.aborted,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      commandFailure(
        deps.options,
        {
          runId: input.runId,
          stage: state.stage,
          readonlyRoots: input.denyWriteRoots?.length ?? 0,
        },
        error,
      );
      if (error instanceof ExecError) throw error;
      throw new ExecError("command_failed");
    } finally {
      clear();
      signal.removeEventListener("abort", clear);
    }
  };
}
