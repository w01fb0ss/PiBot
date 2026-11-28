import { randomUUID } from "node:crypto";
import { type RtcPeerFactory, RunnerDrainError } from "@pibot/link";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { RemoteSettings, RemoteState } from "@pibot/remote-contract";
import { RelayUrlSchema } from "@pibot/remote-contract";
import { transaction } from "@pibot/storage";
import { RemoteDeviceOperations } from "../devices/operations.ts";
import { remoteIdentity, roomScope } from "../link/identity.ts";
import type { EndpointIdentity, RemoteLinkPort } from "../link/port.ts";
import { RemoteOfflineService } from "../offline/service.ts";
import { PairingManager } from "../pairing/manager.ts";
import { RemoteNotifications } from "../push/notifications.ts";
import { PhoneWake } from "../push/wake.ts";
import type { RemoteHostPort, RemoteKernelPort } from "../rpc/port.ts";

import { PhoneAuthorizations } from "../runners/phone-authorizations.ts";
import { RemoteConnections } from "../sessions/connections.ts";
import { validateSettingsChange } from "../settings/validate.ts";
import type { RemoteResources } from "./context.ts";

export interface RemoteOptions {
  createRtcPeer?: RtcPeerFactory;
  link?: RemoteLinkPort;
  kernel?: RemoteKernelPort;
  host?: RemoteHostPort;
}
type SetupStage = "queue" | "power" | "remote";
// Keep-awake is a host round trip; the identity read is the only secret store access; anything
// else in setup is the link. Calling every failure "secrets" sent users to the wrong fix.
const setupFailure = (stage: SetupStage, error: unknown): RemoteState["reason"] =>
  stage === "power"
    ? "rpc_unavailable"
    : error instanceof RpcError && error.code === RpcErrorCodes.secretsUnavailable
      ? "secrets_unavailable"
      : "connection_failed";
const isDrainFailure = (error: unknown) =>
  error instanceof Error &&
  [
    "drain_unconfirmed",
    "remote_connection_drain_failed",
    "remote_session_drain_failed",
    "runner_session_drain_failed",
  ].includes(error.message);
/** Provided to the brain as "interactive-client": the desktop window quit or came back. */
interface InteractiveClientPort {
  setInteractive(state: "available" | "quit"): void;
}
export class RemoteService {
  readonly pairing: PairingManager;
  readonly connections: RemoteConnections;
  readonly offline: RemoteOfflineService;
  readonly phoneAuthorizations: PhoneAuthorizations;
  private authorizationTimer?: ReturnType<typeof setInterval>;
  private authorizationWork?: Promise<void>;
  private readonly deviceOperations: RemoteDeviceOperations;
  private readonly notifications: RemoteNotifications;
  private readonly wake: PhoneWake;
  private wakeTasks = new Set<Promise<void>>();
  private lifetime = new AbortController();
  private active = new AbortController();
  private paused = false;
  private stopping = false;
  private drainFailed = false;
  private runnerCleanup?: () => Promise<void>;
  private identity?: EndpointIdentity;
  private keyRead?: Promise<EndpointIdentity>;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private off?: () => void;
  private powerTimer: ReturnType<typeof setTimeout> | undefined;
  private awake: RemoteState["keepAwake"] = "off";
  private failure?: RemoteState["reason"];
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryMs = 1000;
  private interactive: "available" | "quit" = "available";
  interactivePort(): InteractiveClientPort {
    return {
      setInteractive: (state) => {
        if (this.interactive === state) return;
        this.interactive = state;
        for (const phone of this.connections.phones())
          this.connections.emitTo(phone.deviceId, "remote.interactive", { interactive: state });
      },
    };
  }
  private clearRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
  private retrySetup() {
    if (
      this.retryTimer ||
      this.stopping ||
      this.drainFailed ||
      this.paused ||
      !this.r.settings.get().enabled ||
      !this.options.link ||
      !this.options.kernel ||
      !this.relay()
    )
      return;
    const active = this.active;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.mutate(async () => {
        if (active !== this.active || active.signal.aborted || this.paused) return;
        const stage = { current: "queue" as SetupStage };
        try {
          await this.setup(stage);
        } catch (error) {
          if (isDrainFailure(error)) this.drainFailed = true;
          this.failure = setupFailure(stage.current, error);
          this.r.ctx.logger.warn(
            JSON.stringify({ module: "remote", event: "setup_retry", stage: stage.current }),
          );
          this.changed();
          this.retrySetup();
        }
      }).catch(() => {
        // Queue admission can fail during another mutation; retry only the setup, never its RPC.
        if (active === this.active) this.retrySetup();
      });
    }, this.retryMs);
    this.retryMs = Math.min(60_000, this.retryMs * 2);
    this.retryTimer.unref?.();
  }
  constructor(
    readonly r: RemoteResources,
    private readonly options: RemoteOptions,
  ) {
    if (options.link?.kind === "development" && !r.ctx.dev)
      throw new Error("remote_development_transport_forbidden");
    this.wake = new PhoneWake(r);
    this.offline = new RemoteOfflineService(r, (id, payload) =>
      this.connections.emitTo(id, "remote.offline.changed", payload),
    );
    this.phoneAuthorizations = new PhoneAuthorizations(r, {
      signal: () => AbortSignal.any([this.active.signal, this.lifetime.signal]),
      identity: () => this.keys(),
      send: (id, grants, signal) =>
        this.connections.runners.syncPhoneAuthorizations(id, grants, signal),
      changed: (id) => this.connections.emitTo(id, "remote.offline.changed", {}),
    });
    this.offline.runnerControl = (id, after) => this.phoneAuthorizations.pull(id, after);
    this.connections = new RemoteConnections(
      r,
      () => this.changed(),
      this.offline,
      () => this.interactive,
    );
    this.notifications = new RemoteNotifications(r, (id) => this.connections.foreground(id));
    this.pairing = new PairingManager(r, () => this.refresh());
    this.deviceOperations = new RemoteDeviceOperations(
      r,
      this.connections,
      this.notifications,
      () => this.requireReady(),
      () => this.lifetime.signal,
      this.offline,
    );
  }
  async wakePhone(id: string, parent: AbortSignal) {
    const signal = AbortSignal.any([
      parent,
      this.active.signal,
      this.lifetime.signal,
      AbortSignal.timeout(30_000),
    ]);
    const task = (async () => {
      if (!this.r.settings.get().enabled || this.paused || this.stopping) return;
      const { link, relay } = this.requireReady();
      if (!(await this.wake.send(id, link, relay, signal))) {
        parent.throwIfAborted();
        this.active.signal.throwIfAborted();
        this.lifetime.signal.throwIfAborted();
        if (signal.aborted) throw new RpcError(RpcErrorCodes.timeout, "phone_wake_timeout");
        throw new RpcError(RpcErrorCodes.unsupported, "phone_wake_unavailable");
      }
      while (!signal.aborted) {
        this.r.devices.active(id);
        if (this.connections.phones().some((phone) => phone.deviceId === id && phone.wakeReady))
          return;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 100);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
      parent.throwIfAborted();
      this.active.signal.throwIfAborted();
      this.lifetime.signal.throwIfAborted();
      throw new RpcError(RpcErrorCodes.timeout, "phone_wake_timeout");
    })();
    this.wakeTasks.add(task);
    try {
      await task;
    } finally {
      this.wakeTasks.delete(task);
    }
  }
  private relay() {
    const settings = this.r.settings.get();
    return settings.relay === "custom" ? settings.relayUrl : this.options.link?.officialRelayUrl;
  }
  state(): RemoteState {
    const settings = this.r.settings.get();
    const reason =
      this.stopping || !settings.enabled
        ? !this.options.link
          ? "link_unavailable"
          : "off"
        : this.paused
          ? "sleeping"
          : !this.options.link
            ? "link_unavailable"
            : !this.options.kernel
              ? "rpc_unavailable"
              : !this.relay()
                ? "relay_unavailable"
                : (this.failure ?? this.connections.state());
    return {
      reason,
      onlineDevices: this.connections.onlineCount(),
      pairingAvailable:
        settings.enabled &&
        !this.drainFailed &&
        !this.paused &&
        !this.stopping &&
        !!this.options.link &&
        !!this.options.kernel &&
        !!this.relay() &&
        !this.failure,
      keepAwake: this.options.host ? this.awake : "unsupported",
    };
  }
  changed() {
    if (!this.stopping) this.r.ctx.peer.emit("remote.state", this.state());
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new RpcError(RpcErrorCodes.closed, "remote_stopping"));
    if (this.queued >= 32) return Promise.reject(new RpcError(RpcErrorCodes.busy, "remote_busy"));
    this.queued++;
    const work = this.tail.then(() => {
      this.lifetime.signal.throwIfAborted();
      return action();
    });
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work.finally(() => {
      this.queued--;
    });
  }
  private async keys() {
    if (!this.options.link)
      throw new RpcError(RpcErrorCodes.unsupported, "remote_link_unavailable");
    this.keyRead ??= remoteIdentity(
      this.r,
      this.options.link,
      AbortSignal.any([this.lifetime.signal, this.active.signal, AbortSignal.timeout(20_000)]),
    );
    try {
      this.identity = await this.keyRead;
      return this.identity;
    } catch {
      this.keyRead = undefined;
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "remote_identity_unavailable");
    }
  }
  private requireReady() {
    if (this.drainFailed) throw new RpcError(RpcErrorCodes.unsupported, "remote_apply_incomplete");
    const relay = this.relay();
    if (!this.options.link)
      throw new RpcError(RpcErrorCodes.unsupported, "remote_link_unavailable");
    if (!this.options.kernel)
      throw new RpcError(RpcErrorCodes.unsupported, "remote_rpc_unavailable");
    if (!relay) throw new RpcError(RpcErrorCodes.unsupported, "remote_relay_unavailable");
    return {
      link: this.options.link,
      kernel: this.options.kernel,
      relay: RelayUrlSchema.parse(relay),
    };
  }
  private refreshAuthorizations() {
    if (this.authorizationWork || this.stopping || this.paused || !this.r.settings.get().enabled)
      return;
    this.authorizationWork = this.phoneAuthorizations
      .refresh(AbortSignal.any([this.active.signal, this.lifetime.signal]))
      .catch(() => {
        this.r.ctx.logger.warn("runner_authorizations_refresh_failed");
      })
      .finally(() => {
        this.authorizationWork = undefined;
      });
  }
  async start() {
    this.authorizationTimer = setInterval(() => this.refreshAuthorizations(), 60_000);
    this.authorizationTimer.unref?.();
    this.off = this.options.kernel?.subscribe((event) => {
      if (this.stopping || this.paused || !this.r.settings.get().enabled) return;
      try {
        this.connections.publish(event);
      } catch {
        this.r.ctx.logger.warn("Remote event delivery unavailable");
      }
      const relay = this.relay();
      if (this.options.link && relay)
        this.notifications.publish(event, this.options.link, relay, this.active.signal);
    });
    if (this.r.settings.get().enabled)
      // Keep-awake and the identity decrypt are host round trips (20 s caps) and the
      // relay connect is network; the brain does not need them to report ready. Queued as a
      // mutation so a settings change made right after startup is ordered after it, and stop()
      // waits for it through `tail`. mutate() rejects only when already stopping.
      void this.mutate(async () => {
        const stage = { current: "queue" as SetupStage };
        try {
          await this.setup(stage);
        } catch (error) {
          this.failure = !this.options.link
            ? "link_unavailable"
            : !this.options.kernel
              ? "rpc_unavailable"
              : !this.relay()
                ? "relay_unavailable"
                : setupFailure(stage.current, error);
          this.retrySetup();
        }
        this.changed();
      }).catch(() => {});
    this.changed();
  }
  /** `stage` is written as setup advances so a failure names the step that failed. */
  private async setup(stage: { current: SetupStage }) {
    stage.current = "power";
    await this.applyPower(this.r.settings.get());
    stage.current = "remote";
    await this.refresh();
  }
  private async applyPower(settings: RemoteSettings) {
    clearTimeout(this.powerTimer);
    this.powerTimer = undefined;
    this.awake = this.options.host
      ? await this.options.host.keepAwake(
          settings.enabled && settings.keepAwake,
          AbortSignal.any([this.lifetime.signal, this.active.signal, AbortSignal.timeout(20_000)]),
        )
      : "unsupported";
    this.renewPower(settings);
  }
  private renewPower(settings: RemoteSettings) {
    if (
      !this.stopping &&
      !this.paused &&
      settings.enabled &&
      settings.keepAwake &&
      this.options.host
    ) {
      const active = this.active;
      this.powerTimer = setTimeout(() => {
        void this.mutate(async () => {
          if (active !== this.active || active.signal.aborted || this.paused || this.stopping)
            return;
          try {
            await this.applyPower(this.r.settings.get());
          } catch {
            this.awake = "unsupported";
            this.renewPower(this.r.settings.get());
            this.r.ctx.logger.warn(JSON.stringify({ module: "remote", event: "power_failed" }));
          }
          this.changed();
        }).catch(() => {
          /* Stop retires queued renewals; the host lease expires independently. */
        });
      }, 30_000);
    }
  }
  async refresh() {
    if (this.drainFailed) throw new Error("remote_recovery_drain_failed");
    if (this.stopping || this.paused || !this.r.settings.get().enabled) return;
    const { link, kernel, relay } = this.requireReady();
    const identity = await this.keys();
    this.active.signal.throwIfAborted();
    if (this.stopping || this.paused || !this.r.settings.get().enabled) return;
    const active = this.active;
    try {
      await link.configureLan?.(this.r.settings.get().lanDiscovery);
    } catch (error) {
      if (isDrainFailure(error)) this.drainFailed = true;
      throw error;
    }
    active.signal.throwIfAborted();
    if (active !== this.active || this.stopping || this.paused) return;
    this.connections.start(link, kernel, identity, relay, this.active.signal);
    this.refreshAuthorizations();
    this.failure = undefined;
    this.clearRetry();
    this.retryMs = 1000;
    this.changed();
  }
  setSettings(
    expectedVersion: number,
    patch: Partial<Omit<RemoteSettings, "version">>,
    disclosureAccepted?: boolean,
  ) {
    return this.mutate(async () => {
      const next = validateSettingsChange(
        this.r,
        this.options,
        expectedVersion,
        patch,
        disclosureAccepted,
      );
      if (next.enabled) await this.keys();
      await this.disconnect();
      const value = transaction(this.r.ctx.db, () => {
        const saved = this.r.settings.set(expectedVersion, patch);
        this.r.audit(undefined, "remote.settings.set", saved.enabled ? "enabled" : "disabled");
        return saved;
      });
      this.active = new AbortController();
      if (!value.enabled) this.connections.clearBuffers();
      this.failure = undefined;
      try {
        await this.applyPower(value);
        await this.refresh();
      } catch {
        this.failure = "connection_failed";
        this.retrySetup();
        this.changed();
        throw new RpcError(RpcErrorCodes.unsupported, "remote_apply_incomplete");
      }
      this.changed();
      return value;
    });
  }
  pairStart(kind?: "runner") {
    return this.mutate(async () => {
      if (!this.state().pairingAvailable)
        throw new RpcError(RpcErrorCodes.unsupported, "remote_pair_unavailable");
      const { link, relay } = this.requireReady();
      return this.pairing.start(
        link,
        await this.keys(),
        relay,
        AbortSignal.any([this.lifetime.signal, this.active.signal]),
        kind,
      );
    });
  }
  pairRunner(code: string, parent: AbortSignal) {
    return this.mutate(async () => {
      const { link, relay } = this.requireReady();
      if (!link.pairRunner || !this.state().pairingAvailable)
        throw new RpcError(RpcErrorCodes.unsupported, "remote_pair_unavailable");
      this.r.ctx.redactor.add(code);
      this.r.ctx.redactor.add(code.replace(/[\s-]/g, "").toUpperCase());
      const signal = AbortSignal.any([
        parent,
        this.lifetime.signal,
        this.active.signal,
        AbortSignal.timeout(30_000),
      ]);
      let committed = false;
      try {
        await link.pairRunner({
          identity: await this.keys(),
          relayUrl: relay,
          name: this.r.settings.get().desktopName,
          code,
          signal,
          commit: async (device) => {
            this.r.ctx.redactor.add(device.roomSecret);
            const id = randomUUID();
            const commit = await this.r.secrets.prepareSet(
              roomScope(id),
              "room",
              device.roomSecret,
            );
            signal.throwIfAborted();
            transaction(this.r.ctx.db, () => {
              commit();
              this.r.devices.add({
                id,
                kind: "runner",
                name: this.r.ctx.redactor.redact(device.name),
                publicKey: device.publicKey,
                room: device.room,
              });
              this.r.audit(id, "devices.runnerPair", "paired", "user");
            });
            committed = true;
            this.r.changed();
          },
        });
      } catch (error) {
        if (isDrainFailure(error)) {
          this.drainFailed = true;
          if (error instanceof RunnerDrainError) this.runnerCleanup = error.retry;
          this.r.audit(undefined, "devices.runnerPair", "drain_failed", "user");
          this.changed();
          throw new RpcError(RpcErrorCodes.unsupported, "remote_apply_incomplete");
        }
        if (!committed) {
          this.r.audit(undefined, "devices.runnerPair", "failed", "user");
          throw new RpcError(
            RpcErrorCodes.unsupported,
            error instanceof Error && error.message === "invalid_pairing"
              ? "remote_pair_invalid"
              : error instanceof Error && error.message === "pairing_relay_mismatch"
                ? "remote_pair_relay_mismatch"
                : "remote_pair_failed",
          );
        }
      }
      // Pairing is already durable. Start runner admission without reconfiguring phone LAN
      // listeners; a slow unrelated refresh must not leave the new runner unregistered.
      this.connections.runners.start(link, await this.keys(), relay, this.active.signal);
      this.r.changed();
      this.changed();
      return { ok: true as const };
    });
  }
  list(params: Parameters<RemoteDeviceOperations["list"]>[0]) {
    return this.deviceOperations.list(params);
  }
  listWithCodes(params: Parameters<RemoteDeviceOperations["listWithCodes"]>[0]) {
    return this.deviceOperations.listWithCodes(params);
  }
  rename(id: string, name: string) {
    return this.mutate(() => this.deviceOperations.rename(id, name));
  }
  revoke(id: string, removeAnyway = false) {
    return this.mutate(async () => {
      const result = await this.deviceOperations.revoke(id, removeAnyway);
      this.refreshAuthorizations();
      this.changed();
      return result;
    });
  }
  idle() {
    return (
      !this.drainFailed &&
      !this.wakeTasks.size &&
      !this.queued &&
      !this.pairing.busy() &&
      !this.notifications.busy() &&
      !this.connections.busy() &&
      this.awake !== "requested"
    );
  }
  private async disconnect() {
    clearTimeout(this.powerTimer);
    this.powerTimer = undefined;
    if (this.options.host) {
      try {
        this.awake = await this.options.host.keepAwake(false, AbortSignal.timeout(20_000));
      } catch {
        // A failed host reply must not prevent network/resource drain; its lease still expires.
        this.awake = "unsupported";
        this.r.ctx.logger.warn(JSON.stringify({ module: "remote", event: "power_release_failed" }));
      }
    }
    this.clearRetry();
    this.retryMs = 1000;
    this.active.abort();
    await this.authorizationWork;
    await this.phoneAuthorizations.settled();
    await Promise.allSettled([...this.wakeTasks]);
    try {
      await this.options.link?.configureLan?.(false);
      await this.pairing.cancel();
      await this.connections.close();
      await this.notifications.settled();
      await this.runnerCleanup?.();
      this.runnerCleanup = undefined;
      this.drainFailed = false;
    } catch (error) {
      this.drainFailed = true;
      throw error;
    }
  }
  async pause(signal: AbortSignal) {
    this.paused = true;
    await this.disconnect();
    signal.throwIfAborted();
    this.changed();
  }
  async resume() {
    if (this.drainFailed) throw new Error("remote_recovery_drain_failed");
    this.paused = false;
    this.active = new AbortController();
    const stage = { current: "queue" as SetupStage };
    await this.mutate(async () => {
      if (this.drainFailed) throw new Error("remote_recovery_drain_failed");
      await this.setup(stage);
    }).catch((error: unknown) => {
      if (this.drainFailed || isDrainFailure(error)) {
        this.drainFailed = true;
        throw error;
      }
      this.failure = setupFailure(stage.current, error);
      this.r.ctx.logger.warn(
        JSON.stringify({ module: "remote", event: "setup_retry", stage: stage.current }),
      );
      this.retrySetup();
      this.changed();
      // Remote setup is recoverable. Only unconfirmed resource drain closes brain admission.
    });
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.authorizationTimer);
    this.off?.();
    this.off = undefined;
    this.lifetime.abort();
    await this.disconnect();
    await this.tail;
    // A cancelled in-flight runner pairing can hand back its drain owner after disconnect.
    if (this.runnerCleanup) await this.disconnect();
    this.connections.clearBuffers();
    this.identity = undefined;
    this.keyRead = undefined;
  }
}
