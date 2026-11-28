// Prove the small set of Windows command shapes that need no consent to run without isolation.
import { win32 } from "node:path";
import { gitFacts } from "./git.ts";
import { isOutputTarget } from "./output-targets.ts";
import { powershellSegments } from "./powershell-segments.ts";

type Read = {
  path: string;
  category: "read_file" | "list_dir";
  enumerates?: boolean;
  recurse?: boolean;
  recurseByName?: boolean;
  readEntries?: boolean;
  gitDirectories?: readonly string[];
  gitDiffPath?: boolean;
  gitContent?: boolean;
};

type GitRead = { args: string[]; reads: Read[] };
const child = /^(?:get-childitem|gci|ls|dir)$/;
const content = /^(?:get-content|gc|cat|type)$/;
const item = /^(?:get-item|resolve-path|test-path)$/;
const location = /^(?:get-location|pwd)$/;
const plain = /^[\p{L}\p{M}\p{N}_.+:/\\-]+$/u;
const quoted = /^(?:'([\p{L}\p{M}\p{N}_.+:/\\ -]+)'|"([\p{L}\p{M}\p{N}_.+:/\\ -]+)")$/u;
const measure = /^(?:measure-object|measure)$/;
const measureSwitch =
  /^-(?:average|sum|maximum|minimum|standarddeviation|allstats|line|word|character|ignorewhitespace)$/i;
const gitProgram = /^git(?:\.exe)?$/;
const gitQueries = new Set(["status", "log", "diff", "show", "branch", "rev-parse"]);
const gitGlobals = new Set([
  "--no-pager",
  "--no-optional-locks",
  "--no-replace-objects",
  "--literal-pathspecs",
]);
const versionTools = new Set([
  "node",
  "npm",
  "git",
  "python",
  "python3",
  "uv",
  "ruby",
  "deno",
  "bun",
  "java",
]);
// Some otherwise supported tools use -v for verbose mode (e.g. Python starts an interpreter).
const shortVersionTools = new Set(["node", "npm", "git", "bun"]);
const lookupName = /^[a-z0-9][a-z0-9_.-]*$/i;

type UserPathVariable = "username" | "onedrive" | "homedrive" | "homepath";
export type WindowsUserPaths = Partial<Record<UserPathVariable, string>>;

/** Bind a single PowerShell path operand to host facts before the policy proves the command. */
export function windowsUserReadCommand(command: string, home: string, paths: WindowsUserPaths) {
  const { pieces, unclosed, tooLong } = powershellSegments(command);
  const tokens = pieces[0]?.tokens;
  if (unclosed || tooLong || pieces.length !== 1 || !tokens) return;
  const [program = "", ...args] = tokens;
  const name = program.toLowerCase();
  if (!child.test(name) && !content.test(name) && !item.test(name)) return;
  if (args.length === 2 && /^-(?:path|literalpath)$/i.test(args[0] ?? "")) args.shift();
  const operand = args[0] ?? "";
  if (args.length !== 1) return;
  const quotedOperand = /^(?:"([^"]+)"|'(~[\\/][^']*)')$/.exec(operand)?.slice(1).find(Boolean);
  const raw = quotedOperand ?? operand;
  if (
    !/^[\p{L}\p{M}\p{N}_.+:/$~\\ -]+$/u.test(raw) ||
    (operand.startsWith("'") && raw.includes("$"))
  )
    return;
  let missing = false;
  const expanded = raw
    .replace(/^~(?=[\\/]|$)/, () => home)
    .replace(/\$env:([\p{L}\p{M}\p{N}_:]+)|\$([\p{L}\p{M}\p{N}_:]+)/giu, (_match, env, local) => {
      const key = typeof env === "string" ? env.toLowerCase() : "";
      const value =
        key === "userprofile" || (!key && String(local).toLowerCase() === "home")
          ? home
          : Object.hasOwn(paths, key)
            ? paths[key as UserPathVariable]
            : undefined;
      if (!value) missing = true;
      return value ?? "";
    });
  if (missing || expanded === raw || !/^[a-z]:[\\/]/i.test(expanded)) return;
  return literalWindowsReadCommand(name, expanded);
}

export function literalWindowsReadCommand(program: string, path: string) {
  const operand = `'${path}'`;
  if (windowsLiteralToken(operand) !== path || !windowsLiteralPath(path)) return;
  return `${program} -LiteralPath ${operand}`;
}

export function windowsLiteralToken(token: string) {
  if (plain.test(token)) return token;
  const match = quoted.exec(token);
  return match?.[1] ?? match?.[2];
}

export function windowsLiteralPath(value: string, allowParent = false) {
  const local = value.replace(/^[a-z]:[\\/]/i, "");
  return (
    !/^[\\/]/.test(value) &&
    !/[:*?~[\]]/.test(local) &&
    local
      .split(/[\\/]/)
      .every(
        (part) =>
          part === "." ||
          (allowParent && part === "..") ||
          (part !== ".." &&
            !/[. ]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)),
      )
  );
}

function versionProbe(program: string, args: string[]) {
  const name = program.replace(/\.exe$/, "");
  return (
    args.length === 1 &&
    ((args[0] === "--version" && versionTools.has(name)) ||
      (args[0] === "-v" && shortVersionTools.has(name)))
  );
}

function gitRead(raw: string[]): GitRead | undefined {
  // Quoting or escaping inside a token could give PowerShell and Git different argv.
  // Carets are already excluded by the shell shape filter.
  const args = raw.map(
    (arg) => windowsLiteralToken(arg) ?? (/^[\w.=+:/\\~-]+$/.test(arg) ? arg : ""),
  );
  if (args.some((arg) => !arg)) return;
  if (args.some((arg, index) => arg.startsWith("-") && arg !== raw[index])) return;
  if (versionProbe("git", args)) return { args, reads: [] };
  const gitDirectories: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index++] ?? "";
    if (gitGlobals.has(arg)) continue;
    if (arg !== "-C") {
      index--;
      break;
    }
    const directory = args[index++];
    if (!directory || !windowsLiteralPath(directory, true)) return;
    gitDirectories.push(directory);
  }
  const [query = "", ...rest] = args.slice(index);
  if (query === "remote" && rest.length === 1 && /^(?:-v|--verbose)$/.test(rest[0] ?? ""))
    return { args, reads: [{ path: ".", category: "list_dir", gitDirectories }] };
  if (!gitQueries.has(query)) return;
  // No-index diff can recursively read directory operands, unlike a repository pathspec.
  if (
    rest.some((arg) =>
      /^(?:-c|--(?:config|output|ext-diff|textconv|paginate|no-index)|difftool)/.test(arg),
    )
  )
    return;
  const facts = gitFacts([query, ...rest], win32);
  if (!facts.readonly) return;
  const [root, ...paths] = facts.reads;
  if (root !== "." || paths.some((path) => !windowsLiteralPath(path))) return;
  // Patch and object output can include file contents even without a path operand.
  const gitContent = query === "diff" || query === "show" || query === "log";
  return {
    args,
    reads: [
      { path: root, category: "list_dir", gitDirectories, gitContent },
      ...paths.map(
        (path): Read => ({
          path,
          category: "read_file",
          gitDirectories,
          ...(query === "diff" ? { gitDiffPath: true } : {}),
        }),
      ),
    ],
  };
}

function pathRead(program: string, args: string[]): Read | undefined {
  const category = child.test(program) || item.test(program) ? "list_dir" : "read_file";
  const values = [...args];
  const enumerates = child.test(program);
  const recurse = enumerates && values[0]?.toLowerCase() === "-recurse";
  if (recurse) values.shift();
  const literalPath = values[0]?.toLowerCase() === "-literalpath";
  if (/^-(?:path|literalpath)$/i.test(values[0] ?? "")) {
    values.shift();
    if (!values.length) return undefined;
  }
  if (!values.length && enumerates) return { path: ".", category, enumerates, recurse };
  if (values.length !== 1) return undefined;
  const token = values[0] ?? "";
  const path = windowsLiteralToken(token);
  if (!path || token.startsWith("-") || !windowsLiteralPath(path)) return undefined;
  return { path, category, enumerates, recurse, recurseByName: recurse && !literalPath };
}

/**
 * `Select-String` with named parameters reads the same way as its positional form: one literal
 * pattern and, unless piped, one literal path. Only plain matching switches are accepted.
 */
function namedSelectString(args: string[], piped: boolean) {
  let pattern: string | undefined;
  let path: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const name = args[index]?.toLowerCase() ?? "";
    if (/^-(?:simplematch|casesensitive)$/.test(name)) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-") || !windowsLiteralToken(value)) return;
    index++;
    if (name === "-pattern" && pattern === undefined) pattern = value;
    else if (/^-(?:path|literalpath)$/.test(name) && path === undefined && !piped) path = value;
    else return;
  }
  if (pattern === undefined || (!piped && path === undefined)) return;
  return { path };
}

function readSegment(program: string, args: string[], piped: boolean): Read[] | undefined {
  if (measure.test(program) && args.every((arg) => measureSwitch.test(arg))) return [];
  if (piped) {
    if (
      program === "select-string" &&
      args.length === 1 &&
      windowsLiteralToken(args[0] ?? "") &&
      !args[0]?.startsWith("-")
    )
      return [];
    if (program === "select-string" && args[0]?.startsWith("-") && namedSelectString(args, true))
      return [];
    return undefined;
  }
  if (child.test(program) || content.test(program) || item.test(program)) {
    const read = pathRead(program, args);
    return read ? [read] : undefined;
  }
  if ((location.test(program) || program === "get-date") && !args.length) return [];
  if (versionProbe(program, args)) return [];
  if (
    /^(?:echo|write-output)$/.test(program) &&
    args.every(
      (arg) => (windowsLiteralToken(arg) || /^(?:''|"")$/.test(arg)) && !arg.startsWith("-"),
    )
  )
    return [];
  if (
    program === "get-command" &&
    (!args.length ||
      ((args.length === 1 ||
        (args.length === 2 && /^-(?:listimported|name)$/i.test(args[0] ?? ""))) &&
        lookupName.test(args.at(-1) ?? "")))
  )
    return [];
  if (program === "where.exe" && args.length > 0 && args.every((arg) => lookupName.test(arg)))
    return [];
  if (
    program === "select-string" &&
    args.length === 2 &&
    windowsLiteralToken(args[0] ?? "") &&
    !args[0]?.startsWith("-")
  ) {
    const read = pathRead(program, args.slice(1));
    return read ? [read] : undefined;
  }
  if (program === "select-string" && args[0]?.startsWith("-")) {
    const named = namedSelectString(args, false);
    const read = named?.path === undefined ? undefined : pathRead(program, [named.path]);
    return read ? [read] : undefined;
  }
  return undefined;
}

function cmdRead(args: string[]): Read[] | undefined {
  // Execution pins cmd.exe and supplies /d for the /c form to suppress inherited AutoRun.
  const [execute, ...body] = args[0]?.toLowerCase() === "/d" ? args.slice(1) : args;
  if (execute?.toLowerCase() !== "/c") return undefined;
  const quotedBody =
    body.length === 1
      ? /^"([a-z0-9_.:+/\\ -]+?)(?: > ([a-z]+))?"$/i.exec(body[0] ?? "")
      : undefined;
  const command =
    quotedBody && (!quotedBody[2] || isOutputTarget(quotedBody[2], "win32"))
      ? (quotedBody[1] ?? "").trim().split(/ +/)
      : body;
  const [name, ...operands] = command;
  if (!operands.every((arg) => /^[a-z0-9_.:+/\\-]+$/i.test(arg))) return undefined;
  const program = name?.toLowerCase();
  if (program === "echo" && operands.every((arg) => !/[/\\:]/.test(arg))) return [];
  if (
    /^where(?:\.exe)?$/.test(program ?? "") &&
    operands.length &&
    operands.every((arg) => lookupName.test(arg))
  )
    return [];
  if (program !== "dir" && program !== "type") return undefined;
  if (operands.some((arg) => /^[/-]/.test(arg))) return undefined;
  const read = pathRead(program, operands);
  return read ? [read] : undefined;
}

function withoutNullSink(tokens: string[]) {
  if (tokens.length >= 3 && tokens.at(-2) === ">" && /^\$null$/i.test(tokens.at(-1) ?? ""))
    return tokens.slice(0, -2);
  return tokens;
}

export function windowsReadShape(command: string) {
  // PowerShell recognizes smart quotes as delimiters. Treat expansion/call syntax and comments
  // as unknown, including line continuations and cmd expansion, before using the shared lexer.
  if (
    /[\u2018-\u201f\x60#%&<^(){}@!*?[\],]|[/\\]{2}|[^\S \t\r\n]|\p{Cc}/u.test(
      command.replaceAll(/[\t\r\n]/g, " "),
    )
  )
    return undefined;
  const parsed = powershellSegments(command);
  if (parsed.unclosed || parsed.tooLong || parsed.pieces.length > 16) return undefined;
  const reads: Read[] = [];
  const git: string[][] = [];
  let guard = false;
  let previousRead = false;
  let pipelineSource: Read | undefined;
  let previousProgram = "";
  for (const { tokens, separator } of parsed.pieces) {
    if (!tokens.length) {
      if (separator === "|") return undefined;
      previousRead = false;
      continue;
    }
    const program = tokens[0]?.toLowerCase() ?? "";
    const cmd = program === "cmd.exe" || program === "cmd";
    const shape = withoutNullSink(tokens);
    const args = shape.slice(1);
    const piped = separator === "|";
    if (piped && (!previousRead || cmd)) return undefined;
    const query = !piped && gitProgram.test(program) ? gitRead(args) : undefined;
    const found = query ? query.reads : cmd ? cmdRead(args) : readSegment(program, args, piped);
    if (!found) return undefined;
    if (query) git.push(query.args);
    guard ||=
      !!query ||
      cmd ||
      versionProbe(program, args) ||
      (program === "get-command" && args[0]?.toLowerCase() !== "-listimported") ||
      program === "where.exe";
    if (piped && program === "select-string") {
      if (pipelineSource?.enumerates) pipelineSource.readEntries = true;
      else if (
        pipelineSource?.category !== "read_file" &&
        !/^(?:echo|write-output|git(?:\.exe)?)$/.test(previousProgram)
      )
        return undefined;
    }
    pipelineSource = found.at(-1);
    previousProgram = program;
    reads.push(...found);
    previousRead = true;
  }
  const singlePathProgram =
    parsed.pieces.length === 1 &&
    parsed.pieces[0]?.tokens.at(-2) !== ">" &&
    reads.length === 1 &&
    !reads[0]?.recurse &&
    (child.test(previousProgram) || content.test(previousProgram) || item.test(previousProgram))
      ? previousProgram
      : undefined;
  return previousRead || reads.length ? { reads, git, guard, singlePathProgram } : undefined;
}
