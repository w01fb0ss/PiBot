import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { privateAddress } from "./network-target.ts";

export const CONNECTOR_NETWORK_WAIT_MS = 25_000;
const port = z.number().int().min(1).max(65535);
export const ConnectorNetworkRequestSchema = z.strictObject({
  id: z.number().int().positive().safe(),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.:-]+$/),
  port,
  refusal: z.enum(["private", "ip", "dns", "scheme"]).optional(),
});
export const ConnectorNetworkAnswerSchema = z.strictObject({
  id: ConnectorNetworkRequestSchema.shape.id,
  allow: z.boolean(),
});
export type ConnectorNetworkAttempt = Omit<z.infer<typeof ConnectorNetworkRequestSchema>, "id">;
export type ConnectorNetworkFilter = (
  attempt: ConnectorNetworkAttempt,
  signal: AbortSignal,
) => Promise<boolean>;

const proxyFakeIp = new BlockList();
proxyFakeIp.addSubnet("198.18.0.0", 15);

export function connectorPrivateAddress(address: string) {
  // Azure's platform virtual IP is public-looking, and can also appear as an IPv4-mapped AAAA.
  const platform = new BlockList();
  platform.addAddress("168.63.129.16");
  platform.addSubnet("192.0.0.0", 24);
  platform.addSubnet("192.0.2.0", 24);
  platform.addSubnet("198.18.0.0", 15);
  platform.addSubnet("198.51.100.0", 24);
  platform.addSubnet("203.0.113.0", 24);
  platform.addSubnet("64:ff9b:1::", 48, "ipv6");
  platform.addSubnet("2001::", 32, "ipv6");
  platform.addSubnet("2001:db8::", 32, "ipv6");
  platform.addSubnet("fec0::", 10, "ipv6");
  return privateAddress(address) || platform.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** A proxy can return a fake IP for a DNS name. Literal targets still use the full block list. */
export function connectorPrivateDnsAnswer(address: string) {
  return (
    !proxyFakeIp.check(address, isIP(address) === 6 ? "ipv6" : "ipv4") &&
    connectorPrivateAddress(address)
  );
}

export function connectorNetworkRefusal(host: string) {
  if (isIP(host)) return connectorPrivateAddress(host) ? "private" : "ip";
  if (
    !host.includes(".") ||
    /(?:^|\.)(?:localhost|local|lan|internal|home\.arpa|onion|invalid|test|example)$/u.test(host)
  )
    return "private";
  return undefined;
}

export function connectorNetworkSite(host: string, port: number) {
  return port === 80 || port === 443 ? host : `${host}:${port}`;
}
