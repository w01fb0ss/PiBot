import { ExecError } from "../core/types.ts";
import { createBackgroundStarter } from "./background/job.ts";
import { createBackgroundMonitor } from "./background/monitor.ts";
import {
  backgroundCleanupReason,
  createBackgroundProcesses,
  groupAlive,
} from "./background/processes.ts";
import type {
  BackgroundDependencies,
  BackgroundDrainEvent,
  BackgroundJob,
  BackgroundProcessRecord,
  Job,
} from "./background/types.ts";

export type {
  BackgroundCallbacks,
  BackgroundDrainEvent,
  BackgroundEndReason,
  BackgroundJob,
  BackgroundProcessRecord,
} from "./background/types.ts";

/**
 * A cleanup that could not be confirmed stops new commands, so waiting for a restart is not an
 * option: the retained process groups are checked again on this interval.
 */
const RETRY_MS = 30_000;

/** Log a still-blocked retry once in this many attempts; a stuck group stays quiet otherwise. */
const REPORT_EVERY = 10;

/**
 * Automatic checks stop after this many (about 10 minutes) and the pause is reported as stuck, so
 * a tree that can never be proven gone no longer retries every 30 s for hours (Windows test
 * 2026-11-21: 40 silent attempts). The pause itself stays: only a manual check or a restart ends it.
 */
const MAX_AUTO_ATTEMPTS = 20;

/**
 * A retry is off every command's path, so it may wait longer for a snapshot than the command
 * monitor (10 s on Windows): the pause started because a starved host missed that limit, and
 * the same limit would keep failing the proof for as long as the load lasts.
 */
const RETRY_SNAPSHOT_MS = 30_000;
/** One attempt may take several snapshots (find, stop, confirm); bounded so shutdown never waits. */
const ATTEMPT_MS = 90_000;

interface RetainedDrain {
  reason: BackgroundDrainEvent["reason"];
  /** Captured when the failure happened: the retained job may end before the retry runs. */
  records: BackgroundProcessRecord[];
  /** Every job whose cleanup was never confirmed; a second failure while paused joins this set. */
  jobIds: string[];
  /** The run that owned the failed foreground command, when exactly one did. */
  runId?: string;
  /** All affected runs, for Windows temp and folder leases. */
  runIds: Set<string>;
  attempts: number;
  /** Bumped when another failure joins; a retry that started earlier must not release the pause. */
  revision: number;
  /** Automatic checks ended without proof; only a manual check or a restart can release it. */
  stuck: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** What the person is told: commands are paused while Pi Bot checks, or until they act. */
export type CommandPauseState = "retrying" | "stuck" | null;

/** Records are merged by tree identity so the same group is never checked or killed twice. */
const recordKey = (record: BackgroundProcessRecord) =>
  `${record.group}:${record.processes
    .map((process) => `${process.pid}:${process.started}`)
    .sort()
    .join(",")}`;

/** Instance owner; monitor and jobs retain their resources until real drain succeeds. */
export function createBackgroundJobs(deps: BackgroundDependencies) {
  const jobs = new Map<string, Job>();
  const lifetime = new AbortController();
  let drainFailure: ExecError | undefined;
  let drain: RetainedDrain | undefined;
  let retrying: Promise<void> | undefined;
  const healthyWaiters = new Set<() => void>();
  const monitor = createBackgroundMonitor(deps, jobs, lifetime);
  const processes = createBackgroundProcesses(deps);
  const report = (event: BackgroundDrainEvent) => {
    try {
      deps.onDrain?.(event);
    } catch {
      // A health sink must never decide whether the pause is released.
    }
  };
  const assertHealthy = () => {
    if (drainFailure && deps.platform !== "win32") throw drainFailure;
  };
  const drainFailed = (runId?: string) =>
    !!drainFailure &&
    (deps.platform !== "win32" || runId === undefined || drain?.runIds.has(runId) === true);
  const owner = (current: RetainedDrain) => ({
    ...(current.jobIds.length === 1 ? { jobId: current.jobIds[0] } : {}),
    ...(current.runId ? { runId: current.runId } : {}),
  });
  /** Manual and scheduled checks share one attempt; two concurrent kills of one tree prove nothing. */
  const attempt = () => {
    retrying ??= retry().finally(() => {
      retrying = undefined;
    });
    return retrying;
  };
  const schedule = () => {
    if (!drain || drain.stuck || lifetime.signal.aborted) return;
    clearTimeout(drain.timer);
    const timer = setTimeout(() => {
      if (drain) drain.timer = undefined;
      // Recovery clears `drain`; anything else is still blocked and tries again later.
      void attempt().then(schedule);
    }, RETRY_MS);
    // The retry is a safety net, not a reason to keep the process alive.
    timer.unref?.();
    drain.timer = timer;
  };
  /** Re-check the retained groups; the pause stays until an attempt proves nothing is left. */
  async function retry() {
    const current = drain;
    if (!current || lifetime.signal.aborted) return;
    const revision = current.revision;
    current.attempts += 1;
    // Proof needs something to check: on POSIX the retained group id, on Windows the recorded
    // process identities or, when a starved snapshot never captured them, the root pid and spawn
    // time. Without any of these, a restart stays the only way out.
    const provable =
      current.records.length > 0 &&
      (deps.platform !== "win32" ||
        current.records.every(
          (record) => record.processes.length > 0 || record.spawnedAt !== undefined,
        ));
    let remaining = provable ? 0 : 1;
    try {
      if (provable) {
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(ATTEMPT_MS)]);
        remaining = await processes.killOrphans(current.records, signal, RETRY_SNAPSHOT_MS);
        remaining += groupAlive(current.records, deps.platform);
        if (!remaining) remaining = await processes.treeRemains(current.records, RETRY_SNAPSHOT_MS);
      }
    } catch {
      // A failed snapshot proves nothing either way, so the pause continues.
      remaining = 1;
    }
    if (lifetime.signal.aborted) return;
    // Another failure joined while this attempt was running: its tree has not been checked yet,
    // so releasing the pause here would strand it exactly like the first one was stranded.
    if (drain !== current || current.revision !== revision) return;
    if (remaining) {
      const exhausted = !provable || current.attempts >= MAX_AUTO_ATTEMPTS;
      if (exhausted) {
        // Reported on the transition, and again for each manual check that still finds no proof.
        current.stuck = true;
        clearTimeout(current.timer);
        report({
          phase: "stuck",
          reason: current.reason,
          ...owner(current),
          attempts: current.attempts,
          remaining,
        });
      } else if (current.attempts === 1 || current.attempts % REPORT_EVERY === 0)
        report({
          phase: "retrying",
          reason: current.reason,
          ...owner(current),
          attempts: current.attempts,
          remaining,
        });
      return;
    }
    // Confirmed clean: release the pause first, then end the one job that never finished cleanup.
    drainFailure = undefined;
    drain = undefined;
    clearTimeout(current.timer);
    for (const id of current.jobIds) {
      const abandoned = jobs.get(id);
      if (abandoned?.running)
        void abandoned.finish("failed").catch(() => {
          // The proof above is what matters; a failed log close is reported by the next cleanup.
        });
    }
    report({
      phase: "recovered",
      reason: current.reason,
      ...owner(current),
      attempts: current.attempts,
      remaining: 0,
    });
    for (const resolve of [...healthyWaiters]) resolve();
  }
  /**
   * Resolves once the pause is released; rejects when the instance closes. A run waits here for
   * its temp folder instead of failing its drain, so a later proof frees the run's folder lease
   * too and nothing but the commands themselves waited (Windows test 2026-11-21).
   */
  const whenHealthy = (signal?: AbortSignal, runId?: string) =>
    new Promise<void>((resolve, reject) => {
      if (!drainFailed(runId)) return resolve();
      const stop = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      const done = () => {
        healthyWaiters.delete(done);
        stop.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        healthyWaiters.delete(done);
        reject(drainFailure ?? new ExecError("closed"));
      };
      if (stop.aborted) return abort();
      healthyWaiters.add(done);
      stop.addEventListener("abort", abort, { once: true });
    });
  const pauseState = (): CommandPauseState => {
    if (deps.platform === "win32" || !drainFailure) return null;
    return drain && !drain.stuck ? "retrying" : "stuck";
  };
  const failDrain = (
    error: ExecError,
    jobId?: string,
    record?: BackgroundProcessRecord,
    runId?: string,
  ) => {
    // Only the tree whose cleanup failed is retained; other background commands keep running and
    // must never be killed by the retry or ended by the recovery.
    // The failed job is read regardless of `running`: a reported failure may already have marked
    // it stopped. Without an identifiable tree the pause cannot be proven clear, so it stays.
    const failed = jobId ? jobs.get(jobId) : undefined;
    // A job's spawn time travels with its record, so a Windows tree whose identities a starved
    // snapshot never captured can still be checked later.
    const retained = failed
      ? [{ ...failed.record(), spawnedAt: failed.startedAt }]
      : record
        ? [record]
        : [];
    // A failure while already paused is a different tree, not the same state: dropping it would
    // let the first recovery release the pause with this tree unchecked.
    const joined = drain;
    if (joined) {
      const before = joined.records.length;
      const known = !!jobId && joined.jobIds.includes(jobId);
      const seen = new Set(joined.records.map(recordKey));
      for (const candidate of retained) {
        const key = recordKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        joined.records.push(candidate);
      }
      if (jobId && !joined.jobIds.includes(jobId)) joined.jobIds.push(jobId);
      if (runId) {
        joined.runIds.add(runId);
        if (joined.runId !== runId) joined.runId = undefined;
      }
      // A retry may be mid-flight with the older set; its release must be refused.
      joined.revision += 1;
      const added = joined.records.length > before;
      // A new tree deserves its own round of automatic checks; a repeat report of the same failure
      // (the same error passes several layers) changes nothing and stays quiet.
      if (added && joined.stuck) {
        joined.stuck = false;
        joined.attempts = 0;
        schedule();
      }
      if (added || (jobId && !known))
        report({
          phase: "paused",
          reason: joined.reason,
          ...(jobId ? { jobId } : {}),
          ...(runId ? { runId } : {}),
          attempts: joined.attempts,
          remaining: 0,
        });
      return;
    }
    drainFailure = error;
    drain = {
      reason: backgroundCleanupReason(error),
      records: retained,
      jobIds: jobId ? [jobId] : [],
      ...(runId ? { runId } : {}),
      runIds: new Set(runId ? [runId] : []),
      attempts: 0,
      revision: 0,
      stuck: false,
    };
    report({
      phase: "paused",
      reason: drain.reason,
      ...(jobId ? { jobId } : {}),
      ...(runId ? { runId } : {}),
      attempts: 0,
      remaining: 0,
    });
    schedule();
  };
  const start = createBackgroundStarter({
    ...deps,
    lifetime,
    assertHealthy,
    failDrain,
    terminate: processes.terminate,
    added(job) {
      jobs.set(job.id, job);
      monitor.schedule(50);
    },
    removed(job) {
      jobs.delete(job.id);
      monitor.removed();
    },
    rootExited: monitor.reschedule,
  });
  return {
    start,
    activeCount: () => [...jobs.values()].filter((job) => job.running).length,
    assertHealthy,
    failDrain,
    drainFailed,
    whenHealthy,
    pauseState,
    /**
     * The person asked to check again: one attempt now, with the same proof as the automatic ones.
     * Never a release without proof; the result is the state after the attempt.
     */
    async recheck(): Promise<CommandPauseState> {
      if (drain) await attempt();
      return pauseState();
    },
    killOrphans: (records: BackgroundProcessRecord[], signal: AbortSignal) =>
      processes.killOrphans(records, signal),
    get(id: string): BackgroundJob | undefined {
      return jobs.get(id);
    },
    async dispose() {
      lifetime.abort();
      clearTimeout(drain?.timer);
      healthyWaiters.clear();
      drain = undefined;
      const monitoring = monitor.dispose();
      const results = await Promise.allSettled([...jobs.values()].map((job) => job.stop()));
      await retrying;
      await monitoring;
      if (drainFailure || results.some((result) => result.status === "rejected"))
        throw drainFailure ?? new ExecError("command_failed", "cleanup_failed");
    },
  };
}
