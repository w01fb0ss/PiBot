import { OutsideCommandPatternsSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { neutralStdinFilter } from "./stdin-filter.ts";
import type { CommandAnalysis, CommandInvocation, Platform } from "./types.ts";

/** A person confirms each run outside the sandbox; nothing may answer it for them. */
export const OUTSIDE_SANDBOX_REASON = "outside_sandbox_once";
/** A command the user listed in settings; asked the same way, every time. */
export const LISTED_OUTSIDE_SANDBOX_REASON = "sandbox_outside_command";
export const LOCAL_SERVICE_REASON = "local_service_once";

/** Brain's pure facts about whether this call may leave the sandbox; policy alone decides. */
export const OutsideSandboxFactsSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("eligible"),
    /** This run's same command in the same folder was just blocked by the sandbox. */
    blockRecorded: z.boolean(),
    listed: OutsideCommandPatternsSchema,
    automatic: OutsideCommandPatternsSchema.optional(),
    systemService: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,128}$/)
      .optional(),
    localService: z
      .strictObject({ kind: z.literal("local_service"), rule: z.string(), target: z.string() })
      .optional(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["strict", "unsupported"]),
  }),
]);
export type OutsideSandboxFacts = z.infer<typeof OutsideSandboxFactsSchema>;

function programName(program: string, platform: Platform) {
  const base = program.replaceAll("\\", "/").split("/").at(-1) ?? program;
  return platform === "win32" ? base.toLowerCase().replace(/\.exe$/, "") : base;
}

// Semantic unknowns (what an unlisted program does) are fine: the user listed the program by
// name. Syntactic ones (expansions, assignments, budget cut-offs) mean the words are not known.
const SYNTAX_KNOWN = new Set(["unknown_or_mutating_program", "unknown_option"]);

/**
 * `2>&1`, `>&2`, `2>&-`: descriptor duplication opens no file (policy's redirect analysis already
 * treats it so). Stripped before the `&` check below; anything else with `&` stays sandboxed.
 */
const FD_DUPLICATION = /(?<![\w&])\d*[<>]&(?:\d+|-)(?=[\s|;)]|$)/g;

/** Syntax that keeps a line from being read as "these programs, connected by pipes". */
function opaque(command: string, analysis: CommandAnalysis) {
  return (
    !analysis.commands.length ||
    !analysis.warnings.every((warning) => SYNTAX_KNOWN.has(warning)) ||
    // Analysis does not model `&`; any `&` other than `&&` and descriptor duplication stays
    // sandboxed (backgrounding, `&>file`, `|&` piping stderr into something).
    command.replaceAll("&&", "").replace(FD_DUPLICATION, "").includes("&")
  );
}

/**
 * A later pipeline stage that only filters what the previous stage printed. Its command word must
 * itself be one of the filter programs, spelled bare: no wrapper (`env head`, `nice head`, `xargs
 * head` run another program first), no path (`/tmp/head` is whatever that file is), no quoting.
 * Execution resolves the name to a system directory at dispatch and pins that word to the
 * absolute path in the line it runs. No stage may take stdin from a file, here-string or
 * here-document: `| cat < /etc/hosts` reads a file, not the pipe.
 */
function filterStage(
  analysis: CommandAnalysis,
  index: number,
  invocation: CommandInvocation,
  platform: Platform,
) {
  if (analysis.inputRedirect || /[/\\]/.test(invocation.program)) return undefined;
  const candidate = analysis.filterCandidates?.find((stage) => stage.index === index);
  return candidate && neutralStdinFilter(invocation, programName(invocation.program, platform))
    ? candidate
    : undefined;
}

/** A filter stage execution must resolve and pin: its program and command word's offsets. */
export interface ListedFilter {
  program: string;
  start: number;
  end: number;
}

/**
 * Every command of a compound line must match a listed shape; redirects to files, expansions,
 * shell backgrounding and anything analysis could not read literally keep the whole line
 * sandboxed (as Claude Code does). Two harmless extras are allowed that made listed
 * commands fall back into the sandbox: descriptor duplication (`2>&1`), and later pipeline
 * stages that only filter stdin with no file operands (`| head -20`, see stdin-filter.ts). At
 * least one stage must still be a listed program; a line of filters alone is not "listed".
 * Returns the filter programs execution must verify at dispatch, or undefined when not listed.
 */
export function listedOutsideFilters(
  command: string,
  analysis: CommandAnalysis | undefined,
  patterns: readonly string[],
  platform: Platform,
): ListedFilter[] | undefined {
  if (!patterns.length || !analysis || analysis.fileRedirect || opaque(command, analysis))
    return undefined;
  const shapes = patterns.map((pattern) => {
    const words = pattern.trim().split(" ");
    const open = words.at(-1) === "*";
    return { program: words[0] as string, args: words.slice(1, open ? -1 : undefined), open };
  });
  const listed = (invocation: CommandInvocation) =>
    shapes.some(
      (shape) =>
        programName(invocation.program, platform) === shape.program &&
        (shape.open
          ? invocation.args.length >= shape.args.length
          : invocation.args.length === shape.args.length) &&
        shape.args.every((arg, index) => invocation.args[index] === arg),
    );
  let matched = false;
  const filters: ListedFilter[] = [];
  for (const [index, invocation] of analysis.commands.entries()) {
    if (listed(invocation)) {
      matched = true;
      continue;
    }
    const stage = filterStage(analysis, index, invocation, platform);
    if (!stage) return undefined;
    filters.push({ program: invocation.program, start: stage.start, end: stage.end });
  }
  return matched ? filters : undefined;
}

export function listedOutsideCommand(
  command: string,
  analysis: CommandAnalysis | undefined,
  patterns: readonly string[],
  platform: Platform,
) {
  return listedOutsideFilters(command, analysis, patterns, platform) !== undefined;
}

/**
 * The one program whose output a line reports — a single pipeline whose later stages
 * are only stdin filters (`printf 'aws'` or `aws --version && false` has no such program).
 * Login phrases and exit status are attributable only with ownsStatus: filters can print their
 * own errors, `!` inverts status, and opening a redirected file can fail before aws even starts.
 */
export function soleInvokedProgram(
  command: string,
  analysis: CommandAnalysis | undefined,
  platform: Platform,
): { program: string; ownsStatus: boolean } | undefined {
  if (!analysis || opaque(command, analysis)) return undefined;
  let sole: CommandInvocation | undefined;
  for (const [index, invocation] of analysis.commands.entries()) {
    if (index > 0 && filterStage(analysis, index, invocation, platform)) continue;
    if (sole || (analysis.pipedCommands ?? []).includes(index)) return undefined;
    sole = invocation;
  }
  if (!sole) return undefined;
  return {
    program: programName(sole.program, platform),
    ownsStatus:
      analysis.commands.length === 1 &&
      !analysis.negated &&
      !analysis.pipedCommands?.length &&
      !analysis.outputRedirect &&
      !analysis.fileRedirect &&
      !analysis.inputRedirect,
  };
}

export type OutsideSandboxDecision =
  | { decision: "deny"; reason: string }
  | {
      decision: "ask";
      reason:
        | typeof OUTSIDE_SANDBOX_REASON
        | typeof LISTED_OUTSIDE_SANDBOX_REASON
        | typeof LOCAL_SERVICE_REASON;
    }
  | undefined;

export function outsideSandboxDecision(
  requested: boolean,
  facts: OutsideSandboxFacts | undefined,
  command: string,
  analysis: CommandAnalysis | undefined,
  platform: Platform,
): OutsideSandboxDecision {
  if (facts?.status !== "eligible")
    return requested
      ? { decision: "deny", reason: `outside_sandbox_${facts?.reason ?? "unsupported"}` }
      : undefined;
  // A listed command needs no earlier block; its card names the setting instead.
  if (listedOutsideCommand(command, analysis, facts.listed, platform))
    return { decision: "ask", reason: LISTED_OUTSIDE_SANDBOX_REASON };
  if (!requested) return undefined;
  return facts.blockRecorded
    ? { decision: "ask", reason: OUTSIDE_SANDBOX_REASON }
    : { decision: "deny", reason: "outside_sandbox_no_block" };
}

/** Never infer launcher/ interpreter semantics or persist user arguments. */
export function automaticOutsideShape(
  command: string,
  analysis: CommandAnalysis | undefined,
  platform: Platform,
) {
  if (
    !analysis ||
    opaque(command, analysis) ||
    analysis.commands.length !== 1 ||
    analysis.fileRedirect ||
    analysis.inputRedirect ||
    analysis.outputRedirect ||
    analysis.negated ||
    analysis.pipedCommands?.length ||
    /[|;&\n\r]/.test(command)
  )
    return;
  const invocation = analysis.commands[0];
  if (!invocation || !/^[a-z][a-z0-9-]*$/.test(invocation.program)) return;
  const allowed: Record<string, readonly string[]> = {
    pnpm: ["install", "add", "remove", "update", "rebuild"],
    npm: ["install", "ci", "update", "rebuild"],
    yarn: ["install", "add", "remove", "upgrade"],
    git: ["commit", "clone", "fetch", "pull", "push", "init"],
    docker: ["compose", "build", "pull", "push"],
  };
  const program = programName(invocation.program, platform);
  const subcommand = invocation.args[0];
  return subcommand &&
    command.trimStart().startsWith(`${program} ${subcommand}`) &&
    allowed[program]?.includes(subcommand)
    ? `${program} ${subcommand} *`
    : undefined;
}

/** Fixed commands still require the existing one-shot outside-sandbox approval. */
export function fixedOutsideCommand(analysis: CommandAnalysis | undefined, platform: Platform) {
  // These programs are exactly the ones the analyzer does not know, so its semantic unknowns are
  // expected; syntactic ones (expansions, substitutions, budget cut-offs) still keep the line out.
  if (
    !analysis ||
    analysis.commands.length !== 1 ||
    !analysis.warnings.every((warning) => SYNTAX_KNOWN.has(warning))
  )
    return false;
  const invocation = analysis.commands[0];
  if (!invocation || /[/\\]/.test(invocation.program)) return false;
  const program = programName(invocation.program, platform);
  const subcommand = invocation.args[0];
  if (
    [
      "aws",
      "gh",
      "gcloud",
      "az",
      "kubectl",
      "docker",
      "terraform",
      "pulumi",
      "ssh",
      "scp",
      "rsync",
    ].includes(program)
  ) {
    if (["ssh", "scp", "rsync"].includes(program)) return true;
    return program === "docker" ? subcommand !== "run" : true;
  }
  if (program === "brew" && ["install", "upgrade"].includes(subcommand ?? "")) return true;
  if (program === "git" && ["push", "pull", "fetch", "clone"].includes(subcommand ?? ""))
    return invocation.args.some((arg) => /^ssh(?:[+:]|:\/\/)/i.test(arg));
  return false;
}

/** Exact folder identity, never a prefix or a parent-folder grant. */
export function automaticOutsidePatterns(
  entries: readonly { pattern: string; folder: string; source: "auto" | "user" }[],
  folder: string,
) {
  return (
    entries
      // rc2 saved some one-time approvals automatically. Only explicit choices carry forward.
      .filter((entry) => entry.source === "user" && entry.folder === folder)
      .map((entry) => entry.pattern)
      .slice(0, 32)
  );
}
