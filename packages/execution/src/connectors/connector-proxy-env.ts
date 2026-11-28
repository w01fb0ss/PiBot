import { ExecError } from "../core/types.ts";

const PROXY_NAME = /^(?:https?_proxy|all_proxy)$/i;
const NO_PROXY = /^no_proxy$/i;

export function connectorNoProxy(original: Readonly<NodeJS.ProcessEnv>) {
  const value =
    original.no_proxy ??
    original.NO_PROXY ??
    Object.entries(original).find(([name]) => NO_PROXY.test(name))?.[1];
  return value && value.length <= 4096 && /^[a-z0-9\s,.*:[\]_%/-]+$/i.test(value)
    ? value
    : undefined;
}

/** Read only trusted host proxy settings; credentials are handled by the launch bridge. */
export function connectorProxyUrls(original: Readonly<NodeJS.ProcessEnv>) {
  const urls = new Map<string, URL>();
  for (const [name, value] of Object.entries(original)) {
    if (!PROXY_NAME.test(name) || !value || value.length > 2048 || /[\s\0]/.test(value)) continue;
    const key = name.toUpperCase();
    if (urls.has(key) && name !== name.toLowerCase()) continue;
    try {
      const url = new URL(value);
      if (
        !/^(?:https?|socks[45]?h?):$/.test(url.protocol) ||
        !url.hostname ||
        url.search ||
        url.hash ||
        (url.pathname && url.pathname !== "/")
      )
        continue;
      urls.set(key, url);
    } catch {
      // Malformed host proxy settings cannot be safely forwarded.
    }
  }
  return urls;
}

export function withoutConnectorProxyEnvironment(original: Readonly<NodeJS.ProcessEnv>) {
  return Object.fromEntries(
    Object.entries(original).filter(([name]) => !PROXY_NAME.test(name) && !NO_PROXY.test(name)),
  );
}

export function assertConnectorProxyBridge(proxy: URL) {
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:")
    throw new ExecError("invalid_input", "proxy_unavailable");
}
