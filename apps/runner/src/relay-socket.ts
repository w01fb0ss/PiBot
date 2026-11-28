import { isIP, type NetConnectOpts, connect as netConnect, type Socket } from "node:net";
import { type ConnectionOptions, connect as tlsConnect } from "node:tls";
import { type ConnectProgress, observeConnectSocket, type SocketConstructor } from "@pibot/link";
import { WebSocket } from "ws";
import { directProxy, type RunnerProxy } from "./proxy/route.ts";
import { openTunnel, ProxyTunnelError } from "./proxy/tunnel.ts";

/** A retired socket that never sends its close receipt still has to release the runner's drain. */
const CLOSE_GRACE_MS = 2000;

/**
 * Relay sockets use ws (HTTP/1.1 upgrade, explicit handshake timeout) instead of Node's global
 * WebSocket: that one negotiates HTTP/2 first and gives up at undici's 10 s connect timeout,
 * which a slow or lossy uplink needing 6–16 s for TCP+TLS never meets (Windows field report
 * 2026-11-11: every relay attempt failed after pairing).
 */
export class RelaySocket extends WebSocket {
  readonly connectProgress: ConnectProgress;
  constructor(url: string, proxy: RunnerProxy = directProxy) {
    const progress: ConnectProgress = { step: "dns" };
    super(url, {
      handshakeTimeout: 20_000,
      // Same as ws's own connectors, plus the steps a failed open stopped at. `ws:` is only
      // accepted for a loopback relay (validateRunnerRelay), as in development. The route is
      // asked per connection: a PAC script is fetched and evaluated then, inside the handshake
      // timeout.
      createConnection: (
        options: ConnectionOptions,
        done: (error: Error | null, socket?: Socket) => void,
      ) => {
        const secure = url.startsWith("wss:");
        const host = options.host ?? "";
        const servername = options.servername ?? (isIP(host) ? "" : host);
        const direct = () => {
          const socket = secure
            ? tlsConnect({ ...options, path: undefined, servername } as ConnectionOptions)
            : netConnect({ ...options, path: undefined } as NetConnectOpts);
          observeConnectSocket(socket, secure, progress);
          return socket;
        };
        const tunnelled = (via: URL) => {
          // Through the proxy: the proxy resolves the relay's name, so the steps start at TCP.
          progress.step = "tcp";
          openTunnel(via, host, Number(options.port) || (secure ? 443 : 80)).then(
            (tunnel) => {
              progress.step = secure ? "tls" : "ws_upgrade";
              if (!secure) return done(null, tunnel);
              const socket = tlsConnect({
                ...options,
                host: undefined,
                port: undefined,
                path: undefined,
                socket: tunnel,
                servername,
              } as ConnectionOptions);
              observeConnectSocket(socket, true, progress);
              progress.step = "tls";
              done(null, socket);
            },
            (error: Error) => {
              progress.error ??=
                error instanceof ProxyTunnelError ? error.code : "proxy_unavailable";
              done(error);
            },
          );
        };
        proxy.route(url).then(
          (via) => {
            if (via) tunnelled(via);
            else done(null, direct());
          },
          // Route failures are already logged and mean direct; this only guards a programming error.
          () => done(null, direct()),
        );
        return undefined;
      },
    } as unknown as WebSocket.ClientOptions);
    this.connectProgress = progress;
    // ws emits `error` once more when a socket still connecting is closed; connectRelay observes
    // errors through addEventListener, and an unobserved one would end the process.
    this.on("error", () => {});
  }
  override close(code?: number, reason?: string) {
    if (this.readyState === WebSocket.CONNECTING) {
      this.terminate();
      return;
    }
    super.close(code, reason);
    // ws waits up to 30 s for the relay's close frame; on a lossy uplink that held every
    // reconnect behind an unconfirmed drain. The generation is already retired, so cut it.
    const timer = setTimeout(() => {
      if (this.readyState !== WebSocket.CLOSED) this.terminate();
    }, CLOSE_GRACE_MS);
    timer.unref?.();
  }
}

/** The relay socket class the link layer constructs, bound to this runner's proxy choice. */
export function relaySocket(proxy: RunnerProxy): SocketConstructor {
  return class extends RelaySocket {
    constructor(url: string) {
      super(url, proxy);
    }
  } as unknown as SocketConstructor;
}
