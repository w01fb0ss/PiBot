import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { stallTolerantTimeout, withDeadline } from "../core/deadline.ts";
import { ExecError, type ExecRedactor } from "../core/types.ts";
import { type IsolationProbeStage, IsolationProbeStageSchema } from "../sandbox/isolation-probe.ts";
import {
  MAX_REPORTED_VIOLATIONS,
  MAX_VIOLATION_CHARS,
  VIOLATIONS_LINE_BYTES,
} from "../sandbox/violation-report.ts";
import { CommandOutput } from "./output.ts";
import { PERMISSION_OUTPUT_NOTICE } from "./output-notices.ts";
import { trackProcessTree } from "./process-tree.ts";

export interface ProcessControl {
  record(): { group: number; processes: { pid: number; started: string }[] };
  output(): string;
  lines(): number;
  running(): boolean;
  /** Set only after close and an empty process-tree snapshot, before output finalization. */
  drained?(): boolean;
}

/**
 * A foreground cleanup that could not be confirmed, with the tree it leaves behind: the root pid,
 * whatever identities the monitor captured (none when every snapshot timed out under load) and the
 * spawn time, so the retry can still prove the tree gone instead of pausing until a restart.
 */
export class ProcessCleanupError extends ExecError {
  constructor(
    readonly record:
      | { group: number; processes: { pid: number; started: string }[]; spawnedAt: number }
      | undefined,
    readonly cleanup?: "unconfirmed" | "unverified",
  ) {
    super("command_failed", "cleanup_failed");
  }
}

/** The tree a cleanup failure retained, when the failure came from a foreground process. */
export function cleanupRecord(error: unknown) {
  return error instanceof ProcessCleanupError ? error.record : undefined;
}

const HostViolationsSchema = z
  .array(z.string().max(MAX_VIOLATION_CHARS))
  .max(MAX_REPORTED_VIOLATIONS);
/** The sandbox host's proxy refusals; the host is trusted, the shape is still checked. */
export function parseHostViolations(encoded: string) {
  try {
    const parsed = HostViolationsSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Malformed JSON from the host is treated like any other unknown status line.
    return undefined;
  }
}

// Windows spends 1.7–3.1 s in a single process snapshot on a loaded VM; a 7.5 s cleanup
// budget cut those reads short and reported finished commands as failed. Bounded, not unlimited.
const cleanupDeadlineMs = (platform: NodeJS.Platform) => (platform === "win32" ? 20_000 : 7_500);

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
export async function windowsTree(
  tree: Pick<ReturnType<typeof trackProcessTree>, "members">,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  // Fresh reads only: a scan started before the exit lists PIDs that may be reused by now, and one
  // started before taskkill would report the processes it just ended as still running.
  const members = await tree.members(true);
  if (!members.length) return;
  // Explicit descendant PIDs still work after the original PowerShell has exited.
  for (let offset = 0; offset < members.length; offset += 128) {
    signal.throwIfAborted();
    const batch = members.slice(offset, offset + 128);
    await new Promise<void>((resolve) => {
      const killer = spawn(
        `${env.SystemRoot}\\System32\\taskkill.exe`,
        [...batch.flatMap(({ pid }) => ["/PID", String(pid)]), "/T", "/F"],
        { env, stdio: "ignore", windowsHide: true },
      );
      // taskkill's own outcome proves nothing either way: it reports PIDs that already exited as
      // not found and may hang under load. The fresh snapshot below is the only proof.
      const timer = stallTolerantTimeout(() => {
        killer.kill();
        killer.unref();
        resolve();
      }, 2000);
      killer.once("error", () => {
        timer.clear();
        resolve();
      });
      killer.once("close", () => {
        timer.clear();
        resolve();
      });
    });
  }
  if ((await tree.members(true)).length)
    throw new ExecError("command_failed", "process_kill_failed");
}

export async function executeProcess(options: {
  shell: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  monitorEnv?: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  signal: AbortSignal;
  log: Writable;
  redactor: ExecRedactor;
  onOutput?: (text: string) => void;
  onStderr?: (text: string) => void;
  beforeSpawn?(): void;
  onProcess?(control: ProcessControl): void;
  onExit?(code: number | null): void;
  host?: {
    payload: string;
    prepared(record: ProcessControl["record"] | undefined): Promise<void>;
    dispatch?(): void;
    onProbeStage?(stage: IsolationProbeStage): void;
  };
}) {
  options.signal.throwIfAborted();
  options.beforeSpawn?.();
  options.signal.throwIfAborted();
  const monitorEnv = options.monitorEnv ?? options.env;
  const spawnedAt = Date.now();
  const child = spawn(options.shell, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.platform !== "win32",
    windowsHide: true,
    stdio: options.host ? ["pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  let failed = false;
  let processFailure: ExecError | undefined;
  let hostFailure: unknown;
  let hostReady = !options.host;
  let hostPrepared = false;
  let hostViolations: string[] | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let preparing: Promise<void> | undefined;
  let exitCode: number | null = null;
  let commandExited = false;
  const recordExit = (code: number | null) => {
    if (commandExited) return;
    commandExited = true;
    exitCode = code;
    options.onExit?.(code);
  };
  let killTask: Promise<void> | undefined;
  let windowsTreeDrained = false;
  let forceDrain: ReturnType<typeof stallTolerantTimeout> | undefined;
  let finishWait: (() => void) | undefined;
  let rootClosed = false;
  let drained = false;
  const closed = new Promise<void>((resolve) => {
    finishWait = resolve;
    child.once("close", (code) => {
      rootClosed = true;
      recordExit(options.host && !hostReady && options.signal.aborted ? null : code);
      resolve();
    });
  });
  const tree = child.pid
    ? trackProcessTree(
        child.pid,
        monitorEnv,
        options.platform,
        (error) => {
          // Once the root exited or termination began, a lost monitor cannot mean "nothing ran":
          // the command may already have done its work, so this is unconfirmed cleanup, never a
          // retryable monitor fault (found in review).
          const late = rootClosed || exitCode !== null || killTask !== undefined;
          processFailure ??= late
            ? cleanupFailed("unverified")
            : error instanceof ExecError
              ? error
              : new ExecError("command_failed", "process_monitor_failed");
          failed = true;
          terminate();
        },
        spawnedAt,
      )
    : undefined;
  const cleanupFailed = (reason?: ProcessCleanupError["cleanup"]) =>
    new ProcessCleanupError(
      child.pid
        ? { group: child.pid, processes: tree?.record().processes ?? [], spawnedAt }
        : undefined,
      options.platform === "win32" ? (reason ?? "unconfirmed") : undefined,
    );
  const terminate = () => {
    if (killTask) return;
    // Neither an escaped session retaining pipes nor failed OS cleanup may hold busy forever. A
    // stalled brain must not read as an escaped pipe holder before the queued close is seen.
    forceDrain = stallTolerantTimeout(() => {
      failed = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finishWait?.();
    }, 7500);
    const budget = cleanupDeadlineMs(options.platform);
    const deadlineSignal = AbortSignal.timeout(budget);
    killTask = withDeadline(
      (async () => {
        if (options.platform === "win32") {
          if (!tree) throw new ExecError("command_failed", "process_kill_failed");
          await windowsTree(tree, monitorEnv, deadlineSignal);
          windowsTreeDrained = true;
          return;
        }
        signalGroup(child, "SIGTERM");
        const deadline = performance.now() + 5000;
        while (await tree?.signal("SIGTERM", deadlineSignal)) {
          if (performance.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        signalGroup(child, "SIGKILL");
        await tree?.signal("SIGKILL", deadlineSignal);
      })(),
      budget,
      new ExecError("command_failed", "process_kill_failed"),
    ).catch(() => {
      failed = true;
      // The reason names the phase: retrying a command whose cleanup was unconfirmed would
      // duplicate its side effects, while a kill that failed says nothing about the command.
      processFailure ??= new ExecError("command_failed", "process_kill_failed");
      // Discovery failure must not skip the last attempt against the original group.
      if (options.platform !== "win32") {
        try {
          signalGroup(child, "SIGKILL");
        } catch {
          failed = true;
        }
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          failed = true;
        }
      }
    });
  };
  if (options.host) {
    const host = options.host;
    const status = child.stdio[3] as Readable;
    let buffer = "";
    const failHost = (error?: unknown) => {
      if (!options.signal.aborted) {
        failed = true;
        hostFailure ??= error ?? new ExecError("isolation_unavailable");
      }
      terminate();
    };
    startupTimer = setTimeout(failHost, 20_000);
    status.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      // Limits apply per line and per protocol phase: one chunk may carry `ready` and the long
      // violations line together. Status words are short; only a ready host's violations line
      // may be longer.
      const limit = () => (hostReady && !hostViolations ? VIOLATIONS_LINE_BYTES : 128);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.length > limit()) return failHost();
        if (/^exited (?:null|[0-9]{1,3})$/.test(line) && hostReady && !commandExited) {
          recordExit(line === "exited null" ? null : Number(line.slice(7)));
        } else if (line.startsWith("violations ") && hostReady && !hostViolations) {
          hostViolations = parseHostViolations(line.slice(11));
          if (!hostViolations) return failHost();
        } else if (line.startsWith("probe ") && host.onProbeStage && !hostReady) {
          const stage = IsolationProbeStageSchema.safeParse(line.slice(6));
          if (!stage.success) return failHost();
          host.onProbeStage(stage.data);
        } else if (line === "prepared" && !hostPrepared && !hostReady) {
          hostPrepared = true;
          preparing = host
            .prepared(tree?.record)
            .then(() => {
              options.signal.throwIfAborted();
              if (failed || rootClosed) throw new ExecError("isolation_unavailable");
              host.dispatch?.();
              options.signal.throwIfAborted();
              child.stdin?.write("go\n");
            })
            .catch(failHost);
        } else if (line === "ready" && hostPrepared && !hostReady) {
          hostReady = true;
          host.onProbeStage?.("run_sandbox");
          publishControl();
          clearTimeout(startupTimer);
        } else return failHost();
      }
      if (buffer.length > limit()) return failHost();
    });
    status.once("error", failHost);
    child.stdin?.once("error", failHost);
    child.once("spawn", () => child.stdin?.write(host.payload));
  }
  const output = new CommandOutput(options.log, options.onOutput, () => {
    failed = true;
    terminate();
    child.stdout?.resume();
    child.stderr?.resume();
  });
  const publishControl = () => {
    if (!tree || !hostReady || rootClosed || failed) return;
    if (!options.onProcess) return;
    void tree
      .members()
      .then(() => {
        if (rootClosed || failed || options.signal.aborted) return;
        options.onProcess?.({
          record: tree.record,
          output: () => output.snapshot(),
          lines: () => output.progress.lines,
          running: () => !commandExited && !rootClosed && !failed && !killTask,
          drained: () => drained,
        });
      })
      .catch((error: unknown) => {
        if (rootClosed || options.signal.aborted) return;
        processFailure = error instanceof ExecError ? error : new ExecError("command_failed");
        failed = true;
        terminate();
      });
  };
  if (!options.host) child.once("spawn", publishControl);
  const flushChannels: (() => void)[] = [];
  for (const source of [child.stdout, child.stderr]) {
    if (!source) continue;
    const decoder = new StringDecoder("utf8");
    const stderr = source === child.stderr;
    const channel = output.channel(options.redactor, stderr, stderr ? options.onStderr : undefined);
    let finished = false;
    const flush = () => {
      if (finished) return;
      finished = true;
      channel.push(decoder.end());
      channel.finish();
    };
    flushChannels.push(flush);
    source.on("data", (chunk: Buffer) => {
      if (!channel.push(decoder.write(chunk))) {
        child.stdout?.pause();
        child.stderr?.pause();
      }
    });
    source.once("end", flush);
    source.once("error", () => {
      processFailure ??= new ExecError("command_failed", "process_stream_failed");
      failed = true;
      terminate();
    });
  }
  const drain = () => {
    child.stdout?.resume();
    child.stderr?.resume();
  };
  options.log.on("drain", drain);
  child.once("error", () => {
    processFailure ??= new ExecError("command_failed", "process_spawn_failed");
    failed = true;
    terminate();
  });
  // exit precedes close: orphaned pipe owners cannot prevent cleanup from starting.
  child.once("exit", (code) => {
    // For a hosted command, the status pipe can still contain the shell's earlier exit.
    if (!options.host) recordExit(code);
    terminate();
  });
  options.signal.addEventListener("abort", terminate, { once: true });
  if (options.signal.aborted) terminate();
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await closed;
    // The force-drain timer only exists to unblock a wait that pipes never end; once close is
    // observed, a long cleanup snapshot must not be mistaken for an escaped pipe holder.
    forceDrain?.clear();
    clearTimeout(startupTimer);
    terminate();
    await killTask;
    await preparing;
    // The force-drain timer only unblocks broken pipes; it is not proof of process exit.
    // Report an unconfirmed cleanup distinctly so exec seals admission and retains temp roots.
    // A failed snapshot here is the same unconfirmed state: the command may already have run, so
    // it must not surface as the transient monitor fault the model is told to retry (found in
    // review).
    const leftovers =
      tree && !windowsTreeDrained
        ? await tree.members(true).then(
            (members) => members.length,
            () => {
              throw cleanupFailed("unverified");
            },
          )
        : 0;
    if (!rootClosed || leftovers) throw cleanupFailed();
    drained = true;
    for (const flush of flushChannels) flush();
    const truncatedOutput = await Promise.race([
      output.finish(),
      new Promise<never>((_, reject) => {
        finishTimer = setTimeout(() => {
          options.log.destroy();
          reject(new ExecError("output_failed"));
        }, 1000);
      }),
    ]);
    if (hostFailure instanceof ExecError) throw hostFailure;
    if (!hostReady && !options.signal.aborted) throw new ExecError("isolation_unavailable");
    if (failed) throw processFailure ?? new ExecError("command_failed", "process_unknown");
    const permissionOnly = output.permissionErrors.finish();
    return {
      exitCode,
      ...(exitCode !== 0 ? { denials: output.denials.finish() } : {}),
      ...(hostViolations?.length ? { violations: hostViolations } : {}),
      ...(output.loginHints.finish() ? { loginMissing: true as const } : {}),
      truncatedOutput:
        exitCode === 1 && !options.signal.aborted && permissionOnly
          ? PERMISSION_OUTPUT_NOTICE + truncatedOutput
          : truncatedOutput,
    };
  } finally {
    forceDrain?.clear();
    clearTimeout(startupTimer);
    clearTimeout(finishTimer);
    options.signal.removeEventListener("abort", terminate);
    options.log.removeListener("drain", drain);
    await tree?.dispose();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    child.stdio[3]?.destroy();
    child.unref();
    output.dispose();
    if (!options.log.writableEnded) options.log.destroy();
  }
}
