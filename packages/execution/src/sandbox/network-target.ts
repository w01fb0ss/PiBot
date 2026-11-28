import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// This module is loaded by sandbox-host under Node's strip-only mode, not the brain's loader.
function resolved(host: string, signal: AbortSignal) {
  return new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    void lookup(host, { all: true, verbatim: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** URL parsing canonicalizes inet_aton shorthand and mapped IPv6 before the address check. */
export function targetUrl(value: string, connect = false) {
  const url = new URL(connect ? `http://${value}` : value);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.hash ||
    (connect && (url.pathname !== "/" || url.search || !/:(\d+)$/.test(value)))
  )
    throw new Error("invalid_target");
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host || /[\s%]/u.test(host)) throw new Error("invalid_target");
  const port = connect ? Number(/:(\d+)$/.exec(value)?.[1]) : Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_target");
  return { url, host, port };
}

export function privateAddress(address: string) {
  const list = new BlockList();
  for (const [host, bits] of [
    ["0.0.0.0", 8],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    // Carrier-grade NAT, including Tailscale peers: the user's own devices, like a LAN.
    ["100.64.0.0", 10],
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    list.addSubnet(host, bits);
  for (const [host, bits] of [
    ["::", 96],
    ["fe80::", 10],
    ["fc00::", 7],
    ["ff00::", 8],
    ["64:ff9b::", 96],
    ["2002::", 16],
  ] as const)
    list.addSubnet(host, bits, "ipv6");
  if (!isIP(address)) return true;
  return list.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** Matches SRT's exact / wildcard / optional-port entries, not arbitrary suffix lookalikes. */
export function listedTarget(host: string, port: number, entries: readonly string[]) {
  return entries.some((entry) => {
    const authority = entry.startsWith("*.") ? entry.slice(2) : entry;
    try {
      const url = new URL(`http://${authority}`);
      const name = url.hostname
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
        .replace(/\.$/, "");
      const suffix = /:(\d+)$/.exec(authority)?.[1];
      if (suffix && Number(suffix) !== port) return false;
      return entry.startsWith("*.") ? !isIP(host) && host.endsWith(`.${name}`) : host === name;
    } catch {
      return false;
    }
  });
}

export function targetAllowed(host: string, port: number, allowed: readonly string[]) {
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local");
  return listedTarget(host, port, allowed) || !(local || (isIP(host) && privateAddress(host)));
}

export async function checkedTarget(
  host: string,
  port: number,
  allowed: readonly string[],
  upstream: boolean,
  signal: AbortSignal,
  isPrivate = privateAddress,
) {
  const explicit = listedTarget(host, port, allowed);
  if (!targetAllowed(host, port, allowed)) throw new Error("private_address");
  if (isIP(host)) return host;
  try {
    const addresses = await resolved(host, signal);
    if (!addresses.length || (!explicit && addresses.some(({ address }) => isPrivate(address))))
      throw new Error("private_address");
    return addresses[0]?.address as string;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message === "private_address") throw error;
    // A user-selected proxy may resolve names our local resolver cannot (split DNS / fake IP).
    if (upstream) return host;
    throw new Error("dns_unavailable");
  }
}
