import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { sameFile } from "../core/file-identity.ts";
import { canonicalPath, missing, writablePath } from "../core/paths.ts";
import { ExecError, type FileContext } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import { applyEdits, type TextEdit } from "./replace-text.ts";
import { textDiff } from "./text-diff.ts";
import {
  sameFileVersion,
  statVersion,
  type TextSnapshot,
  textSnapshot,
  textVersion,
} from "./text-snapshot.ts";

const maxTextBytes = 256 * 1024;
const maxWriteBytes = 64 * 1024 * 1024;
function fileSignal(signal: AbortSignal) {
  return AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
}

export async function verifyOpenedReadPath(path: string, file: FileHandle) {
  if (process.platform !== "linux") return;
  // Compare the kernel's name for the descriptor directly. Resolving that name again would
  // follow any symlink installed at the old pathname after the descriptor was opened.
  const opened = await readlink(`/proc/self/fd/${file.fd}`).catch((error: unknown) => {
    // The handle is still open. A missing descriptor link means procfs verification is unavailable.
    if (missing(error)) throw new ExecError("file_failed", "unsupported_platform");
    throw error;
  });
  if (opened !== path) throw new ExecError("outside_workplace");
}

async function verifyOpenedDirectory(path: string, handle: FileHandle) {
  const [named, opened] = await Promise.all([
    lstat(path, { bigint: true }),
    handle.stat({ bigint: true }),
  ]);
  if (!named.isDirectory() || !sameFile(named, opened)) throw new ExecError("outside_workplace");
  await verifyOpenedReadPath(path, handle);
}

export async function listDir(options: FileContext & { path: string; depth?: number }) {
  const signal = fileSignal(options.signal);
  await verifyWorkspace(options.rootIdentities, signal);
  const depth = options.depth ?? 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new ExecError("invalid_input");
  const root = await canonicalPath(options.path, options.cwd);
  if (options.expectedPath && root !== options.expectedPath)
    throw new ExecError("outside_workplace");
  const entries: { name: string; type: string; size: number; modifiedAt: string }[] = [];
  let truncated = false;
  async function visit(path: string, entryPath: string, prefix: string, level: number) {
    signal.throwIfAborted();
    // Pin the directory before enumerating or looking up children. Reopening its absolute name
    // after realpath would let a concurrent rename or symlink substitute a different tree.
    const handle =
      process.platform === "linux"
        ? await open(entryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        : undefined;
    const lookup = handle ? `/proc/self/fd/${handle.fd}` : path;
    try {
      if (handle) await verifyOpenedDirectory(path, handle);
      signal.throwIfAborted();
      const directory = await opendir(lookup);
      for await (const entry of directory) {
        signal.throwIfAborted();
        if (entries.length >= 500) {
          truncated = true;
          break;
        }
        const full = join(path, entry.name);
        const child = handle ? join(lookup, entry.name) : full;
        const stat = await lstat(child);
        const name = prefix ? join(prefix, entry.name) : entry.name;
        entries.push({
          name,
          type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
        // Directory links are metadata only; traversal could silently cross the approved root.
        if (stat.isDirectory() && level < depth && (await realpath(child)) === full)
          await visit(full, child, name, level + 1);
        if (truncated) break;
      }
      if (handle) await verifyOpenedDirectory(path, handle);
    } finally {
      await handle?.close();
    }
  }
  await visit(root, root, "", 1);
  if (process.platform === "linux") await verifyWorkspace(options.rootIdentities, signal);
  return { path: root, entries, truncated };
}

export async function readFile(
  options: FileContext & { path: string; offset?: number; limit?: number; versioned?: boolean },
) {
  const signal = fileSignal(options.signal);
  await verifyWorkspace(options.rootIdentities, signal);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 2000;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 2000
  )
    throw new ExecError("invalid_input");
  const path = await canonicalPath(options.path, options.cwd);
  if (options.expectedPath && path !== options.expectedPath)
    throw new ExecError("outside_workplace");
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1n)
    throw new ExecError("outside_workplace");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    // Bind the opened descriptor to the path that was checked. Checking only around readFile
    // misses a parent directory swapped out and restored while open() follows its components.
    if (!stat.isFile() || stat.nlink > 1n || !sameFile(stat, before))
      throw new ExecError("outside_workplace");
    // Linux can verify the opened file itself, even if an ancestor is exchanged during open().
    await verifyOpenedReadPath(path, file);
    // A complete project-note read must round-trip bytes for conditional writes, including BOM.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const lines: string[] = [];
    let pending = "";
    let skipped = 0;
    let retained = 0;
    let truncated = false;
    const buffer = Buffer.alloc(32 * 1024);
    const hash =
      options.versioned && offset === 0 && stat.size <= BigInt(maxWriteBytes)
        ? createHash("sha256")
        : undefined;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer);
      hash?.update(buffer.subarray(0, bytesRead));
      let text: string;
      try {
        text = decoder.decode(buffer.subarray(0, bytesRead), { stream: bytesRead > 0 });
        if (text.includes("\0")) throw new Error("Binary");
      } catch {
        return { path, type: "binary" as const, size: Number(stat.size) };
      }
      // Discard skipped lines chunk by chunk, even when a line exceeds the returned-text cap.
      while (skipped < offset && text) {
        const newline = text.indexOf("\n");
        if (newline < 0) {
          text = "";
          break;
        }
        skipped++;
        text = text.slice(newline + 1);
      }
      pending += text;
      while (pending.includes("\n") || (!bytesRead && pending)) {
        const end = pending.indexOf("\n");
        const line = end < 0 ? pending : pending.slice(0, end + 1);
        pending = end < 0 ? "" : pending.slice(end + 1);
        if (lines.length >= limit || retained + Buffer.byteLength(line) > maxTextBytes) {
          const available = Math.max(0, maxTextBytes - retained);
          if (lines.length < limit && available)
            lines.push(
              Buffer.from(line)
                .subarray(0, available)
                .toString("utf8")
                .replace(/\uFFFD$/, ""),
            );
          truncated = true;
          break;
        }
        lines.push(line);
        retained += Buffer.byteLength(line);
      }
      if (truncated || !bytesRead) break;
      if (pending && lines.length >= limit) {
        truncated = true;
        break;
      }
      // A single extremely long line is bounded as well as normal line-based output.
      if (Buffer.byteLength(pending) > maxTextBytes) {
        const available = Math.max(0, maxTextBytes - retained);
        if (skipped >= offset && lines.length < limit && available)
          lines.push(
            Buffer.from(pending)
              .subarray(0, available)
              .toString("utf8")
              .replace(/\uFFFD$/, ""),
          );
        truncated = true;
        break;
      }
    }
    // The returned text can be cut for the model while the version still covers every byte.
    if (truncated && hash) {
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    }
    const text = lines.join("");
    if (options.versioned && !sameFileVersion(stat, await file.stat({ bigint: true })))
      throw new ExecError("file_conflict");
    return {
      ...(hash ? { version: statVersion(stat, hash.digest("hex")) } : {}),
      path,
      type: "text" as const,
      size: Number(stat.size),
      text,
      truncated,
    };
  } finally {
    try {
      await verifyReadFile(path, before, file, options, signal);
    } finally {
      await file.close();
    }
  }
}

export async function createParents(path: string, context: FileContext): Promise<void> {
  context.signal.throwIfAborted();
  try {
    if (!(await lstat(path)).isDirectory()) throw new ExecError("file_failed");
  } catch (error) {
    if (!missing(error)) throw error;
    await createParents(dirname(path), context);
    await writablePath(path, context.cwd, context.writeRoots, context.denyWriteRoots);
    context.signal.throwIfAborted();
    context.assertCurrent?.();
    await context.confirmDispatch?.();
    context.signal.throwIfAborted();
    await mkdir(path, { mode: 0o700 });
  }
}

/**
 * A file the Bot creates is the person's own work, not a secret: it gets the same permission any
 * other program's new file would (0666 minus the umask) instead of a hard-coded 0600, which left
 * every written file unreadable for teammates and other tools on Linux.
 */
export function newFileMode(): number {
  // Windows has no POSIX permission bits; the mode only controls the read-only attribute there.
  if (process.platform === "win32") return 0o666;
  return 0o666 & ~process.umask();
}

async function replacementMode(target: string): Promise<number> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile()) throw new ExecError("file_failed");
    // Keep executability without carrying setuid/setgid/sticky bits onto new content.
    return stat.mode & 0o777;
  } catch (error) {
    if (!missing(error)) throw error;
    return newFileMode();
  }
}

async function replaceFile(
  path: string,
  content: string | Buffer,
  context: FileContext,
  snapshot?: TextSnapshot,
  createOnly = false,
) {
  await verifyWorkspace(context.rootIdentities, context.signal);
  const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.length;
  if (bytes > maxWriteBytes) throw new ExecError("invalid_input");
  const target = await writablePath(path, context.cwd, context.writeRoots, context.denyWriteRoots);
  if (context.expectedPath && target !== context.expectedPath)
    throw new ExecError("outside_workplace");
  const mode = await replacementMode(target);
  await createParents(dirname(target), context);
  const parent = await lstat(dirname(target), { bigint: true });
  const temp = join(dirname(target), `.pibot-${randomUUID()}.tmp`);
  if ((await writablePath(temp, context.cwd, context.writeRoots, context.denyWriteRoots)) !== temp)
    throw new ExecError("outside_workplace");
  const file = await open(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (
      (await realpath(temp)) !== temp ||
      (await writablePath(path, context.cwd, context.writeRoots, context.denyWriteRoots)) !== target
    )
      throw new ExecError("outside_workplace");
    await file.writeFile(content, { encoding: "utf8", signal: context.signal });
    await file.chmod(mode);
    await file.sync();
    context.signal.throwIfAborted();
    const checked = await writablePath(
      path,
      context.cwd,
      context.writeRoots,
      context.denyWriteRoots,
    );
    const currentParent = await lstat(dirname(target), { bigint: true });
    if (checked !== target || !sameFile(parent, currentParent) || (await realpath(temp)) !== temp)
      throw new ExecError("outside_workplace");
    context.signal.throwIfAborted();
    context.assertCurrent?.();
    await context.confirmDispatch?.();
    context.signal.throwIfAborted();
    // A runner's dispatch confirmation can wait on another process: recheck after that wait.
    await verifyWorkspace(context.rootIdentities, context.signal);
    if (
      (await writablePath(path, context.cwd, context.writeRoots, context.denyWriteRoots)) !== target
    )
      throw new ExecError("outside_workplace");
    if (snapshot) {
      const latest = await lstat(target, { bigint: true }).catch((error: unknown) => {
        if (!missing(error)) throw error;
        throw new ExecError("file_conflict");
      });
      if (!sameFileVersion(snapshot.stat, latest)) throw new ExecError("file_conflict");
    }
    context.signal.throwIfAborted();
    context.assertCurrent?.();
    // A missing-file approval never authorizes replacing a file created during the wait.
    if (createOnly) {
      await link(temp, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw new ExecError("file_conflict");
        throw error;
      });
    } else await rename(temp, target);
    return { path: target, bytes };
  } finally {
    await file.close();
    await unlink(temp).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}

export async function writeFile(
  options: FileContext & {
    path: string;
    content: string;
    expectedHash?: string | null;
    expectedVersion?: string;
  },
) {
  const context = { ...options, signal: fileSignal(options.signal) };
  let before: TextSnapshot | undefined;
  if (options.expectedHash !== undefined || options.expectedVersion !== undefined) {
    if (typeof options.expectedHash === "string" && !/^[a-f0-9]{64}$/.test(options.expectedHash))
      throw new ExecError("invalid_input");
    await verifyWorkspace(context.rootIdentities, context.signal);
    const target = await writablePath(
      options.path,
      context.cwd,
      context.writeRoots,
      context.denyWriteRoots,
    );
    if (context.expectedPath && target !== context.expectedPath)
      throw new ExecError("outside_workplace");
    const snapshot = await textSnapshot(target, context.signal);
    const hash = snapshot ? createHash("sha256").update(snapshot.text).digest("hex") : null;
    if (
      (options.expectedHash !== undefined && hash !== options.expectedHash) ||
      (options.expectedVersion !== undefined &&
        (!snapshot || textVersion(snapshot.stat, snapshot.text) !== options.expectedVersion))
    )
      throw new ExecError("file_conflict");
    before = snapshot ?? undefined;
  }
  return replaceFile(options.path, options.content, context, before, options.expectedHash === null);
}

export async function editFile(
  options: FileContext & {
    path: string;
    old?: string;
    new?: string;
    replaceAll?: boolean;
    edits?: readonly TextEdit[];
  },
) {
  const edits = editList(options);
  const context = { ...options, signal: fileSignal(options.signal) };
  await verifyWorkspace(context.rootIdentities, context.signal);
  const target = await writablePath(
    options.path,
    options.cwd,
    options.writeRoots,
    options.denyWriteRoots,
  );
  if (options.expectedPath && target !== options.expectedPath)
    throw new ExecError("outside_workplace");
  const before = await textSnapshot(target, context.signal);
  if (!before) throw new ExecError("file_not_found");
  const content = await applyEdits(before.text, edits, context.signal);
  const diff = await textDiff(options.path, before.text, content.toString("utf8"), context.signal);
  const result = await replaceFile(options.path, content, context, before);
  return { ...result, diff };
}

/** Two call shapes, never mixed: one old/new pair, or `edits` with all replacements at once. */
function editList(options: {
  old?: string;
  new?: string;
  replaceAll?: boolean;
  edits?: readonly TextEdit[];
}): TextEdit[] {
  if (options.edits) {
    // A top-level replaceAll cannot mean anything for several edits; ignore-free rejection keeps
    // the caller from believing it was applied.
    if (options.old !== undefined || options.new !== undefined || options.replaceAll !== undefined)
      throw new ExecError("invalid_input");
    if (!options.edits.length) throw new ExecError("invalid_input");
    return [...options.edits];
  }
  if (!options.old || options.new === undefined) throw new ExecError("invalid_input");
  return [{ old: options.old, new: options.new, replaceAll: options.replaceAll }];
}

async function verifyReadFile(
  path: string,
  before: BigIntStats,
  file: FileHandle,
  options: FileContext & { versioned?: boolean },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const current = await lstat(path, { bigint: true }),
    opened = await file.stat({ bigint: true });
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink > 1n ||
    !sameFile(current, before) ||
    !sameFile(opened, before) ||
    (options.versioned && !sameFileVersion(before, current)) ||
    (await realpath(path)) !== path
  )
    throw new ExecError("outside_workplace");
  await verifyWorkspace(options.rootIdentities, signal);
}
