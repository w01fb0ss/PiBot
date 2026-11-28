import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
// The SDK's own tables (pinned 0.0.81): naming them twice would let the two drift apart.
import {
  DANGEROUS_FILES,
  DEPENDENCY_DIRECTORIES,
  getDangerousDirectories,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { within } from "../core/paths.ts";
import type { SandboxBlock, SandboxBlockItem, SandboxBlockKind } from "../core/types.ts";
import { violationItems } from "./sandbox-violations.ts";

const MAX_ITEMS = 8;
const dangerousFiles = new Set<string>(DANGEROUS_FILES);
const dangerousDirectories = getDangerousDirectories();
const dependencyDirectories = new Set<string>(DEPENDENCY_DIRECTORIES);

/** Output may name a path that was never created; canonicalize its deepest existing ancestor. */
function canonical(path: string) {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...rest);
  } catch {
    return path;
  }
}

const GLOB = /[*?[\]{}]/;
/** Literal grant/deny roots only; glob entries are SRT-anchored rules handled by mandatoryRule. */
function literalPaths(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return GLOB.test(entry) ? [] : [entry];
    if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string")
      return [];
    const literal = "literal" in entry && entry.literal === true;
    return literal || !GLOB.test(entry.path) ? [entry.path] : [];
  });
}

/** A rule SRT applies beneath the command's directory regardless of the write grant. */
function mandatoryRule(
  path: string,
  cwd: string,
): { kind: SandboxBlockKind; rule: string } | undefined {
  if (!within(cwd, path)) return undefined;
  const segments = relative(cwd, path).split(sep).filter(Boolean);
  // Protected names inside a dependency folder are writable.
  let inDependency = false;
  for (const [index, segment] of segments.entries()) {
    const rest = segments.slice(index).join("/");
    if (segment === ".git" && /^\.git\/(?:hooks(?:\/|$)|config$)/.test(rest))
      return {
        kind: "git_resource",
        rule: rest.startsWith(".git/hooks") ? ".git/hooks" : ".git/config",
      };
    const directory = dangerousDirectories.find(
      (name) => rest === name || rest.startsWith(`${name}/`),
    );
    if (directory && !inDependency) return { kind: "protected_name", rule: directory };
    if (dependencyDirectories.has(segment)) inDependency = true;
  }
  const last = segments.at(-1);
  return last && dangerousFiles.has(last) && !inDependency
    ? { kind: "protected_name", rule: last }
    : undefined;
}

function classifyPath(
  path: string,
  cwd: string,
  allowWrite: readonly string[],
  denyWrite: readonly string[],
  platform?: NodeJS.Platform,
  profileCwd = cwd,
): SandboxBlockItem | undefined {
  // Seatbelt's mandatory literal .git/hooks rule also pins its parent against creation.
  if (platform === "darwin" && path === join(profileCwd, ".git"))
    return { kind: "git_resource", rule: ".git/hooks", target: path };
  const mandatory = mandatoryRule(path, cwd);
  if (mandatory) return { ...mandatory, target: path };
  if (denyWrite.some((root) => within(root, path)))
    return {
      kind: path.split(sep).includes(".git") ? "git_resource" : "protected_path",
      rule: "explicit_deny",
      target: path,
    };
  if (!allowWrite.some((root) => within(root, path)))
    return { kind: "outside_workplace_write", rule: "write_root", target: path };
  // Writable and no deny rule: an ordinary permission error, not the sandbox.
  return undefined;
}

/**
 * Only paths that match this call's own deny rules count: a denial message alone may be a real
 * file permission problem, and calling that a sandbox block would invite a needless bypass.
 * `violations` are the sandbox's own reports: they need no such match, and the strong
 * ones (protected reads, keychain, refused hosts) count even when the command exited 0.
 */
export function classifySandboxBlock(input: {
  candidates: readonly string[];
  signals?: readonly {
    kind: "network" | "system_service" | "local_service";
    rule: string;
    target: string;
  }[];
  violations?: readonly string[];
  /** Loopback ports a local service answers on, for the port-only Seatbelt socket reports. */
  listening?: ReadonlySet<number>;
  /** Credential tools that ran without the user's login (credential-tools.ts); always strong. */
  credentials?: readonly SandboxBlockItem[];
  /** The user's and the Bot's homes, for `~/…` names of credential stores. */
  homes?: readonly string[];
  /** Exit 0: only strong violation evidence is a block; output hints are not collected then. */
  succeeded?: boolean;
  /** Completed external-agent turns can ignore the repeated login-keychain metadata probe. */
  quietLoginKeychainMetadata?: boolean;
  command?: string;
  cwd: string;
  profileCwd?: string;
  config: SandboxRuntimeConfig;
  platform?: NodeJS.Platform;
}): SandboxBlock | undefined {
  const cwd = canonical(input.cwd);
  const allowWrite = literalPaths(input.config.filesystem?.allowWrite).map(canonical);
  const denyWrite = literalPaths(input.config.filesystem?.denyWrite).map(canonical);
  const items: SandboxBlockItem[] = [];
  const seen = new Set<string>();
  const push = (item: SandboxBlockItem) => {
    if (items.length >= MAX_ITEMS || seen.has(`${item.kind}\0${item.target}`)) return;
    seen.add(`${item.kind}\0${item.target}`);
    items.push(item);
  };
  for (const item of input.credentials ?? []) push(item);
  if (input.violations?.length) {
    const found = violationItems(input.violations, {
      homes: [...new Set((input.homes ?? []).map(canonical))],
      denyRead: literalPaths(input.config.filesystem?.denyRead).map(canonical),
      platform: input.platform ?? process.platform,
      ...(input.quietLoginKeychainMetadata ? { quietLoginKeychainMetadata: true } : {}),
      classifyWrite: (path) =>
        classifyPath(canonical(path), cwd, allowWrite, denyWrite, input.platform, input.profileCwd),
      ...(input.listening ? { listening: input.listening } : {}),
    });
    // Reads first: a missing login explains the rest of a failure better than a cache write.
    const order = (kind: SandboxBlockKind) => (kind.endsWith("_read") ? 0 : 1);
    for (const { item, strong } of found.sort((a, b) => order(a.item.kind) - order(b.item.kind)))
      if (strong || !input.succeeded) push(item);
  }
  if (input.succeeded) return items.length ? { kinds: kindsOf(items), items } : undefined;
  for (const candidate of input.candidates) {
    // `~` in output is the Bot's own HOME, not a path this call can attribute reliably.
    if (candidate.startsWith("~/")) continue;
    const path = canonical(isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate));
    const item = classifyPath(path, cwd, allowWrite, denyWrite, input.platform, input.profileCwd);
    if (item) push(item);
  }
  // Path-less signals come from fixed patterns of a command that failed inside the sandbox.
  for (const signal of input.signals ?? []) push(signal);
  // The macOS pasteboard service is not reachable from the sandbox and its tools print nothing.
  const pasteboard = /(?:^|[|;&(]\s*)(?:\S*\/)?(pbcopy|pbpaste)(?=\s|$)/.exec(
    input.command ?? "",
  )?.[1];
  if (input.platform === "darwin" && pasteboard)
    push({ kind: "system_service", rule: "pasteboard", target: pasteboard });
  if (!items.length) return undefined;
  return { kinds: kindsOf(items), items };
}

const kindsOf = (items: readonly SandboxBlockItem[]) => [
  ...new Set(items.map((item) => item.kind)),
];
