import { createRequire } from "node:module";
import { join } from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";
import type { CommandAnalysis, CommandInvocation, Platform, PolicyOptions } from "../core/types.ts";
import { type AnalysisBudget, createAnalysisBudget } from "./analysis-budget.ts";
import { addDirectoryChange, emptyAnalysis, uncertain } from "./command-facts.ts";
import {
  type DirectoryState,
  directoryFlow,
  directoryPath,
  initialDirectory,
} from "./directory-flow.ts";
import { homeArgument } from "./home-argument.ts";
import { collectInvocations, type ScriptContext } from "./invocations.ts";
import { isOutputTarget } from "./output-targets.ts";
import type { ScriptInputs } from "./scripts.ts";
import { changesShellEnvironment, substituteShell } from "./shell-substitution.ts";

/** Shell quoting is decoded only for literal words; no expansion is executed here. */
function literal(text: string): string | undefined {
  if (text === "{}") return text;
  let quote = "";
  let value = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? "" : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? "" : '"';
      continue;
    }
    if (quote !== "'" && (char === "$" || char === "`" || (!quote && /[*?[\]{}]/.test(char))))
      return undefined;
    if (char === "\\" && quote !== "'") {
      const next = text[++i];
      if (next === undefined) return undefined;
      if (quote === '"' && !/["\\$`\n]/.test(next)) value += "\\";
      if (next !== "\n") value += next;
    } else value += char;
  }
  return quote ? undefined : value;
}
function literalInvocation(node: Node): CommandInvocation | undefined {
  if (node.type !== "command") return;
  const tokens = node.namedChildren;
  const words = tokens.map((token) => literal(token.text));
  if (
    tokens.every((token) =>
      ["command_name", "word", "number", "string", "raw_string", "concatenation"].includes(
        token.type,
      ),
    ) &&
    words.length &&
    words.every((word) => word !== undefined) &&
    tokens.every((token) => !token.text.includes("~"))
  )
    return { program: words[0] as string, args: words.slice(1) as string[] };
}

function leadingAndCommand(statement: Node, text: string) {
  // Walk the left spine of Bash's left-associative &&/|| lists. A || in this
  // spine would make it possible to continue after a failed initialization.
  const left: { node: Node; after: number }[] = [];
  let node = statement;
  while (node.type === "list") {
    const [first, operator, second] = node.children;
    if (node.children.length !== 3 || !first || !second || operator?.type !== "&&") return;
    left.push({ node: second, after: operator.endIndex });
    node = first;
  }
  if (!left.length) return;
  const first = literalInvocation(node);
  if (!first) return;
  const cdArgs = first.args[0] === "--" ? first.args.slice(1) : first.args;
  const directory = first.program === "cd" && cdArgs.length === 1 ? cdArgs[0] : undefined;
  if (directory === "-" || directory?.startsWith("-")) return;
  const next = directory ? left.pop()?.node : node;
  const invocation = next && literalInvocation(next);
  if (!invocation) return;
  const suffix = left.at(-1);
  const remainder = suffix && text.slice(suffix.after).trimStart();
  return { invocation, directory, remainder };
}

/** A pipeline stage after the first: its stdin is the previous stage's output. */
function pipedStage(node: Node) {
  const stage = node.parent?.type === "redirected_statement" ? node.parent : node;
  const pipeline = stage.parent;
  return pipeline?.type === "pipeline" && pipeline.namedChildren[0]?.id !== stage.id;
}

function collect(
  root: Node,
  result: CommandAnalysis,
  nested: (text: string, state: DirectoryState) => void,
  budget: AnalysisBudget,
  platform: Platform,
  home?: string,
  direct = false,
  initial: DirectoryState = initialDirectory,
  /** The command text itself, not a nested shell's: AST offsets refer to that text. */
  top = false,
  /** Script texts (judged only for the outermost simple invocation) and cwd entries. */
  scriptInput?: Omit<ScriptContext, "atCwd">,
) {
  const flow = directoryFlow(root, literal, budget, initial);
  const project = (paths: string[], state: DirectoryState) =>
    paths.flatMap((path) =>
      path.startsWith("/") || path.startsWith("~")
        ? [path]
        : state.paths.map((directory) => directoryPath(directory, path)),
    );
  const word = (token: Node): string | undefined => {
    if (token.type === "process_substitution") return undefined;
    const value = literal(token.text);
    if (home && value?.startsWith("~")) {
      if (token.text.startsWith("~")) {
        // Preserve the path gate's existing hard refusal for named-user home expansion.
        if (!/^~(?:\/|$)/.test(value)) return value;
        if (direct && /^~(?:\/|$)/.test(token.text)) return home + value.slice(1);
        uncertain(result, "dynamic_argument");
        return undefined;
      }
      // Quoted/escaped tildes are literal filenames, not home aliases.
      return `./${value}`;
    }
    if (value !== undefined || !home || !direct) return value;
    const expanded = homeArgument(token.text, home);
    // Showing a known path must not upgrade dynamic words to reusable readonly grants.
    if (expanded !== undefined) uncertain(result, "dynamic_argument");
    return expanded;
  };
  const nodes: Node[] = [root];
  while (nodes.length && budget.check()) {
    const node = nodes.pop();
    if (!node) continue;
    if (node.isError || node.isMissing) uncertain(result, "syntax_error");
    // Inspect parser tokens so quoted ampersands and redirect operators are not background jobs.
    if (node.children.some((child) => child.type === "&")) uncertain(result, "background_command");
    if (
      [
        "variable_assignment",
        "heredoc_body",
        "process_substitution",
        "function_definition",
      ].includes(node.type)
    )
      uncertain(result, "dynamic_shell_content");
    if (node.type === "command") {
      const tokens = node.namedChildren.filter(
        (child) =>
          !["variable_assignment", "file_redirect", "heredoc_redirect"].includes(child.type),
      );
      const words = tokens.map(word);
      const state = flow.contexts.get(node.id) ?? initial;
      if (flow.changes.has(node.id)) {
        const target = flow.changes.get(node.id);
        if (target) for (const path of project([target], state)) addDirectoryChange(result, path);
        if (!target) uncertain(result, "unsupported_directory_change");
      } else {
        if (words.some((word) => word === undefined)) uncertain(result, "dynamic_argument");
        const readStart = result.reads.length;
        const writeStart = result.writes.length;
        const scriptStart = result.scriptEntryPoints?.length ?? 0;
        const commandStart = result.commands.length;
        const innerCommands: string[] = [];
        // Retain literal operands around dynamic words for hard-deny path checks.
        collectInvocations(
          result,
          words.map((word) => word ?? ""),
          (text) => {
            // A nested shell is parsed on its own and would miss the `cd` directory.
            innerCommands.push(text);
          },
          budget,
          platform,
          undefined,
          scriptInput && {
            ...scriptInput,
            allowScripts: top && scriptInput.allowScripts,
            atCwd: !state.unknown && state.paths.length === 1 && state.paths[0] === ".",
          },
        );
        // Only the stage's own program reads the pipe; wrapped inner programs are not marked.
        if (result.commands.length > commandStart && pipedStage(node)) {
          result.pipedCommands ??= [];
          result.pipedCommands.push(commandStart);
          // A filter candidate's command word IS its program: no wrapper (`env head`), no path
          // spelling, no quoting, and in the top-level text so execution can pin that word.
          const name = node.childForFieldName("name");
          const program = result.commands[commandStart]?.program;
          if (
            top &&
            name &&
            result.commands.length === commandStart + 1 &&
            program &&
            name.text === program &&
            words[0] === program
          ) {
            result.filterCandidates ??= [];
            result.filterCandidates.push({
              index: commandStart,
              start: name.startIndex,
              end: name.endIndex,
            });
          }
        }
        const reads = result.reads.splice(readStart);
        const writes = result.writes.splice(writeStart);
        result.reads.push(...project(reads, state));
        result.writes.push(...project(writes, state));
        const scripts = result.scriptEntryPoints?.splice(scriptStart);
        if (scripts?.length)
          result.scriptEntryPoints?.push(
            ...project(
              state.unknown ? scripts.filter((path) => path.startsWith("/")) : scripts,
              state,
            ),
          );
        for (const text of innerCommands) nested(text, state);
        if (state.unknown) {
          uncertain(result, "unknown_command_directory");
          if (writes.some((path) => !path.startsWith("/")) || !result.readonly)
            uncertain(result, "unknown_directory_write");
        }
      }
    }
    if (node.type === "negated_command") result.negated = true;
    // Here-strings and here-documents also replace a command's stdin.
    if (node.type === "herestring_redirect" || node.type === "heredoc_redirect")
      result.inputRedirect = true;
    if (node.type === "file_redirect") {
      const target = node.childForFieldName("destination") ?? node.namedChildren.at(-1);
      const value = target && word(target);
      const operator = /^\d*\s*(&>>|&>|>>|<>|>&|<&|>|<)/.exec(node.text)?.[1];
      if (!value) {
        uncertain(result, "dynamic_redirect");
        if (operator?.includes(">") && flow.contexts.get(node.id)?.unknown)
          uncertain(result, "unknown_directory_write");
      } else if ((operator === ">&" || operator === "<&") && /^\d+$|^-$/.test(value)) {
        // Descriptor duplication does not open a file.
      } else if (operator === "<&" || !operator) uncertain(result, "descriptor_redirect");
      else {
        // Even /dev/null must be opened by the shell and can fail before the program starts.
        if (operator.includes(">")) result.outputRedirect = true;
        if (operator.includes(">") && !isOutputTarget(value, platform)) {
          const state = flow.contexts.get(node.id) ?? initial;
          result.writes.push(...project([value], state));
          if (state.unknown && !value.startsWith("/")) uncertain(result, "unknown_directory_write");
          result.fileRedirect = true;
        }
        if (operator === "<" || operator === "<>") {
          result.reads.push(...project([value], flow.contexts.get(node.id) ?? initial));
          result.inputRedirect = true;
        }
      }
    }
    nodes.push(...node.namedChildren.toReversed());
  }
}
export async function createCommandAnalyzer(options: PolicyOptions) {
  const require = createRequire(import.meta.url);
  const paths =
    options.wasmPaths ??
    (options.resourcesDir
      ? {
          core: join(options.resourcesDir, "wasm", "web-tree-sitter.wasm"),
          bash: join(options.resourcesDir, "wasm", "tree-sitter-bash.wasm"),
        }
      : {
          core: require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
          bash: require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
        });
  await Parser.init({ locateFile: () => paths.core });
  const language = await Language.load(paths.bash);
  const parser = new Parser();
  parser.setLanguage(language);
  let disposed = false;
  return {
    analyze(
      command: string,
      platform: Platform = options.platform,
      home?: string,
      inputs?: ScriptInputs,
    ): CommandAnalysis {
      if (disposed) throw new Error("Policy disposed");
      const result = emptyAnalysis();
      if (platform === "win32") {
        uncertain(result, "windows_unisolated");
        result.readonly = false;
        return result;
      }
      if (command.length > 32_768) {
        uncertain(result, "command_too_large");
        return result;
      }
      const budget = createAnalysisBudget(result);
      const simple = !/[;&|<>`$()\n\\]/u.test(command.replace(/'[^']*'|"[^"$`\\]*"/gu, ""));
      // C1: a script's assignments come from its own parse tree, never from text lines. A text
      // that does not parse cleanly keeps its expansions, which the analyser treats as dynamic.
      const substitute = (text: string, args: readonly string[]) => {
        if (!budget.check()) return text;
        const tree = parser.parse(text, null, { progressCallback: () => !budget.check() });
        if (!tree) {
          parser.reset();
          return text;
        }
        try {
          if (tree.rootNode.hasError) return text;
          if (changesShellEnvironment(tree.rootNode)) {
            uncertain(result, "script_shell_environment");
            return text;
          }
          return substituteShell(tree.rootNode, text, args, literal);
        } finally {
          tree.delete();
        }
      };
      const parse = (text: string, depth = 0, initial: DirectoryState = initialDirectory) => {
        if (!budget.check()) return;
        if (depth > 3) {
          uncertain(result, "nested_shell_limit");
          return;
        }
        const tree = parser.parse(text, null, {
          progressCallback: () => !budget.check(),
        });
        if (!tree) {
          parser.reset();
          uncertain(result, "parse_failed_or_timed_out");
          return;
        }
        try {
          if (tree.rootNode.hasError) uncertain(result, "syntax_error");
          const single =
            tree.rootNode.children.length === 1 ? tree.rootNode.children[0] : undefined;
          if (depth === 0 && single && !tree.rootNode.hasError) {
            const list =
              single.type === "redirected_statement" ? single.childForFieldName("body") : single;
            if (list?.type === "list") {
              const chain = leadingAndCommand(list, text);
              // A trailing redirect belongs to the last command. Keep it in the suffix;
              // if Git is last, the fixed recipe cannot reproduce that redirect.
              if (single === list || chain?.remainder) result.leadingAndCommand = chain;
            }
          }
          if (depth === 0 && single?.type === "redirected_statement" && !tree.rootNode.hasError) {
            const body = single.childForFieldName("body");
            const redirect = single.namedChildren[1];
            const invocation = body && literalInvocation(body);
            const destination = redirect?.childForFieldName("destination");
            const path = destination && literal(destination.text);
            // A single stdout redirect is result storage; fd changes, expansions and lists
            // cannot certify that all writes belong to the scan result.
            if (
              single.namedChildren.length === 2 &&
              invocation &&
              path &&
              redirect?.type === "file_redirect" &&
              !redirect.childForFieldName("descriptor") &&
              [">", ">>"].includes(redirect.children[0]?.text ?? "") &&
              !path.includes("~")
            )
              result.literalOutputRedirect = {
                command: invocation,
                path,
                operator: redirect.children[0]?.text as ">" | ">>",
              };
          }
          if (depth === 0 && single?.type === "command" && !tree.rootNode.hasError) {
            const tokens = single.namedChildren;
            const words = tokens.map((token) => literal(token.text));
            if (
              tokens.every((token) =>
                ["command_name", "word", "string", "raw_string", "concatenation"].includes(
                  token.type,
                ),
              ) &&
              words.length &&
              words.every((word) => word !== undefined) &&
              tokens.every((token) => !token.text.includes("~"))
            )
              result.literalCommand = {
                program: words[0] as string,
                args: words.slice(1) as string[],
              };
          }
          // Assignments, compound commands and nested shells can change HOME before expansion.
          // Keep them opaque rather than showing a path inferred from the initial environment.
          const body =
            single?.type === "redirected_statement" ? single.childForFieldName("body") : single;
          const direct =
            depth === 0 &&
            body?.type === "command" &&
            !/\$\(|`|[<>]\(/.test(single?.text ?? "") &&
            body.namedChildren.every((token) => token.type !== "variable_assignment");
          collect(
            tree.rootNode,
            result,
            (inner, state) => parse(inner, depth + 1, state),
            budget,
            platform,
            home,
            direct,
            initial,
            depth === 0,
            // Only a command that is nothing but one simple invocation may be judged by a script's
            // text: a `cd`, a redirect or a second command could change which file actually runs.
            { ...inputs, allowScripts: depth === 0 && simple, substitute },
          );
        } finally {
          tree.delete();
        }
      };
      parse(command);
      for (const key of ["programs", "reads", "writes", "domains", "unknownOptions"] as const)
        result[key] = [...new Set(result[key])];
      result.readonly =
        !result.incomplete &&
        !result.writes.length &&
        result.commands.length > 0 &&
        result.readonly;
      return result;
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        parser.delete();
      }
    },
  };
}
