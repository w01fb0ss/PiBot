import { z } from "zod";
import { DomainSchema } from "../permissions/settings.ts";

export const CONNECTOR_NETWORK_SITE_MAX_LENGTH = 260;

/** The configured origin of a remote MCP, without paths or credentials. */
export function connectorEndpointSite(url: URL): string {
  const host = url.hostname.replace(/\.$/u, "");
  return url.port && url.port !== "80" && url.port !== "443" ? `${host}:${url.port}` : host;
}

/** Bare host covers HTTP/HTTPS default ports only. Other ports are individually authorized. */
export const ConnectorNetworkSiteSchema = z
  .string()
  .trim()
  .max(CONNECTOR_NETWORK_SITE_MAX_LENGTH)
  .transform((value, ctx) => {
    try {
      const match = /^([^:/@?#%\s\\]+)(?::([0-9]{1,5}))?$/u.exec(value);
      if (!match?.[1]) throw new Error("invalid_site");
      const hostname = DomainSchema.parse(
        new URL(`http://${match[1]}`).hostname.replace(/\.$/u, ""),
      );
      const port = match[2] === undefined ? 443 : Number(match[2]);
      if (port < 1 || port > 65535) throw new Error("invalid_port");
      return port === 80 || port === 443 ? hostname : `${hostname}:${port}`;
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid website host" });
      return z.NEVER;
    }
  });
export const ConnectorAllowedSiteSchema = ConnectorNetworkSiteSchema.refine((site) => {
  const host = site.split(":")[0] ?? "";
  return (
    host.includes(".") &&
    !/^\d+\.\d+\.\d+\.\d+$/u.test(host) &&
    !/(?:^|\.)(?:localhost|local|lan|internal|home\.arpa|onion|invalid|test|example)$/u.test(host)
  );
}, "Only public website hostnames are allowed");
export const ConnectorNetworkRefusalSchema = z.enum([
  "private",
  "ip",
  "dns",
  "scheme",
  "denied",
  "unattended",
  "timeout",
  "limit",
  "rate_limit",
]);
export const ConnectorBlockedSiteSchema = z.strictObject({
  host: z
    .string()
    .max(CONNECTOR_NETWORK_SITE_MAX_LENGTH)
    .regex(/^[a-z0-9.:[\]-]+$/u),
  reason: ConnectorNetworkRefusalSchema,
});
export type ConnectorBlockedSite = z.infer<typeof ConnectorBlockedSiteSchema>;
export interface ConnectorNetworkApproval {
  available(): boolean;
  request(input: {
    host: string;
    signal: AbortSignal;
    text: Record<"zh" | "en", { title: string; lead: string }>;
    save(): void;
  }): Promise<"allowed" | "denied" | "unattended" | "timeout">;
}
