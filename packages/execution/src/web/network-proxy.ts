import { createRequire } from "node:module";
import { isIP } from "node:net";

// Validated and injected by brain; exec never discovers a proxy from the host.
export interface NetworkProxy {
  url: string;
}
export class ProxyUnavailableError extends Error {
  readonly code = "proxy_unavailable";
  constructor() {
    super("proxy_unavailable");
  }
}
export class ProxyCredentialsError extends Error {
  readonly code = "proxy_credentials_unavailable";
  constructor() {
    super("proxy_credentials_unavailable");
  }
}
export class ProxyAuthenticationError extends Error {
  readonly code = "proxy_auth_failed";
  constructor() {
    super("proxy_auth_failed");
  }
}
export function isProxyAuthenticationFailure(error: unknown): boolean {
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
    const value = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (
      value.code === "proxy_auth_failed" ||
      (value.code === "UND_ERR_ABORTED" &&
        typeof value.message === "string" &&
        /Proxy response \(407\)/.test(value.message))
    )
      return true;
    current = value.cause;
  }
  return false;
}
export function isProxyFailure(error: unknown): boolean {
  return (
    error instanceof ProxyCredentialsError ||
    isProxyAuthenticationFailure(error) ||
    isProxyUnavailable(error)
  );
}
export function isProxyUnavailable(error: unknown): boolean {
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
    if (current instanceof ProxyUnavailableError) return true;
    const value = current as { code?: unknown; cause?: unknown };
    if (["proxy_unavailable", "UND_ERR_PRX_TLS", "UND_ERR_PRX_CONN"].includes(String(value.code)))
      return true;
    current = value.cause;
  }
  return false;
}
export function proxyAgent(
  proxy: NetworkProxy,
  timeouts?: { headersTimeout?: number; bodyTimeout?: number },
) {
  // Network implementation is unused during brain registration and first-screen reads.
  const { buildConnector, Client, ProxyAgent } = createRequire(import.meta.url)(
    "undici",
  ) as typeof import("undici");
  const url = new URL(proxy.url);
  const token =
    url.username || url.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`
      : undefined;
  url.username = "";
  url.password = "";
  // Track failures on the proxy socket, not destination TLS or HTTP errors.
  // Fail proxy socket establishment before the web/search outer deadline can misclassify it.
  const connector = buildConnector({ timeout: 5000 });
  return new ProxyAgent({
    ...timeouts,
    uri: url.href,
    token,
    proxyTunnel: true,
    connectTimeout: 5000,
    clientFactory(origin, options) {
      return new Client(origin, {
        ...options,
        connect(input, callback) {
          // Node 26 rejects IP SNI; TLS still validates the certificate against the proxy host.
          const servername = isIP(input.hostname.replace(/^\[|\]$/g, ""))
            ? undefined
            : input.servername;
          try {
            connector({ ...input, servername }, (error, socket) => {
              if (error) callback(new ProxyUnavailableError(), null);
              else callback(null, socket);
            });
          } catch {
            callback(new ProxyUnavailableError(), null);
          }
        },
      });
    },
  });
}
