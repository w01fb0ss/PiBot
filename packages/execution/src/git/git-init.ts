import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileIdentity, matchesFileIdentity, sameFile } from "../core/file-identity.ts";
import { checkedRoot, missing, within } from "../core/paths.ts";
import { ExecError, type ExecOptions, type RunCommandOptions } from "../core/types.ts";
import { sensitiveReadBoundary } from "../sandbox/sensitive-paths.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import {
  type GitInitialization,
  gitDirectoryCreationCommand,
  gitInitArguments,
  quoteGitInitWord,
} from "./git-init-args.ts";
import { findGit } from "./git-process.ts";

interface Directory {
  path: string;
  handle: FileHandle;
  device: string;
  inode: string;
}
// Validate sensitive names before issuing the narrow SRT permission, not only inside SRT.
const forbidden = new Set([
  ".git",
  ".vscode",
  ".idea",
  ".claude",
  ".ssh",
  ".gnupg",
  ".pi",
  ".aws",
  ".kube",
  ".gitconfig",
  ".gitmodules",
  ".git-credentials",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
]);

export async function prepareGitInitialization(
  request: GitInitialization,
  input: RunCommandOptions,
  options: ExecOptions,
  signal: AbortSignal,
) {
  const cwd = resolve(input.cwd, request.directory ?? ".");
  const parsed = gitInitArguments(request.argv, cwd, request.program);
  if (!parsed) return undefined;
  const executable = request.program === "git" ? await findGit(options) : request.program;
  if (!executable) throw new ExecError("git_unavailable");
  if (options.platform !== "darwin" && options.platform !== "linux")
    throw new ExecError("isolation_unavailable");
  if (typeof request.assertAuthorized !== "function") throw new ExecError("invalid_input");
  request.assertAuthorized();
  const primary = request.primary;
  if (
    !primary.device ||
    !primary.inode ||
    !input.rootIdentities?.some(
      (root) =>
        root.canonicalPath === primary.canonicalPath &&
        root.device === primary.device &&
        root.inode === primary.inode,
    )
  )
    throw new ExecError("outside_workplace");
  signal.throwIfAborted();
  await verifyWorkspace([primary], signal);
  const root = await checkedRoot(primary.canonicalPath);
  const writes = await Promise.all(input.writeRoots.map(checkedRoot));
  const realExecutable = await realpath(executable);
  if (writes.some((path) => within(path, executable) || within(path, realExecutable)))
    throw new ExecError("outside_workplace");
  const target = parsed.target;
  const gitDir = join(target, ".git");
  const setupWriteRoot = writes
    .filter((path) => within(path, target))
    .map((path) => (within(root, path) ? path : root))
    .sort((a, b) => b.length - a.length)[0];
  for (const directory of parsed.directories) {
    signal.throwIfAborted();
    if (
      !within(root, directory) ||
      (await checkedRoot(directory)) !== directory ||
      !(await lstat(directory)).isDirectory()
    )
      throw new ExecError("outside_workplace");
  }
  if (
    !within(root, target) ||
    !setupWriteRoot ||
    input.denyWriteRoots?.some((path) => within(path, target) || within(target, path))
  )
    throw new ExecError("outside_workplace");
  const names = relative(root, target).split(sep).filter(Boolean);
  if (
    names.length > 32 ||
    [...root.split(sep), ...names].some((name) => forbidden.has(name.toLowerCase()))
  )
    throw new ExecError("outside_workplace");
  const reads = await sensitiveReadBoundary(
    options.platform,
    [options.systemHome, homedir(), input.botHome],
    options.env,
    { dataDir: input.dataDir, botHome: input.botHome },
  );
  if (!reads.permitsWriteRoot(target) || !reads.permitsWriteRoot(gitDir))
    throw new ExecError("outside_workplace");
  const held: Directory[] = [];
  async function configExists() {
    try {
      await lstat(join(gitDir, "config"));
      return true;
    } catch (error) {
      if (!missing(error)) throw error;
      return false;
    }
  }
  async function check() {
    signal.throwIfAborted();
    request.assertAuthorized();
    await verifyWorkspace([primary], signal);
    for (const dir of held) {
      const [now, pinned] = await Promise.all([
        lstat(dir.path, { bigint: true }),
        dir.handle.stat({ bigint: true }),
      ]);
      if (
        !now.isDirectory() ||
        now.isSymbolicLink() ||
        !matchesFileIdentity(now, dir) ||
        !sameFile(now, pinned) ||
        (await realpath(dir.path)) !== dir.path
      )
        throw new ExecError("outside_workplace");
    }
    signal.throwIfAborted();
    request.assertAuthorized();
  }
  async function hold(path: string) {
    await check();
    // Node has no parent-dirfd-relative mkdir. An absolute mkdir can follow a replaced
    // ancestor outside the approved root before any post-write identity check runs.
    // This function stays read-only. Missing paths are created only by the fixed SRT phase.
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isDirectory() || (await realpath(path)) !== resolve(path))
        throw new ExecError("outside_workplace");
      held.push({ path, handle, ...fileIdentity(info) });
      await check();
    } catch (error) {
      if (!held.some((dir) => dir.handle === handle)) await handle.close();
      throw error;
    }
  }
  async function close() {
    await Promise.all(held.map((dir) => dir.handle.close()));
  }
  try {
    await hold(root);
    let directory = root;
    const paths: string[] = [];
    for (const name of names) {
      directory = join(directory, name);
      paths.push(directory);
    }
    paths.push(gitDir);
    let completed = 0;
    for (const path of paths) {
      try {
        await hold(path);
        completed++;
      } catch (error) {
        if (!missing(error)) throw error;
        break;
      }
    }
    let ready = completed === paths.length;
    return {
      cwd,
      command: `cd -- ${quoteGitInitWord(cwd)} && exec ${[realExecutable, ...parsed.argv].map(quoteGitInitWord).join(" ")}`,
      remainder: request.remainder,
      existingConfig: ready && (await configExists()),
      gitDir,
      setupWriteRoot,
      setupCommand: ready ? undefined : gitDirectoryCreationCommand(gitDir),
      check,
      close,
      async complete() {
        try {
          for (const path of paths.slice(completed)) await hold(path);
          ready = true;
        } catch (error) {
          if (error instanceof ExecError) throw error;
          throw new ExecError(missing(error) ? "isolation_unavailable" : "outside_workplace");
        }
      },
      dispatchSetup() {
        signal.throwIfAborted();
        request.assertAuthorized();
      },
      dispatch() {
        signal.throwIfAborted();
        request.assertAuthorized();
        if (!ready) throw new ExecError("isolation_unavailable");
      },
      async checkFreshConfig() {
        if (await configExists()) throw new ExecError("outside_workplace");
      },
    };
  } catch (error) {
    await close();
    if (error instanceof ExecError) throw error;
    if (missing(error)) throw new ExecError("isolation_unavailable");
    throw new ExecError("outside_workplace");
  }
}
