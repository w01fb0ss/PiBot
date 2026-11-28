import { posix, win32 } from "node:path";
import {
  canonicalPath,
  ExecError,
  type GitEntryInvocation,
  type GitEntryPlan,
  gitEntryPlanCurrent,
  inspectGitEntries,
} from "@pibot/execution";
import {
  type CommandAnalysis,
  expandHome,
  GIT_ENTRY_CONFIRMATION_REASON,
  windowsReadShape,
} from "@pibot/policy";
import {
  type GitEntryFacts,
  GitEntryFactsSchema,
  type ResolvedWorkplace,
  RpcError,
} from "@pibot/protocol-base";
import type { RunCommandArgs } from "@pibot/tools/command";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

export interface PreparedGitEntries {
  /** Absent when the command runs no project entry; then only `plan` is kept. */
  facts?: GitEntryFacts;
  /** Private plan bound to this call; never serialized or shown. */
  plan?: GitEntryPlan;
}

const GIT = /(?:^|[/\\])git(?:\.exe)?$/i;
/** Variables that move the repository, config or a program Git runs; the scan cannot see them. */
const LAYOUT_ENV =
  /(?:^|[\s;&|(])(?:export\s+)?(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG\w*|EXEC_PATH|EDITOR|SEQUENCE_EDITOR|SSH|SSH_COMMAND|SSH_VARIANT|ASKPASS|EXTERNAL_DIFF|PROXY_COMMAND|NAMESPACE|TEMPLATE_DIR|ALLOW_PROTOCOL)|EDITOR|VISUAL|SSH_ASKPASS|HOME|XDG_CONFIG_HOME)=/;

const refused = (reason: GitEntryFacts["reason"]): PreparedGitEntries => ({
  facts: { version: 1, status: "unsupported", reason, entries: [], authority: "none" },
});

/**
 * Candidate working folders for each Git segment of a compound command: the call's folder plus
 * every literal `cd` target seen so far (over-inclusive, so a subshell cannot hide a repository).
 */
function invocations(
  analysis: CommandAnalysis,
  cwd: string,
  home: string | undefined,
  path: typeof posix,
): GitEntryInvocation[] | "dynamic" {
  const folders = [cwd];
  let current = cwd;
  const result: GitEntryInvocation[] = [];
  for (const command of analysis.commands) {
    if (command.program === "cd" || command.program === "pushd") {
      const target = command.args.find((arg) => !arg.startsWith("-"));
      if (target !== undefined && (!target || /[$`]/.test(target))) return "dynamic";
      // A runner's command HOME is its own; "~" there cannot be resolved from this machine.
      if ((target ?? "~").startsWith("~") && !home) return "dynamic";
      current = path.resolve(current, home ? expandHome(target ?? "~", home) : (target as string));
      if (!folders.includes(current)) folders.push(current);
      continue;
    }
    if (!GIT.test(command.program)) continue;
    for (const folder of folders) result.push({ args: command.args, cwd: folder });
  }
  return result;
}

/**
 * Before an ordinary command that runs Git, find the project hooks / executable config
 * entries it would run. Returns undefined when no Git runs or nothing would be run.
 */
export async function prepareRunGitEntries(
  local: LocalService,
  context: ToolRunContext,
  args: RunCommandArgs,
  workplace: ResolvedWorkplace,
  analysis: CommandAnalysis,
  signal: AbortSignal,
  callId: string,
): Promise<PreparedGitEntries | undefined> {
  const location = workplace.boundary.location;
  const remote = !!location?.target && location.target !== "local";
  const platform = (remote ? location?.platform : undefined) ?? local.deps.platform;
  // The Bash analyzer cannot bind Windows quoting and path separators for a no-card read.
  const windowsGit = platform === "win32" ? windowsReadShape(args.command)?.git : undefined;
  if (!windowsGit?.length && !analysis.commands.some((command) => GIT.test(command.program)))
    return undefined;
  // Indirect Git (scripts, package managers) is not visible here.
  if (LAYOUT_ENV.test(args.command)) return refused("dynamic");
  const path = platform === "win32" ? win32 : posix;
  // Maintainers 2026-11-06: runners get the same check, scanned on the runner where the repo lives.
  const target = remote ? local.targetFor(location) : undefined;
  if (remote && !target?.inspectGitEntries) return refused("unsupported_target");
  const home = remote ? undefined : workplace.home;
  const cwd = target
    ? (await target.canonicalizePath(args.cwd ?? workplace.cwd, workplace.cwd, signal)).path
    : await canonicalPath(expandHome(args.cwd ?? workplace.cwd, workplace.home), workplace.cwd);
  const literal = analysis.literalCommand && GIT.test(analysis.literalCommand.program);
  const found = windowsGit?.length
    ? windowsGit.map((args) => ({ args, cwd }))
    : literal
      ? [{ args: analysis.literalCommand?.args ?? [], cwd }]
      : invocations(analysis, cwd, home, path);
  if (found === "dynamic") return refused("dynamic");
  if (!found.length) return undefined;
  const request = {
    invocations: found.map((item) => ({
      args: item.args,
      cwd: path.isAbsolute(item.cwd) ? item.cwd : path.join(cwd, item.cwd),
    })),
    compound: !literal,
    callId,
    command: args.command,
    ...(windowsGit?.length ? { windowsReadRoots: workplace.boundary.readRoots } : {}),
  };
  const scan = target?.inspectGitEntries
    ? await target.inspectGitEntries(request, signal).catch((error: unknown) => {
        signal.throwIfAborted();
        // A runner that cannot scan (older build, refused folder) cannot bind what Git would run.
        if (error instanceof RpcError) return undefined;
        throw error;
      })
    : await inspectGitEntries(
        {
          ...request,
          botHome: workplace.home,
          platform: local.deps.platform,
          env: local.deps.env,
          privateTempRoot: local.deps.tempDir,
        },
        signal,
      );
  if (!scan) return refused("unsupported_target");
  if (scan.status === "none") return { plan: scan.plan };
  // Runner output crosses a trust boundary: validate before policy sees it.
  const facts = GitEntryFactsSchema.parse(scan.facts);
  if (scan.status === "unsupported") return { facts };
  // Owner decision Q2: nobody can answer the card here, or the host cannot re-check at launch.
  if (
    platform === "win32" ||
    args.background ||
    args.docker ||
    args.outsideSandbox ||
    context.routineRunId ||
    context.routineWorkplace ||
    context.routineSource ||
    context.routineResume
  )
    return refused("unsupported_target");
  return { facts, plan: scan.plan };
}

export function gitEntriesFingerprint(value: PreparedGitEntries | undefined) {
  if (!value) return undefined;
  return (
    value.facts ?? (value.plan?.windowsReadScopeVerified ? "windows_read_scope_verified" : "none")
  );
}

/**
 * Re-checked on every dispatch assertion, including the last one right before the process
 * starts: a confirmable plan needs this call's own human answer to the forced card, and every
 * bound hook / config path must still be exactly what the card showed.
 */
export function gitEntriesCurrent(prepared: PreparedTool): boolean {
  const entries = prepared.gitEntries;
  if (!entries) return true;
  const command = prepared.call.input.command;
  const plan = entries.plan;
  return (
    (entries.facts === undefined || entries.facts.status === "confirmation-required") &&
    prepared.call.tool === "run_command" &&
    typeof command === "string" &&
    !!plan &&
    plan.callId === prepared.call.id &&
    plan.command === command &&
    plan.facts?.digest === entries.facts?.digest &&
    // A runner-held plan is re-checked by the runner right before spawn (runner host); this
    // process can only confirm the handle still names this call.
    (plan.remotePlanId !== undefined ||
      gitEntryPlanCurrent(plan, { id: prepared.call.id, command }))
  );
}

/** The human answer itself; checked once before dispatch, not at every assertion. */
export function assertGitEntriesConfirmed(prepared: PreparedTool) {
  if (!prepared.gitEntries) return;
  if (!prepared.gitEntries.facts) {
    if (!gitEntriesCurrent(prepared)) throw new ExecError("authorization_changed");
    return;
  }
  if (
    !gitEntriesCurrent(prepared) ||
    prepared.confirmedNow !== true ||
    prepared.result.decision !== "ask" ||
    prepared.result.reason !== GIT_ENTRY_CONFIRMATION_REASON ||
    prepared.result.risk !== "danger" ||
    prepared.result.canRemember ||
    prepared.result.grantScope
  )
    throw new ExecError("authorization_changed");
}
