import { posix } from "node:path";
import type { CommandAnalysis, Platform } from "../core/types.ts";
import type { AnalysisBudget } from "./analysis-budget.ts";
import type { ArgumentFacts } from "./argument-types.ts";
import { addCommand, uncertain } from "./command-facts.ts";
import { optionValues, parseOptions } from "./options/options.ts";
import { wrapperOptions } from "./options/wrapper-options.ts";
import { pythonShadowed, scriptLoadsCode } from "./script-loads.ts";
import {
  pureCode,
  type ScriptInputs,
  type ScriptRun,
  scriptDigest,
  scriptLanguage,
  scriptRun,
  shebangProgram,
  skillTokenScript,
} from "./scripts.ts";

/** What judging a script run may use, beyond the command words. */
export interface ScriptContext extends ScriptInputs {
  /** Only the outermost simple invocation may be judged by a script file's text. */
  allowScripts: boolean;
  /** The command runs in the original working directory (no `cd` before it). */
  atCwd: boolean;
  /** Parses a shell script and substitutes its plain assignments and arguments. */
  substitute(text: string, args: readonly string[]): string;
}
/**
 * analysis.warnings: a read script loads code from elsewhere (a security review finding), so its
 * digest does not pin what runs and it is not offered as a routine's pinned consent.
 */
export const SCRIPT_LOADS_CODE = "script_loads_code";

interface Invocation {
  words: string[];
  offset: number;
  directory?: string;
  depth: number;
}
/** analysis.warnings: a script file the analysis could not read because of where it runs. */
export const NESTED_SCRIPT = "nested_script";
export const prefix = (directory: string | undefined, path: string) =>
  !directory || posix.isAbsolute(path) || path.startsWith("~") ? path : `${directory}/${path}`;
/** A cursor avoids recursive env/time expansion and repeated copies of the remaining argv. */
export function collectInvocations(
  result: CommandAnalysis,
  words: string[],
  parseNested: (text: string) => void,
  budget: AnalysisBudget,
  platform: Platform,
  directory?: string,
  scriptInput?: ScriptContext,
) {
  const pending: Invocation[] = [{ words, offset: 0, depth: 0, directory }];
  while (pending.length && budget.check()) {
    const task = pending.pop();
    if (!task) continue;
    if (task.depth > 64) {
      uncertain(result, "invocation_depth_limit");
      continue;
    }
    let { offset, directory } = task;
    let queryOnly = false;
    while (offset < task.words.length && budget.check()) {
      let program = task.words[offset++] ?? "";
      const word = program;
      if (!program) {
        uncertain(result, "dynamic_program");
        break;
      }
      if (/^\/(?:usr\/)?bin\/[\w.-]+$/.test(program)) program = posix.basename(program);
      if (["nohup", "setsid", "disown"].includes(program)) uncertain(result, "background_command");
      const spec = Object.hasOwn(wrapperOptions, program) ? wrapperOptions[program] : undefined;
      if (spec) {
        if (program === "xargs") uncertain(result, "dynamic_xargs_arguments");
        // Stop at the next executable without copying the remaining argv for each layer.
        let split: string | undefined;
        while (offset < task.words.length && budget.check()) {
          const parsed = parseOptions(task.words, spec, { offset });
          offset = parsed.nextIndex;
          result.unknownOptions.push(...parsed.unknownOptions);
          if (parsed.incomplete) uncertain(result, "wrapper_options");
          for (const path of parsed.reads) result.reads.push(prefix(directory, path));
          for (const path of parsed.writes) result.writes.push(prefix(directory, path));
          if (
            parsed.writes.length ||
            parsed.reads.length ||
            (program === "env" && parsed.flags.size)
          )
            uncertain(result, "wrapper_options");
          if (program === "command" && (parsed.flags.has("-v") || parsed.flags.has("-V"))) {
            queryOnly = true;
            uncertain(result, "wrapper_query");
          }
          if (program === "env") {
            const change = optionValues(parsed, "-C", "--chdir").at(-1);
            if (change !== undefined) directory = prefix(directory, change);
            split = optionValues(parsed, "-S", "--split-string").at(-1);
            if (split !== undefined) break;
            if (/^\w+=/.test(task.words[offset] ?? "")) {
              uncertain(result, "environment_assignment");
              offset++;
              continue;
            }
          }
          break;
        }
        if (split !== undefined) {
          parseNested(split);
          break;
        }
        if (program === "timeout") offset++;
        if (offset >= task.words.length) uncertain(result, "wrapper_missing_program");
        continue;
      }
      const args = task.words.slice(offset);
      const run = scriptRun(program, args);
      if (!queryOnly && run?.kind === "file") {
        const entryPoint = run.language
          ? run.path
          : (skillTokenScript({ program: word, args }) ?? run.path);
        result.scriptEntryPoints ??= [];
        result.scriptEntryPoints.push(prefix(directory, entryPoint));
      }
      if (
        run &&
        judgeScript(
          result,
          { program, word },
          args,
          run,
          parseNested,
          directory,
          task.depth,
          scriptInput,
        )
      )
        break;
      const readStart = result.reads.length;
      const writeStart = result.writes.length;
      const facts = addCommand(result, program, args, platform);
      for (let i = readStart; i < result.reads.length; i++)
        result.reads[i] = prefix(directory, result.reads[i] as string);
      for (let i = writeStart; i < result.writes.length; i++)
        result.writes[i] = prefix(directory, result.writes[i] as string);
      if (!budget.check()) break;
      if (["sh", "bash", "zsh", "dash"].includes(program)) {
        const index = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
        if (index >= 0 && args[index + 1]) parseNested(args[index + 1] as string);
      }
      if (program === "find")
        queueFindActions(facts, task.depth, directory, pending, result, budget);
      break;
    }
  }
}
function queueFindActions(
  facts: ArgumentFacts,
  depth: number,
  directory: string | undefined,
  pending: Invocation[],
  result: CommandAnalysis,
  budget: AnalysisBudget,
) {
  const actions: Invocation[] = [];
  const roots = facts.find?.roots ?? [];
  for (const action of facts.find?.actions ?? []) {
    if (!budget.check()) return;
    if (["-execdir", "-okdir"].includes(action.option))
      uncertain(result, "find_action_cwd_unknown");
    const words: string[] = [];
    for (const arg of action.words) {
      if (!budget.check()) return;
      if (arg === "{}") {
        for (const root of roots) {
          if (!budget.check()) return;
          words.push(root);
        }
      } else words.push(arg);
    }
    actions.push({ words, offset: 0, directory, depth: depth + 1 });
  }
  for (let i = actions.length - 1; i >= 0; i--) pending.push(actions[i] as Invocation);
}

/**
 * Judge an interpreter run by its script. True when handled (the interpreter itself is
 * not recorded, so a script that merely uses curl is not "download and execute"); false leaves
 * the ordinary path, where an interpreter is an unknown program and the run asks as before.
 */
function judgeScript(
  result: CommandAnalysis,
  { program, word }: { program: string; word: string },
  args: string[],
  run: ScriptRun,
  parseNested: (text: string) => void,
  directory: string | undefined,
  depth: number,
  input: ScriptContext | undefined,
): boolean {
  // Every verdict below assumes this interpreter is the system one; execution
  // resolves it in the command's PATH before dispatch and refuses a writable folder or a shim.
  const relies = (interpreter: string | undefined) => {
    if (!interpreter) return;
    result.scriptInterpreters ??= [];
    if (!result.scriptInterpreters.includes(interpreter))
      result.scriptInterpreters.push(interpreter);
  };
  const pure = () => {
    // A file run straight by path (`./tool.py`) records its shebang interpreter in judged().
    if (run.kind === "inline" || run.language) relies(word);
    result.programs.push(program);
    result.commands.push({ program, args });
    result.readonly = result.commands.length === 1 ? true : result.readonly;
  };
  if (run.kind === "inline") {
    if (!pureCode(run.language, run.code)) return false;
    if (run.language === "python" && !run.safePath) {
      // `python3 -c` imports from the cwd before the standard library, so a
      // planted `json.py` (or any module an allowlisted one loads) would run instead. Only an
      // entry listing of the original cwd can rule that out; the caller supplies it on request.
      if (!input?.atCwd || directory !== undefined) return false;
      if (!input.cwdNames) {
        result.moduleSearchCwd = true;
        return false;
      }
      if (pythonShadowed(input.cwdNames)) {
        uncertain(result, SCRIPT_LOADS_CODE);
        return false;
      }
    }
    pure();
    return true;
  }
  if (depth !== 0 || !input?.allowScripts) {
    // A script started from inside another one (or after a `cd`) is not read, so a
    // digest of the outer text does not pin what runs; this keeps it out of routine consent.
    uncertain(result, NESTED_SCRIPT);
    return false;
  }
  const path = prefix(directory, run.path);
  result.scriptFiles ??= [];
  if (!result.scriptFiles.includes(path)) result.scriptFiles.push(path);
  const source = input.files?.get(path);
  if (!source) return false;
  const language = scriptLanguage(run.path, source.text, run.language);
  if (!language) return false;
  const token = `script:${scriptDigest(`${source.text}\0${run.args.join("\0")}`)}`;
  const judged = () => {
    relies(run.language ? word : shebangProgram(source.text));
    result.programs.push(token);
    result.reads.push(path);
    // The verdict is about these bytes; execution re-reads the file right
    // before it starts the run and refuses if another writer changed it in between.
    if (source.path && source.sha256) {
      result.scriptPins ??= [];
      result.scriptPins.push({ path: source.path, sha256: source.sha256 });
    }
  };
  if (language === "shell") {
    judged();
    parseNested(input.substitute(source.text, run.args));
    return true;
  }
  // `python3 file.py` puts the file's own directory first on sys.path.
  const pythonClean =
    language !== "python" ||
    run.safePath === true ||
    (source.neighbours !== undefined && !pythonShadowed(source.neighbours));
  if (pythonClean && pureCode(language, source.text)) {
    pure();
    judged();
    return true;
  }
  // Read but not proven pure. The interpreter stays an unknown program (the run asks),
  // and the digest still names this exact text, which is what a routine may pre-authorize unless
  // the text loads other workplace code that could change under the same digest.
  if (scriptLoadsCode(language, source.text, pythonClean)) uncertain(result, SCRIPT_LOADS_CODE);
  judged();
  return false;
}
