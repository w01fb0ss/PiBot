// Chooses the proxy for each outbound runner connection (owner decision 2026-11-25: pairing
// failed on hosts that only reach the internet through a proxy, e.g. the Windows test host).
import { isIP } from "node:net";

export type RunnerProxySource = "flag" | "env" | "system" | "none";

/** One proxy setting as read from a source; schemes the runner cannot tunnel are dropped early. */
export interface ProxySettings {
  /** For https:// and wss:// targets. */
  secure?: URL;
  /** For http:// and ws:// targets. */
  plain?: URL;
  /** NO_PROXY-style patterns: host, .suffix, *.suffix, IP, optional :port, or "*". */
  bypass: string[];
  /** Windows `<local>`, macOS ExcludeSimpleHostnames: host names without a dot go direct. */
  bypassSimple?: boolean;
  /** A proxy auto-config script's location; it decides for every target the bypass list lets through. */
  pac?: string;
}

export interface RunnerProxy {
  readonly source: RunnerProxySource;
  /** The proxy to reach `target` through, or undefined to connect directly. */
  route(target: string): Promise<URL | undefined>;
}

export const directProxy: RunnerProxy = { source: "none", route: async () => undefined };

/** Only HTTP CONNECT proxies (http:// or https:// to the proxy itself) can carry the relay. */
export function proxyUrl(value: string | undefined): URL | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  // Windows and many tools write a bare host:port; it means an HTTP proxy.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url;
}

/** A PAC script address the runner can fetch (http, https or file); anything else is ignored. */
export function pacLocation(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return ["http:", "https:", "file:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** `--proxy <url>`; "direct" turns every proxy source off. Throws on anything else unusable. */
export function flagProxy(value: string): ProxySettings | "direct" {
  if (value === "direct") return "direct";
  const url = proxyUrl(value);
  if (!url) throw new TypeError("invalid_proxy");
  return { secure: url, plain: url, bypass: [] };
}

const env = (values: Readonly<Record<string, string | undefined>>, name: string) =>
  values[name] ?? values[name.toLowerCase()];

/**
 * HTTPS_PROXY / HTTP_PROXY / ALL_PROXY and NO_PROXY, upper or lower case like curl. A SOCKS
 * ALL_PROXY cannot carry the relay and is ignored, reported by `ignored`.
 */
export function environmentProxy(values: Readonly<Record<string, string | undefined>>) {
  const all = env(values, "ALL_PROXY");
  const secureText = env(values, "HTTPS_PROXY") ?? all;
  const plainText = env(values, "HTTP_PROXY") ?? all;
  const secure = proxyUrl(secureText);
  const plain = proxyUrl(plainText);
  const ignored = (!!secureText?.trim() && !secure) || (!!plainText?.trim() && !plain);
  const settings: ProxySettings | undefined =
    secure || plain ? { secure, plain, bypass: noProxyList(env(values, "NO_PROXY")) } : undefined;
  return { settings, ignored };
}

export function noProxyList(value: string | undefined) {
  return (value ?? "")
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 200);
}

const unbracket = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();

function loopback(host: string) {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}

function ipv4(value: string) {
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0)
    ? parts.reduce((total, part) => total * 256 + part, 0)
    : undefined;
}

function bypassed(pattern: string, host: string, port: string) {
  if (pattern === "*") return true;
  let rule = pattern;
  // host:port (an IPv6 literal keeps its brackets or has more than one colon).
  const portMatch = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(rule);
  if (portMatch) {
    if (portMatch[2] !== port) return false;
    rule = portMatch[1] ?? rule;
  }
  rule = unbracket(rule);
  // macOS ExceptionsList CIDR form such as 169.254/16 or 10.0.0.0/8.
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(rule);
  if (cidr && isIP(host) === 4) {
    const octets = (cidr[1] ?? "").split(".");
    while (octets.length < 4) octets.push("0");
    const base = ipv4(octets.join("."));
    const address = ipv4(host);
    const bits = Number(cidr[2]);
    if (base === undefined || address === undefined || bits > 32) return false;
    const size = 2 ** (32 - bits);
    return Math.floor(address / size) === Math.floor(base / size);
  }
  // Windows ProxyOverride wildcards such as 10.* or *.corp.example.
  if (rule.includes("*")) {
    const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(host);
  }
  if (rule.startsWith(".")) return host.endsWith(rule) || host === rule.slice(1);
  return host === rule || host.endsWith(`.${rule}`);
}

/** Whether `target` skips every proxy (loopback, the bypass list), before static or PAC choice. */
export function bypassesProxy(settings: ProxySettings, target: string) {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return true;
  }
  const host = unbracket(url.hostname);
  if (!host || loopback(host)) return true;
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const port = url.port || (secure ? "443" : "80");
  if (settings.bypassSimple && !host.includes(".") && !isIP(host)) return true;
  return settings.bypass.some((pattern) => bypassed(pattern, host, port));
}

export function proxyFor(settings: ProxySettings, target: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  const host = unbracket(url.hostname);
  // Loopback never leaves this machine (a development relay); a proxy would resolve it to itself.
  if (!host || loopback(host)) return undefined;
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const port = url.port || (secure ? "443" : "80");
  if (settings.bypassSimple && !host.includes(".") && !isIP(host)) return undefined;
  if (settings.bypass.some((pattern) => bypassed(pattern, host, port))) return undefined;
  return secure ? settings.secure : settings.plain;
}

/** The first source that names a proxy wins: `--proxy`, then the environment, then the system. */
export function runnerProxy(
  sources: { flag?: ProxySettings | "direct"; env?: ProxySettings; system?: ProxySettings },
  envBypass: string[] = [],
  /** Builds the PAC lookup for a system PAC location (sandboxed engine, fetch, cache). */
  pac?: (location: string) => (target: string) => Promise<URL | undefined>,
): RunnerProxy {
  if (sources.flag === "direct") return directProxy;
  const pick: [RunnerProxySource, ProxySettings | undefined][] = [
    // An explicit proxy still honors NO_PROXY, like the same proxy given in HTTPS_PROXY would.
    ["flag", sources.flag && { ...sources.flag, bypass: envBypass }],
    ["env", sources.env],
    ["system", sources.system],
  ];
  for (const [source, settings] of pick) {
    if (!settings) continue;
    // A system PAC script wins over static entries, as in the system's own network stack.
    if (settings.pac && pac) {
      const lookup = pac(settings.pac);
      return {
        source,
        route: async (target) => (bypassesProxy(settings, target) ? undefined : lookup(target)),
      };
    }
    if (settings.secure || settings.plain)
      return { source, route: async (target) => proxyFor(settings, target) };
  }
  return directProxy;
}
