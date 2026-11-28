import { dirname, isAbsolute, resolve } from "node:path";
import { ExecError } from "../core/types.ts";

export interface GitInitialization {
  program: string;
  argv: string[];
  directory?: string;
  remainder?: string;
  primary: { canonicalPath: string; device: string | null; inode: string | null };
  /** Synchronous brain-owned check; an edited primary/permission/group invalidates preparation. */
  assertAuthorized(): void;
}

export const quoteGitInitWord = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/** Only exec's validated plan may derive this fixed command; it is never a model setup tool. */
export function gitDirectoryCreationCommand(gitDir: string) {
  // An exclusive final mkdir refuses a repository created since planning.
  return `umask 077; /bin/mkdir -p -- ${quoteGitInitWord(dirname(gitDir))} && exec /bin/mkdir -- ${quoteGitInitWord(gitDir)}`;
}

/** Structured argv supplied by the authorized brain port, never inferred from arbitrary shell text. */
export function gitInitArguments(argv: string[], cwd: string, program = "git") {
  if (!/^(?:git|\/(?:usr\/bin|bin|usr\/local\/bin|opt\/homebrew\/bin)\/git)$/.test(program))
    throw new ExecError("invalid_input");
  let directory = cwd;
  const directories = [cwd];
  let unsupportedGlobal = false;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] as string;
    if (["--no-pager", "--literal-pathspecs", "--no-optional-locks"].includes(arg)) index++;
    else if (arg === "-C" || (arg.startsWith("-C") && arg.length > 2)) {
      const value = arg === "-C" ? argv[++index] : arg.slice(2);
      if (value === undefined) throw new ExecError("invalid_input");
      if (value) directory = resolve(directory, value);
      directories.push(directory);
      index++;
    } else if (["-c", "--git-dir", "--work-tree"].includes(arg)) {
      unsupportedGlobal = true;
      if (argv[++index] === undefined) return undefined;
      index++;
    } else if (
      arg.startsWith("-c") ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=") ||
      arg === "--bare"
    ) {
      unsupportedGlobal = true;
      index++;
    } else break;
  }
  if (argv[index] !== "init") return undefined;
  if (unsupportedGlobal) throw new ExecError("invalid_input");
  const initAt = index++;
  let template = false;
  let destination: string | undefined;
  let operands = false;
  for (; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg.includes("\0")) throw new ExecError("invalid_input");
    if (!operands && arg === "--") operands = true;
    else if (!operands && (arg === "--quiet" || /^-q+$/.test(arg))) continue;
    else if (
      !operands &&
      ["--template", "--initial-branch", "--object-format", "--ref-format", "-b"].includes(arg)
    ) {
      if (argv[++index] === undefined) throw new ExecError("invalid_input");
      if (arg === "--template") {
        if (argv[index] !== "") throw new ExecError("invalid_input");
        template = true;
      }
    } else if (
      !operands &&
      /^(?:--(?:template|initial-branch|object-format|ref-format)=|-q*b.).*/.test(arg)
    )
      if (arg.startsWith("--template=")) {
        if (arg !== "--template=") throw new ExecError("invalid_input");
        template = true;
      } else if (!operands && /^-q+b$/.test(arg)) {
        if (argv[++index] === undefined) throw new ExecError("invalid_input");
      } else if (!operands && (arg === "--shared" || arg.startsWith("--shared="))) continue;
      else if (!operands && arg.startsWith("-")) throw new ExecError("invalid_input");
      else {
        if (destination !== undefined) throw new ExecError("invalid_input");
        destination = arg;
      }
  }
  const target = resolve(directory, destination ?? ".");
  if (!isAbsolute(target)) throw new ExecError("invalid_input");
  const command = [...argv];
  if (!template) command.splice(initAt + 1, 0, "--template=");
  // Fix the executable as well as argv; no wrapper or earlier shell command is run.
  return {
    target,
    directories,
    argv: command,
  };
}
