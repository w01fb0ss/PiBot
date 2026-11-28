// Turns the sandbox's own denial reports (macOS Seatbelt via violation-monitor.ts, SRT
// proxy refusals from the sandbox host) into block items. Unlike output hints these are proof the
// sandbox refused something, so they also count when the command exited 0: `aws … | head` and
// `cmd 2>/dev/null || fallback` hide the failure the refusal caused.
import { isIP } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import { within } from "../core/paths.ts";
import type { SandboxBlockItem } from "../core/types.ts";
import { CREDENTIAL_STORES } from "./sensitive-paths.ts";

/** Seatbelt detail: `ls(88342) deny(1) file-read-metadata /Users/x/.aws`. */
const SEATBELT = /^(.{1,80}?)\(\d+\) deny\(\d+\) ([a-z0-9*-]{1,64})(?: (.{1,4096}))?$/;
/** SRT proxy lines: `deny network-outbound h:p (r)`, `deny http-request M url (r)`, socks. */
const PROXY = /^deny (network-outbound|http-request|socks-tunnel) (?:[A-Z]{1,16} )?(\S{1,2048})/;
const HOST_PORT = /^\[?[A-Za-z0-9.:-]{1,253}\]?(?::\d{1,5})?$/;
const SERVICE = /^[A-Za-z0-9._-]{1,128}$/;
// SRT's own monitor drops these as noise every program makes (name resolution, diagnostics).
// `kern.iossupportversion` is read by every process at start (measured: bash, adb, nc).
const NOISE =
  /mDNSResponder|com\.apple\.(?:diagnosticd|analyticsd)|sysctl-read kern\.iossupportversion/;
// Security.framework talks to these for the login keychain (gh, git-credential-osxkeychain, aws
// SSO caches); a refusal there reads to the tool like "no saved login".
const KEYCHAIN = /^com\.apple\.(?:SecurityServer|securityd(?:\..+)?|security\..+|secd)$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
function isLocalService(target: string) {
  const value = target.replace(/^\[/, "").replace(/\]$/, "");
  const separator = value.lastIndexOf(":");
  return (
    separator > 0 &&
    LOOPBACK.has(value.slice(0, separator).toLowerCase()) &&
    /^\d{1,5}$/.test(value.slice(separator + 1))
  );
}

export interface ViolationContext {
  /** Canonical homes whose credential stores are named `~/…` (the user's and the Bot's). */
  homes: readonly string[];
  /** Literal read denies of this call (canonical). */
  denyRead: readonly string[];
  platform: NodeJS.Platform;
  quietLoginKeychainMetadata?: boolean;
  /** Write classification shared with the output-candidate path. */
  classifyWrite(path: string): SandboxBlockItem | undefined;
  /** Loopback ports a local service answers on (loopback-probe.ts); absent = none known. */
  listening?: ReadonlySet<number>;
}

export interface ViolationItem {
  item: SandboxBlockItem;
  /** Evidence strong enough to report although the command exited 0. */
  strong: boolean;
}

/** `~/rel` for a path inside one of the homes; otherwise the path itself. */
function display(path: string, homes: readonly string[]) {
  for (const home of homes)
    if (within(home, path)) {
      const rel = relative(home, path).split(sep).join("/");
      return rel ? `~/${rel}` : "~";
    }
  return path;
}

function safeRule(value: string) {
  return value.replace(/[^A-Za-z0-9_.:/-]/g, "_").slice(0, 80) || "unknown";
}

function other(rule: string, target = "sandbox rule") {
  return { item: { kind: "other" as const, rule: safeRule(rule), target }, strong: false };
}

function readItem(path: string, context: ViolationContext): SandboxBlockItem {
  const stores = CREDENTIAL_STORES[context.platform] ?? [];
  for (const home of context.homes)
    for (const store of stores)
      if (within(join(home, ...store.split("/")), path))
        // Only the store's name: which file inside it was wanted says nothing more useful.
        return { kind: "credential_read", rule: "credential_store", target: `~/${store}` };
  // The deny root, not the file below it: a browser profile's file names are nobody's business.
  const root = context.denyRead
    .filter((deny) => within(deny, path))
    .sort((a, b) => a.length - b.length)[0];
  return {
    kind: "protected_read",
    rule: "deny_read",
    target: display(root ?? path, context.homes).slice(0, 256),
  };
}

function seatbelt(detail: string, context: ViolationContext): ViolationItem | undefined {
  const match = SEATBELT.exec(detail);
  if (!match || NOISE.test(detail)) return undefined;
  const operation = match[2] as string;
  const target = (match[3] ?? "").trim();
  if (operation.startsWith("file-read")) {
    if (!isAbsolute(target)) return undefined;
    // Security.framework probes this file's metadata on completed agy/Codex turns. Keep
    // data denials, other Keychain paths, and startup/failure diagnostics visible.
    if (
      context.platform === "darwin" &&
      context.quietLoginKeychainMetadata &&
      operation === "file-read-metadata" &&
      context.homes.some(
        (home) => target === join(home, "Library", "Keychains", "login.keychain-db"),
      )
    )
      return undefined;
    return { item: readItem(target, context), strong: true };
  }
  if (operation.startsWith("file-write")) {
    if (!isAbsolute(target)) return undefined;
    if (target === "/dev" || target.startsWith(`/dev${sep}`))
      return {
        item: { kind: "system_service", rule: "dev_write", target: "/dev" },
        strong: true,
      };
    const item = context.classifyWrite(target) ?? {
      kind: target.split(sep).includes(".git") ? "git_resource" : "other",
      rule: target.split(sep).includes(".git") ? "git_metadata" : "file_write",
      target,
    };
    return { item, strong: false };
  }
  if (operation === "mach-lookup") {
    if (!SERVICE.test(target)) return undefined;
    if (KEYCHAIN.test(target))
      return { item: { kind: "system_service", rule: "keychain", target }, strong: true };
    if (target.startsWith("com.apple.pasteboard"))
      return { item: { kind: "system_service", rule: "pasteboard", target }, strong: false };
    return { item: { kind: "system_service", rule: "mach_lookup", target }, strong: false };
  }
  // Seatbelt names a refused socket `remote:<host>:<port>` / `local:<host>:<port>`, the host
  // usually `*`. A port a local service answers on is that service (adb tried 127.0.0.1:5037, could
  // not, and tried to start its own server on 5037); approving it opens only that loopback port.
  const socket = /^(?:remote|local):([^\s]*):(\d{1,5})$/.exec(target);
  if (socket && operation.startsWith("network-")) {
    const port = Number(socket[2]);
    // An ephemeral bind (`local:*:0`) is how a client opens its socket; alone it names nothing a
    // person could allow, and beside the real refusal it would read as "internet blocked".
    if (port === 0) return undefined;
    const host = (socket[1] ?? "").replace(/^\[|\]$/g, "").toLowerCase();
    if (port > 0 && (LOOPBACK.has(host) || context.listening?.has(port)))
      return {
        item: { kind: "local_service", rule: "loopback_socket", target: `127.0.0.1:${port}` },
        strong: operation === "network-outbound",
      };
    if (operation === "network-outbound")
      return {
        item: { kind: "network", rule: "socket", target: `${host || "*"}:${port}` },
        strong: true,
      };
  }
  if (operation === "network-outbound") {
    // A path is a local socket (Docker, an SSH agent): a service, not an internet host.
    if (isAbsolute(target))
      return {
        item: {
          kind: "local_service",
          rule: "unix_socket",
          target: display(target, context.homes).slice(0, 256),
        },
        strong: false,
      };
    return HOST_PORT.test(target)
      ? {
          item: {
            kind: isLocalService(target) ? "local_service" : "network",
            rule: isLocalService(target) ? "loopback_socket" : "socket",
            target,
          },
          strong: true,
        }
      : undefined;
  }
  if (operation === "network-bind" || operation === "network-inbound")
    return {
      item: {
        kind: target && isLocalService(target) ? "local_service" : "network",
        rule: target && isLocalService(target) ? "loopback_bind" : "local_bind",
        target: target || "socket",
      },
      strong: false,
    };
  // An operation this table does not know: name the rule, never the raw target (it may be a path
  // or other text from the command), and keep it weak so a command that succeeded stays a success.
  return other(operation);
}

function proxy(line: string): ViolationItem | undefined {
  const match = PROXY.exec(line);
  if (!match) return undefined;
  let target = match[2] as string;
  if (match[1] === "http-request") {
    try {
      // CONNECT carries `host:port`; plain requests a URL whose path is nobody's business.
      target = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? new URL(target).host : target;
    } catch {
      return undefined;
    }
  }
  let networkDomain: string | undefined;
  if (
    HOST_PORT.test(target) &&
    match[1] === "network-outbound" &&
    line.endsWith(" (pibot_website_not_allowed)")
  ) {
    try {
      const host = new URL(`http://${target}`).hostname.toLowerCase().replace(/\.$/, "");
      // Private destinations still require their existing per-run approval. A DNS name is only
      // a candidate here: the proxy also checks its resolved address when the command retries.
      if (
        !isIP(host) &&
        host.length <= 253 &&
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          host,
        ) &&
        !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host)
      )
        networkDomain = host;
    } catch {
      // Malformed proxy authorities remain diagnostics with no permission action.
    }
  }
  return HOST_PORT.test(target)
    ? {
        item: {
          kind: isLocalService(target) ? "local_service" : "network",
          rule: isLocalService(target) ? "loopback_proxy" : "proxy_denied",
          target,
          ...(networkDomain ? { networkDomain } : {}),
        },
        strong: true,
      }
    : other(match[1] ?? "proxy", target);
}

export function violationItems(
  violations: readonly string[],
  context: ViolationContext,
): ViolationItem[] {
  return violations.flatMap((line) => {
    // seatbelt() returns nothing on purpose for noise and for reports that name no target; only a
    // line it cannot read at all is reported as an unknown sandbox rule.
    const item = line.startsWith("deny ")
      ? proxy(line)
      : SEATBELT.test(line)
        ? seatbelt(line, context)
        : other("unrecognized");
    return item ? [item] : [];
  });
}
