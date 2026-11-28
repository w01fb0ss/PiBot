import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve, win32 } from "node:path";
import {
  type ConfigEntry,
  type ConfigSource,
  displayKey,
  lastValue,
  readConfigSource,
} from "./git-entry-config.ts";
import { type BoundPath, boundCurrent, EntryScanIncomplete, observe } from "./git-entry-files.ts";
import { scanHooks } from "./git-entry-hooks.ts";
import {
  bind,
  type Collector,
  discover,
  expandHome,
  type GitEntry,
  type GitEntryRefusal,
  parseInvocation,
  Refused,
  type Repository,
  sha,
} from "./git-entry-layout.ts";
import { builtinSubcommand, hooksFor, keyRunsFor, RECEIVE_HOOKS } from "./git-entry-tables.ts";

export type { GitEntry, GitEntryRefusal } from "./git-entry-layout.ts";
export interface GitEntryFactsData {
  version: 1;
  status: "confirmation-required" | "unsupported";
  reason: "entries_found" | GitEntryRefusal;
  entries: GitEntry[];
  digest?: string;
  authority: "none";
}
/** Private, non-serializable binding of what one confirmed call may run; re-checked at launch. */
export interface GitEntryPlan {
  /** Absent when nothing would run: the plan then only pins that this is still true at launch. */
  readonly facts?: Readonly<GitEntryFactsData>;
  /** The Windows read can start without ordinary consent only while this plan is current. */
  readonly windowsReadScopeVerified?: true;
  readonly callId: string;
  readonly command: string;
  /**
   * Set on a desktop-side handle for a plan held by a runner: the runner, where the repository
   * lives, re-checks the bound paths right before spawn; this process cannot.
   */
  readonly remotePlanId?: string;
}
/** What a caller supplies; the executing target adds its own HOME, platform, env and temp root. */
export interface GitEntryTargetInput {
  invocations: readonly GitEntryInvocation[];
  compound: boolean;
  callId: string;
  command: string;
  /** Canonical work folders for an implicit Windows read, including its Git metadata. */
  windowsReadRoots?: readonly string[];
}
export interface GitEntryInvocation {
  args: readonly string[];
  cwd: string;
}
export interface GitEntryScanInput extends GitEntryTargetInput {
  /** The command's HOME (the Bot home); its `.gitconfig` is the global file Git reads there. */
  botHome: string;
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  /** Brain temp root outside every command write root, for private config copies. */
  privateTempRoot: string;
}
export type GitEntryResult =
  | { status: "none"; plan: GitEntryPlan }
  | { status: "unsupported"; facts: GitEntryFactsData }
  | { status: "confirmation-required"; facts: GitEntryFactsData; plan: GitEntryPlan };

const issued = new WeakMap<GitEntryPlan, readonly BoundPath[]>();
const MAX_SCANS = 16;
const MAX_ENTRIES = 32;

async function source(path: string, collector: Collector, always: boolean) {
  const read = await readConfigSource(path, collector.reader, always);
  bind(collector, read.bound);
  return read;
}

/** Project and Bot-reachable sources only (owner decision Q1); system/vendor config is baseline. */
async function repositorySources(
  repository: Repository,
  collector: Collector,
  always: boolean,
  submodule = false,
) {
  const sources: ConfigSource[] = [
    await source(join(collector.botHome, ".gitconfig"), collector, always),
  ];
  const local = await source(join(repository.commonDir, "config"), collector, always);
  sources.push(local);
  if (/^(?:true|yes|on|1)$/i.test(lastValue([local], "extensions.worktreeconfig") ?? ""))
    sources.push(await source(join(repository.gitDir, "config.worktree"), collector, always));
  for (const item of sources)
    for (const entry of item.entries) {
      const key = entry.key.toLowerCase();
      if (key === "include.path" || (key.startsWith("includeif.") && key.endsWith(".path")))
        throw new Refused("include_unknown");
      // A submodule's own git dir names its checkout this way; anywhere else it moves the layout.
      if (key === "core.worktree" && !submodule) throw new Refused("layout_unsupported");
    }
  return sources;
}

function addEntry(collector: Collector, entry: GitEntry) {
  if (collector.entries.length >= MAX_ENTRIES) throw new EntryScanIncomplete("entries");
  if (
    !collector.entries.some((known) => known.source === entry.source && known.name === entry.name)
  )
    collector.entries.push(entry);
}

function configEntries(
  sources: readonly ConfigSource[],
  inline: readonly ConfigEntry[],
  subcommand: string,
  rest: readonly string[],
  collector: Collector,
) {
  for (const entry of inline)
    if (keyRunsFor(entry.key, entry.value, subcommand, rest)) throw new Refused("dynamic");
  for (const item of sources)
    for (const entry of item.entries) {
      const key = entry.key.toLowerCase();
      const alias = key === `alias.${subcommand.toLowerCase()}` && !builtinSubcommand(subcommand);
      // A plain alias expands into Git arguments this scan never saw.
      if (alias && !(entry.value ?? "").startsWith("!")) throw new Refused("dynamic");
      if (alias || keyRunsFor(key, entry.value, subcommand, rest))
        addEntry(collector, {
          kind: "config",
          name: displayKey(entry.key),
          source: item.bound.path,
          sha256: sha(`${entry.key}\0${entry.value ?? ""}`),
        });
    }
}

/** core.hooksPath by precedence: `-c`, worktree, local, then the Bot home global file. */
function hooksDirectory(
  repository: Repository,
  sources: readonly ConfigSource[],
  inline: readonly ConfigEntry[],
  home: string,
) {
  const configured = lastValue(
    [...sources, { bound: { path: "", kind: "absent" }, entries: [...inline] }],
    "core.hookspath",
  );
  if (configured === undefined || configured === "") return join(repository.commonDir, "hooks");
  const path = expandHome(configured, home);
  return isAbsolute(path) ? path : resolve(repository.worktree ?? repository.gitDir, path);
}

/** Local path or file:// remotes run the receiving repository's hooks during a push. */
function localPushTargets(
  sources: readonly ConfigSource[],
  rest: readonly string[],
  repository: Repository,
  cwd: string,
  home: string,
) {
  const values: { value: string; base: string }[] = [];
  for (const item of sources)
    for (const entry of item.entries)
      if (/^remote\..+\.(?:url|pushurl)$/i.test(entry.key) && entry.value)
        values.push({ value: entry.value, base: repository.worktree ?? repository.gitDir });
  const operand = rest.find((arg) => !arg.startsWith("-"));
  if (operand) values.push({ value: operand, base: cwd });
  const targets = new Set<string>();
  for (const { value, base } of values) {
    const path = value.startsWith("file://")
      ? decodeURIComponent(value.slice(7))
      : /^(?:\/|\.\.?\/|~\/)/.test(value) || value === "." || value === ".."
        ? expandHome(value, home)
        : undefined;
    if (path !== undefined) targets.add(resolve(base, path));
  }
  if (targets.size > 8) throw new EntryScanIncomplete("targets");
  return [...targets];
}

function withinWindowsReadScope(
  paths: readonly string[],
  commonDir: string,
  roots: readonly string[],
  collector: Collector,
) {
  // Gitfiles, commondir and upward discovery can all select data outside the explicit cwd.
  if (
    !paths.every(
      (path) =>
        !/^[\\/]{2}/.test(path) &&
        roots.some((root) => {
          const relative = win32.relative(root, path);
          return !win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\");
        }),
    )
  )
    return false;
  const path = join(commonDir, "objects", "info", "alternates");
  let alternates: BoundPath;
  try {
    alternates = observe(path);
  } catch (error) {
    if (error instanceof EntryScanIncomplete) return false;
    throw error;
  }
  if (alternates.kind !== "absent") return false;
  bind(collector, alternates);
  return true;
}

async function scanInvocation(
  invocation: GitEntryInvocation,
  collector: Collector,
  windowsReadScope: { roots: readonly string[]; verified: boolean } | undefined,
) {
  const parsed = parseInvocation(invocation, collector.botHome);
  if (!parsed) return;
  const { subcommand, rest, inline, cwd } = parsed;
  if (
    (subcommand === "init" || subcommand === "clone") &&
    rest.some((arg) => arg.startsWith("--template"))
  )
    throw new Refused("dynamic");
  // A new repository's hooks come from the template (baseline), never from an enclosing repo.
  const repository =
    subcommand === "clone" || subcommand === "init" ? undefined : discover(cwd, collector);
  // Scope determines eligibility for automatic approval. The ordinary entry scan still
  // has to finish so that the standard consent path can use its result.
  if (windowsReadScope?.verified)
    windowsReadScope.verified = repository
      ? withinWindowsReadScope(
          [cwd, repository.worktree ?? cwd, repository.gitDir, repository.commonDir],
          repository.commonDir,
          windowsReadScope.roots,
          collector,
        )
      : subcommand !== "diff" || rest.length === 0; // With operands, Git can imply --no-index.
  if (!repository) {
    // Outside a repository only the Bot home global file can name a program.
    const global = await source(join(collector.botHome, ".gitconfig"), collector, false);
    configEntries([global], inline, subcommand, rest, collector);
    return;
  }
  const push = subcommand === "push";
  const sources = await repositorySources(repository, collector, push);
  configEntries(sources, inline, subcommand, rest, collector);
  const hooks = hooksDirectory(repository, sources, inline, collector.botHome);
  scanHooks(hooks, subcommand, rest, collector, bind, addEntry);
  const recurse =
    subcommand === "submodule" ||
    (rest.includes("--recurse-submodules") && !rest.includes("--no-recurse-submodules")) ||
    /^(?:true|yes|on|1)$/i.test(lastValue(sources, "submodule.recurse") ?? "");
  if (recurse) await scanModules(repository, subcommand, rest, collector);
  if (!push) return;
  for (const target of localPushTargets(sources, rest, repository, cwd, collector.botHome)) {
    const receiving = discover(target, collector);
    if (!receiving) continue;
    const targetSources = await repositorySources(receiving, collector, false);
    scanHooks(
      hooksDirectory(receiving, targetSources, [], collector.botHome),
      "receive-pack",
      [],
      collector,
      bind,
      addEntry,
      RECEIVE_HOOKS,
    );
  }
}

/** Submodule repositories keep their own hooks and config under `<common>/modules/`. */
async function scanModules(
  repository: Repository,
  subcommand: string,
  rest: readonly string[],
  collector: Collector,
) {
  const names = [...new Set([...hooksFor("checkout", []), ...hooksFor(subcommand, rest)])];
  const pending: { path: string; depth: number }[] = [
    { path: join(repository.commonDir, "modules"), depth: 0 },
  ];
  let repositories = 0;
  while (pending.length) {
    const { path, depth } = pending.shift() as { path: string; depth: number };
    const seen = observe(path);
    bind(collector, seen);
    if (seen.kind !== "dir") continue;
    if (observe(join(path, "HEAD")).kind === "file") {
      if (++repositories > 32) throw new EntryScanIncomplete("modules");
      const module = { gitDir: path, commonDir: path };
      const sources = await repositorySources(module, collector, false, true);
      configEntries(sources, [], subcommand, rest, collector);
      scanHooks(
        hooksDirectory(module, sources, [], collector.botHome),
        subcommand,
        rest,
        collector,
        bind,
        addEntry,
        names,
      );
    }
    if (depth >= 4) continue;
    let children: string[];
    try {
      children = readdirSync(path);
    } catch {
      throw new EntryScanIncomplete("modules");
    }
    if (children.length > 256) throw new EntryScanIncomplete("modules");
    for (const child of children)
      if (!["objects", "refs", "logs", "hooks", "info", "worktrees"].includes(child))
        pending.push({ path: join(path, child), depth: depth + 1 });
  }
}

/**
 * Which project hooks / executable config entries ordinary Git commands would run.
 * Bounded (time, files, entries) and fail-closed: anything it cannot bind is a refusal reason.
 */
export async function inspectGitEntries(
  input: GitEntryScanInput,
  signal: AbortSignal,
): Promise<GitEntryResult> {
  const collector: Collector = {
    entries: [],
    bound: [],
    reader: {
      platform: input.platform,
      env: input.env,
      privateTempRoot: input.privateTempRoot,
      signal,
    },
    deadline: Date.now() + 15_000,
    botHome: input.botHome,
    platform: input.platform,
  };
  const refuse = (reason: GitEntryRefusal): GitEntryResult => ({
    status: "unsupported",
    facts: { version: 1, status: "unsupported", reason, entries: [], authority: "none" },
  });
  const windowsReadScope =
    input.platform === "win32" && input.windowsReadRoots && input.invocations.length
      ? { roots: input.windowsReadRoots, verified: true }
      : undefined;
  try {
    if (input.invocations.length > MAX_SCANS) return refuse("scan_incomplete");
    for (const invocation of input.invocations)
      await scanInvocation(invocation, collector, windowsReadScope);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Refused) return refuse(error.reason);
    if (error instanceof EntryScanIncomplete) return refuse("scan_incomplete");
    throw error;
  }
  const bound = Object.freeze(collector.bound.map((item) => Object.freeze({ ...item })));
  if (!collector.entries.length) {
    // Hooks found absent are bound too, so one created before launch refuses this call.
    const plan: GitEntryPlan = Object.freeze({
      callId: input.callId,
      command: input.command,
      ...(windowsReadScope?.verified ? { windowsReadScopeVerified: true as const } : {}),
    });
    issued.set(plan, bound);
    return { status: "none", plan };
  }
  if (input.compound) return refuse("compound");
  const entries = collector.entries;
  const facts = Object.freeze({
    version: 1 as const,
    status: "confirmation-required" as const,
    reason: "entries_found" as const,
    entries,
    digest: sha(JSON.stringify({ entries, bound, callId: input.callId, command: input.command })),
    authority: "none" as const,
  });
  const plan: GitEntryPlan = Object.freeze({ facts, callId: input.callId, command: input.command });
  issued.set(plan, bound);
  return { status: "confirmation-required", facts, plan };
}

/**
 * Synchronous last check before the process starts: the plan must be one this module issued for
 * this exact call, and every bound path (entries, config sources, hooks directory, absent hooks)
 * must be unchanged.
 */
export function gitEntryPlanCurrent(
  plan: GitEntryPlan | undefined,
  call: { id: string; command: string },
): boolean {
  const bound = plan ? issued.get(plan) : undefined;
  return (
    !!plan &&
    !!bound &&
    plan.callId === call.id &&
    plan.command === call.command &&
    boundCurrent(bound)
  );
}
