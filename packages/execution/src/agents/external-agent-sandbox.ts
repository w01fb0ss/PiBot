// The outer sandbox of an external coding agent (Codex, Claude Agent, Cursor,
// OpenCode, a custom ACP command). The agent runs its own tools, so the boundary is the whole
// process: it writes only the topic's folders, its private temp folder and its own config/login
// folder, reads nothing Pi Bot protects except the exact exceptions below, and reaches only its
// own service. The agent's own sandbox is off (macOS cannot nest Seatbelt; Linux bwrap
// cannot create a user namespace inside SRT), so this boundary must start or nothing runs.
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js";
import { canonicalPath, checkedRoot, denyTargets, within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { gitDefaultWriteDenies, gitMetadataWriteDenies } from "../git/git-init-sandbox.ts";
import { linuxGitWriteDenies } from "../git/git-protected-paths.ts";
import { bundledNodePath } from "../runtime/child-node.ts";
import { createSandboxDependencies, SAFE_SYSTEM_SERVICES } from "../sandbox/sandbox-config.ts";
import { sensitiveReadBoundary } from "../sandbox/sensitive-paths.ts";
import { commandTempBoundary } from "../sandbox/temp-boundary.ts";
import { verifyCommandAliases } from "../sandbox/workspace.ts";
import { hookDenies, keyringModuleRoots } from "./external-agent-denies.ts";

/**
 * The only protected home paths an agent may be given, and how. Anything else inside a protected
 * root is refused even if the brain asks: a wrong catalog entry cannot open `~/.ssh` or another
 * tool's login. Keys are home-relative with POSIX separators.
 */
const EXCEPTIONS: Readonly<Record<string, "readWrite" | "readOnly">> = {
  ".codex": "readWrite",
  ".claude": "readWrite",
  ".claude.json": "readWrite",
  ".cursor": "readWrite",
  ".config/opencode": "readWrite",
  // Antigravity: its sessions and logs, and its global customizations read only (hooks, MCP
  // servers and plugins there run later outside any sandbox). The rest of ~/.gemini stays hidden.
  ".gemini/antigravity-cli": "readWrite",
  ".gemini/config": "readOnly",
  // The login keychain file only, never the Keychains folder (Claude and Cursor keep
  // their token there). Note: securityd then serves every item this program's ACL allows.
  "Library/Keychains/login.keychain-db": "readOnly",
};
/**
 * Files their agent replaces atomically: it writes `<name>.tmp.<pid>.<hex>` beside the file and
 * renames it over. Claude Code falls back to writing in place only on EACCES, and macOS denies
 * with EPERM, so without the sibling its settings never save. macOS only (a write glob); Linux
 * SRT drops write globs, so there Claude keeps the in-place limitation.
 */
const ATOMIC_SIBLINGS: Readonly<Record<string, string>> = { ".claude.json": ".claude.json.tmp.*" };
/**
 * Inside a writable grant, the agent's own installed program stays read-only: a binary rewritten
 * from inside the sandbox would run later in the user's terminal outside any sandbox.
 */
const GRANT_WRITE_DENIES: Readonly<Record<string, readonly string[]>> = {
  ".opencode": ["bin"],
  // Codex's standalone installer keeps its releases here; ~/.local/bin/codex points into it.
  ".codex": ["packages"],
  // Antigravity unpacks its bundled plugins (with sidecar programs) into `builtin` and stages its
  // own updates in `updater`; both run later outside any sandbox.
  ".gemini/antigravity-cli": ["builtin", "updater"],
};
/** Cursor resolves DNS itself. Never a directory: /var/run also holds docker.sock. */
const UNIX_SOCKETS = new Set(["/var/run/mDNSResponder", "/private/var/run/mDNSResponder"]);
const MACH_SERVICES = new Set<string>(SAFE_SYSTEM_SERVICES);
const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/;
const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface AgentAllowanceInput {
  readWrite: readonly string[];
  readOnly: readonly string[];
  machLookup: readonly string[];
  unixSockets: readonly string[];
  network: readonly string[];
  /** macOS: bind and accept on local ports, and connect to any loopback port (SRT switch). */
  localBinding?: boolean;
  /** macOS: open pseudo-terminals (`/dev/ptmx`, `/dev/ttys*`; SRT switch). */
  pty?: boolean;
}

export interface ExternalAgentSandboxInput {
  platform: NodeJS.Platform;
  /** The user's real home: the agent finds its login there. */
  systemHome: string;
  env: Readonly<NodeJS.ProcessEnv>;
  /** Pi Bot's data directory: unreadable, except `readRoots` below. */
  dataDir: string;
  /** The topic's working folders (primary first); the agent's cwd must be inside one. */
  writeRoots: readonly string[];
  /**
   * The agent Bot's id. Its default folder `<data>/bots/<id>/home` (the folder every Bot works in
   * when the topic has none) is the one place inside Pi Bot's data an agent may use as a write
   * root; the rest of the data directory, other Bots' folders included, stays hidden.
   */
  botId?: string;
  /**
   * A group the agent takes a plan step in: that group's default folder `<data>/groups/<id>/home`
   * (used when the group has no folder of the user's) is allowed the same way, exactly.
   */
  groupId?: string;
  /** Pinned adapter folder inside the data directory; readable, never writable. */
  readRoots: readonly string[];
  allowances: AgentAllowanceInput;
  /** Parent proxy URL of the user's network settings, or none. */
  parentProxy?: string;
  /** Pi Bot's exec temp folder: other runs' namespaces there stay unreadable. */
  tempDir: string;
  /** Packaged resources (ripgrep, seccomp helper); absent when running from the workspace. */
  resourcesDir?: string;
  /**
   * Pi Bot's own MCP bridge, the one Pi Bot endpoint the agent may reach. macOS:
   * exactly this unix socket (connect only; its name stays unwritable). Linux: exactly
   * 127.0.0.1:<port> through the sandbox proxy (seccomp refuses every unix socket there).
   */
  bridge?: AgentBridgeEndpoint;
  signal: AbortSignal;
}

export type AgentBridgeEndpoint = (
  | { kind: "unix"; path: string }
  | { kind: "tcp"; port: number }
) & {
  /** The helper Node and relay script the agent starts; their folders become readable. */
  relay?: readonly string[];
};

const BRIDGE_SOCKET = /^[A-Za-z0-9._-]{1,40}\.sock$/;

/**
 * The bridge endpoint as sandbox rules, refused unless it is exactly Pi Bot's: a socket name the
 * agent could write (inside its folders or grants) could be swapped for one of its own.
 */
function bridgeAllowance(
  platform: NodeJS.Platform,
  bridge: AgentBridgeEndpoint | undefined,
  writable: readonly string[],
): { socket?: string; domain?: string } {
  if (!bridge) return {};
  if (bridge.kind === "tcp") {
    if (platform !== "linux" || !Number.isInteger(bridge.port) || bridge.port < 1024)
      throw new ExecError("invalid_input");
    if (bridge.port > 65535) throw new ExecError("invalid_input");
    return { domain: `127.0.0.1:${bridge.port}` };
  }
  const path = normalize(bridge.path);
  if (
    platform !== "darwin" ||
    !isAbsolute(path) ||
    path !== bridge.path ||
    !BRIDGE_SOCKET.test(path.split(sep).at(-1) ?? "") ||
    writable.some((root) => within(root, path))
  )
    throw new ExecError("invalid_input");
  return { socket: path };
}

/**
 * The folders of the relay program, read-only. Only Pi Bot's own packaged files qualify: each must
 * resolve inside the packaged resources (or, running from the workspace, be one of its files),
 * so no caller-supplied path can open a folder.
 */
async function bridgeRelayReads(bridge: AgentBridgeEndpoint | undefined, resourcesDir?: string) {
  if (!bridge?.relay?.length) return [];
  const resources = resourcesDir ? await realpath(resourcesDir) : undefined;
  const folders: string[] = [];
  for (const file of bridge.relay) {
    if (!isAbsolute(file)) throw new ExecError("invalid_input");
    const real = await realpath(file);
    if (resources && !within(resources, real)) throw new ExecError("invalid_input");
    folders.push(dirname(real));
  }
  return [...new Set(folders)];
}

function homeRelative(entry: string) {
  const value = normalize(entry).split(sep).join("/");
  if (!entry || isAbsolute(entry) || value === "." || value.startsWith("../") || value === "..")
    throw new ExecError("invalid_input");
  return value;
}

/** Exactly what one agent process may touch; throws instead of widening anything. */
export async function externalAgentSandboxConfig(
  input: ExternalAgentSandboxInput,
): Promise<SandboxRuntimeConfig> {
  input.signal.throwIfAborted();
  if (input.platform !== "darwin" && input.platform !== "linux")
    throw new ExecError("isolation_unavailable");
  const home = resolve(input.systemHome);
  // Linux: SRT needs ripgrep (its mandatory-deny search) and the seccomp helper (unix socket
  // filter). Missing either fails closed instead of running with a weaker boundary.
  const { rg, helper } = await createSandboxDependencies({
    platform: input.platform,
    ...(input.resourcesDir ? { resourcesDir: input.resourcesDir } : {}),
  }).dependencies();
  if (input.platform === "linux" && !helper)
    throw new ExecError("isolation_unavailable", "seccomp_helper_unavailable");
  const reads = await sensitiveReadBoundary(input.platform, [home], input.env);
  const protectedRoots = reads.denyRead;
  const dataRoots = [...new Set(await denyTargets(input.dataDir))];

  const grant = async (entry: string, mode: "readWrite" | "readOnly") => {
    const relative = homeRelative(entry);
    const lexical = join(home, ...relative.split("/"));
    const targets = [...new Set(await denyTargets(lexical))];
    const exception = EXCEPTIONS[relative];
    const permitted = exception === mode || (exception === "readWrite" && mode === "readOnly");
    for (const target of targets) {
      // A grant may never contain a protected root or Pi Bot's data (e.g. "Library" or ".").
      if (
        protectedRoots.some((root) => within(target, root) && !targets.includes(root)) ||
        dataRoots.some((root) => within(target, root) || within(root, target))
      )
        throw new ExecError("invalid_input", "write_path_protected");
      // Inside a protected root only the fixed exceptions apply; elsewhere (a custom agent's own
      // data folder) the grant opens nothing Pi Bot protects.
      if (protectedRoots.some((root) => within(root, target)) && !permitted)
        throw new ExecError("invalid_input", "write_path_protected");
    }
    return targets;
  };
  const writable = (
    await Promise.all(input.allowances.readWrite.map((entry) => grant(entry, "readWrite")))
  ).flat();
  const readable = (
    await Promise.all(input.allowances.readOnly.map((entry) => grant(entry, "readOnly")))
  ).flat();
  const opened = new Set([...writable, ...readable]);
  // Only beside a granted file, and only when the home path has no glob syntax of its own.
  const siblings =
    input.platform === "darwin" && !/[*?[\]{}\\]/.test(home)
      ? input.allowances.readWrite.flatMap((entry) => {
          const sibling = ATOMIC_SIBLINGS[homeRelative(entry)];
          return sibling ? [join(home, sibling)] : [];
        })
      : [];

  const roots = await Promise.all(input.writeRoots.map((root) => checkedRoot(resolve(root))));
  if (!roots.length) throw new ExecError("outside_workplace");
  if (input.botId !== undefined && !BOT_ID.test(input.botId)) throw new ExecError("invalid_input");
  if (input.groupId !== undefined && !BOT_ID.test(input.groupId))
    throw new ExecError("invalid_input");
  // Exactly this Bot's (or this group's) own default folder, never a parent, sibling or another's.
  const data = await checkedRoot(resolve(input.dataDir));
  const botHome = input.botId === undefined ? undefined : join(data, "bots", input.botId, "home");
  const groupHome =
    input.groupId === undefined ? undefined : join(data, "groups", input.groupId, "home");
  const ownHomes = [botHome, groupHome].filter((path): path is string => !!path);
  for (const root of roots)
    if (
      !ownHomes.includes(root) &&
      (protectedRoots.some((denied) => within(denied, root) || within(root, denied)) ||
        dataRoots.some((data) => within(data, root) || within(root, data)) ||
        root === home)
    )
      throw new ExecError("outside_workplace", "profile_write_root");
  // The data directory itself must not sit inside a protected root the own folder would reopen.
  const dataWork = ownHomes.filter((home) => roots.includes(home));
  if (dataWork.some((home) => protectedRoots.some((denied) => within(denied, home))))
    throw new ExecError("outside_workplace", "profile_write_root");
  const adapterRoots = await Promise.all(
    input.readRoots.map(async (root) => {
      const canonical = await canonicalPath(root, home);
      if (!dataRoots.some((data) => within(data, canonical)))
        throw new ExecError("invalid_input", "profile_read_root");
      return canonical;
    }),
  );
  for (const socket of input.allowances.unixSockets)
    if (input.platform !== "darwin" || !UNIX_SOCKETS.has(socket))
      throw new ExecError("invalid_input");
  for (const service of input.allowances.machLookup)
    if (input.platform !== "darwin" || !MACH_SERVICES.has(service))
      throw new ExecError("invalid_input");
  const domains = input.allowances.network.map((domain) => domain.toLowerCase());
  if (domains.some((domain) => !DOMAIN.test(domain))) throw new ExecError("invalid_input");
  const bridge = bridgeAllowance(input.platform, input.bridge, [...roots, ...writable]);
  if (bridge.domain) domains.push(bridge.domain);
  const relayReads = await bridgeRelayReads(input.bridge, input.resourcesDir);
  input.signal.throwIfAborted();

  // OS temp and Pi Bot's exec temp are unreadable (other runs' namespaces, other agents' private
  // HOME/TMPDIR); the host adds this process's own private folder back.
  const temporary = await commandTempBoundary(input.tempDir, undefined, input.platform, roots, [
    ...(helper ? [dirname(helper)] : []),
    ...(input.platform === "linux" && input.resourcesDir
      ? [dirname(bundledNodePath(input.resourcesDir, input.platform))]
      : []),
  ]);
  const writeDenies = [
    ...adapterRoots,
    ...input.allowances.readWrite.flatMap((entry) =>
      (GRANT_WRITE_DENIES[homeRelative(entry)] ?? []).map((child) =>
        join(home, ...homeRelative(entry).split("/"), child),
      ),
    ),
    // SRT's own default writable paths (e.g. ~/.npm/_logs) outside what this agent may write.
    ...(await gitDefaultWriteDenies([...roots, ...writable])),
    ...(await hookDenies(input.platform, home, writable, roots)),
    // Nothing inside may remove or replace Pi Bot's socket with one of its own.
    ...(bridge.socket ? [bridge.socket] : []),
  ];
  if (input.platform === "linux") {
    // SRT drops write globs on Linux: Git hooks/config of every repository in the topic folders
    // are pinned by name, then every other writable name for those inodes (hard links) too.
    const permitsRead = (path: string) =>
      !protectedRoots.some((root) => within(root, path)) &&
      (dataWork.some((root) => within(root, path)) ||
        !dataRoots.some((root) => within(root, path)));
    writeDenies.push(...(await linuxGitWriteDenies({ roots, permitsRead, signal: input.signal })));
    writeDenies.push(
      ...(await verifyCommandAliases(roots, writeDenies, input.signal, undefined, true)),
    );
  }
  input.signal.throwIfAborted();

  // Drop exactly the opened roots (and protected roots inside them) from the deny list; a parent
  // such as Library/Keychains stays denied while one file inside it is allowed to be read.
  const denyRead = [
    ...new Set([
      ...protectedRoots.filter((root) => ![...opened].some((path) => within(path, root))),
      ...dataRoots,
      ...keyringModuleRoots(),
    ]),
  ];
  const value = SandboxRuntimeConfigSchema.parse({
    credentials: {
      envVars: ["JAVA_TOOL_OPTIONS", "GIT_CONFIG_COUNT"].map((name) => ({ name, mode: "deny" })),
    },
    network: {
      allowedDomains: [...new Set(domains)],
      deniedDomains: [],
      strictAllowlist: true,
    },
    filesystem: {
      denyRead: [
        ...denyRead.map((path) => ({ path, literal: true })),
        ...reads.denyReadGlobs,
        ...temporary.denyRead,
      ],
      allowRead: [
        // A writable grant inside a protected root (Antigravity's folder in ~/.gemini) is read
        // back too; the rest of that root stays denied.
        ...[
          ...new Set([...readable, ...writable, ...adapterRoots, ...dataWork, ...relayReads]),
        ].map((path) => ({
          path,
          literal: true,
        })),
        ...temporary.allowRead,
      ],
      allowWrite: [
        ...[...new Set([...roots, ...writable])].map((path) => ({ path, literal: true as const })),
        ...siblings,
      ],
      denyWrite: [
        ...[...new Set(writeDenies)].map((path) => ({ path, literal: true })),
        // A hook or config written by the agent would run later outside any sandbox (macOS
        // globs; Linux gets the literal names above).
        ...gitMetadataWriteDenies(input.platform, false),
        ...temporary.denyWrite,
      ],
    },
    ripgrep: { command: rg },
    ...(helper ? { seccomp: { applyPath: helper } } : {}),
  }) as SandboxRuntimeConfig;
  if (input.platform === "darwin") {
    // Linux needs nothing: bubblewrap's own network namespace already allows a private bind.
    if (input.allowances.localBinding) value.network.allowLocalBinding = true;
    // Linux needs nothing either: bubblewrap mounts a private /dev/pts for the sandbox.
    if (input.allowances.pty) value.allowPty = true;
    value.network.allowMachLookup = [
      ...new Set([...SAFE_SYSTEM_SERVICES, ...input.allowances.machLookup]),
    ];
    const sockets = [...input.allowances.unixSockets, ...(bridge.socket ? [bridge.socket] : [])];
    if (sockets.length) value.network.allowUnixSockets = [...new Set(sockets)];
  }
  // Empty strings explicitly disable SRT's ambient fallback to the host shell's proxy variables.
  value.network.parentProxy = input.parentProxy
    ? { http: input.parentProxy, https: input.parentProxy, noProxy: "" }
    : { http: "", https: "", noProxy: "" };
  return value;
}
