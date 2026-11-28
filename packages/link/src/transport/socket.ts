import { LinkError, MAX_FRAME } from "../core/bytes.ts";
import {
  type ConnectProgress,
  networkErrorClass,
  type RunnerLinkStage,
} from "./connect-progress.ts";
import type { BinaryTransport } from "./port.ts";
export interface SocketLike {
  readyState: number;
  /** Optional: how far the socket got (DNS → TCP → TLS → upgrade) before it failed. */
  readonly connectProgress?: ConnectProgress;
  binaryType: string;
  bufferedAmount: number;
  send(data: ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
}
export interface SocketEvent {
  readonly type: string;
  data?: unknown;
  /** Close events only: the WebSocket close code (diagnostics). */
  readonly code?: unknown;
  /** Close events only: whether the peer completed the WebSocket close handshake. */
  readonly wasClean?: unknown;
}
export type SocketConstructor = new (url: string) => SocketLike;
export interface SocketOptions {
  WebSocket: SocketConstructor;
  url: () => string;
  signal: AbortSignal;
  onConnect: (transport: BinaryTransport, signal: AbortSignal) => void;
  onState?: (state: "connecting" | "online" | "offline" | "stopped") => void;
  onPresence?: (online: boolean) => void;
  onError?: (code: string) => void;
  /**
   * Diagnostics only, called before `offline`: which step a generation ended at and why, as
   * fixed codes. `opened` tells a failed open from a dropped connection.
   */
  onClosed?: (failure: {
    stage: RunnerLinkStage;
    reason: string;
    opened: boolean;
    status?: number;
    closeCode?: number;
    wasClean?: boolean;
  }) => void;
  connectTimeoutMs?: number;
  connectStepTimeoutMs?: Partial<Record<import("./connect-progress.ts").RelayConnectStep, number>>;
  /**
   * Relay ping interval. Mobile carrier NATs drop idle TCP mappings in about 30 s, so a phone
   * room pings more often than the 25 s default; a socket silent for two intervals and 10 s is dead.
   */
  heartbeatMs?: number;
}
/** Fixed diagnostic code for a WebSocket close event: `close_<code>` for a valid close code. */
export function socketCloseReason(event: SocketEvent) {
  const code = event.code;
  return typeof code === "number" && Number.isInteger(code) && code >= 1000 && code <= 4999
    ? `close_${code}`
    : "closed";
}
function socketCloseCode(event: SocketEvent) {
  return typeof event.code === "number" &&
    Number.isInteger(event.code) &&
    event.code >= 1000 &&
    event.code <= 4999
    ? event.code
    : undefined;
}
function socketUpgradeStatus(event: SocketEvent) {
  const message =
    event && typeof event === "object" && "message" in event && typeof event.message === "string"
      ? event.message
      : "";
  const status = /Unexpected server response: (\d{3})/.exec(message)?.[1];
  return status ? Number(status) : undefined;
}
/**
 * Some socket implementations (ws) emit `error` after close() on a socket still connecting.
 * With no listener left, Node turns that into an uncaught exception and the process dies: the
 * Windows runner exited without a `runner.stopped` line this way (2026-11-11). A retired socket
 * keeps this listener; its generation already reported the failure.
 */
const ignoreRetiredError = () => {};
const HEARTBEAT_MS = 25_000;
// A reconnect hands out a fresh transport: its owner must build a fresh Noise handshake/Peer.
export function connectRelay(options: SocketOptions) {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const silentMs = 2 * heartbeatMs + 10_000;
  let socket: SocketLike | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined,
    heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry = 0,
    stopped = false,
    generation = 0;
  let retire = () => {};
  const state = (value: Parameters<NonNullable<SocketOptions["onState"]>>[0]) => {
    try {
      options.onState?.(value);
    } catch {
      /* State observers cannot retain a retired connection. */
    }
  };
  const report = (code: string) => {
    try {
      options.onError?.(code);
    } catch {
      /* Diagnostics never interrupt cleanup. */
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    clearTimeout(timer);
    retire();
    options.signal.removeEventListener("abort", stop);
    state("stopped");
  };
  const start = () => {
    if (stopped) return;
    const id = ++generation;
    const connection = new AbortController();
    let closed = false;
    let opened = false;
    let stepTimer: ReturnType<typeof setInterval> | undefined;
    const listeners = new Set<(frame: Uint8Array) => void>();
    const close = (reason = "closed") => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      clearInterval(stepTimer);
      clearInterval(heartbeat);
      for (const [type, handler] of handlers) current?.removeEventListener(type, handler);
      current?.addEventListener("error", ignoreRetiredError);
      const progress = current?.connectProgress;
      try {
        current?.close(1000, "closed");
      } catch {
        /* Closing a failed connection is best effort; its generation is retired. */
      }
      listeners.clear();
      if (socket === current) socket = undefined;
      if (!stopped && id === generation) {
        try {
          const closeEvent = lastClose;
          options.onClosed?.(
            opened
              ? {
                  stage: "relay",
                  reason,
                  opened,
                  ...(closeEvent?.code === undefined ? {} : { closeCode: closeEvent.code }),
                  ...(typeof closeEvent?.wasClean === "boolean"
                    ? { wasClean: closeEvent.wasClean }
                    : {}),
                }
              : {
                  stage: progress?.step ?? "relay",
                  reason:
                    reason === "closed" || reason === "failed" || reason.startsWith("close_")
                      ? (progress?.error ?? reason)
                      : reason,
                  opened,
                  ...(progress?.status === undefined ? {} : { status: progress.status }),
                  ...(closeEvent?.code === undefined ? {} : { closeCode: closeEvent.code }),
                  ...(typeof closeEvent?.wasClean === "boolean"
                    ? { wasClean: closeEvent.wasClean }
                    : {}),
                },
          );
        } catch {
          /* Diagnostics never interrupt cleanup. */
        }
      }
      // A room waiter can reject synchronously on abort. Record the socket failure first.
      connection.abort();
      if (!stopped && id === generation) {
        state("offline");
        if (stopped) return;
        timer = setTimeout(start, Math.min(60_000, 1000 * 2 ** Math.min(retry++, 6)));
      }
    };
    let current: SocketLike | undefined;
    let lastClose: { code?: number; wasClean?: boolean } | undefined;
    // Anything from the relay (a pong included) proves the socket is alive; see the heartbeat.
    let heard = Date.now();
    const receive = (event: SocketEvent) => {
      if (closed || id !== generation) return;
      heard = Date.now();
      try {
        if (typeof event.data === "string") {
          if (event.data === "pibot:pong") return;
          if (event.data !== "pibot:online" && event.data !== "pibot:offline")
            throw new LinkError("invalid_control_frame");
          options.onPresence?.(event.data === "pibot:online");
          return;
        }
        const frame =
          event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : event.data instanceof Uint8Array
              ? event.data
              : undefined;
        if (!frame || frame.length > MAX_FRAME) throw new LinkError("invalid_frame");
        for (const listener of listeners) listener(frame);
      } catch {
        report("relay_frame_failed");
        close("invalid_frame");
      }
    };
    const open = () => {
      if (closed || id !== generation) return;
      opened = true;
      clearTimeout(deadline);
      clearInterval(stepTimer);
      state("online");
      if (closed || stopped) return;
      heard = Date.now();
      heartbeat = setInterval(() => {
        // A socket the network or a proxy dropped silently still reads as open, and a side that
        // waits in its room for the other would wait forever. Two missed pongs retire it.
        if (Date.now() - heard > silentMs) {
          report("relay_silent");
          close("silent");
          return;
        }
        if (current?.readyState === 1) {
          try {
            current.send("pibot:ping");
          } catch {
            close("send_failed");
          }
        }
      }, heartbeatMs);
      try {
        options.onConnect(
          {
            kind: "relay",
            closed: connection.signal,
            send(frame) {
              if (closed || current?.readyState !== 1) throw new LinkError("connection_closed");
              if (frame.length > MAX_FRAME || current.bufferedAmount > 2 * MAX_FRAME)
                throw new LinkError("transport_capacity");
              current.send(frame.slice().buffer);
            },
            subscribe(listener) {
              if (closed) throw new LinkError("connection_closed");
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            bufferedAmount() {
              return current?.bufferedAmount ?? 0;
            },
            close: () => close("local_close"),
            confirm() {
              retry = 0;
            },
          },
          connection.signal,
        );
      } catch {
        report("connection_setup_failed");
        close("setup_failed");
      }
    };
    const handlers: [string, (event: SocketEvent) => void][] = [
      ["open", open],
      ["message", receive],
      [
        "close",
        (event) => {
          lastClose = {
            code: socketCloseCode(event),
            wasClean: event.wasClean as boolean | undefined,
          };
          close(socketCloseReason(event));
        },
      ],
      [
        "error",
        (event) => {
          if (!opened && current?.connectProgress && current.connectProgress.status === undefined) {
            const status = socketUpgradeStatus(event);
            if (status !== undefined) current.connectProgress.status = status;
          }
          close(opened ? "error" : networkErrorClass(event));
        },
      ],
    ];
    retire = () => close("stopped");
    state("connecting");
    if (stopped) return;
    try {
      current = new options.WebSocket(options.url());
      socket = current;
      current.binaryType = "arraybuffer";
      for (const [type, handler] of handlers) current.addEventListener(type, handler);
      deadline = setTimeout(() => close("timeout"), options.connectTimeoutMs ?? 10_000);
      if (options.connectStepTimeoutMs) {
        let step = current.connectProgress?.step;
        let since = Date.now();
        stepTimer = setInterval(() => {
          const next = current?.connectProgress?.step;
          if (next !== step) {
            step = next;
            since = Date.now();
          }
          const budget = step && options.connectStepTimeoutMs?.[step];
          if (budget && Date.now() - since >= budget) close("timeout");
        }, 250);
      }
    } catch {
      report("connection_failed");
      close("construct_failed");
    }
  };
  if (options.signal.aborted) {
    stopped = true;
    state("stopped");
  } else {
    options.signal.addEventListener("abort", stop, { once: true });
    start();
  }
  return { stop };
}
