import { isActive, type RoutineRun, type TaskCenter } from "./pages.ts";

export interface TaskCounts {
  working: number;
  waiting: number;
  doneToday: number;
}
const sameDay = (iso: string, now: Date) => {
  const at = new Date(iso);
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
};
/**
 * B17 (phone 2026-11-14): "Done today" read 31 on the chat list (every finished reply) and 0 on
 * Tasks (routines) under the same label. Both now count the same thing: routine runs that
 * finished today, once per run.
 */
function doneToday(center: TaskCenter | undefined, now: Date) {
  const ids = new Set<string>();
  for (const run of routineRuns(center).finished)
    if (run.status === "done" && run.finishedAt && sameDay(run.finishedAt, now)) ids.add(run.id);
  return ids.size;
}
/**
 * Summary from data the phone already has: the task center's runs and the approval inbox.
 * Before the first task center arrives, the chat list's running conversations stand in.
 */
export function taskCounts(
  center: TaskCenter | undefined,
  approvals: number,
  runningChats: number,
  now = new Date(),
): TaskCounts {
  const runs = center?.runs ?? [];
  return {
    working: center
      ? runs.filter((run) => isActive(run) && run.status !== "waiting").length
      : runningChats,
    waiting: approvals,
    doneToday: doneToday(center, now),
  };
}
/**
 * Maintainers 2026-11-13: the Tasks tab is about routines only — ordinary chats stay in Chats. In progress
 * means a routine run that is running or waiting for approval; finished ones list newest first.
 */
const ROUTINE_ACTIVE = new Set<RoutineRun["status"]>(["running", "waiting"]);
const ROUTINE_FINISHED = new Set<RoutineRun["status"]>(["done", "failed", "cancelled", "timeout"]);
export function routineRuns(center: TaskCenter | undefined) {
  const runs = center?.routines ?? [];
  return {
    active: runs.filter((run) => ROUTINE_ACTIVE.has(run.status)),
    finished: runs
      .filter((run) => ROUTINE_FINISHED.has(run.status))
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")),
  };
}
/**
 * B17: the finished list showed two identical "Morning summary · last run yesterday" rows. Each
 * row reads as the routine's last run, so a routine appears once, with its newest finished run.
 */
export function latestFinished(finished: readonly RoutineRun[]) {
  const seen = new Set<string>();
  return finished.filter((run) => {
    const key = run.routineId ?? run.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function routineCounts(
  center: TaskCenter | undefined,
  waiting: number,
  now = new Date(),
): TaskCounts {
  const { active } = routineRuns(center);
  return {
    working: active.filter((run) => run.status === "running").length,
    waiting,
    doneToday: doneToday(center, now),
  };
}
export function greetingKey(now = new Date()) {
  const hour = now.getHours();
  return hour < 12 ? "greetMorning" : hour < 18 ? "greetAfternoon" : "greetEvening";
}
