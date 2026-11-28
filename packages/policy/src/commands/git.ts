import { posix } from "node:path";
import { networkTarget } from "../targets/network-target.ts";
import { type ArgumentFacts, countShorthand, optionFacts } from "./argument-types.ts";
import { gitCommandOptions, gitGlobalOptions } from "./options/git-options.ts";
import { optionValues, parseOptions } from "./options/options.ts";

const readonlyCommands = new Set(["status", "log", "diff", "show", "ls-files"]);
// Queries whose operands are revisions or patterns, never paths; they only read .git.
const revisionQueries = new Set(["rev-parse", "branch"]);
const revision = /^(?!-)[\w./@{}~^-]+$/;
// Named, non-secret scalar queries only. --list/unknown keys must not expose credentials or includes.
const readableConfig = new Set([
  "user.name",
  "user.email",
  "init.defaultbranch",
  "core.repositoryformatversion",
  "core.bare",
  "core.filemode",
  "core.ignorecase",
  "core.logallrefupdates",
]);
export function gitFacts(
  args: string[],
  paths: Pick<typeof posix, "isAbsolute"> = posix,
): ArgumentFacts {
  const global = parseOptions(args, gitGlobalOptions);
  const [subcommand = "", ...given] = global.operands;
  const rest = subcommand === "log" || subcommand === "show" ? countShorthand(given) : given;
  const spec = Object.hasOwn(gitCommandOptions, subcommand)
    ? gitCommandOptions[subcommand]
    : undefined;
  const parsed = parseOptions(rest, spec ?? {});
  let root = ".";
  for (const path of optionValues(global, "-C"))
    root = paths.isAbsolute(path) || path.startsWith("~") ? path : `${root}/${path}`;
  const atRoot = (path: string) =>
    paths.isAbsolute(path) || path.startsWith("~") ? path : `${root}/${path}`;
  const result = optionFacts(parsed);
  const metadata = global.reads;
  result.reads = [root, ...metadata, ...parsed.reads.map(atRoot)];
  result.writes = parsed.writes.map(atRoot);
  result.unknownOptions.unshift(...global.unknownOptions);
  result.incomplete ||= !spec || global.unknown || metadata.length > 0 || global.values.has("-c");
  if (
    optionValues(global, "--attr-source").some(
      (oid) => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid),
    )
  )
    result.incomplete = true;
  result.network = ["clone", "fetch", "pull", "push"].includes(subcommand);
  if (result.network)
    result.domains.push(
      ...parsed.operands.map(networkTarget).filter((host): host is string => !!host),
    );
  // --file is a value option, so it lives in parsed.values rather than parsed.flags.
  const fileScope = optionValues(parsed, "--file").length > 0;
  const configRead =
    subcommand === "config" &&
    parsed.operands.length === 1 &&
    readableConfig.has((parsed.operands[0] ?? "").toLowerCase()) &&
    [...parsed.flags].every((flag) =>
      ["--global", "--system", "--local", "--get", "--get-all"].includes(flag),
    ) &&
    ["--global", "--system", "--local"].filter((flag) => parsed.flags.has(flag)).length +
      (fileScope ? 1 : 0) <=
      1 &&
    optionValues(parsed, "--file").length <= 1 &&
    !parsed.incomplete;
  // `git branch` lists only without operands (or with --list patterns); with one it creates.
  const revisionQuery =
    revisionQueries.has(subcommand) &&
    !parsed.incomplete &&
    parsed.operands.every((arg) => revision.test(arg)) &&
    (subcommand !== "branch" || !parsed.operands.length || parsed.flags.has("--list"));
  // Only explicit stdout export: every file-output/dynamic option remains unknown.
  const stdoutPatch =
    subcommand === "format-patch" &&
    parsed.flags.has("--stdout") &&
    !parsed.incomplete &&
    parsed.operands.length === 1 &&
    parsed.operands.every((arg) => revision.test(arg)) &&
    !rest.includes("--");
  const readOnly = readonlyCommands.has(subcommand) || configRead || revisionQuery || stdoutPatch;
  if (configRead) {
    result.writes = [];
    result.reads.push(...optionValues(parsed, "--file").map(atRoot));
    if (parsed.flags.has("--global")) result.reads.push("~/.gitconfig");
    else if (parsed.flags.has("--system")) result.reads.push("/etc/gitconfig");
    else if (!fileScope) result.reads.push(atRoot(".git/config"));
  }
  if (parsed.values.has("-L")) result.incomplete = true;
  const separator = rest.indexOf("--");
  if (subcommand === "diff" && parsed.flags.has("--no-index")) {
    result.reads.push(...parsed.operands.map(atRoot));
    if (parsed.operands.length !== 2) result.incomplete = true;
  } else if (revisionQuery) {
    // Revisions and branch patterns name refs inside .git, which `root` already covers.
  } else if (readOnly && !configRead) {
    if (separator >= 0) result.reads.push(...rest.slice(separator + 1).map(atRoot));
    const paths = new Set(separator >= 0 ? rest.slice(separator + 1) : []);
    for (const arg of parsed.operands) {
      if (paths.has(arg) || /^(?:HEAD|[0-9a-f]{7,40})(?:[~^]\d*)?$/.test(arg)) continue;
      result.reads.push(atRoot(arg));
      // A literal revision/range can also name an in-tree path. Record that possible read,
      // but the ambiguity does not make the query a write; policy still resolves its boundary.
      if (subcommand !== "status" && subcommand !== "ls-files" && !revision.test(arg))
        result.incomplete = true;
    }
  } else if (!configRead) {
    result.writes.push(root, ...metadata);
    if (["clean", "add"].includes(subcommand)) result.writes.push(...parsed.operands.map(atRoot));
    if (subcommand === "init") {
      result.writes.push(...parsed.operands.map(atRoot));
      if (parsed.operands.length > 1) result.incomplete = true;
      result.reads = result.reads.filter((path) => path !== `${root}/`);
    }
    if (subcommand === "config" && parsed.flags.has("--global")) result.writes.push("~/.gitconfig");
    if (subcommand === "config" && parsed.flags.has("--system"))
      result.writes.push("/etc/gitconfig");
    if (subcommand === "clone" && parsed.operands.length > 1)
      result.writes.push(atRoot(parsed.operands.at(-1) as string));
  }
  result.readonly = readOnly && parsed.readonly && !result.incomplete && !result.writes.length;
  return result;
}
