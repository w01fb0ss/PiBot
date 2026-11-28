import type { BackgroundPreferences } from "@pibot/protocol";
import { startBrainHost } from "../brain/brain-host.ts";
import { retireBrain } from "../brain/retire-brain.ts";
import type { reserveDescriptor } from "./background-directory.ts";
import type { createBackgroundServer } from "./background-server.ts";

type Host = ReturnType<typeof startBrainHost>;
type Options = Parameters<typeof startBrainHost>[0];

/** Expected retirement destroys one host, retaining only owner-owned capabilities and power input. */
export function createBackgroundBrainCycle(deps: {
  host: Omit<Options, "business" | "onChild" | "beforeBootstrap" | "bootstrapSignal" | "onReady">;
  reservation: Awaited<ReturnType<typeof reserveDescriptor>>;
  server: Awaited<ReturnType<typeof createBackgroundServer>>;
  signal: AbortSignal;
  active(): void;
  connected(): boolean;
  created(host: Host | undefined): void;
  retiring(): void;
  ready(host: Host): void;
  preferences(value: BackgroundPreferences): void;
}) {
  let host: Host | undefined;
  let child: Electron.UtilityProcess | undefined;
  let clearing: Promise<void> | undefined;
  let generation = 0;
  let retiring = false;
  let clientTransitions = Promise.resolve();
  let recovery: { child: Electron.UtilityProcess; pending: Promise<void> } | undefined;
  const guard = (current: Host) => {
    const processHandle = child;
    const owner = generation;
    return () => {
      deps.signal.throwIfAborted();
      deps.active();
      if (
        !processHandle ||
        host !== current ||
        child !== processHandle ||
        generation !== owner ||
        retiring
      )
        throw new Error("background_recovery_stale");
    };
  };
  const syncClient = (
    current: Host,
    active: () => void,
    connected: () => boolean,
    accepted?: () => void,
  ) => {
    const pending = clientTransitions.then(async () => {
      active();
      await current.desktopClient(connected());
      active();
      accepted?.();
    });
    clientTransitions = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  const exitedPids = new Set<number>();
  const clearExited = (): Promise<void> => {
    // A pid recorded after the running loop finished would otherwise wait for an unrelated call.
    if (clearing) return clearing.then(() => (exitedPids.size ? clearExited() : undefined));
    const pending = (async () => {
      for (const pid of exitedPids) {
        await deps.reservation.clearUtility(pid);
        exitedPids.delete(pid);
      }
    })();
    clearing = pending;
    void pending
      .finally(() => {
        if (clearing === pending) clearing = undefined;
      })
      .catch(() => {});
    return pending;
  };
  return {
    async desktopClient(connected: boolean, accepted?: () => void) {
      const current = host;
      if (!current) throw new Error("background_brain_unavailable");
      await syncClient(current, guard(current), () => connected, accepted);
    },
    async retire() {
      const current = host;
      retiring = true;
      generation++;
      deps.retiring();
      if (current) await current.stop();
      else if (child) await retireBrain(child, deps.host.logger);
      await clientTransitions;
      await recovery?.pending;
      await clearExited();
      if (child || deps.reservation.descriptor.utilityPid !== null)
        throw new Error("background_utility_exit_unconfirmed");
      if (host === current) {
        host = undefined;
        deps.created(undefined);
      }
    },
    async launch(signal: AbortSignal) {
      deps.active();
      if (host || child || deps.reservation.descriptor.utilityPid !== null)
        throw new Error("background_writer_still_owned");
      await clearExited();
      deps.active();
      retiring = false;
      let resolveReady = () => {};
      let rejectReady = (_error: Error) => {};
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      // A slow start that keeps advancing must not be failed on a fixed clock: a brain
      // recovering many unfinished session tails reported nothing but stayed busy for 43 s, and the
      // fixed 90 s window was burned by repeated restarts. Re-arm on each progress report; a child
      // that reports nothing for 90 s is genuinely stuck (its own 15 s watchdog kills it first).
      const stalled = new AbortController();
      const launchedAt = performance.now();
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const armStall = () => {
        clearTimeout(stallTimer);
        // Hard ceiling: a child that keeps reporting but never becomes ready still has to fail.
        const remaining = 600_000 - (performance.now() - launchedAt);
        if (remaining <= 0) {
          stalled.abort(new Error("background_launch_timeout"));
          return;
        }
        stallTimer = setTimeout(
          () => stalled.abort(new Error("background_launch_timeout")),
          Math.min(90_000, remaining),
        );
      };
      armStall();
      const waiting = AbortSignal.any([signal, stalled.signal]);
      const abort = () => rejectReady(new Error("background_launch_cancelled"));
      waiting.addEventListener("abort", abort, { once: true });
      let current: Host | undefined;
      try {
        current = startBrainHost({
          ...deps.host,
          business: deps.server.port,
          acp: deps.server.acpPort,
          onAcpRetired: deps.server.acpRetired,
          bootstrapSignal: deps.signal,
          retainRoutineHost: true,
          attachmentPartition: `attachment-owner-${deps.reservation.descriptor.instance}`,
          onChild: (value) => {
            generation++;
            child = value;
            let pid = value.pid;
            value.once("spawn", () => {
              pid = value.pid;
            });
            value.once("exit", () => {
              if (child === value) {
                generation++;
                child = undefined;
              }
              const exited = pid;
              if (exited !== undefined) {
                exitedPids.add(exited);
                void clearExited().catch(() =>
                  deps.host.logger.error("Exited utility PID publication failed; claim retained"),
                );
              }
            });
          },
          beforeBootstrap: async (pid) => {
            await clearExited();
            deps.active();
            await deps.reservation.utility(pid);
            deps.active();
          },
          onStatus: (next, reason) => {
            if (current && host !== current) return;
            // Publish ready only after this utility has recovered the current client policy.
            if (next === "ready") return;
            generation++;
            if (next === "failed") rejectReady(new Error("background_launch_failed"));
            deps.host.onStatus?.(next, reason);
          },
          onStartupProgress: (phase) => {
            armStall();
            deps.host.onStartupProgress?.(phase);
          },
          onReady: () => {
            if (!current || host !== current || !child || retiring || deps.signal.aborted) return;
            if (recovery?.child === child) return;
            const readyHost = current;
            const readyChild = child;
            const owner = generation;
            const active = guard(readyHost);
            const readyAt = performance.now();
            const pending = (async () => {
              active();
              const value = await readyHost.preferences();
              active();
              deps.preferences(value);
              // Attach commits its client identity in the same lane; detach/drain cannot
              // be overtaken by a ready continuation with a stale connected snapshot.
              await syncClient(readyHost, active, deps.connected);
              active();
              deps.ready(readyHost);
              deps.host.onStatus?.("ready");
              // The preferences and client-policy round trips after brain "ready".
              deps.host.logger.info(
                JSON.stringify({
                  module: "startup",
                  event: "owner_ready",
                  clientSyncMs: Math.round(performance.now() - readyAt),
                  sinceProcessMs: Math.round(performance.now()),
                }),
              );
              resolveReady();
            })()
              .catch((error: unknown) => {
                if (
                  deps.signal.aborted ||
                  retiring ||
                  host !== readyHost ||
                  child !== readyChild ||
                  generation !== owner
                )
                  return;
                // The class only: a validation message could quote stored values.
                deps.host.logger.error(
                  JSON.stringify({
                    module: "startup",
                    event: "interactive_recovery_failed",
                    reason: error instanceof Error ? error.name : typeof error,
                  }),
                );
                deps.host.onStatus?.("failed");
                rejectReady(new Error("background_recovery_failed"));
              })
              .finally(() => {
                if (recovery?.child === readyChild) recovery = undefined;
              });
            recovery = { child: readyChild, pending };
          },
        });
        host = current;
        deps.created(current);
        if (waiting.aborted) abort();
        await ready;
        waiting.throwIfAborted();
        deps.active();
      } finally {
        clearTimeout(stallTimer);
        waiting.removeEventListener("abort", abort);
      }
    },
  };
}
