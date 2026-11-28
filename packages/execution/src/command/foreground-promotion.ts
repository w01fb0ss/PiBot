import type { CommandResult, RunCommandOptions } from "../core/types.ts";
import { ExecError } from "../core/types.ts";
import type { BackgroundJob } from "./background.ts";
import type { CommandDependencies } from "./command-context.ts";
import { timeoutOutput } from "./output-notices.ts";
import type { ProcessControl } from "./process.ts";

/** Detach the wait, never the process owner, sandbox, output stream or run temp lease. */
export async function runPromotableCommand(
  deps: Pick<
    CommandDependencies,
    "lifetime" | "adoptForeground" | "retainCommand" | "waitForForegroundCleanup"
  >,
  input: RunCommandOptions,
  execute: (
    signal: AbortSignal,
    ready: (control: ProcessControl, logPath: string) => void,
    output: (text: string) => void,
    exited: () => void,
  ) => Promise<{
    exitCode: number | null;
    truncatedOutput: string;
    logPath: string;
  }>,
): Promise<CommandResult> {
  const promotion = input.promotion;
  if (!promotion) throw new ExecError("invalid_input");
  const started = performance.now();
  const timeoutSec = input.timeoutSec ?? 120;
  const stop = new AbortController();
  let trigger: "timeout" | "user" | undefined;
  let timedOut = false;
  let control: ProcessControl | undefined;
  let job: BackgroundJob | undefined;
  let progress: ReturnType<typeof setInterval> | undefined;
  let settled = false;
  let finalOutput: string | undefined;
  let resolvePromotion!: (result: CommandResult) => void;
  const promoted = new Promise<CommandResult>((resolve) => {
    resolvePromotion = resolve;
  });
  const cancel = () => {
    if (!trigger) stop.abort();
  };
  input.signal.addEventListener("abort", cancel);
  if (input.signal.aborted) cancel();
  const signal = AbortSignal.any([stop.signal, deps.lifetime.signal]);
  const attempt = (reason: "timeout" | "user") => {
    if (trigger || settled || signal.aborted || !control?.running() || !job) return false;
    const seconds = Math.floor((performance.now() - started) / 1000);
    if (!promotion.promote(job, reason, seconds)) return false;
    trigger = reason;
    clearTimeout(timer);
    input.signal.removeEventListener("abort", cancel);
    deps.adoptForeground(job);
    resolvePromotion({
      exitCode: null,
      timedOut: false,
      stopped: false,
      durationMs: Math.round(performance.now() - started),
      logPath: job.logPath,
      truncatedOutput: control.output(),
      promoted: { id: job.id, trigger: reason, outputLines: control.lines() },
    });
    return true;
  };
  const request = () => {
    try {
      attempt("user");
    } catch {
      stop.abort();
    }
  };
  promotion.request.addEventListener("abort", request, { once: true });
  const timer = setTimeout(() => {
    try {
      if (attempt("timeout")) return;
    } catch {
      // A failed registry transaction cannot leave an unowned process beyond its deadline.
    }
    timedOut = true;
    stop.abort();
  }, timeoutSec * 1000);
  const work = Promise.resolve().then(() =>
    execute(
      signal,
      (value, logPath) => {
        control = value;
        attach(logPath);
      },
      (text) => {
        if (!trigger) input.onOutput?.(text);
      },
      () => clearTimeout(timer),
    ),
  );
  const ended = work.then(
    (result) => {
      finalOutput = result.truncatedOutput;
      return {
        exitCode: result.exitCode,
        reason: signal.aborted ? ("stopped" as const) : ("exited" as const),
      };
    },
    async (error: unknown) => {
      // Output/log failures after certified OS drain are terminal failures, not live jobs.
      // A missing certificate (including legacy adapters) must retain ownership and leases.
      if (
        !control?.drained?.() ||
        (error instanceof ExecError && error.reason === "cleanup_failed")
      ) {
        const cleanup =
          trigger && deps.waitForForegroundCleanup(error, input.runId, control?.record());
        if (!cleanup) throw error;
        await cleanup;
      }
      return { exitCode: null, reason: "failed" as const };
    },
  );
  // Retain the real operation, including failure, after the tool's wait has returned.
  deps.retainCommand(work, input.runId);
  // loggedCommand establishes the log before publishing its process handle.
  const attach = (path: string) => {
    job = {
      id: promotion.id,
      logPath: path,
      ended,
      get running() {
        return !settled && !!control?.running();
      },
      get outputLines() {
        return control?.lines() ?? 0;
      },
      listeners: { supported: true, sockets: [] },
      ports: () => [],
      output: (maxChars) => (finalOutput ?? control?.output())?.slice(-maxChars) ?? "",
      record: () => control?.record() ?? { group: 0, processes: [] },
      async writeInput() {
        throw new ExecError("invalid_input");
      },
      async stop() {
        stop.abort();
        await ended;
      },
    };
    if (control) promotion.ready(job);
    let record = JSON.stringify(job.record());
    progress = setInterval(() => {
      if (trigger && job) {
        try {
          const next = JSON.stringify(job.record());
          if (next !== record) {
            record = next;
            promotion.callbacks.onChange?.(job);
          } else promotion.callbacks.onProgress?.(job);
        } catch {
          // Registry/observer failure must not crash the owner or orphan its still-live process.
          stop.abort();
        }
      }
    }, 1000);
  };
  const completed = work
    .then(
      (result): CommandResult => ({
        ...result,
        truncatedOutput:
          timedOut && result.exitCode === null
            ? timeoutOutput(result.truncatedOutput, timeoutSec)
            : result.truncatedOutput,
        timedOut: timedOut && result.exitCode === null,
        stopped: !timedOut && signal.aborted,
        durationMs: Math.round(performance.now() - started),
      }),
    )
    .finally(() => {
      settled = true;
      clearTimeout(timer);
      clearInterval(progress);
      input.signal.removeEventListener("abort", cancel);
      promotion.request.removeEventListener("abort", request);
    });
  // Both branches stay observed even after promotion wins the race.
  void ended.catch(() => {}); // retainCommand records drain failure; ended must not certify exit.
  return Promise.race([completed, promoted]);
}
