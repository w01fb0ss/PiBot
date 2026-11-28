// A command that runs a script file is judged by what the script contains, not by the
// bare interpreter name. The analyser asks for the file on a first pass (scriptFiles); the async
// caller reads it (inside the workplace, bounded) and analyses again with the text. Anything this
// cannot read or prove stays as before: the run asks, every time.
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { CommandInvocation } from "../core/types.ts";
import { PURE_CODE_MAX, type PureLanguage } from "./script-purity.ts";

export { pureCode } from "./script-purity.ts";
export const SCRIPT_MAX_BYTES = PURE_CODE_MAX;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PYTHON = /^python(?:\d+(?:\.\d+)?)?$/u;
const LUA = /^(?:lua(?:\d+(?:\.\d+)?)?|luajit)$/u;
const POWERSHELL = /^(?:pwsh|powershell)(?:\.exe)?$/iu;

export type ScriptLanguage = "shell" | PureLanguage;
export interface ScriptSource {
  text: string;
  /** The file as the command names it (cwd-joined, links not followed): what execution re-reads. */
  path?: string;
  /** SHA-256 of the file's bytes when it was read, for the check right before the run starts. */
  sha256?: string;
  /**
   * Entry names of the directories Python puts first on `sys.path` for this file (its own
   * directory, as written and with links resolved); undefined when they could not be listed.
   */
  neighbours?: readonly string[];
}
/** What the analyser may use besides the command text: read scripts and the cwd's entries. */
export interface ScriptInputs {
  files?: ReadonlyMap<string, ScriptSource>;
  /** Entry names of the command's working directory (`python3 -c` imports from there first). */
  cwdNames?: readonly string[];
}
/** `safePath`: `python3 -I` / `-P` keep the script's directory and the cwd off `sys.path`. */
export type ScriptRun =
  | { kind: "file"; language?: ScriptLanguage; path: string; args: string[]; safePath?: true }
  | { kind: "inline"; language: PureLanguage; code: string; safePath?: true };

/**
 * Interpreters whose only understood shapes are "inline code" (the flag) or "a file and
 * its arguments". Any other option (perl -n / -i, ruby -I, php -d, lua -l) changes what runs or
 * which files are read, so the run is not judged by a script.
 */
const INLINE_FLAGS: Record<string, { language: PureLanguage; flag: string }> = {
  ruby: { language: "ruby", flag: "-e" },
  perl: { language: "perl", flag: "-e" },
  php: { language: "php", flag: "-r" },
};
function plainRun(
  language: PureLanguage,
  flag: string,
  args: readonly string[],
): ScriptRun | undefined {
  const [first, ...rest] = args;
  if (first === flag)
    return rest.length === 1 ? { kind: "inline", language, code: rest[0] as string } : undefined;
  if (!first || first.startsWith("-")) return undefined;
  return { kind: "file", language, path: first, args: rest };
}
// PowerShell: only the switches that change nothing but start-up noise may come first.
function powershellRun(args: readonly string[]): ScriptRun | undefined {
  let i = 0;
  while (/^-(?:NoProfile|NonInteractive|NoLogo)$/iu.test(args[i] ?? "")) i++;
  const first = args[i];
  if (/^-(?:c|Command)$/iu.test(first ?? ""))
    return args.length === i + 2
      ? { kind: "inline", language: "powershell", code: args[i + 1] as string }
      : undefined;
  const file = /^-(?:f|File)$/iu.test(first ?? "") ? args[i + 1] : first;
  const start = /^-(?:f|File)$/iu.test(first ?? "") ? i + 2 : i + 1;
  if (!file || file.startsWith("-")) return undefined;
  return { kind: "file", language: "powershell", path: file, args: args.slice(start) };
}

/** `sh x.sh a b`, `python3 tool.py`, `node -e '…'`, `./run.sh` — the script and its arguments. */
export function scriptRun(program: string, args: readonly string[]): ScriptRun | undefined {
  if (SHELLS.has(program)) {
    // `-c` is the existing nested-shell path; `-s` and other options read stdin or change meaning.
    if (args.some((arg) => arg.startsWith("-"))) return undefined;
    const [path, ...rest] = args;
    return path ? { kind: "file", language: "shell", path, args: rest } : undefined;
  }
  if (PYTHON.test(program)) {
    let i = 0;
    while (i < args.length && /^-[uBOEsIPq]+$/u.test(args[i] ?? "")) i++;
    const safe = args.slice(0, i).some((flag) => /[IP]/u.test(flag))
      ? { safePath: true as const }
      : {};
    const first = args[i];
    if (first === "-c" && args[i + 1] !== undefined)
      return { kind: "inline", language: "python", code: args[i + 1] as string, ...safe };
    if (!first || first.startsWith("-")) return undefined;
    return { kind: "file", language: "python", path: first, args: args.slice(i + 1), ...safe };
  }
  if (program === "node") {
    const first = args[0];
    if ((first === "-e" || first === "--eval") && args[1] !== undefined)
      return { kind: "inline", language: "javascript", code: args[1] };
    if (!first || first.startsWith("-")) return undefined;
    return { kind: "file", language: "javascript", path: first, args: args.slice(1) };
  }
  const inline = Object.hasOwn(INLINE_FLAGS, program) ? INLINE_FLAGS[program] : undefined;
  if (inline) return plainRun(inline.language, inline.flag, args);
  if (LUA.test(program)) return plainRun("lua", "-e", args);
  if (POWERSHELL.test(program)) return powershellRun(args);
  // A path to the script itself (./run.sh, tools/report.py): the shebang names the language.
  if (program.includes("/") && !/^\/(?:usr\/|opt\/)?s?bin\//u.test(program))
    return { kind: "file", path: program, args: [...args] };
  return undefined;
}

/** The literal interpreter and operand a saved skill token may be approved for. */
export function skillTokenScript(invocation: CommandInvocation | undefined) {
  if (!invocation) return undefined;
  const { program, args } = invocation;
  const name = posix.basename(program);
  if (
    (name !== program &&
      !/^\/(?:usr\/(?:local\/)?)?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/.test(program)) ||
    !(name === "node" || PYTHON.test(name) || SHELLS.has(name))
  )
    return undefined;
  const run = scriptRun(name, args);
  return run?.kind === "file" ? run.path : undefined;
}

export function skillInterpreterRuntime(
  program: string | undefined,
): "python" | "node" | undefined {
  if (program === "node") return "node";
  if (program && PYTHON.test(program)) return "python";
}

/** PowerShell is opaque to policy. Identify simple file invocations for runtime selection only. */
export function windowsSkillScript(command: string) {
  const invokesQuotedProgram = /^\s*&\s+/.test(command);
  const words = command
    .replace(/^\s*&\s+/, "")
    .match(/(?:'[^'\r\n]*'|"[^"\r\n]*"|[^\s'"`;&|()<>]+)|\S/gu);
  if (!words?.length || /[\r\n]/.test(command)) return undefined;
  if (!invokesQuotedProgram && /^[\u0027"]/.test(words[0] ?? "")) return undefined;
  const [program, ...args] = words.map((word) => word.replace(/^(['"])(.*)\1$/, "$2"));
  if (!program || /[$%*?{}`]/.test(program)) return undefined;
  const name = win32
    .basename(program)
    .toLowerCase()
    .replace(/\.exe$/, "");
  const run = scriptRun(name, args);
  if (run?.kind === "file" && !/[$%*?{}`;&|()<>]/.test(run.path))
    return { path: run.path, runtime: skillInterpreterRuntime(name) };
  if (/[/\\]/.test(program) && /\.(?:ps1|py|[cm]?js)$/i.test(program)) return { path: program };
}

export function scriptLanguage(
  path: string,
  text: string,
  hint?: ScriptLanguage,
): ScriptLanguage | undefined {
  if (hint) return hint;
  const shebang = text.startsWith("#!");
  const interpreter = shebangProgram(text)?.split("/").at(-1);
  if (interpreter && SHELLS.has(interpreter)) return "shell";
  if (interpreter && PYTHON.test(interpreter)) return "python";
  if (interpreter === "node") return "javascript";
  if (interpreter && LUA.test(interpreter)) return "lua";
  if (interpreter && POWERSHELL.test(interpreter)) return "powershell";
  if (interpreter === "ruby" || interpreter === "perl" || interpreter === "php") return interpreter;
  if (!shebang && /\.(?:sh|bash)$/u.test(path)) return "shell";
  return undefined;
}

/**
 * Only a system interpreter, alone or named by a system `env` with nothing else on the
 * line, names the language. A shebang into the workplace (`#!.venv/bin/python`) runs a binary
 * policy has not looked at; any further word changes what runs first (security review C4:
 * `#!/usr/bin/env BASH_ENV=a/bash bash` sources a/bash before the script on macOS, and
 * interpreter options or `env -S` / `-i` / `-u` / `--` do similar things).
 */
/**
 * The program a shebang runs: the absolute interpreter, or the name `env` looks up in PATH
 * (which execution resolves again before dispatch, N2). Undefined for anything else.
 */
export function shebangProgram(text: string): string | undefined {
  if (!text.startsWith("#!")) return undefined;
  const end = text.indexOf("\n");
  const line = text.slice(2, end < 0 ? undefined : end);
  // Only spaces and tabs separate words for the kernel; a `\r` stays part of the last word.
  const [path, name, ...rest] = line.replace(/^[ \t]+|[ \t]+$/gu, "").split(/[ \t]+/u);
  if (
    !path ||
    !/^\/(?:usr\/(?:local\/)?)?s?bin\/[\w.+-]+$|^\/opt\/homebrew\/bin\/[\w.+-]+$/u.test(path)
  )
    return undefined;
  if (path.endsWith("/env"))
    return name && rest.length === 0 && /^[A-Za-z][\w.+-]*$/u.test(name) ? name : undefined;
  return name === undefined ? path : undefined;
}

export function scriptDigest(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const INTERPRETER =
  /^(?:python\d*(?:\.\d+)?|node|nodejs|deno|bun|tsx|ts-node|ruby|perl|php|lua\d*(?:\.\d+)?|luajit|pwsh|powershell|osascript|Rscript|tclsh|wish|java|jshell|groovy|swift)$/u;
/**
 * Whether this invocation runs code from somewhere other than its own words: a script
 * file, a module (`python3 -m x`), or an interpreter with options policy does not read. Inline
 * code (`python3 -c '…'`, `sh -c '…'`) is part of the text that contains it.
 */
export function loadsOtherCode(program: string, args: readonly string[]): boolean {
  const run = scriptRun(program, args);
  // An empty inline text is a dynamic word (`sh -c "$(cat x.sh)"`, `python3 -c "$CODE"`): the
  // code comes from elsewhere at run time, so it is not part of the pinned text.
  if (run) return run.kind === "file" || run.code === "";
  if (SHELLS.has(program)) {
    const index = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/u.test(arg));
    return index < 0 || !args[index + 1];
  }
  return INTERPRETER.test(program);
}
