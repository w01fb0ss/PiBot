import { ConnectorAllowedSiteSchema } from "@pibot/protocol-base";
import type { PolicyResult } from "./types.ts";

export const CONNECTOR_NETWORK_CONFIRMATION = "connector_network_confirmation";

/**
 * This is a destination expansion, like the command sandbox's unlisted-domain boundary.
 * YOLO can release command execution confirmation but cannot add a website to an allowlist.
 */
export function connectorNetworkPolicy(input: {
  host: string;
  refusal?: "private" | "ip" | "dns" | "scheme";
  allowed: boolean;
  denied: boolean;
  attended: boolean;
  full: boolean;
  rateLimited?: boolean;
  valid: boolean;
}): PolicyResult {
  const reason =
    input.refusal ??
    (!input.valid || !ConnectorAllowedSiteSchema.safeParse(input.host).success
      ? "changed"
      : input.allowed
        ? "connector_network_listed"
        : input.denied
          ? "denied"
          : input.full
            ? "limit"
            : input.attended
              ? input.rateLimited
                ? "rate_limit"
                : CONNECTOR_NETWORK_CONFIRMATION
              : "unattended");
  const decision =
    reason === "connector_network_listed"
      ? "allow"
      : reason === CONNECTOR_NETWORK_CONFIRMATION
        ? "ask"
        : "deny";
  return {
    category: "connector",
    decision,
    reason,
    risk: "normal",
    canRemember: false,
    facts: [{ kind: "network", value: input.host }],
    explanation: [{ axis: "boundary", code: reason, effect: decision }],
  };
}
