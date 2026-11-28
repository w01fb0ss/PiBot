import { LinkError } from "../core/bytes.ts";
import { readRunnerRoute, runnerRoute } from "../room/runner.ts";
import type { RoomTicket } from "../room/ticket.ts";
import { RunnerLinkError, type RunnerLinkStage } from "./connect-progress.ts";
import type { BinaryTransport } from "./port.ts";
import { bufferRunnerTransport } from "./runner-buffer.ts";
import { drainRunnerConnection } from "./runner-retry.ts";
import {
  connectRelay,
  type SocketConstructor,
  type SocketEvent,
  type SocketLike,
} from "./socket.ts";

/** One generation; reconnect and credential ownership belong to the product session owner. */
export async function openRunnerRelay(options: {
  WebSocket: SocketConstructor;
  relay: string;
  ticket: RoomTicket;
  role: "desktop" | "runner";
  slot: string;
  signal: AbortSignal;
  peerTimeoutMs?: number;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.slot)) throw new LinkError("invalid_identity");
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  let socket: SocketLike | undefined;
  let drained: Promise<void> = Promise.resolve();
  const Socket: SocketConstructor = class implements SocketLike {
    private readonly inner: SocketLike;
    private readonly listeners = new Map<
      (event: SocketEvent) => void,
      (event: SocketEvent) => void
    >();
    constructor(url: string) {
      socket = this.inner = new options.WebSocket(url);
      drained = new Promise<void>((resolve) =>
        this.inner.addEventListener("close", () => resolve()),
      );
    }
    get readyState() {
      return this.inner.readyState;
    }
    get connectProgress() {
      return this.inner.connectProgress;
    }
    get bufferedAmount() {
      return this.inner.bufferedAmount;
    }
    get binaryType() {
      return this.inner.binaryType;
    }
    set binaryType(value: string) {
      this.inner.binaryType = value;
    }
    send(value: ArrayBuffer | string) {
      if (typeof value === "string" || options.role !== "desktop") this.inner.send(value);
      else this.inner.send(runnerRoute(options.slot, new Uint8Array(value)).buffer as ArrayBuffer);
    }
    close(code?: number, reason?: string) {
      this.inner.close(code, reason);
    }
    addEventListener(type: string, fn: (event: SocketEvent) => void) {
      if (type !== "message") {
        this.inner.addEventListener(type, fn);
        return;
      }
      const listener = (event: SocketEvent) => {
        if (type !== "message" || typeof event.data === "string" || options.role !== "desktop") {
          fn(event);
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        const routed = readRunnerRoute(new Uint8Array(event.data));
        if (routed?.slot === options.slot)
          fn({ type: "message", data: routed.frame.slice().buffer });
      };
      this.listeners.set(fn, listener);
      this.inner.addEventListener(type, listener);
    }
    removeEventListener(type: string, fn: (event: SocketEvent) => void) {
      if (type !== "message") {
        this.inner.removeEventListener(type, fn);
        return;
      }
      const listener = this.listeners.get(fn);
      if (listener) this.inner.removeEventListener(type, listener);
      this.listeners.delete(fn);
    }
  };
  let client: ReturnType<typeof connectRelay> | undefined;
  let present = false;
  // Why the latest generation ended, as fixed codes, for the caller's diagnostics.
  let failure: { stage: RunnerLinkStage; reason: string } | undefined;
  let diagnostics: { status?: number; closeCode?: number; wasClean?: boolean } | undefined;
  const failed = (stage: RunnerLinkStage) =>
    new RunnerLinkError(
      failure?.stage ?? stage,
      failure?.reason ?? (options.signal.aborted ? "cancelled" : "closed"),
      diagnostics?.status,
      diagnostics?.closeCode,
      diagnostics?.wasClean,
    );
  const observers = new Set<() => void>();
  const stop = () => {
    lifetime.abort();
    queueMicrotask(() => client?.stop());
    for (const notify of observers) notify();
  };
  const close = async () => {
    stop();
    client?.stop();
    signal.removeEventListener("abort", stop);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // Some WebSocket implementations report a failed connect as error with CLOSED state.
        socket?.readyState === 3 ? Promise.resolve() : drained,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new LinkError("drain_unconfirmed")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      observers.clear();
    }
  };
  try {
    const transport = await new Promise<BinaryTransport>((resolve, reject) => {
      const abort = () => {
        reject(failed("relay"));
        stop();
      };
      signal.addEventListener("abort", abort, { once: true });
      const ticket = options.ticket;
      client = connectRelay({
        WebSocket: Socket,
        // Desktop: leave room for its one-second retry within the ten-second recovery budget.
        // Runner: a slow or lossy uplink can need 6–16 s for TCP+TLS (Windows field report
        // 2026-11-11); five seconds then failed every attempt, so the runner waits longer.
        connectTimeoutMs: options.role === "runner" ? 20_000 : 5000,
        // Pairing and reconnect use the same dial budget on the runner. The peer wait begins
        // after upgrade and cannot shorten DNS, proxy CONNECT, TLS or the upgrade itself.
        connectStepTimeoutMs:
          options.role === "desktop" && options.peerTimeoutMs
            ? { dns: 3000, tcp: 5000, tls: 16_000, ws_upgrade: 3000 }
            : undefined,
        url: () =>
          `${options.relay}/room/${ticket.roomId}?credential=${ticket.credential}&period=${ticket.period}&role=${options.role}&kind=runner&peer=${options.slot}`,
        signal,
        onConnect(wire, ended) {
          signal.removeEventListener("abort", abort);
          ended.addEventListener("abort", stop, { once: true });
          resolve(bufferRunnerTransport(wire));
        },
        onPresence(online) {
          const was = present;
          present = online;
          if (was && !online) failure = { stage: "session", reason: "peer_left" };
          for (const notify of observers) notify();
          if (was && !online) stop();
        },
        onClosed({ stage, reason, opened, status, closeCode, wasClean }) {
          failure = { stage: opened && present ? "session" : opened ? "room_wait" : stage, reason };
          diagnostics = {
            ...(status === undefined ? {} : { status }),
            ...(closeCode === undefined ? {} : { closeCode }),
            ...(wasClean === undefined ? {} : { wasClean }),
          };
        },
        onState(state) {
          // A runner room is one generation, including failures before WebSocket open.
          if (state === "offline") abort();
        },
      });
      if (signal.aborted) abort();
    });
    signal.addEventListener("abort", stop, { once: true });
    let peerTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.peerTimeoutMs)
      peerTimer = setTimeout(() => {
        failure = { stage: "room_wait", reason: "timeout" };
        stop();
      }, options.peerTimeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const notify = () => {
          if (!present && !signal.aborted) return;
          observers.delete(notify);
          if (signal.aborted) reject(failed("room_wait"));
          else resolve();
        };
        observers.add(notify);
        notify();
      });
    } finally {
      clearTimeout(peerTimer);
    }
    if (!socket) throw new LinkError("transport_closed");
    return {
      transport,
      signal,
      close,
      /** Fixed codes for why this room ended, once it has; undefined while it is open. */
      ended: () =>
        signal.aborted
          ? {
              ...(failure ?? { stage: "session" as const, reason: "closed" }),
              ...diagnostics,
            }
          : undefined,
    };
  } catch (error) {
    // A failed open has no room handle to hand to the caller. Keep its socket owner here, and do
    // not let a slow drain replace the connect error the caller needs for its retry decision.
    await drainRunnerConnection([close], options.signal, () => {}).catch(() => {});
    throw error;
  }
}
