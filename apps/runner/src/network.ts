import { randomBytes } from "node:crypto";
import {
  connectRunnerPunch,
  connectRunnerSession,
  connectRunnerSocket,
  createRunnerDrain,
  decodeRunnerPairCode,
  isRunnerPunchMessage,
  openRunnerRelay,
  pairRunnerSession,
  RunnerDrainError,
  type RunnerLinkStage,
  RunnerPunchRequestSchema,
  relayAddress,
  resumeRunnerDrain,
  roomTicket,
  runnerDeviceId,
  runnerLinkFailure,
  runnerPairCode,
  runnerPairRoom,
  runnerRetryDelay,
  runnerRoomKey,
  unbase64,
  waitRunnerRetry,
} from "@pibot/link";
import type { Port } from "@pibot/protocol-base";
import type { createRunnerRuntime, RunnerIdentity } from "@pibot/runner";
import { createRunnerDirect } from "./direct.ts";
import type { RunnerLogger } from "./logger.ts";
import { forgetPairedDesktop, readPairedDesktop, savePairedDesktop } from "./paired-desktop.ts";
import type { RunnerProxy } from "./proxy/route.ts";
import type { RunnerRedactor } from "./redactor.ts";
import { relaySocket } from "./relay-socket.ts";
import { createRunnerRtcFactory } from "./rtc-peer.ts";
import type { RunnerConnection } from "./state.ts";

export const OFFICIAL_RUNNER_RELAY = "wss://relay.pibot.space";
export function validateRunnerRelay(value: string) {
  return relayAddress(value, true);
}
/** The computer's LAN listener URLs, checked as strictly as the wire schema would. */
function connectAddresses(
  message: unknown,
): { success: true; data: { params: { addresses: string[] } } } | { success: false } {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { success: false };
  const value = message as Record<string, unknown>;
  const params = value.params as Record<string, unknown> | undefined;
  const list = params && typeof params === "object" ? params.addresses : undefined;
  if (
    Object.keys(value).sort().join(",") !== "jsonrpc,method,params" ||
    value.jsonrpc !== "2.0" ||
    value.method !== "link.runner.connect_addresses" ||
    !params ||
    Object.keys(params).join(",") !== "addresses" ||
    !Array.isArray(list) ||
    list.length > 8 ||
    !list.every((item) => typeof item === "string" && item.length >= 3 && item.length <= 512)
  )
    return { success: false };
  return { success: true, data: { params: { addresses: list as string[] } } };
}

export function createRunnerNetwork(options: {
  dataDir: string;
  rtc?: ReturnType<typeof createRunnerRtcFactory>;
  listen?: readonly string[];
  identity: RunnerIdentity;
  runtime: Awaited<ReturnType<typeof createRunnerRuntime>>;
  signal: AbortSignal;
  logger: RunnerLogger;
  redactor: RunnerRedactor;
  pair?: boolean;
  pairCode?: string;
  relay: string;
  /** How relay connections reach the internet (`--proxy`, environment or system proxy). */
  proxy: RunnerProxy;
  /** This device's name as it appears in the desktop (default: host name, or `pair --name`). */
  deviceName: string;
  output(code: string): void;
  onRevoked?(): void;
  onPaired?(): void;
}) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const RelaySocketClass = relaySocket(options.proxy);
  // The route is asynchronous (a PAC script may decide it); a failed lookup means direct.
  const relayRoute = async (relay: string) => ({
    relay: relay === OFFICIAL_RUNNER_RELAY ? "official" : "custom",
    proxy: (await options.proxy.route(relay).catch(() => undefined))
      ? options.proxy.source
      : "direct",
  });
  let current: Port | undefined;
  let pendingCleanup: (() => Promise<void>) | undefined;
  let revocation: Promise<void> | undefined;
  // `pibot runner status` reports these so a person can tell a paired-but-offline runner from a
  // connected one, and when the desktop last reached it, without reading the log files.
  let connection: RunnerConnection = "connecting";
  let lastSeenAt: string | undefined;
  let pairedComputerName: string | undefined;
  let path: "lan" | "address" | "punched" | "relay" | undefined;
  const audit = (outcome: string, fields: Record<string, string | number | boolean> = {}) =>
    options.logger.write("info", "runner.pairing", {
      outcome,
      deviceId: options.identity.deviceId,
      ...fields,
    });
  // An unconfirmed drain is a slow-link condition, not a reason to end this process: keep the
  // retry owner for close() and let the caller reconnect with a fresh generation.
  const drainConnection = async (cleanups: (() => void | Promise<void>)[]) => {
    const previous = pendingCleanup;
    const drain = createRunnerDrain([() => previous?.(), ...cleanups], signal, () =>
      options.logger.write("warn", "runner.connection_drain_retry"),
    );
    pendingCleanup = drain;
    try {
      await drain();
      pendingCleanup = undefined;
      return true;
    } catch (error) {
      if (!(error instanceof RunnerDrainError)) throw error;
      options.logger.write("warn", "runner.connection_drain_unconfirmed");
      return false;
    }
  };
  const revoke = () => {
    revocation ??= (async () => {
      try {
        await forgetPairedDesktop(options.dataDir);
        audit("revoked");
        try {
          current?.post({ jsonrpc: "2.0", method: "link.runner.revoke", params: {} });
        } catch {
          // Local trust is durably removed; an already closed peer cannot acknowledge revocation.
          options.logger.write("warn", "runner.revoke_delivery_unconfirmed");
        }
      } finally {
        lifetime.abort();
        current?.dispose?.();
      }
    })();
    return revocation;
  };
  const settled = (async () => {
    if (options.pair) {
      if (await readPairedDesktop(options.dataDir)) throw new Error("runner_already_paired");
      const code = options.pairCode ?? runnerPairCode(randomBytes, options.relay);
      options.redactor.add(code);
      options.redactor.add(code.replaceAll("-", ""));
      options.redactor.add(code.split("@")[0] ?? code);
      const decoded = decodeRunnerPairCode(code);
      decoded.psk.fill(0);
      decoded.prologue.fill(0);
      const relay = decoded.relay ?? options.relay;
      const expires = Date.now() + 600_000;
      const pairing = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
      if (!options.pairCode) options.output(code);
      let success = false;
      let reachedService = false;
      // Only a pairing that reached the room can tell us the code was rejected. Relay and TLS
      // timeouts happen before that and must not consume the three code attempts.
      let codeFailures = 0;
      let retry = 0;
      while (!pairing.aborted && codeFailures < 3) {
        let room: Awaited<ReturnType<typeof openRunnerRelay>> | undefined;
        let opened = false;
        let failed: unknown;
        const started = Date.now();
        try {
          room = await openRunnerRelay({
            WebSocket: RelaySocketClass,
            relay,
            ticket: runnerPairRoom(decoded.hint),
            slot: runnerDeviceId(new TextEncoder().encode(decoded.hint.padEnd(32, ":"))),
            role: "runner",
            signal: pairing,
          });
          opened = true;
          reachedService = true;
          await pairRunnerSession({
            transport: room.transport,
            keys: options.identity.keys,
            role: "responder",
            code,
            name: options.deviceName,
            random: randomBytes,
            signal: AbortSignal.any([
              pairing,
              room.signal,
              AbortSignal.timeout(Math.min(20_000, expires - Date.now())),
            ]),
            async commit(peer) {
              await savePairedDesktop(options.dataDir, {
                version: 1,
                ...peer,
                relay,
              });
              options.onPaired?.();
              audit("paired", await relayRoute(relay));
              success = true;
            },
          });
          success = true;
        } catch (error) {
          failed = error;
          if (success) break;
          const where = {
            ...runnerLinkFailure(error, opened ? "noise_handshake" : "relay"),
            ...(await relayRoute(relay)),
            elapsedMs: Date.now() - started,
          };
          if (opened && !pairing.aborted) {
            codeFailures++;
            audit("attempt_failed", where);
          } else if (!pairing.aborted) {
            audit("attempt_retry", where);
          }
        } finally {
          await drainConnection([() => resumeRunnerDrain(failed), () => room?.close()]);
        }
        if (success) break;
        if (!pairing.aborted && codeFailures < 3) {
          await waitRunnerRetry(runnerRetryDelay(retry), pairing);
          retry = Math.min(retry + 1, 4);
        }
      }
      if (!success) {
        audit("expired_or_exhausted");
        throw new Error(reachedService ? "runner_pair_failed" : "runner_pair_unreachable");
      }
    }
    let attempt = 0;
    // Counts every try since start for the log; `attempt` is the backoff step and resets online.
    let tries = 0;
    const initialPair = await readPairedDesktop(options.dataDir);
    if (!initialPair) return;
    const routeKey = runnerRoomKey(
      options.identity.keys,
      initialPair.publicKey,
      initialPair.rotation,
    );
    const direct = await createRunnerDirect({
      listen: options.listen ?? [],
      key: routeKey,
      signal,
      warn: () => options.logger.write("warn", "runner.direct_unavailable"),
    }).catch((error: unknown) => {
      routeKey.fill(0);
      throw error;
    });
    const rtc =
      options.rtc ??
      createRunnerRtcFactory((code) => options.logger.write("warn", "runner.rtc_close", { code }));
    type Direct = Awaited<ReturnType<typeof connectRunnerSocket>> & {
      path: "lan" | "address" | "punched";
    };
    const discoveryStop = new AbortController();
    const discoverySignal = AbortSignal.any([signal, discoveryStop.signal]);
    let candidate: Direct | undefined;
    let computerAddresses: string[] = [];
    let nextDirect: Promise<Direct> | undefined;
    let punchStop: AbortController | undefined;
    let punchWork: Promise<void> | undefined;
    let lastPunchAt = 0;
    let publishPunch: ((value: Direct) => void) | undefined;
    let socketStop: AbortController | undefined;
    const startDirect = () => {
      if (nextDirect) return nextDirect;
      socketStop = new AbortController();
      const socketSignal = AbortSignal.any([discoverySignal, socketStop.signal]);
      const discoveryStopLocal = new AbortController();
      const discoveryOnlySignal = AbortSignal.any([discoverySignal, discoveryStopLocal.signal]);
      const punched = new Promise<Direct>((resolve) => {
        publishPunch = resolve;
      });
      const sockets = (async () => {
        const dial = async (address: string) =>
          direct.dial(address, socketSignal, async (socket) => {
            const connected = await connectRunnerSocket(socket, {
              keys: options.identity.keys,
              publicKey: initialPair.publicKey,
              role: "initiator",
              random: randomBytes,
              signal: socketSignal,
            });
            try {
              await connected.selected();
              return { ...connected, path: "lan" as const };
            } catch (error) {
              await connected.close();
              throw error;
            }
          });
        while (!socketSignal.aborted) {
          try {
            const discovery = direct.open(discoveryOnlySignal, async (socket, path) => {
              const connected = await connectRunnerSocket(socket, {
                keys: options.identity.keys,
                publicKey: initialPair.publicKey,
                role: "initiator",
                random: randomBytes,
                signal: socketSignal,
              });
              try {
                await connected.selected();
                return { ...connected, path };
              } catch (error) {
                await connected.close();
                throw error;
              }
            });
            const lan = computerAddresses.length
              ? Promise.any(computerAddresses.slice(0, 8).map((address) => dial(address)))
              : new Promise<Direct>(() => {});
            const selected = await Promise.any([discovery, lan]);
            discoveryStopLocal.abort();
            return selected;
          } catch {
            if (!socketSignal.aborted) await waitRunnerRetry(1000, socketSignal);
          }
        }
        throw new Error("runner_direct_cancelled");
      })();
      nextDirect = Promise.race([sockets, punched]).then(async (value) => {
        candidate = value;
        if (value.path === "punched") {
          socketStop?.abort();
          await Promise.allSettled([sockets]);
        }
        return value;
      });
      void sockets.catch(() => {});
      void nextDirect.catch(() => {});
      return nextDirect;
    };
    try {
      while (!signal.aborted) {
        // A timeout retains the old owner; a fresh handshake cannot discharge its work.
        if (pendingCleanup) {
          try {
            await pendingCleanup();
            pendingCleanup = undefined;
          } catch (error) {
            if (!(error instanceof RunnerDrainError)) throw error;
            await waitRunnerRetry(1000, signal);
            continue;
          }
        }
        if (signal.aborted) break;
        const paired = await readPairedDesktop(options.dataDir);
        if (!paired) return;
        pairedComputerName = paired.name;
        const relay = validateRunnerRelay(paired.relay);
        let room: Awaited<ReturnType<typeof openRunnerRelay>> | undefined;
        let selectedDirect: Direct | undefined;
        let active: AbortSignal;
        let session: Awaited<ReturnType<typeof options.runtime.attach>> | undefined;
        let off: (() => void) | undefined;
        let addressTimer: ReturnType<typeof setInterval> | undefined;
        let failed: unknown;
        // The step this try is in, for the failure line when the error itself does not say.
        let stage: RunnerLinkStage = "relay";
        let onlineAt: number | undefined;
        const started = Date.now();
        tries++;
        const generation = AbortSignal.any([
          signal,
          AbortSignal.timeout(86_400_000 - (Date.now() % 86_400_000) + 20),
        ]);
        try {
          const relayStop = new AbortController();
          const relayLifetime = AbortSignal.any([generation, relayStop.signal]);
          const openRelay = async () => {
            const key = runnerRoomKey(options.identity.keys, paired.publicKey, paired.rotation);
            try {
              const ticket = roomTicket(key);
              room = await openRunnerRelay({
                WebSocket: RelaySocketClass,
                relay,
                ticket,
                role: "runner",
                // The desktop can be between attempts when this runner rejoins.
                peerTimeoutMs: 20_000,
                slot: runnerDeviceId(unbase64(ticket.roomId, 32)),
                signal: relayLifetime,
              });
            } finally {
              key.fill(0);
            }
            const relaySignal = AbortSignal.any([relayLifetime, room.signal]);
            if (!candidate) stage = "noise_handshake";
            const port = await connectRunnerSession({
              transport: room.transport,
              keys: options.identity.keys,
              publicKey: paired.publicKey,
              role: "initiator",
              random: randomBytes,
              signal: relaySignal,
            });
            return { port, signal: relaySignal };
          };
          // Desktop is the sole selector; runner may authenticate candidates but never races commits.
          const relayAttempt = candidate
            ? Promise.reject(new Error("direct_selected"))
            : openRelay();
          void relayAttempt.catch(() => {});
          const chosen = await Promise.race([
            startDirect().then((wire) => ({ direct: wire })),
            ...(candidate ? [] : [relayAttempt.then((wire) => ({ relay: wire }))]),
          ]);
          if ("direct" in chosen) {
            selectedDirect = chosen.direct;
            relayStop.abort();
            // Opening relay may still be pending. Close its transport and await the owner before attach.
            await room?.close();
            const relayResult = await Promise.allSettled([relayAttempt]);
            if (relayResult[0]?.status === "fulfilled") relayResult[0].value.port.dispose?.();
            await room?.close();
            room = undefined;
            await selectedDirect.activate();
            current = selectedDirect.port;
            active = selectedDirect.signal;
          } else {
            current = chosen.relay.port;
            active = chosen.relay.signal;
          }
          stage = "session_admission";
          options.logger.write("info", "runner.path", {
            path: selectedDirect?.path ?? "relay",
            elapsedMs: Date.now() - started,
            tries,
          });
          const announce = () => {
            try {
              current?.post({
                jsonrpc: "2.0",
                method: "link.runner.addresses",
                params: { addresses: direct.addresses },
              });
            } catch {
              /* A retired wire is handled by its generation owner. */
            }
          };
          addressTimer = setInterval(announce, 5000);
          announce();
          if (!current) throw new Error("runner_connection_unavailable");
          const wire = current;
          off = wire.onMessage((message) => {
            const addresses = connectAddresses(message);
            if (addresses.success) {
              // The computer repeats its list every 5 s; restarting on every repeat would cut off
              // a hole punch still in progress. Only a changed list (new interface) restarts.
              const next = addresses.data.params.addresses;
              const changed = next.join("\n") !== computerAddresses.join("\n");
              computerAddresses = next;
              if (changed && !selectedDirect) {
                socketStop?.abort();
                nextDirect = undefined;
                void startDirect().catch(() => {});
              }
              return;
            }
            const request = RunnerPunchRequestSchema.safeParse(message);
            if (
              !selectedDirect &&
              request.success &&
              !punchWork &&
              Date.now() - lastPunchAt >= 60_000
            ) {
              lastPunchAt = Date.now();
              punchStop = new AbortController();
              const punchSignal = AbortSignal.any([discoverySignal, punchStop.signal]);
              punchWork = (async () => {
                const connected = await connectRunnerPunch({
                  port: wire,
                  ...request.data.params,
                  keys: options.identity.keys,
                  publicKey: paired.publicKey,
                  role: "initiator",
                  random: randomBytes,
                  signal: punchSignal,
                  createPeer: async (input) => {
                    try {
                      return await rtc.createPeer(input);
                    } catch (error) {
                      if (error instanceof Error && error.message === "unsupported") {
                        wire.post({
                          jsonrpc: "2.0",
                          method: "link.runner.punch.unsupported",
                          params: { id: request.data.params.id },
                        });
                        options.logger.write("warn", "runner.punch_unsupported");
                      }
                      throw error;
                    }
                  },
                  onDiagnostic: (event) =>
                    options.logger.write("info", "runner.rtc", {
                      diagnostic: JSON.stringify(event),
                    }),
                });
                try {
                  await connected.selected();
                  publishPunch?.({ ...connected, path: "punched" });
                } catch (error) {
                  await connected.close();
                  throw error;
                }
              })()
                .catch(() => {
                  options.logger.write("warn", "runner.punch_unavailable");
                })
                .finally(() => {
                  punchWork = undefined;
                });
            }
            if (isRunnerRevocation(message))
              void revoke()
                .then(() => options.onRevoked?.())
                .catch(() => {
                  lifetime.abort();
                  options.logger.write("error", "runner.revoke_failed");
                  options.onRevoked?.();
                });
          });
          const port: Port = {
            ...wire,
            onMessage: (fn) =>
              wire.onMessage((value) => {
                if (!isRunnerRevocation(value) && !isRunnerPunchMessage(value)) fn(value);
              }),
          };
          session = await options.runtime.attach(port);
          connection = "online";
          path = selectedDirect?.path ?? "relay";
          lastSeenAt = new Date().toISOString();
          attempt = 0;
          stage = "session";
          onlineAt = Date.now();
          if (selectedDirect) {
            await waitRunnerRetry(86_400_000 - (Date.now() % 86_400_000), active);
          } else {
            await Promise.race([
              waitRunnerRetry(86_400_000 - (Date.now() % 86_400_000), active),
              startDirect(),
            ]);
          }
          if (!signal.aborted)
            (() => {
              const ended = room?.ended();
              options.logger.write("info", "runner.connection_ended", {
                path: selectedDirect?.path ?? "relay",
                stage: ended?.stage ?? "session",
                reason: generation.aborted
                  ? "rotation"
                  : selectedDirect
                    ? "closed"
                    : (ended?.reason ?? "direct_upgrade"),
                onlineMs: Date.now() - (onlineAt ?? started),
                ...(ended?.closeCode === undefined ? {} : { closeCode: ended.closeCode }),
                ...(ended?.wasClean === undefined ? {} : { wasClean: ended.wasClean }),
              });
            })();
        } catch (error) {
          // A successful drain handoff in finally must allow the next connection attempt.
          failed = error;
          if (!signal.aborted)
            options.logger.write("warn", "runner.connection_failed", {
              ...runnerLinkFailure(error, stage),
              ...(await relayRoute(relay)),
              path: selectedDirect?.path ?? "relay",
              elapsedMs: Date.now() - started,
              ...(onlineAt ? { onlineMs: Date.now() - onlineAt } : {}),
              tries,
            });
        } finally {
          connection = "reconnecting";
          path = undefined;
          clearInterval(addressTimer);
          if (candidate?.path !== "punched") {
            punchStop?.abort();
            await punchWork;
          }
          const wire = current;
          current = undefined;
          await drainConnection([
            () => resumeRunnerDrain(failed),
            () => off?.(),
            () => wire?.dispose?.(),
            () => session?.dispose(),
            () => room?.close(),
            () => selectedDirect?.close(),
          ]);
          if (selectedDirect) {
            candidate = undefined;
            nextDirect = undefined;
          }
        }
        if (!signal.aborted) {
          await waitRunnerRetry(attempt === 0 ? 0 : runnerRetryDelay(attempt - 1), signal);
          attempt = Math.min(attempt + 1, 4);
        }
      }
    } finally {
      discoveryStop.abort();
      punchStop?.abort();
      socketStop?.abort();
      await punchWork;
      await candidate?.close();
      await direct.close();
      await Promise.allSettled(nextDirect ? [nextDirect] : []);
      if (!options.rtc) await rtc.close();
      routeKey.fill(0);
    }
  })();
  void settled.catch(() => {});
  return {
    settled,
    revoke,
    status: () => ({ connection, lastSeenAt, pairedComputerName, path }),
    async close() {
      lifetime.abort();
      const results = await Promise.allSettled([settled, revocation]);
      const retried = pendingCleanup !== undefined;
      if (pendingCleanup) {
        // A retained retry owner is best effort here: the process is ending, so it must not keep
        // the shutdown path hostage to a socket the network already dropped.
        await pendingCleanup().catch((error: unknown) => {
          if (!(error instanceof RunnerDrainError)) throw error;
        });
        pendingCleanup = undefined;
        current = undefined;
      }
      const failed = results.find(
        (result) =>
          result.status === "rejected" &&
          !(
            retried &&
            result.reason instanceof Error &&
            result.reason.message === "runner_session_drain_failed"
          ),
      );
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}
export function isRunnerRevocation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).sort().join(",") === "jsonrpc,method,params" &&
    v.jsonrpc === "2.0" &&
    v.method === "link.runner.revoke" &&
    !!v.params &&
    typeof v.params === "object" &&
    !Array.isArray(v.params) &&
    Object.keys(v.params).length === 0
  );
}
