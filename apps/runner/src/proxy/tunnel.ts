// An HTTP CONNECT tunnel through the chosen proxy; the relay's TLS then runs inside it.
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

const TUNNEL_MS = 20_000;
const HEADER_LIMIT = 16 * 1024;

/** Fixed codes only: the proxy's reply and address never reach logs or errors. */
export class ProxyTunnelError extends Error {
  constructor(
    readonly code: "proxy_unavailable" | "proxy_auth_failed" | "proxy_refused" | "proxy_timeout",
  ) {
    super(code);
  }
}

export function openTunnel(proxy: URL, host: string, port: number): Promise<Socket> {
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  const credentials =
    proxy.username || proxy.password
      ? Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64")
      : undefined;
  return new Promise((resolve, reject) => {
    const socket: Socket =
      proxy.protocol === "https:"
        ? tlsConnect({
            host: proxyHost,
            port: proxyPort,
            ...(isIP(proxyHost) ? {} : { servername: proxyHost }),
          })
        : netConnect({ host: proxyHost, port: proxyPort });
    let received = Buffer.alloc(0);
    let settled = false;
    const fail = (code: ProxyTunnelError["code"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new ProxyTunnelError(code));
    };
    const timer = setTimeout(() => fail("proxy_timeout"), TUNNEL_MS);
    timer.unref?.();
    const onError = () => fail("proxy_unavailable");
    const onClose = () => fail("proxy_unavailable");
    socket.on("error", onError);
    socket.once("close", onClose);
    socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${
          credentials ? `Proxy-Authorization: Basic ${credentials}\r\n` : ""
        }\r\n`,
      );
    });
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end < 0) {
        if (received.length > HEADER_LIMIT) fail("proxy_refused");
        return;
      }
      socket.off("data", onData);
      const status = Number(
        /^HTTP\/1\.[01] (\d{3})/.exec(received.subarray(0, end).toString("latin1"))?.[1],
      );
      if (status === 407) return fail("proxy_auth_failed");
      if (status < 200 || status > 299 || !Number.isFinite(status)) return fail("proxy_refused");
      settled = true;
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("close", onClose);
      // The TLS layer (or ws) above reports failures; an error on the raw tunnel between this
      // hand-over and its listener must not end the runner as an unhandled event.
      socket.on("error", () => {});
      // The relay speaks only after our ClientHello / upgrade request, so nothing follows the
      // reply yet; any bytes that do already belong to the tunnelled connection.
      const rest = received.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on("data", onData);
  });
}
