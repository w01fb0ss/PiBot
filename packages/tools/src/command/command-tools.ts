import { createHash } from "node:crypto";
import { dockerFailureHint, ExecError, SECRET_OUTPUT_WITHHELD } from "@pibot/execution";
import type { AuditDetail } from "@pibot/protocol-base";
import type { PreparedToolView, ToolResult, ToolRuntime } from "../runtime/tool-runtime.ts";
import { type BackgroundTextValues, backgroundText } from "./background-text.ts";
import { searchNoMatch } from "./no-match.ts";

export interface RunCommandArgs {
  command: string;
  /** Opaque browser handles only; never plaintext environment values. */
  env?: Record<string, string>;
  cwd?: string;
  timeoutSec?: number;
  background?: boolean;
  docker?: boolean;
  /** Judged by policy; what they open reaches execution as `writeRoots`, never as-is. */
  writePaths?: string[];
  /** Reaches execution only as a permit after a person confirmed this exact call. */
  outsideSandbox?: true;
}

export interface BackgroundCommandArgs {
  action: "list" | "output" | "wait" | "stop";
  id?: string;
  maxChars?: number;
  seconds?: number;
  /** "end": return only when the command ends (up to 600 s); default returns on new output. */
  until?: "output" | "end";
}

export interface WriteStdinArgs {
  id: string;
  text: string;
  eof?: boolean;
}

/** Execute one foreground or background command after brain has prepared and authorized it. */
export async function executeRunCommand(
  runtime: ToolRuntime,
  prepared: PreparedToolView,
  args: RunCommandArgs,
  auditFields: AuditDetail,
  signal: AbortSignal,
  output: (text: string) => void,
): Promise<ToolResult> {
  const isolation = await runtime.target.isolationStatus(signal);
  if (!runtime.authorizationMatches(prepared)) throw new ExecError("invalid_input");
  if (!isolation.available && !prepared.docker && !runtime.allowsUnisolated(prepared.call.id))
    throw new ExecError("isolation_unavailable");
  if (!isolation.available && prepared.boundary?.roots.some((root) => root.role === "readonly"))
    throw new ExecError("isolation_unavailable");
  if (prepared.docker && prepared.secretUses?.length) throw new ExecError("invalid_input");

  if (args.outsideSandbox && (args.background || prepared.docker))
    throw new ExecError("invalid_input");
  const validateHandles = runtime.validateCommandHandles?.bind(runtime);
  const secretEnv = await runtime.commandSecretEnvironment(prepared, signal);
  const handles = args.env ? await runtime.commandHandleEnvironment?.(prepared, signal) : undefined;
  if (args.env && (!handles || !validateHandles)) throw new ExecError("invalid_input");
  if (handles && (args.background || args.docker || args.outsideSandbox))
    throw new ExecError("invalid_input");
  if (handles) {
    for (const [name, value] of Object.entries(handles.env)) {
      if (Object.hasOwn(secretEnv, name)) throw new ExecError("invalid_input");
      secretEnv[name] = value;
    }
  }
  const skillSecrets = await runtime.commandSkillSecrets?.(prepared, signal);
  if (skillSecrets) {
    if (!isolation.available || args.background || args.docker || args.outsideSandbox || handles)
      throw new ExecError("invalid_input");
    for (const [name, value] of Object.entries(skillSecrets.env)) {
      if (Object.hasOwn(secretEnv, name)) throw new ExecError("invalid_input");
      secretEnv[name] = value;
    }
  }
  // Brain resolves the prepared runtime for this skill scope; nothing here comes from args.
  const skillEnv = await runtime.commandSkillEnvironment?.(prepared);
  runtime.assertDispatch(prepared);
  // Spent here, once: a confirmed outside run (or listed command) gets its one-time permit.
  const outsideSandbox = runtime.outsideSandboxPermit(prepared);
  if (
    skillEnv &&
    (prepared.docker || (!isolation.available && isolation.reason !== "windows_unisolated"))
  )
    throw new ExecError("isolation_unavailable");
  if (outsideSandbox && (args.background || skillSecrets)) throw new ExecError("invalid_input");
  const allowUnisolated = !isolation.available && runtime.allowsUnisolated(prepared.call.id);
  const commandAudit = {
    ...auditFields,
    toolCallId: prepared.call.id,
    command: auditFields.target,
    ...(prepared.result.facts?.some(
      (fact) => fact.kind === "warning" && fact.value === "sandbox_outside_auto",
    )
      ? { reasonCode: "sandbox_outside_auto_used" }
      : {}),
    ...(outsideSandbox ? { outsideSandbox: true as const } : {}),
  };
  if (args.background) {
    runtime.clearCommandChecks();
    await runtime.watchCommandRoots(prepared);
    return runtime.startBackgroundCommand({
      prepared,
      command: args.command,
      secretEnv,
      ...(skillEnv ? { skillEnv } : {}),
      allowUnisolated,
      auditFields: commandAudit,
      signal,
    });
  }

  runtime.auditCommand("started", "Command started / 命令开始", commandAudit);
  await runtime.watchCommandRoots(prepared);
  const literal = prepared.result.analysis?.literalCommand;
  const leading = prepared.result.analysis?.leadingAndCommand;
  const git = literal ?? leading?.invocation;
  const primary = prepared.boundary?.roots.find((root) => root.id === prepared.boundary?.primaryId);
  const check = await runtime.beginCommandCheck(args.command, prepared, signal);
  // Declared paths are authority only through the approval; a runner must not receive them raw.
  const {
    writePaths: _declared,
    outsideSandbox: _requested,
    env: _handleEnv,
    ...commandArgs
  } = args;
  const managedGit =
    isolation.available &&
    !outsideSandbox &&
    !prepared.docker &&
    primary &&
    git &&
    /^(?:git|\/(?:usr\/bin|bin|usr\/local\/bin|opt\/homebrew\/bin)\/git)$/.test(git.program) &&
    git.args.includes("init");
  // Automatic isolated consent covers a foreground lifetime, never automatic background promotion.
  const foreground =
    !handles &&
    !skillSecrets &&
    !prepared.docker &&
    !managedGit &&
    !outsideSandbox &&
    !prepared.result.commandNetwork
      ? runtime.prepareForegroundCommand?.(prepared)
      : undefined;
  const credentialProgram = outsideSandbox
    ? undefined
    : runtime.commandCredentialProgram?.(prepared);
  const localServices = runtime.commandLocalServices?.(prepared);
  const privateHosts =
    outsideSandbox || prepared.docker ? [] : (runtime.commandPrivateHosts?.() ?? []);
  const network = withPrivateHosts(
    prepared.result.commandNetwork ?? prepared.settings.network,
    privateHosts,
  );
  const result = await runtime.target
    .runCommand({
      ...(foreground ? { promotion: foreground.promotion } : {}),
      ...commandArgs,
      ...(prepared.result.windowsReadProven && !prepared.docker && prepared.result.command
        ? { command: prepared.result.command }
        : {}),
      rootIdentities: prepared.boundary?.roots,
      denyWriteRoots: prepared.boundary?.denyWriteRoots,
      cwd: prepared.cwd,
      dataDir: runtime.dataDir,
      botHome: prepared.home,
      skillGroupId: runtime.commandGroupId(),
      skillPackageIds: runtime.commandSkillPackageIds?.(),
      // Settings can send a prepared skill command outside after confirmation. Drop its runtime.
      ...(skillEnv && !outsideSandbox ? { skillEnv } : {}),
      runId: runtime.context.runId,
      toolCallId: prepared.call.id,
      writeRoots: runtime.writeRoots(prepared),
      network,
      privateNetworkHosts: privateHosts.map((host) => (host.includes(":") ? `[${host}]` : host)),
      pathEntries: prepared.settings.pathEntries,
      ...(credentialProgram ? { credentialProgram } : {}),
      docker: prepared.docker,
      ...(runtime.commandSystemServices
        ? { systemServices: runtime.commandSystemServices(prepared) }
        : {}),
      ...(localServices ? { localServices } : {}),
      secretEnv,
      ...(skillSecrets ? { secretOutput: skillSecrets.values } : {}),
      ...(handles
        ? {
            secretOutput: handles.values,
            confirmDispatch: () => {
              if (!validateHandles) throw new ExecError("invalid_input");
              return validateHandles(prepared, signal);
            },
          }
        : {}),
      ...(prepared.docker
        ? { assertDockerAuthorized: () => runtime.assertDockerDispatch(prepared) }
        : {}),
      // The scripts this verdict read are re-checked right before the run starts.
      ...(prepared.result.analysis?.scriptPins?.length
        ? { scriptPins: prepared.result.analysis.scriptPins }
        : {}),
      // N2: and the interpreters it assumed are the system ones.
      ...(prepared.result.analysis?.scriptInterpreters?.length
        ? { scriptInterpreters: prepared.result.analysis.scriptInterpreters }
        : {}),
      assertAuthorized: () => runtime.assertDispatch(prepared),
      ...(prepared.gitEntries?.plan?.remotePlanId
        ? { gitEntryPlanId: prepared.gitEntries.plan.remotePlanId }
        : {}),
      ...(prepared.result.windowsReadOnly &&
      (prepared.result.windowsReadProven || prepared.result.reason === "windows_read_only") &&
      !prepared.docker
        ? { windowsReadOnly: true as const }
        : {}),
      signal,
      onOutput: output,
      allowUnisolated,
      ...(outsideSandbox ? { outsideSandbox } : {}),
      ...(managedGit
        ? {
            gitInitialization: {
              program: git.program,
              argv: git.args,
              directory: leading?.directory,
              remainder: leading?.remainder,
              primary,
              assertAuthorized() {
                if (!runtime.authorizationMatches(prepared))
                  throw new ExecError("outside_workplace");
              },
            },
          }
        : {}),
    })
    .finally(() => foreground?.dispose());
  if (
    (outsideSandbox ||
      prepared.result.reason === "local_service_once" ||
      prepared.result.reason === "system_service_once") &&
    !result.stopped &&
    !result.timedOut &&
    !result.promoted
  )
    runtime.rememberOutsideCommand?.(prepared);
  await runtime.finishCommandCheck(
    check,
    prepared.call.id,
    result.exitCode === 0 && !result.timedOut && !result.stopped,
    signal,
  );
  if ((handles || skillSecrets) && result.truncatedOutput.includes(SECRET_OUTPUT_WITHHELD)) {
    runtime.auditCommand("finished", "Secret output withheld / 秘密输出已扣留", {
      ...commandAudit,
      exitCode: result.exitCode,
      reasonCode: SECRET_OUTPUT_WITHHELD,
    });
    return { text: SECRET_OUTPUT_WITHHELD, isError: true };
  }
  // Computed before the record so the audit page can tell "no matches" apart from a real
  // failure; the record itself keeps the true exit code.
  const noMatches =
    !result.stopped &&
    !result.timedOut &&
    !result.sandboxBlock &&
    searchNoMatch(prepared.result.analysis, result.exitCode, result.truncatedOutput);
  if (!result.promoted)
    runtime.auditCommand("finished", "Command finished / 命令结束", {
      ...auditFields,
      toolCallId: prepared.call.id,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stopped: result.stopped,
      ...(noMatches ? { noMatches: true as const } : {}),
      ...(result.sandboxBlock ? { sandboxBlockKinds: result.sandboxBlock.kinds } : {}),
      ...(result.pinnedFilters ? { outsideFilters: "pinned_system_path" as const } : {}),
    });
  if (result.promoted) {
    runtime.clearCommandChecks();
    const { id, trigger, outputLines } = result.promoted;
    const seconds = Math.floor(result.durationMs / 1000);
    return {
      text: `${trigger === "user" ? "用户已把这条命令转到后台 / The user moved this command to the background.\n" : ""}已运行 ${seconds} 秒，已转入后台（id ${id}），已输出 ${outputLines} 行 / Ran for ${seconds}s; moved to background (id ${id}); ${outputLines} output lines.\n${result.truncatedOutput}\n${backgroundText("started", runtime.context.language, { id, logPath: result.logPath, running: true, visible: true })}`,
      untrustedContent: result.truncatedOutput.length > 0,
      summary: runtime.context.language === "zh" ? "已转入后台" : "Moved to background",
      details: {
        backgroundWaiting: true,
        backgroundJobId: id,
        backgroundStatus: "running",
        durationMs: result.durationMs,
        logPath: result.logPath,
      },
    };
  }
  // grep / rg exit 1 with no output means "no matches"; as a failure it made the model
  // retry the same query until the repetition budget stopped the run. Every other non-zero exit
  // stays a failure.
  const failed = !noMatches && result.exitCode !== 0 && !result.stopped && !result.timedOut;
  const succeeded = !failed && !result.stopped && !result.timedOut;
  const dockerHint = failed ? dockerFailureHint(result.truncatedOutput) : undefined;
  // A block the sandbox itself reported counts after exit 0 too (`aws … | head` exits 0
  // with "Unable to locate credentials"), so the model is told before it trusts that output.
  const block = !result.stopped && !result.timedOut ? result.sandboxBlock : undefined;
  if (
    block &&
    isolation.available &&
    !outsideSandbox &&
    block.items.length === 1 &&
    block.items[0]?.rule === "proxy_denied"
  ) {
    const retried = await runtime.retrySandboxWebsite?.(prepared, block, signal);
    if (retried) return retried;
  }
  const offerOutside = block ? runtime.recordSandboxBlock(prepared, block) : false;
  const commandHint = failed
    ? runtime.commandFailureGuidance(
        literal,
        result.truncatedOutput,
        block,
        offerOutside,
        isolation.available && !outsideSandbox && !prepared.docker,
        network,
        prepared.result.analysis?.commands,
        !!outsideSandbox,
      )
    : block
      ? // Only the block: the other failure hints describe output of a command that failed.
        runtime.commandFailureGuidance(
          undefined,
          "",
          block,
          offerOutside,
          isolation.available && !outsideSandbox && !prepared.docker,
        )
      : undefined;
  const repeatCount = block ? (runtime.sandboxBlockRepeatCount?.(prepared, block) ?? 0) : 0;
  const repeatHint =
    repeatCount >= 3
      ? `同样的操作已被拦 ${repeatCount} 次，换个办法或请用户处理 / The same operation has been blocked ${repeatCount} times; try another approach or ask the user to handle it.`
      : undefined;
  // Only a read that worked says anything about where the next read should go; a failed
  // command already carries its own diagnostic and must not be drowned out.
  const readHint = succeeded ? runtime.commandReadGuidance(literal) : undefined;
  const browserHint = succeeded ? runtime.commandBrowserOpenGuidance(literal) : undefined;
  const outcome = result.stopped
    ? "已停止 / Stopped"
    : result.timedOut
      ? "执行超时 / Command timed out"
      : noMatches
        ? "没有匹配 / no matches (exit 1)"
        : `退出码 / Exit code: ${result.exitCode ?? "unknown"}`;
  return {
    text: `${prepared.docker && runtime.platform !== "darwin" ? "注意：本次 Docker 客户端未隔离，Docker 可访问工作文件夹外的宿主文件，容器可能继续运行 / Warning: this Docker client is not isolated; Docker can access host files outside the workspace and containers may keep running.\n" : ""}${result.truncatedOutput}${dockerHint ? `\n\n诊断提示 / Diagnostic note: ${dockerHint}` : ""}${commandHint ? `\n\n${commandHint}` : ""}${repeatHint ? `\n\n${repeatHint}` : ""}${readHint ? `\n\n${readHint}` : ""}${browserHint ? `\n\n${browserHint}` : ""}\n${outcome}`,
    untrustedContent: result.truncatedOutput.length > 0,
    isError: result.stopped || result.timedOut || (!noMatches && result.exitCode !== 0),
    details: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stopped: result.stopped,
      durationMs: result.durationMs,
      logPath: result.logPath,
    },
  };
}

/** Model-facing control of already registered background commands. */
export async function executeBackgroundCommand(
  runtime: Pick<
    ToolRuntime,
    | "context"
    | "listBackgroundCommands"
    | "getBackgroundCommand"
    | "stopBackgroundCommand"
    | "backgroundOutput"
    | "waitBackgroundOutput"
    | "observeBackground"
  >,
  args: BackgroundCommandArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  signal.throwIfAborted();
  const language = runtime.context.language;
  if (args.action === "list")
    return {
      text: backgroundText("list", language, { rows: runtime.listBackgroundCommands(10) }),
    };
  const row = args.id ? runtime.getBackgroundCommand(args.id) : undefined;
  if (!row) return { text: backgroundText("unknown", language), isError: true };
  if (args.action === "stop") {
    const stopped = await runtime.stopBackgroundCommand(row.id);
    return {
      text: backgroundText("stopped", language, { rows: [stopped] }),
      details: {
        backgroundJobId: stopped.id,
        backgroundStatus: stopped.status,
        exitCode: stopped.exitCode,
        timedOut: stopped.stopReason === "time_limit",
        stopped: stopped.status === "stopped",
      },
    };
  }
  const value =
    args.action === "wait"
      ? await runtime.waitBackgroundOutput(
          row.id,
          args.maxChars ?? 4000,
          // Only a wait for the end may block long; output waits keep the short cap.
          args.until === "end" ? (args.seconds ?? 300) : Math.min(args.seconds ?? 30, 60),
          signal,
          args.until === "end",
        )
      : runtime.backgroundOutput(row.id, args.maxChars ?? 4000);
  const ended = value.row.status !== "running";
  const idle =
    !ended &&
    runtime.observeBackground?.(row.id, JSON.stringify([value.row.outputLines, value.output]));
  return {
    details: {
      backgroundWaiting: !ended,
      backgroundJobId: value.row.id,
      backgroundStatus: value.row.status,
      exitCode: value.row.exitCode,
      timedOut: value.row.stopReason === "time_limit",
      stopped: value.row.status === "stopped",
    },
    text:
      backgroundText("output", language, {
        rows: [value.row],
        output: value.output,
        permissionOnly: value.permissionOnly,
        logPath: value.logPath,
      }) +
      (args.action === "wait" ? `\n${language === "zh" ? "是否已结束" : "Ended"}: ${ended}` : "") +
      (idle
        ? language === "zh"
          ? "\n后台命令仍在运行，没有新输出。请结束这一轮，命令结束后会自动接着做。"
          : "\nThe background command is still running with no new output. End this turn; completion will automatically continue the task."
        : ""),
  };
}

/** A live process cannot have its original sandbox narrowed after launch. */
export function backgroundInputScope(
  prepared: Pick<PreparedToolView, "settings" | "cwd" | "boundary">,
) {
  return createHash("sha256")
    .update(JSON.stringify([prepared.settings, prepared.cwd, prepared.boundary]))
    .digest("hex");
}

export async function executeWriteStdin(
  runtime: ToolRuntime,
  prepared: PreparedToolView,
  args: WriteStdinArgs,
  signal: AbortSignal,
): Promise<ToolResult> {
  const target = runtime.backgroundInputTarget(args.id);
  const assertCurrent = () => {
    runtime.assertDispatch(prepared);
    const current = runtime.backgroundInputTarget(args.id);
    if (current !== target || current.scope !== backgroundInputScope(prepared))
      throw new ExecError("invalid_input");
  };
  const isolation = await runtime.target.isolationStatus(signal);
  if (!isolation.available && !runtime.allowsUnisolated(prepared.call.id))
    throw new ExecError("isolation_unavailable");
  assertCurrent();
  runtime.clearCommandChecks();
  await runtime.watchCommandRoots(prepared, true);
  const audit = (phase: "started" | "finished", reasonCode: string) =>
    runtime.auditCommand(phase, "Background stdin / 后台标准输入", {
      actor: "automatic",
      toolName: "write_stdin",
      toolCallId: prepared.call.id,
      target: args.id,
      bytes: Buffer.byteLength(args.text),
      reasonCode,
    });
  audit("started", args.eof ? "stdin_eof_requested" : "stdin_requested");
  try {
    const receipt = await runtime.target.writeBackground({
      jobId: args.id,
      runId: runtime.context.runId,
      text: args.text,
      eof: args.eof ?? false,
      rootIdentities: prepared.boundary?.roots,
      signal,
      assertAuthorized: assertCurrent,
    });
    audit("finished", receipt.eof ? "stdin_eof_delivered" : "stdin_delivered");
    return {
      text: JSON.stringify({ ...receipt, id: args.id, commandCompleted: false }),
      summary:
        runtime.context.language === "zh" ? "已向后台进程写入" : "Written to background process",
    };
  } catch (error) {
    const code = error instanceof ExecError ? error.code : "internal";
    audit("finished", code === "busy" ? "stdin_busy" : "stdin_unconfirmed");
    if (error instanceof ExecError && error.reason === "cleanup_failed") throw error;
    return {
      text:
        code === "busy"
          ? "输入通道正忙，本次未写入 / Input channel is busy; this call wrote nothing"
          : "写入未确认，不要自动重发；部分输入可能已执行。先核对后台命令状态与输出 / Input delivery is unconfirmed; never resend automatically. Some input may have executed. Inspect background status and output first.",
      isError: true,
    };
  }
}

export { searchKind } from "./no-match.ts";
export type { BackgroundTextValues };
export { backgroundText };

/**
 * An explicitly listed host is the one way through the sandbox proxy's private-address block
 * (network-target.ts); the run's allowed local-network hosts are added for this command only,
 * never to the stored network settings.
 */
function withPrivateHosts(
  network: { allowAll: boolean; domains: string[] },
  hosts: readonly string[],
): { allowAll: boolean; domains: string[] } {
  if (!hosts.length) return network;
  // The proxy reads entries as URL authorities, so an IPv6 literal needs its brackets.
  const entries = hosts.map((host) => (host.includes(":") ? `[${host}]` : host));
  return { ...network, domains: [...new Set([...network.domains, ...entries])] };
}
