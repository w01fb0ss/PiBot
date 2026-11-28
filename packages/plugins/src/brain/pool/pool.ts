import type { ConnectorConnection } from "@pibot/plugins-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";

export interface ConnectorPoolTarget {
  connectorId: string;
  generation: number;
  // The injected adapter owns cleanup if opening fails before returning a connection.
  open(signal: AbortSignal): Promise<ConnectorConnection>;
  /** Longer opening deadline for a target that waits on a person (an OS permission prompt). */
  openTimeoutMs?: number;
  /** An isolated stdio server shares one network origin across all requests. */
  serial?: boolean;
}
interface Entry {
  generation: number;
  controller: AbortController;
  ready: Promise<ConnectorConnection>;
  connection?: ConnectorConnection;
  tail?: Promise<unknown>;
  calls: Set<Promise<unknown>>;
  lastUsed: number;
  stopping: boolean;
  drainFailed: boolean;
  draining?: Promise<void>;
}

/** Brain-owned; sessions borrow a connection but never close the pool. */
export class ConnectorPool {
  private readonly entries = new Map<string, Entry>();
  // Keep the generation floor after resource disposal, without revoking idle/retry reconnects.
  private readonly generations = new Map<string, { generation: number; revoked: boolean }>();
  private disposed = false;

  constructor(
    private readonly options: {
      now?: () => number;
      idleMs?: number;
      openTimeoutMs?: number;
      callTimeoutMs?: number;
      drainTimeoutMs?: number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private entry(target: ConnectorPoolTarget): Entry {
    if (this.disposed)
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector pool closed");
    const previous = this.entries.get(target.connectorId);
    if (previous) {
      if (previous.stopping)
        throw new RpcError(
          RpcErrorCodes.busy,
          previous.drainFailed ? "Connector cleanup requires retry" : "Connector stopping",
        );
      if (previous.generation !== target.generation)
        throw new RpcError(RpcErrorCodes.connectorStale, "Connector generation changed");
      return previous;
    }
    const latest = this.generations.get(target.connectorId);
    if (
      latest &&
      (target.generation < latest.generation ||
        (target.generation === latest.generation && latest.revoked))
    )
      throw new RpcError(RpcErrorCodes.connectorStale, "Connector generation retired");
    const controller = new AbortController();
    const entry: Entry = {
      generation: target.generation,
      controller,
      ready: Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return target.open(controller.signal);
      }),
      calls: new Set(),
      lastUsed: this.now(),
      stopping: false,
      drainFailed: false,
    };
    this.generations.set(target.connectorId, { generation: target.generation, revoked: false });
    this.entries.set(target.connectorId, entry);
    const timer = setTimeout(
      () => {
        controller.abort(new DOMException("Connector opening timed out", "TimeoutError"));
        this.recover(target.connectorId, entry);
      },
      target.openTimeoutMs ?? this.options.openTimeoutMs ?? 30_000,
    );
    timer.unref();
    entry.ready = entry.ready.then((connection) => {
      entry.connection = connection;
      controller.signal.throwIfAborted();
      return connection;
    });
    // Observe failures even when the only waiter has already cancelled; retain ownership for drain.
    void entry.ready.then(
      () => clearTimeout(timer),
      () => {
        clearTimeout(timer);
        this.recover(target.connectorId, entry);
      },
    );
    return entry;
  }

  private recover(id: string, entry: Entry): void {
    void this.beginDrain(id, entry).catch(() => {
      // Admission reports failed cleanup; keep ownership so explicit stop can retry it.
      entry.drainFailed = true;
    });
  }

  async run<T>(
    target: ConnectorPoolTarget,
    action: (connection: ConnectorConnection, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    const entry = this.entry(target);
    const timeout = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const combined = AbortSignal.any([signal, entry.controller.signal, timeout.signal]);
    entry.lastUsed = this.now();
    // Do not race the action against abort: settlement is not proof that remote work drained.
    const previous = target.serial ? entry.tail : undefined;
    const pending = (async () => {
      const connection = await entry.ready;
      if (previous) await previous;
      // Opening has its own deadline (it may wait on a permission prompt); this one bounds the call.
      timer = setTimeout(
        () => timeout.abort(new DOMException("Connector call timed out", "TimeoutError")),
        this.options.callTimeoutMs ?? 60_000,
      );
      timer.unref();
      combined.throwIfAborted();
      return action(connection, combined);
    })();
    if (target.serial)
      entry.tail = pending.then(
        () => undefined,
        () => undefined,
      );
    entry.calls.add(pending);
    try {
      return await pending;
    } finally {
      clearTimeout(timer);
      entry.calls.delete(pending);
      entry.lastUsed = this.now();
    }
  }

  stop(connectorId: string, generation?: number): Promise<void> {
    const entry = this.entries.get(connectorId);
    const latest = this.generations.get(connectorId);
    const owner = generation ?? entry?.generation ?? latest?.generation;
    if (
      (entry && owner !== entry.generation) ||
      (owner !== undefined && latest && owner < latest.generation)
    )
      return Promise.reject(
        new RpcError(RpcErrorCodes.connectorStale, "Connector generation changed"),
      );
    // Even joining an idle/recovery drain, or stopping an idle resource, revokes its owner.
    if (owner !== undefined)
      this.generations.set(connectorId, { generation: owner, revoked: true });
    return entry ? this.beginDrain(connectorId, entry) : Promise.resolve();
  }

  private beginDrain(connectorId: string, entry: Entry): Promise<void> {
    if (entry.draining) return this.awaitDrain(entry);
    // Revoke admission before the first await. A failing/slow close must keep this tombstone.
    entry.stopping = true;
    entry.drainFailed = false;
    // Publish the shared drain before abort(): a cancel listener may reenter stop() synchronously,
    // and a second drain here would close the same connection concurrently.
    entry.draining = this.drain(connectorId, entry).catch(() => {
      entry.draining = undefined;
      entry.drainFailed = true;
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector drain failed");
    });
    entry.controller.abort(new DOMException("Connector stopped", "AbortError"));
    return this.awaitDrain(entry);
  }

  private async awaitDrain(entry: Entry): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entry.draining,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            entry.drainFailed = true;
            reject(new RpcError(RpcErrorCodes.connectorUnavailable, "Connector drain timed out"));
          }, this.options.drainTimeoutMs ?? 10_000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // A deadline only releases the waiter. The same background drain retains ownership;
    // retry must never start a second close while the first is still in flight.
  }

  private async drain(id: string, entry: Entry): Promise<void> {
    // Opening failures have no returned resource; adapters must clean up before rejecting.
    await entry.ready.then(
      () => undefined,
      () => undefined,
    );
    if (entry.connection) await entry.connection.close();
    await Promise.allSettled(entry.calls);
    if (this.entries.get(id) === entry) this.entries.delete(id);
  }

  async reapIdle(): Promise<void> {
    const now = this.now();
    const pending: Promise<void>[] = [];
    for (const [id, entry] of this.entries) {
      if (
        !entry.stopping &&
        !entry.calls.size &&
        now - entry.lastUsed >= (this.options.idleMs ?? 900_000)
      )
        pending.push(this.beginDrain(id, entry));
    }
    const results = await Promise.allSettled(pending);
    if (results.some((result) => result.status === "rejected"))
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "Idle connector drain failed");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.stop(id)));
    if (results.some((result) => result.status === "rejected"))
      throw new RpcError(RpcErrorCodes.connectorUnavailable, "Connector pool drain failed");
    this.generations.clear();
  }
}
