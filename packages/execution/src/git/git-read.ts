import type { ChildProcess } from "node:child_process";
import { posix, win32 } from "node:path";
import { ExecError } from "../core/types.ts";
import {
  findGit,
  type GitProcessOptions,
  type GitProcessResult,
  killGit,
  spawnGit,
} from "./git-process.ts";
import { gitHardening } from "./git-program.ts";
import { gitRefName } from "./git-write.ts";

/**
 * Read-only Git outside the sandbox. Only typed operations exist, so no caller can supply a
 * subcommand or option; argv is fixed and never passes through a shell.
 *
 * Reads run with the folder as cwd. When the repository root is above the folder every
 * diff-family operation carries `--relative`, which limits it to the folder and prints
 * folder-relative paths, and status carries a `.` pathspec; both are no-ops at the repository
 * root. Porcelain status still prints root-relative paths, so brain strips the prefix. Log takes
 * `scoped` instead, because a `.` pathspec simplifies history (hiding empty commits and merges)
 * even at the root.
 */
export type GitReadOperation =
  | { op: "remoteNames" }
  | { op: "remoteURL"; remote: string; push?: boolean }
  | { op: "networkConfig" }
  | { op: "tracking"; branch: string }
  | { op: "ref"; kind: "branch" | "tag"; name: string }
  | { op: "refs"; kind: "branch" | "tag"; after?: string }
  | { op: "objectType"; oid: string }
  | { op: "probe" }
  | { op: "worktrees" }
  | { op: "head" }
  | { op: "status"; includeSubmodules?: boolean }
  | { op: "numstat"; base: string }
  | { op: "diff"; base: string; path: string; numstat?: boolean }
  | { op: "diffNoIndex"; left: string | null; right: string | null; numstat?: boolean }
  | { op: "commitFiles"; commit: string }
  | { op: "commitDiff"; commit: string; path: string; numstat?: boolean }
  | { op: "log"; from: string; skip: number; limit: number; scoped?: boolean; files?: boolean }
  | { op: "config"; key: "user.name" | "user.email" }
  /** One file's bytes at a commit (`parent` = its first parent), relative to the folder. */
  | { op: "blob"; commit: string; parent?: boolean; path: string }
  /** Commits ahead / behind the branch's configured upstream, from local refs only (no fetch). */
  | { op: "upstream" };

export type GitReadResult = GitProcessResult;

export interface GitReaderOptions extends GitProcessOptions {
  maxConcurrent?: number;
}

const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative"];
// -U implies a patch, so counts-only requests must not carry it (the patch would follow).
const diffFlags = (numstat?: boolean) =>
  numstat ? [...common, "--numstat"] : [...common, "--src-prefix=a/", "--dst-prefix=b/", "-U3"];

function relativePath(platform: NodeJS.Platform, path: string) {
  const paths = platform === "win32" ? win32 : posix;
  if (
    !path ||
    path.length > 4096 ||
    /[\0\r\n]/.test(path) ||
    paths.isAbsolute(path) ||
    posix.isAbsolute(path) ||
    path.split(/[\\/]/).some((part) => part === ".." || part === "")
  )
    throw new ExecError("invalid_input");
  return path;
}
function absolutePath(platform: NodeJS.Platform, path: string | null) {
  if (path === null) return "/dev/null";
  if (/[\0\r\n]/.test(path) || !(platform === "win32" ? win32 : posix).isAbsolute(path))
    throw new ExecError("invalid_input");
  return path;
}
function commit(value: string) {
  if (!oid.test(value)) throw new ExecError("invalid_input");
  return value;
}

export function gitReadArguments(platform: NodeJS.Platform, operation: GitReadOperation): string[] {
  switch (operation.op) {
    case "remoteNames":
      return ["remote"];
    case "remoteURL":
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(operation.remote))
        throw new ExecError("invalid_input");
      return [
        "remote",
        "get-url",
        ...(operation.push ? ["--push"] : []),
        "--all",
        operation.remote,
      ];
    case "networkConfig":
      return [
        "config",
        "--includes",
        "--null",
        "--name-only",
        "--get-regexp",
        "^(url\\..*\\.(insteadof|pushinsteadof)|http\\..*|filter\\..*\\.(clean|smudge|process|required))$",
      ];
    case "tracking":
      if (
        !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(operation.branch) ||
        operation.branch.includes("..")
      )
        throw new ExecError("invalid_input");
      return [
        "for-each-ref",
        "--format=%(upstream:remotename)%00%(upstream:remoteref)",
        `refs/heads/${operation.branch}`,
      ];

    case "ref":
      return [
        "show-ref",
        "--verify",
        "--hash",
        `${operation.kind === "branch" ? "refs/heads/" : "refs/tags/"}${gitRefName(operation.name)}`,
      ];
    case "objectType":
      return ["cat-file", "-t", commit(operation.oid)];
    case "refs": {
      const prefix = operation.kind === "branch" ? "refs/heads/" : "refs/tags/";
      if (
        operation.after &&
        (!operation.after.startsWith(prefix) || /[\0\r\n]/.test(operation.after))
      )
        throw new ExecError("invalid_input");
      return [
        "for-each-ref",
        "--count=51",
        "--format=%(refname)%00%(objectname)%00%(if)%(worktreepath)%(then)1%(else)0%(end)",
        `--start-after=${operation.after ?? prefix}`,
      ];
    }
    case "probe":
      return [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
        "--show-object-format",
        // Last: empty at the repository root, "sub/dir/" when the folder is inside it.
        "--show-prefix",
      ];
    case "worktrees":
      return ["worktree", "list", "--porcelain", "-z"];
    case "head":
      return ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"];
    case "status":
      return [
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--no-renames",
        operation.includeSubmodules ? "--ignore-submodules=none" : "--ignore-submodules=dirty",
        "--",
        ".",
      ];
    case "numstat":
      return [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--relative",
        "--ignore-submodules=dirty",
        commit(operation.base),
        "--",
      ];
    case "diff":
      return [
        "diff",
        ...diffFlags(operation.numstat),
        "--ignore-submodules=dirty",
        commit(operation.base),
        "--",
        relativePath(platform, operation.path),
      ];
    case "diffNoIndex":
      if (operation.left === null && operation.right === null) throw new ExecError("invalid_input");
      return [
        "diff",
        "--no-index",
        // --relative has no meaning between two absolute paths outside the index.
        ...diffFlags(operation.numstat).filter((flag) => flag !== "--relative"),
        "--",
        absolutePath(platform, operation.left),
        absolutePath(platform, operation.right),
      ];
    case "commitFiles":
      return [
        "show",
        "--format=",
        "-z",
        "--raw",
        "--numstat",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--relative",
        "--diff-merges=first-parent",
        commit(operation.commit),
        "--",
      ];
    case "commitDiff":
      return [
        "show",
        "--format=",
        ...diffFlags(operation.numstat),
        "--diff-merges=first-parent",
        commit(operation.commit),
        "--",
        relativePath(platform, operation.path),
      ];
    case "log":
      if (operation.files) {
        // %x1e opens each record so the -z name list after a header stays inside that record.
        const args = gitReadArguments(platform, { ...operation, files: false });
        args[1] = "--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1f";
        args.splice(3, 0, "-z", "--name-only", "--no-renames", "--relative");
        args.splice(args.indexOf("--"), 0, "--diff-merges=first-parent");
        return args;
      }
      if (
        !Number.isSafeInteger(operation.skip) ||
        operation.skip < 0 ||
        !Number.isInteger(operation.limit) ||
        operation.limit < 1 ||
        operation.limit > 200
      )
        throw new ExecError("invalid_input");
      return [
        "log",
        "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1e",
        "--no-show-signature",
        "-n",
        String(operation.limit),
        `--skip=${operation.skip}`,
        commit(operation.from),
        "--",
        ...(operation.scoped ? ["."] : []),
      ];
    case "config":
      if (operation.key !== "user.name" && operation.key !== "user.email")
        throw new ExecError("invalid_input");
      return ["config", "--get", operation.key];
    case "blob": {
      // "./" resolves against the folder (cwd), which matters when the repository is above it.
      const file = relativePath(platform, operation.path).split("\\").join("/");
      return [
        "cat-file",
        "blob",
        `${commit(operation.commit)}${operation.parent ? "^" : ""}:./${file}`,
      ];
    }
    case "upstream":
      return ["rev-list", "--left-right", "--count", "HEAD...@{upstream}", "--"];
  }
}

/** Created once per brain; readers never share the command executor's mutual exclusion. */
export function createGitReader(options: GitReaderOptions) {
  const limit = options.maxConcurrent ?? 4;
  let active = 0;
  const waiting: (() => void)[] = [];
  let program: Promise<string | undefined> | undefined;
  const live = new Set<ChildProcess>();
  let disposed = false;

  function locate() {
    // Only a found Git is remembered: the user may install one while Pi Bot runs (git-install.ts).
    program ??= findGit(options).then((found) => {
      if (!found) program = undefined;
      return found;
    });
    return program;
  }
  async function acquire(signal: AbortSignal) {
    while (active >= limit) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = waiting.indexOf(wake);
          if (index >= 0) waiting.splice(index, 1);
          reject(new ExecError("command_failed", "cancelled"));
        };
        waiting.push(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    active++;
    return () => {
      active--;
      waiting.shift()?.();
    };
  }

  async function run(
    operation: GitReadOperation,
    input: { cwd: string; signal: AbortSignal; timeoutMs?: number; maxBytes?: number },
  ): Promise<GitReadResult> {
    if (disposed) throw new ExecError("closed");
    const args = gitReadArguments(options.platform, operation);
    const maxBytes = input.maxBytes ?? 8 * 1024 * 1024;
    const timeoutMs = input.timeoutMs ?? 15_000;
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 64 * 1024 * 1024 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000 ||
      !(options.platform === "win32" ? win32 : posix).isAbsolute(input.cwd)
    )
      throw new ExecError("invalid_input");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    const executable = await locate();
    if (!executable) throw new ExecError("git_unavailable");
    const release = await acquire(signal);
    try {
      return await spawnGit(options, {
        executable,
        args: [...gitHardening(options.platform, executable), "--no-optional-locks", ...args],
        cwd: input.cwd,
        signal,
        cancelled: () => input.signal.aborted,
        maxBytes,
        live,
      });
    } catch (error) {
      // A missing or blocked executable may have been replaced during installation.
      if (error instanceof ExecError && error.code === "git_unavailable") program = undefined;
      throw error;
    } finally {
      release();
    }
  }
  return {
    /** Absolute path of the fixed Git executable, shared with the user's writes. */
    program: locate,
    run,
    dispose() {
      disposed = true;
      for (const child of live) killGit(options, child);
      live.clear();
    },
  };
}
export type GitReader = ReturnType<typeof createGitReader>;
