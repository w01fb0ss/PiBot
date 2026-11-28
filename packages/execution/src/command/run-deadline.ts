import { withDeadline } from "../core/deadline.ts";
import { ExecError } from "../core/types.ts";

/** A stuck dependency closes only its command; createExec retains actual work until drained. */
export function commandDeadline<T>(
  operation: Promise<T>,
  timeoutSec: number | undefined,
  signal: AbortSignal,
  lifetime: AbortController,
  cleanupGraceMs = 10_000,
) {
  const force = new AbortController();
  let grace: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (!force.signal.aborted) grace ??= setTimeout(() => force.abort(), cleanupGraceMs);
  };
  signal.addEventListener("abort", stop, { once: true });
  lifetime.signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted || lifetime.signal.aborted) stop();
  const seconds =
    timeoutSec && Number.isInteger(timeoutSec) && timeoutSec >= 1 && timeoutSec <= 600
      ? timeoutSec
      : 120;
  const deadline = new ExecError("command_failed", "timeout");
  return withDeadline(operation, seconds * 1000 + cleanupGraceMs, deadline, force.signal)
    .catch((error: unknown) => {
      if (error === deadline || force.signal.aborted) lifetime.abort();
      throw error;
    })
    .finally(() => {
      clearTimeout(grace);
      signal.removeEventListener("abort", stop);
      lifetime.signal.removeEventListener("abort", stop);
    });
}
