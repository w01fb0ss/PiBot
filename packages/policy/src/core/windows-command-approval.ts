// Keep implicit Windows approval tied to the same paths and permissions as file tools.
import { win32 } from "node:path";
import type { ApprovalFact } from "@pibot/protocol-base";
import {
  literalWindowsReadCommand,
  windowsLiteralPath,
  type windowsReadShape,
} from "../commands/windows-approval-shape.ts";
import { canonicalPath, containsPath, withAbort } from "../paths/paths.ts";
import { windowsProtectedCommandPath } from "./command-path-risk.ts";
import { PolicyTargetError } from "./errors.ts";
import type { RequestFacts } from "./request-facts.ts";
import type { EvaluationInput, PathContext } from "./types.ts";

type FileRead = {
  category: "read_file" | "list_dir";
  path: string;
};

function localDrivePath(path: string) {
  return /^[a-z]:[\\/]/i.test(path) && windowsLiteralPath(path);
}

type Protection = { roots: readonly string[]; own: readonly string[] };

async function approvedPath(
  path: string,
  context: PathContext,
  protection: Protection,
  raw?: string,
) {
  const { roots, own } = protection;
  const absolute = win32.resolve(context.cwd, path);
  if (!localDrivePath(absolute) || windowsProtectedCommandPath(absolute, roots, own))
    return undefined;
  const resolved = await canonicalPath(raw ?? absolute, context);
  if (!localDrivePath(resolved.path) || windowsProtectedCommandPath(resolved.path, roots, own))
    return undefined;
  return resolved;
}

type CommandInput = EvaluationInput & {
  request: Extract<EvaluationInput["request"], { category: "run_command" }>;
};
type ReadPolicy = (request: FileRead) => Promise<RequestFacts>;
type ReadShape = NonNullable<ReturnType<typeof windowsReadShape>>;
type ReadProof = {
  facts: ApprovalFact[];
  outside: Array<{ category: FileRead["category"]; result: RequestFacts["result"] }>;
  command?: string;
};

export async function proveWindowsReadOnly(
  input: CommandInput,
  context: PathContext,
  cwd: string | undefined,
  protectedRoots: Protection,
  shape: ReturnType<typeof windowsReadShape>,
  readPolicy: ReadPolicy,
): Promise<ReadProof | undefined> {
  if (!cwd || !localDrivePath(cwd) || input.request.stdin || input.request.outsideSandbox) return;
  if (
    input.request.background ||
    input.request.writePaths?.length ||
    input.boundary?.location?.target.startsWith("acp:")
  )
    return;
  if (!shape) return;
  if (shape.git.length && input.windowsGitReadScopeVerified !== true) return;

  try {
    const work = input.boundary?.readRoots ?? [
      input.workplace.home,
      ...input.workplace.folders.map((folder) => folder.path),
    ];
    const directory = await approvedPath(cwd, context, protectedRoots);
    if (!directory?.exists || !work.some((root) => containsPath(root, directory.path, "win32")))
      return;
    const checked = { ...context, cwd: directory.path };
    const local = (input.boundary?.location?.target ?? "local") === "local";
    return await readFacts(shape, checked, work, protectedRoots, readPolicy, local);
  } catch (error) {
    context.signal.throwIfAborted();
    // A filesystem proof may fail on a disconnected target or inaccessible path. Keep the card.
    if (
      error instanceof PolicyTargetError ||
      (error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(
          String(error.code),
        ))
    )
      return;
    throw error;
  }
}

async function gitDirectory(
  directories: readonly string[],
  context: PathContext,
  work: readonly string[],
  protection: Protection,
) {
  let cwd = context.cwd;
  for (const argument of directories) {
    const lexical = win32.resolve(cwd, argument);
    if (!work.some((root) => containsPath(root, lexical, "win32"))) return;
    const raw = win32.isAbsolute(argument) ? argument : `${cwd}\\${argument}`;
    const directory = await approvedPath(argument, { ...context, cwd }, protection, raw);
    // Git applies successive -C arguments to the real directory. A junction could
    // make the Git entry scan inspect a different repository.
    if (!directory?.exists || win32.relative(lexical, directory.path) !== "") return;
    cwd = directory.path;
  }
  return cwd;
}

async function readFacts(
  shape: ReadShape,
  context: PathContext,
  work: readonly string[],
  protectedRoots: Protection,
  readPolicy: ReadPolicy,
  local: boolean,
): Promise<ReadProof | undefined> {
  const proof: ReadProof = { facts: [], outside: [] };
  const gitCwds = new Map<readonly string[], string>();
  for (const read of shape.reads) {
    let cwd = context.cwd;
    if (read.gitDirectories) {
      const directory =
        gitCwds.get(read.gitDirectories) ??
        (await gitDirectory(read.gitDirectories, context, work, protectedRoots));
      if (!directory) return;
      gitCwds.set(read.gitDirectories, directory);
      cwd = directory;
    }
    const readContext = { ...context, cwd };
    const path = await approvedPath(read.path, readContext, protectedRoots);
    if (!path) return;
    const lexical = win32.resolve(cwd, read.path);
    // An operand outside the repository can put Git into implicit no-index mode.
    if (
      read.gitDiffPath &&
      ![lexical, path.path].every((value) => containsPath(cwd, value, "win32"))
    )
      return;
    const access = await readPolicy({ category: read.category, path: lexical });
    if (
      local &&
      access.outside &&
      !shape.git.length &&
      access.result.category !== "read_ai_config"
    ) {
      if (access.result.path?.path !== path.path) return;
      if (shape.singlePathProgram) {
        proof.command = literalWindowsReadCommand(shape.singlePathProgram, path.path);
        if (!proof.command) return;
      } else if (win32.relative(lexical, path.path) !== "") {
        // Compound commands keep their spelling, so their outside operands cannot be aliases.
        return;
      }
      proof.outside.push({ category: read.category, result: access.result });
    } else if (!readAllowed(access)) return;
    if (read.gitContent && !readAllowed(await readPolicy({ category: "read_file", path: lexical })))
      return;
    if (read.recurse || read.readEntries) {
      const checked =
        path.exists && (await entriesAllowed(path.path, read, context, protectedRoots, readPolicy));
      if (!checked) {
        // PS 5.1 searches from the parent when the last -Path component isn't a directory.
        // Prove that broader search too, including any paths that could feed a content pipeline.
        if (!read.recurseByName) return;
        const parent = win32.dirname(lexical);
        const directory = await approvedPath(parent, readContext, protectedRoots);
        if (
          !directory?.exists ||
          !readAllowed(await readPolicy({ category: "list_dir", path: parent })) ||
          !(await entriesAllowed(directory.path, read, context, protectedRoots, readPolicy))
        )
          return;
      }
    }
    proof.facts.push({ kind: "read", value: path.path });
  }
  return proof;
}

function readAllowed(facts: RequestFacts) {
  const { result, outside } = facts;
  return (
    result.decision !== "deny" &&
    result.category !== "read_ai_config" &&
    (!outside || result.decision === "allow")
  );
}

async function entriesAllowed(
  path: string,
  read: { recurse?: boolean; readEntries?: boolean },
  context: PathContext,
  protectedRoots: Protection,
  readPolicy: ReadPolicy,
) {
  const enumerate = context.fs.windowsReadEntries;
  if (!enumerate) return false;
  const entries = await withAbort(
    () =>
      enumerate(
        path,
        read.recurse === true,
        context.signal,
        (entry) =>
          localDrivePath(entry) &&
          !windowsProtectedCommandPath(entry, protectedRoots.roots, protectedRoots.own),
      ),
    context.signal,
  );
  if (!entries) return false;
  for (const entry of entries) {
    if (
      read.readEntries &&
      !entry.directory &&
      !readAllowed(await readPolicy({ category: "read_file", path: entry.path }))
    )
      return false;
  }
  return true;
}
