import { ExecError } from "../../core/types.ts";
import { ProcessCleanupError, windowsTree } from "../process.ts";
import { type ProcessRow, snapshot } from "../process-tree.ts";
import type {
  BackgroundDependencies,
  BackgroundDrainReason,
  BackgroundProcessRecord,
  Job,
} from "./types.ts";

const STOP_GRACE_MS = 3000;
/** Spawn time is read just before (foreground) or after (background) the spawn; widen the match. */
const SPAWN_MARGIN_MS = 2000;
/** .NET ticks (100 ns since 0001-01-01) of the Unix epoch, the unit of Windows CreationDate. */
const EPOCH_TICKS = 621355968000000000n;

function createdAtOrAfter(row: ProcessRow, earliest: bigint) {
  try {
    return BigInt(row.started) >= earliest;
  } catch {
    // An unreadable creation time could be anything, so it counts as possibly part of the tree.
    return true;
  }
}

/**
 * Windows: ParentProcessId keeps naming a creator after it exits, and that PID may now belong to
 * another process. A real child started after its parent; an older one is not ours to kill.
 */
function startedAfter(row: ProcessRow, parent: ProcessRow) {
  try {
    return BigInt(row.started) >= BigInt(parent.started);
  } catch {
    // An unreadable time cannot prove the relation, and this set is killed.
    return false;
  }
}

/**
 * Why a process tree did not provably exit: kept as a class so the cleanup retry can tell an
 * unconfirmed tree (processes remain) from a failed snapshot (existence unknown).
 */
export class BackgroundCleanupError extends ExecError {
  constructor(readonly cleanup: "unconfirmed" | "unverified") {
    super("command_failed", "cleanup_failed");
  }
}

export function backgroundCleanupReason(error: unknown): BackgroundDrainReason {
  const cleanup =
    error instanceof BackgroundCleanupError || error instanceof ProcessCleanupError
      ? error.cleanup
      : undefined;
  return cleanup ? `cleanup_${cleanup}` : "unknown";
}

/**
 * Retained process groups that still exist (POSIX). The group id is the only thing left to check
 * once every recorded pid died, and a live group can still hold children started after the last
 * snapshot. Returns 0 on Windows, where the recorded tree is the only identity.
 */
export function groupAlive(
  records: readonly BackgroundProcessRecord[],
  platform: NodeJS.Platform,
): number {
  if (platform === "win32") return 0;
  let alive = 0;
  for (const record of records) {
    try {
      process.kill(-record.group, 0);
      alive += 1;
    } catch (error) {
      // ESRCH is the only proof the group is gone; EPERM or an unknown error stays unconfirmed.
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) alive += 1;
    }
  }
  return alive;
}

function signalPid(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    // ESRCH proves this pid is gone. EPERM does not, so cleanup must remain unconfirmed.
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function isPermissionDenied(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

export function createBackgroundProcesses(deps: BackgroundDependencies) {
  const { platform } = deps;
  async function terminate(job: Job) {
    const env = deps.env();
    let verified = false;
    const refresh = async () => {
      try {
        job.update(job.tree.update(await snapshot(env, platform)));
        verified = true;
      } catch {
        verified = false;
        // Keep the last membership; the group signal below still reaches most of the tree.
      }
      return job.members;
    };
    if (platform === "win32") {
      try {
        await windowsTree({ members: refresh }, env, AbortSignal.timeout(STOP_GRACE_MS * 2));
        if (verified) return;
      } catch {
        // taskkill could not confirm; the final refresh below decides what is still running.
      }
      await refresh();
      if (!verified || job.members.length)
        throw new BackgroundCleanupError(verified ? "unconfirmed" : "unverified");
      return;
    }
    signalPid(-job.root, "SIGTERM");
    for (const row of await refresh()) signalPid(row.pid, "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && (await refresh()).length)
      await new Promise((resolve) => setTimeout(resolve, 150));
    if (job.members.length) {
      signalPid(-job.root, "SIGKILL");
      for (const row of job.members) signalPid(row.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await refresh();
    }
    await refresh();
    if (!verified || job.members.length)
      throw new BackgroundCleanupError(verified ? "unconfirmed" : "unverified");
  }

  /**
   * Brain restart: stops processes recorded by a previous brain that are still alive.
   * Identity is pid + start time, so a recycled pid is never signalled; the recorded process
   * group is included only while one of its recorded members still matches. Idempotent.
   */
  async function killOrphans(
    records: BackgroundProcessRecord[],
    signal: AbortSignal,
    snapshotTimeoutMs?: number,
  ) {
    const wanted = new Set(
      records.flatMap((record) => record.processes.map((p) => `${p.pid}:${p.started}`)),
    );
    if (!wanted.size) return 0;
    const env = deps.env();
    const targets = async () => {
      const rows = await snapshot(env, platform, snapshotTimeoutMs);
      const matched = rows.filter((row) => wanted.has(`${row.pid}:${row.started}`));
      const groups = new Set(
        platform === "win32"
          ? []
          : records
              .filter((record) =>
                matched.some((row) => row.pid === record.group || row.group === record.group),
              )
              .map((record) => record.group),
      );
      const found = new Map(matched.map((row) => [row.pid, row]));
      for (const row of rows) if (groups.has(row.group)) found.set(row.pid, row);
      // Descendants started by the recorded processes after the last record.
      for (let grew = true; grew; ) {
        grew = false;
        for (const row of rows) {
          const parent = found.get(row.parent);
          if (found.has(row.pid) || !parent) continue;
          if (platform === "win32" && !startedAfter(row, parent)) continue;
          found.set(row.pid, row);
          grew = true;
        }
      }
      return [...found.values()];
    };
    let rows = await targets();
    if (!rows.length) return 0;
    if (platform === "win32") {
      try {
        await windowsTree({ members: targets }, env, signal);
      } catch {
        signal.throwIfAborted();
        // taskkill failure is resolved only by the bounded identity check below.
      }
      const deadline = Date.now() + STOP_GRACE_MS;
      rows = await targets();
      while (Date.now() < deadline && rows.length) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 150));
        rows = await targets();
      }
      return rows.length;
    }
    const denied = new Set<string>();
    const send = (pid: number, started: string, value: NodeJS.Signals) => {
      try {
        signalPid(pid, value);
      } catch (error) {
        if (!isPermissionDenied(error)) throw error;
        denied.add(`${pid}:${started}`);
      }
    };
    for (const row of rows) send(row.pid, row.started, "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && rows.length) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 150));
      rows = await targets();
    }
    denied.clear();
    for (const row of rows) send(row.pid, row.started, "SIGKILL");
    const killDeadline = Date.now() + STOP_GRACE_MS;
    rows = await targets();
    while (Date.now() < killDeadline && rows.length) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 150));
      rows = await targets();
    }
    const remaining = new Set(rows.map((row) => `${row.pid}:${row.started}`));
    for (const identity of denied) remaining.add(identity);
    return remaining.size;
  }

  /**
   * Windows only: processes that may still belong to a retained tree, found by the same rule the
   * command's own monitor uses (the root pid, then children created after their creator) but
   * seeded with the root and every recorded pid even when they already exited, so a tree whose
   * identities were never captured can still be shown to be gone. Check-only: a pid matched by
   * creation time alone may be an unrelated process that reused it, so nothing is signalled, and
   * every such match keeps the pause (the safe direction).
   */
  async function treeRemains(records: readonly BackgroundProcessRecord[], timeoutMs: number) {
    const dated = records.filter((record) => record.spawnedAt !== undefined);
    if (platform !== "win32" || !dated.length) return 0;
    const rows = await snapshot(deps.env(), platform, timeoutMs);
    const children = new Map<number, ProcessRow[]>();
    for (const row of rows) {
      const list = children.get(row.parent) ?? [];
      list.push(row);
      children.set(row.parent, list);
    }
    let remaining = 0;
    for (const record of dated) {
      const earliest =
        BigInt(Math.max(0, (record.spawnedAt as number) - SPAWN_MARGIN_MS)) * 10_000n + EPOCH_TICKS;
      const found = new Set<number>();
      for (const row of rows)
        if (row.pid === record.group && createdAtOrAfter(row, earliest)) found.add(row.pid);
      const queue = [record.group, ...record.processes.map((process) => process.pid)];
      const visited = new Set<number>();
      for (let i = 0; i < queue.length; i++) {
        const parent = queue[i] as number;
        if (visited.has(parent)) continue;
        visited.add(parent);
        for (const row of children.get(parent) ?? []) {
          if (found.has(row.pid) || !createdAtOrAfter(row, earliest)) continue;
          found.add(row.pid);
          queue.push(row.pid);
        }
      }
      remaining += found.size;
    }
    return remaining;
  }

  return { terminate, killOrphans, treeRemains };
}
