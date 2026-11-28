import type { IsolationStatus } from "@pibot/execution";
import {
  createRunnerDrain,
  isRunnerPunchMessage,
  RunnerDrainError,
  type RunnerLinkStage,
  resumeRunnerDrain,
  runnerDeviceId,
  runnerLinkFailure,
  runnerRetryDelay,
  unbase64,
  waitRunnerRetry,
} from "@pibot/link";
import { firstConnection } from "@pibot/link/lan";
import { parseRunnerAddress } from "@pibot/link/runner-address";
import type { Port } from "@pibot/protocol-base";
import { createRemoteExecutionTarget } from "@pibot/runner/remote-target";
import { transaction } from "@pibot/storage";
import { z } from "zod";
import { roomScope } from "../link/identity.ts";
import type { EndpointIdentity, LinkSession, RemoteLinkPort } from "../link/port.ts";
import type { RemoteResources } from "../runtime/context.ts";

import { runnerAdmission } from "./runner-admission.ts";

const REVOKE_ACK_MS = 5000;
const REVOKE_RETRY_MS = 2000;
const REVOKE_MAX_DELAY_MS = 30_000;
const RECONNECT_DELAY_MS = 1000;

interface Entry {
  target?: Awaited<ReturnType<typeof createRemoteExecutionTarget>>;
  path?: "lan" | "address" | "punched" | "relay";
  addresses?: string[];
  controller: AbortController;
  settled: Promise<void>;
  session?: LinkSession;
  online: boolean;
  /**
   * `revoke_pending` means local trust is already gone and this entry exists only to delete the
   * pairing on the runner side. It never admits the peer again.
   */
  state: "connecting" | "online" | "reconnecting" | "drain_failed" | "revoke_pending";
  cleanup?: () => Promise<void>;
  /** Resolved by the runner's echo once it has durably forgotten this desktop. */
  revokeAck?: (delivered: boolean) => void;
  /** Ends the current quiet wait so the loop switches to delivering a revocation right away. */
  interrupt?: AbortController;
  /** Last probe the runner reported in this session; cleared once it disconnects. */
  isolation?: IsolationStatus;
  /** Failed tries since the last session; bounds how often a failure is logged. */
  failures: number;
}
function revocation(value: unknown) {
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
export class RunnerConnections {
  private readonly entries = new Map<string, Entry>();
  /** Kept from start() so a revocation can open a delivery-only entry while the peer is away. */
  private link: RemoteLinkPort | undefined;
  private identity: EndpointIdentity | undefined;
  private relay: string | undefined;
  private parent: AbortSignal | undefined;
  constructor(
    private readonly r: RemoteResources,
    private readonly changed: () => void,
  ) {}
  online(id: string) {
    return this.entries.get(id)?.online ?? false;
  }
  state(id: string) {
    return this.entries.get(id)?.state;
  }
  path(id: string) {
    return this.entries.get(id)?.path ?? "relay";
  }
  isolation(id: string) {
    return this.entries.get(id)?.isolation;
  }
  count() {
    return [...this.entries.values()].filter((entry) => entry.online).length;
  }
  busy() {
    return [...this.entries.values()].some(
      (entry) => entry.online || entry.session || entry.cleanup,
    );
  }
  start(link: RemoteLinkPort, identity: EndpointIdentity, relay: string, parent: AbortSignal) {
    this.link = link;
    this.identity = identity;
    this.relay = relay;
    this.parent = parent;
    let after: string | undefined;
    for (;;) {
      const page = this.r.devices.page({ after, limit: 100, includeRevoked: true });
      for (const record of page.items) {
        if (record.kind !== "runner" || this.entries.has(record.id)) continue;
        // A runner whose deletion was never confirmed keeps its room so this desktop can still meet
        // it and deliver the revocation; one without a room can never be reached again.
        if (record.revokedAt && !record.room) continue;
        const entry = this.entry(record.revokedAt ? "revoke_pending" : "connecting");
        this.entries.set(record.id, entry);
        this.spawn(record.id, entry, link, identity, relay, parent);
      }
      if (!page.nextAfter) break;
      after = page.nextAfter;
    }
  }
  private entry(state: Entry["state"]): Entry {
    return {
      controller: new AbortController(),
      settled: Promise.resolve(),
      online: false,
      state,
      failures: 0,
    };
  }
  /**
   * Fixed codes only (stage, reason, path, durations, counts): never the device, room, address or
   * key. The desktop logged nothing about runner links before (2026-11-11), so a runner stuck
   * "reconnecting" could not be told from one whose relay or handshake kept failing.
   */
  private log(
    level: "info" | "warn",
    event: string,
    fields: Record<string, string | number | boolean>,
  ) {
    this.r.ctx.logger[level](JSON.stringify({ module: "runner-link", event, ...fields }));
  }
  private spawn(
    id: string,
    entry: Entry,
    link: RemoteLinkPort,
    identity: EndpointIdentity,
    relay: string,
    parent: AbortSignal,
  ) {
    entry.settled = this.run(
      id,
      entry,
      link,
      identity,
      relay,
      AbortSignal.any([parent, entry.controller.signal]),
    );
    void entry.settled.catch(() => {
      // An unconfirmed drain only ends this generation; reconnect instead of parking the entry.
      if (entry.controller.signal.aborted) return;
      entry.state = "reconnecting";
      this.r.ctx.logger.warn("runner_session_drain_failed");
      this.r.changed();
      this.changed();
    });
  }
  private async run(
    id: string,
    entry: Entry,
    link: RemoteLinkPort,
    identity: EndpointIdentity,
    relay: string,
    signal: AbortSignal,
  ) {
    const connectDirect = link.connectRunnerDirect;
    const connectPunch = link.connectRunnerPunch;
    let revokeDelay = REVOKE_RETRY_MS;
    let pending: LinkSession | undefined;
    // After a direct session ends the relay is tried at once, but the direct address keeps being
    // re-dialed beside it. Relay-only here
    // left a reachable listener unused for minutes (Linux acceptance F3, 2026-11-11).
    let directEnded = false;
    let drainSince: number | undefined;
    while (!signal.aborted) {
      // Keep failed cleanup attached to this entry until the actual owner confirms drain.
      if (entry.cleanup) {
        try {
          await entry.cleanup();
          entry.cleanup = undefined;
        } catch (error) {
          if (!(error instanceof RunnerDrainError)) throw error;
          drainSince ??= Date.now();
          entry.failures++;
          if (entry.failures <= 3 || entry.failures % 20 === 0)
            this.log("warn", "drain_pending", {
              waitedMs: Date.now() - drainSince,
              failures: entry.failures,
            });
          entry.state = entry.state === "revoke_pending" ? "revoke_pending" : "drain_failed";
          this.r.changed();
          this.changed();
          await waitRunnerRetry(RECONNECT_DELAY_MS, signal);
          continue;
        }
      }
      drainSince = undefined;
      if (signal.aborted) break;
      const started = Date.now();
      let stage: RunnerLinkStage = "relay";
      let onlineAt: number | undefined;
      let relayFailure: ReturnType<typeof runnerLinkFailure> | undefined;
      let target: Awaited<ReturnType<typeof createRemoteExecutionTarget>> | undefined;
      let unregister: (() => void) | undefined;
      let addressTimer: ReturnType<typeof setInterval> | undefined;
      let off: (() => void) | undefined;
      let failed: unknown;
      let unconfirmed: unknown;
      let session: LinkSession | undefined;
      try {
        const record = this.r.devices.require(id);
        const revoking = !!record.revokedAt;
        // The room and public key outlive the revocation until the runner confirms the deletion;
        // they are the only way to reach a peer that is not connected right now.
        const secret = await this.r.secrets.get(roomScope(id), "room");
        signal.throwIfAborted();
        if (!secret || !record.publicKey || !record.room)
          throw new Error("remote_room_unavailable");
        const input = {
          identity,
          publicKey: record.publicKey,
          room: record.room,
          roomSecret: secret,
          relayUrl: relay,
          signal,
          kind: "runner" as const,
        };
        if (pending && revoking) {
          await pending.close();
          pending = undefined;
        }
        if (entry.failures === 0)
          this.log("info", "attempt", {
            mode: pending ? "upgrade" : connectDirect && !revoking ? "direct_and_relay" : "relay",
          });
        // Inside a race the direct leg keeps re-dialing, so the race only ends when one leg
        // connects: the relay leg has to retry on its own too, or a failed relay is never tried
        // again while the direct leg waits for a listener that may be gone.
        const relayLeg = async (candidateSignal: AbortSignal, retry: boolean) => {
          for (let attempt = 0; ; attempt++) {
            try {
              return await link.connect({ ...input, signal: candidateSignal });
            } catch (error) {
              relayFailure = runnerLinkFailure(error, "relay");
              if (
                (!retry && attempt > 0) ||
                candidateSignal.aborted ||
                error instanceof RunnerDrainError ||
                (error instanceof Error && error.message === "drain_unconfirmed")
              )
                throw error;
              entry.failures++;
              if (entry.failures <= 3 || entry.failures % 20 === 0)
                this.log("warn", "runner_connection_failed", {
                  ...relayFailure,
                  path: "relay",
                  elapsedMs: Date.now() - started,
                  failures: entry.failures,
                });
              await waitRunnerRetry(
                attempt === 0 ? 0 : runnerRetryDelay(attempt - 1),
                candidateSignal,
              );
              candidateSignal.throwIfAborted();
            }
          }
        };
        if (pending) {
          session = pending;
          pending = undefined;
        } else if (connectDirect && !revoking) {
          const retryDirect = directEnded;
          session = await firstConnection<LinkSession>(
            [
              (candidateSignal) => this.dialDirect(connectDirect, input, entry, candidateSignal),
              async (candidateSignal) => {
                if (!retryDirect) await waitRunnerRetry(3000, candidateSignal);
                candidateSignal.throwIfAborted();
                return relayLeg(candidateSignal, true);
              },
            ],
            signal,
          );
        } else session = await relayLeg(signal, false);
        directEnded = false;
        session.select?.();
        await session.activate?.();
        entry.path = session.runnerPath ?? "relay";
        this.r.ctx.logger.info(
          JSON.stringify({ module: "runner-path", path: entry.path, stage: "selected" }),
        );
        stage = "session_admission";
        entry.session = session;
        const wire = session.port;
        // The runner is the LAN dialer: send only authenticated, private-interface route hints
        // over the already encrypted session. The runner still performs Noise admission on each
        // candidate, so these addresses never become an unauthenticated capability.
        try {
          const addresses = link.lanAddresses?.(secret) ?? [];
          wire.post({
            jsonrpc: "2.0",
            method: "link.runner.connect_addresses",
            params: { addresses: addresses.slice(0, 8) },
          });
        } catch {
          // A missing LAN listener is expected; relay and punching remain available.
        }
        addressTimer = setInterval(() => {
          try {
            wire.post({
              jsonrpc: "2.0",
              method: "link.runner.connect_addresses",
              params: { addresses: (link.lanAddresses?.(secret) ?? []).slice(0, 8) },
            });
          } catch {
            /* The session owner will retire this interval during drain. */
          }
        }, 5000);
        const addressNotice = z.object({ method: z.literal("link.runner.addresses") });
        const addresses = (value: unknown) => {
          if (!addressNotice.safeParse(value).success) return false;
          const parsed = z
            .strictObject({
              jsonrpc: z.literal("2.0"),
              method: z.literal("link.runner.addresses"),
              params: z.strictObject({ addresses: z.array(z.string().min(3).max(512)).max(8) }),
            })
            .safeParse(value);
          if (!parsed.success) {
            this.r.ctx.logger.warn("runner_address_rejected");
            return true;
          }
          entry.addresses = parsed.data.params.addresses.flatMap((address) => {
            try {
              return [parseRunnerAddress(address).address];
            } catch {
              this.r.ctx.logger.warn("runner_address_rejected");
              return [];
            }
          });
          return true;
        };
        off = wire.onMessage((value) => {
          if (addresses(value)) return;
          if (!revocation(value)) return;
          // An echo of our own revoke request is the acknowledgement, not a second revocation.
          if (entry.revokeAck) {
            entry.revokeAck(true);
            return;
          }
          // A late echo can land on a session this desktop already retired (the peer read a
          // buffered frame after it resumed, when the desktop had stopped waiting). The device
          // being already revoked still proves the deletion happened on its side, so the
          // revocation is done; every other frame on such a session stays dropped.
          if (this.r.devices.get(id)?.revokedAt) {
            this.finishRevoke(id, true);
            entry.controller.abort();
            this.entries.delete(id);
            return;
          }
          transaction(this.r.ctx.db, () => {
            this.r.devices.revoke(id);
            this.r.devices.clearRoom(id);
            this.r.secrets.remove(roomScope(id), "room");
            this.r.audit(id, "devices.revoke", "runner_revoked", "automatic");
          });
          entry.controller.abort();
          this.r.changed();
        });
        if (revoking) {
          entry.state = "revoke_pending";
          if (await this.deliverRevoke(id, entry, wire, signal)) {
            entry.controller.abort();
            return;
          }
          throw new Error("runner_revoke_undelivered");
        }
        const admission = runnerAdmission(wire);
        const port: Port = {
          ...admission.port,
          onMessage: (fn) =>
            admission.port.onMessage((value) => {
              if (
                !revocation(value) &&
                !isRunnerPunchMessage(value) &&
                !addressNotice.safeParse(value).success
              )
                fn(value);
            }),
        };
        const registry =
          this.r.ctx.ports.get<import("@pibot/protocol-base").EndpointRegistrySource>(
            "endpoints.registry",
          );
        const capabilityFailure = new AbortController();
        const expectedIdentity = `runner:${runnerDeviceId(unbase64(record.publicKey, 32))}`;
        target = await createRemoteExecutionTarget(
          port,
          registry
            ? {
                signal: AbortSignal.any([signal, ...(session.signal ? [session.signal] : [])]),
                receive: (targetId, manifest) => {
                  if (targetId !== expectedIdentity || manifest.endpointKind !== "runner")
                    throw new Error("runner_identity_mismatch");
                  this.r.devices.active(id);
                  entry.online = true;
                  registry.refresh();
                  registry.receive(id, manifest);
                },
                enabled: () => registry.enabled(id),
                subscribe: (listener) => registry.subscribe(id, listener),
                failed: () => {
                  this.r.ctx.logger.warn("runner_capability_delivery_failed");
                  capabilityFailure.abort();
                },
              }
            : undefined,
        );
        signal.throwIfAborted();
        // Re-checked after the handshake: a revocation may have landed while it was in flight.
        this.r.devices.active(id);
        const expected = `runner:${runnerDeviceId(unbase64(record.publicKey, 32))}` as const;
        if (target.targetId !== expected) throw new Error("runner_identity_mismatch");
        unregister = this.r.ctx.local.executionTargets.register(expected, {
          target,
          platform: target.platform,
          name: record.name,
          pairedDeviceId: id,
        });
        entry.target = target;
        entry.online = true;
        entry.state = "online";
        stage = "session";
        onlineAt = Date.now();
        this.log("info", "connected", {
          path: entry.path,
          elapsedMs: onlineAt - started,
          failures: entry.failures,
        });
        entry.failures = 0;
        // runner.info already carries the probe; keep it while the session lasts so the
        // device row can explain why commands would be refused on this host.
        entry.isolation = await target.isolationStatus();
        this.r.devices.seen(id);
        this.r.changed();
        this.changed();
        revokeDelay = REVOKE_RETRY_MS;
        entry.interrupt = new AbortController();
        // A revocation request during this quiet wait breaks it and hands over to the delivery path.
        const active = AbortSignal.any([
          signal,
          capabilityFailure.signal,
          entry.interrupt.signal,
          ...(session.signal ? [session.signal] : []),
        ]);
        if (entry.path !== "relay" || !connectDirect) {
          await waitRunnerRetry(2_147_483_647, active);
          directEnded = !signal.aborted && entry.path !== "relay";
        } else {
          let firstUpgrade = true;
          while (!active.aborted) {
            if (!firstUpgrade) await waitRunnerRetry(60_000, active);
            firstUpgrade = false;
            if (active.aborted) break;
            const attempt = new AbortController();
            const timer = setTimeout(() => attempt.abort(), 10_000);
            try {
              pending = await connectDirect({
                ...input,
                addresses: entry.addresses ?? [],
                ...(this.r.settings.get().direct.mode === "stun" && connectPunch
                  ? {
                      punch: (candidateSignal: AbortSignal) =>
                        connectPunch({
                          identity,
                          publicKey: input.publicKey,
                          port: wire,
                          stunUrl: this.r.settings.get().direct.stunUrl,
                          signal: candidateSignal,
                        }),
                    }
                  : {}),
                signal: AbortSignal.any([signal, attempt.signal]),
              });
              if (active.aborted || this.r.devices.require(id).revokedAt) {
                await pending.close();
                pending = undefined;
                break;
              }
              if (!admission.idle()) {
                await pending.close();
                pending = undefined;
                continue;
              }
              // No await between proving idle, closing target admission and committing selection.
              admission.freeze();
              unregister?.();
              unregister = undefined;
              pending.select?.();
              break;
            } catch (error) {
              if (error instanceof RunnerDrainError) throw error;
              // An unavailable candidate does not retire the healthy relay generation.
              this.r.ctx.logger.info(
                JSON.stringify({
                  module: "runner-path",
                  path: "relay",
                  stage: "upgrade_unavailable",
                }),
              );
            } finally {
              clearTimeout(timer);
            }
          }
        }
      } catch (error) {
        // Finally decides whether the drain is still unconfirmed, not the old error.
        failed = error;
        if (!signal.aborted && !entry.state.startsWith("revoke_")) {
          entry.failures++;
          // The relay leg's own failure says more than firstConnection's summary code.
          const where = relayFailure && !session ? relayFailure : runnerLinkFailure(error, stage);
          if (entry.failures <= 3 || entry.failures % 20 === 0)
            this.log("warn", "runner_connection_failed", {
              ...where,
              path: entry.path ?? "relay",
              elapsedMs: Date.now() - started,
              ...(onlineAt ? { onlineMs: Date.now() - onlineAt } : {}),
              failures: entry.failures,
            });
        }
      } finally {
        clearInterval(addressTimer);
        if (onlineAt !== undefined)
          this.log("info", "session_ended", {
            path: entry.path ?? "relay",
            reason: signal.aborted
              ? "cancelled"
              : pending
                ? "direct_upgrade"
                : entry.interrupt?.signal.aborted
                  ? "interrupted"
                  : failed
                    ? runnerLinkFailure(failed, stage).reason
                    : (session?.ended?.()?.reason ?? "closed"),
            onlineMs: Date.now() - onlineAt,
          });
        entry.online = false;
        entry.target = undefined;
        if (entry.state !== "revoke_pending") entry.state = "reconnecting";
        entry.isolation = undefined;
        // Close admission and publish offline before waiting for potentially slow socket drain.
        unregister?.();
        this.r.changed();
        this.changed();
        entry.cleanup = createRunnerDrain(
          [
            () => resumeRunnerDrain(failed),
            () => off?.(),
            () => target?.dispose(),
            () => session?.close(),
          ],
          signal,
          (incomplete) => {
            // Only fixed owner names and states: errors can contain network credentials.
            const steps = ["previous_drain", "listener", "target", "session"] as const;
            for (const operation of incomplete ?? [])
              this.log("warn", "drain_incomplete", {
                step: steps[operation.index] ?? "unknown",
                state: operation.state === "idle" ? "rejected" : "pending",
              });
            this.r.ctx.logger.warn("runner_session_drain_retry");
            this.r.changed();
          },
        );
        try {
          await entry.cleanup();
          entry.cleanup = undefined;
        } catch (error) {
          // A slow link is not a lifecycle failure: keep the retry owner for close() and reconnect.
          if (signal.aborted) unconfirmed = error;
          else this.r.ctx.logger.warn("runner_session_drain_unconfirmed");
        }
        entry.session = undefined;
        this.r.changed();
        this.changed();
      }
      // Shutdown still reports an unconfirmed drain to close(), which retries the cleanup.
      if (signal.aborted && pending) {
        await pending.close();
        pending = undefined;
      }
      if (unconfirmed) throw unconfirmed;
      if (!signal.aborted) {
        // Keep a relay presence listener ready quickly when the runner returns. The runner's
        // own retry schedule may reach 30 s; desktop admission must not add another long delay.
        const delay = entry.state === "revoke_pending" ? revokeDelay : RECONNECT_DELAY_MS;
        if (entry.state === "revoke_pending")
          revokeDelay = Math.min(REVOKE_MAX_DELAY_MS, revokeDelay * 2);
        if (!pending && !directEnded) await waitRunnerRetry(delay, signal).catch(() => {});
      }
    }
  }
  /**
   * Direct leg of a connection race: re-dials with the runner backoff until it connects or the
   * race ends, so a listener that comes back is used even while the relay is unusable.
   */
  private async dialDirect(
    connect: NonNullable<RemoteLinkPort["connectRunnerDirect"]>,
    input: Omit<Parameters<NonNullable<RemoteLinkPort["connectRunnerDirect"]>>[0], "addresses">,
    entry: Entry,
    signal: AbortSignal,
  ): Promise<LinkSession> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await connect({ ...input, addresses: entry.addresses ?? [], signal });
      } catch (error) {
        if (signal.aborted || error instanceof RunnerDrainError) throw error;
        await waitRunnerRetry(runnerRetryDelay(attempt), signal);
        signal.throwIfAborted();
      }
    }
  }
  /** Sends the deletion and waits for the runner's echo on the current session. */
  private deliverRevoke(id: string, entry: Entry, wire: Port, signal: AbortSignal) {
    const stop = () =>
      entry.session?.signal ? AbortSignal.any([signal, entry.session.signal]) : signal;
    return (async () => {
      while (!stop().aborted) {
        if (await this.askRevoke(entry, wire, REVOKE_ACK_MS)) {
          // Nothing else is waiting on this delivery, so the audit entry has to be written here.
          this.finishRevoke(id, true);
          return true;
        }
        const wait = stop();
        if (wait.aborted) return false;
        await waitRunnerRetry(REVOKE_RETRY_MS, wait).catch(() => {});
        if (wait.aborted) return false;
      }
      return false;
    })();
  }
  private askRevoke(entry: Entry, wire: Port, ms: number) {
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: boolean) => {
        clearTimeout(timer);
        if (entry.revokeAck === finish) entry.revokeAck = undefined;
        resolve(value);
      };
      timer = setTimeout(() => finish(false), ms);
      entry.revokeAck = finish;
      try {
        wire.post({ jsonrpc: "2.0", method: "link.runner.revoke", params: {} });
      } catch {
        // A session that broke before the frame left still gets another delivery attempt.
        finish(false);
      }
    });
  }
  private finishRevoke(id: string, audit: boolean) {
    transaction(this.r.ctx.db, () => {
      this.r.devices.clearRoom(id);
      this.r.secrets.remove(roomScope(id), "room");
      // The caller of revoke() still records the user-facing outcome; a late delivery is its own news.
      if (audit) this.r.audit(id, "devices.revoke", "delivered", "automatic");
    });
    this.r.changed();
    this.changed();
  }
  /** Returns whether the runner confirmed it forgot this desktop on an open session. */
  async revoke(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return this.spawnDelivery(id);
    entry.state = "revoke_pending";
    const session = entry.session;
    if (!session) {
      // The loop is between generations; it will open the next one straight into delivery mode.
      entry.interrupt?.abort();
      return false;
    }
    const delivered = await this.askRevoke(entry, session.port, REVOKE_ACK_MS);
    if (delivered) {
      this.finishRevoke(id, false);
      // The peer already forgot this desktop; nothing is left to retry on this session.
      entry.controller.abort();
      this.entries.delete(id);
      return true;
    }
    // Not delivered yet: keep the entry so the deletion is retried while the peer is still away.
    entry.interrupt?.abort();
    return false;
  }
  /** Starts a delivery-only entry for a runner that is not connected right now. */
  private spawnDelivery(id: string) {
    const { link, identity, relay, parent } = this;
    if (!link || !identity || !relay || !parent) return false;
    const entry = this.entry("revoke_pending");
    this.entries.set(id, entry);
    this.spawn(id, entry, link, identity, relay, parent);
    return false;
  }
  async syncPhoneAuthorizations(
    id: string,
    grants: import("@pibot/protocol-base").PhoneControlGrant[],
    signal: AbortSignal,
  ) {
    const target = this.entries.get(id)?.target;
    if (!target) throw new Error("runner_offline");
    await target.syncPhoneAuthorizations(grants, signal);
  }
  async close(id?: string) {
    const entries = [...this.entries].filter(([key]) => !id || key === id);
    for (const [, entry] of entries) entry.controller.abort();
    const results = await Promise.allSettled(entries.map(([, entry]) => entry.settled));
    if (results.some((result) => result.status === "rejected")) {
      const retried = await Promise.allSettled(entries.map(([, entry]) => entry.cleanup?.()));
      if (retried.some((result) => result.status === "rejected"))
        throw new Error("runner_session_drain_failed");
    }
    for (const [key] of entries) this.entries.delete(key);
  }
}
