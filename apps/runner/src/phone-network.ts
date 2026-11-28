import { randomBytes } from "node:crypto";
import {
  assertPhoneControlCurrent,
  connectRunnerSession,
  createRunnerDrain,
  openRunnerRelay,
  phoneRunnerPath,
  type RtcPeerFactory,
  RunnerDrainError,
  resumeRunnerDrain,
  roomTicket,
  runnerDeviceId,
  runnerRoomKey,
  unbase64,
  waitRunnerRetry,
} from "@pibot/link";
import { firstConnection, lanToken } from "@pibot/link/lan";
import type { createRunnerRuntime, RunnerIdentity } from "@pibot/runner";
import type { RunnerLogger } from "./logger.ts";
import { readPairedDesktop } from "./paired-desktop.ts";
import type { openPhoneAuthorizations } from "./phone-authorizations.ts";
import { openPhoneLan } from "./phone-lan.ts";
import type { RunnerProxy } from "./proxy/route.ts";
import { relaySocket } from "./relay-socket.ts";

/** Each delegated room has its own authenticated identity; the runtime alone selects its writer. */
export function phoneRunnerNetwork(options: {
  createPeer: RtcPeerFactory;
  dataDir: string;
  identity: RunnerIdentity;
  grants: Awaited<ReturnType<typeof openPhoneAuthorizations>>;
  runtime: Awaited<ReturnType<typeof createRunnerRuntime>>;
  signal: AbortSignal;
  logger: RunnerLogger;
  /** How relay connections reach the internet (`--proxy`, environment or system proxy). */
  proxy: RunnerProxy;
}) {
  const RelaySocketClass = relaySocket(options.proxy);
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, options.signal]);
  const entries = new Map<
    string,
    { signature: string; stop: AbortController; work: Promise<void> }
  >();
  const retired = new Set<Promise<void>>();
  const cleanups = new Set<() => Promise<void>>();
  let closed = false;
  const refresh = () => {
    if (closed) return;
    const grants = options.grants
      .list()
      .filter((g) => g.body.enabled && g.body.expiresAt > Date.now());
    for (const [key, entry] of entries) {
      if (grants.some((g) => g.body.phone === key && g.signature === entry.signature)) continue;
      entry.stop.abort();
      entries.delete(key);
      retired.add(entry.work);
      void entry.work.then(
        () => retired.delete(entry.work),
        () => options.logger.write("error", "runner.phone_drain_unconfirmed"),
      );
    }
    for (const grant of grants) {
      if (entries.has(grant.body.phone)) continue;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        lifetime,
        controller.signal,
        AbortSignal.timeout(Math.max(1, grant.body.expiresAt - Date.now())),
      ]);
      const work = (async () => {
        for (let attempt = 0; !signal.aborted; attempt++) {
          try {
            for (const cleanup of cleanups) await cleanup();
          } catch (error) {
            if (!(error instanceof RunnerDrainError) || signal.aborted) throw error;
            await waitRunnerRetry(1000, signal);
            continue;
          }
          let failed: unknown;
          let cleanupFailure: unknown;
          let selected:
            | {
                port: import("@pibot/protocol-base").Port;
                signal: AbortSignal;
                close(): Promise<void>;
              }
            | undefined;
          let session: Awaited<ReturnType<typeof options.runtime.attach>> | undefined;
          const roomKey = runnerRoomKey(
            options.identity.keys,
            grant.body.phone,
            grant.body.rotation,
          );
          try {
            await options.grants.assert(grant);
            const desktop = await readPairedDesktop(options.dataDir);
            if (!desktop) return;
            if (options.runtime.hasDesktop()) {
              await waitRunnerRetry(1000, signal);
              continue;
            }
            const instance = runnerDeviceId(unbase64(grant.body.rotation, 32)).slice(0, 32);
            selected = await firstConnection(
              [
                async (branchSignal) => {
                  const lan = await openPhoneLan({
                    instance,
                    token: lanToken(roomKey, instance),
                    keys: options.identity.keys,
                    phone: grant.body.phone,
                    signature: grant.signature,
                    warn: () => options.logger.write("info", "runner.phone_lan_unavailable"),
                    signal: branchSignal,
                    allowed: () => !options.runtime.hasDesktop(),
                  });
                  try {
                    const candidate = await lan.candidate;
                    await candidate.activate();
                    return {
                      port: candidate.port,
                      signal: candidate.signal,
                      async close() {
                        await candidate.close();
                        await lan.close();
                      },
                    };
                  } catch (error) {
                    await lan.close();
                    throw error;
                  }
                },
                async (branchSignal) => {
                  const ticket = roomTicket(roomKey);
                  const room = await openRunnerRelay({
                    WebSocket: RelaySocketClass,
                    relay: desktop.relay,
                    ticket,
                    role: "runner",
                    slot: runnerDeviceId(unbase64(ticket.roomId, 32)),
                    signal: branchSignal,
                    peerTimeoutMs: 5000,
                  });
                  try {
                    const active = AbortSignal.any([branchSignal, room.signal]);
                    const port = await connectRunnerSession({
                      transport: room.transport,
                      keys: options.identity.keys,
                      publicKey: grant.body.phone,
                      role: "initiator",
                      random: randomBytes,
                      signal: active,
                      timeoutMs: 5000,
                      authorizationSignature: grant.signature,
                    });
                    const selected = await phoneRunnerPath({
                      port,
                      signal: active,
                      keys: options.identity.keys,
                      grant,
                      role: "initiator",
                      random: randomBytes,
                      createPeer: options.createPeer,
                    });
                    return {
                      ...selected,
                      async close() {
                        await selected.close();
                        await room.close();
                      },
                    };
                  } catch (error) {
                    await room.close();
                    throw error;
                  }
                },
              ],
              signal,
            );
            await options.grants.assert(grant);
            assertPhoneControlCurrent(grant);
            session = await options.runtime.attach(selected.port, { kind: "phone", grant });
            await new Promise<void>((resolve) => {
              const active = selected?.signal as AbortSignal;
              let off = () => {};
              const done = () => {
                active.removeEventListener("abort", done);
                off();
                resolve();
              };
              off = selected?.port.onClose?.(done) ?? (() => {});
              active.addEventListener("abort", done, { once: true });
              if (active.aborted) done();
            });
          } catch (error) {
            failed = error;
            if (!signal.aborted)
              options.logger.write("info", "runner.phone_connection_unavailable");
          } finally {
            roomKey.fill(0);
            const drain = createRunnerDrain(
              [() => resumeRunnerDrain(failed), () => session?.dispose(), () => selected?.close()],
              signal,
              () => options.logger.write("warn", "runner.phone_drain_retry"),
            );
            const cleanup = async () => {
              await drain();
              cleanups.delete(cleanup);
            };
            cleanups.add(cleanup);
            try {
              await cleanup();
            } catch (error) {
              if (!(error instanceof RunnerDrainError) || signal.aborted) cleanupFailure = error;
              // Keep this exact owner for the next loop; a late close cannot authorize replay.
            }
          }
          if (cleanupFailure) throw cleanupFailure;
          if (!signal.aborted)
            await waitRunnerRetry(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)), signal).catch(
              () => {},
            );
        }
      })();
      void work.catch(() => {
        options.logger.write("error", "runner.phone_drain_unconfirmed");
      });
      entries.set(grant.body.phone, { signature: grant.signature, stop: controller, work });
    }
  };
  const off = options.grants.subscribe(refresh);
  refresh();
  return {
    async close() {
      closed = true;
      off();
      stop.abort();
      await Promise.allSettled([...entries.values()].map((e) => e.work).concat([...retired]));
      await Promise.all([...cleanups].map((cleanup) => cleanup()));
      entries.clear();
    },
  };
}
