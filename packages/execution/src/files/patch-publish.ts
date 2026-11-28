import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileIdentity, matchesFileIdentity, sameFile } from "../core/file-identity.ts";
import { canonicalExistingPathSync, missing } from "../core/paths.ts";
import { ExecError, type FileContext } from "../core/types.ts";
import { MAX_WRITE_BYTES, sameFileVersion, type TextSnapshot } from "./text-snapshot.ts";

export interface StagedFile {
  path: string;
  before: TextSnapshot | null;
  next: string | null;
  parent: BigIntStats;
  stage?: { path: string; stat: BigIntStats };
  backup: { path: string; stat: BigIntStats };
  moved?: boolean;
  published?: boolean;
}
export class PatchRecoveryError extends ExecError {
  constructor() {
    super("file_conflict", "cleanup_failed");
  }
}
function exists(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
// Journal entries spell identities with the canonical encoding (patch-journal.ts).
const sameIdentity = (stat: BigIntStats | null, expected: { dev: string; ino: string }) =>
  !!stat && matchesFileIdentity(stat, { device: expected.dev, inode: expected.ino });
/** Content checks are against the descriptor, not a pathname reopened after an identity check. */
export function matchesPatchContent(
  path: string,
  expected: { dev: string; ino: string; hash: string },
) {
  const before = exists(path);
  if (!before || !sameIdentity(before, expected)) return false;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink > 2n ||
    before.size > BigInt(MAX_WRITE_BYTES)
  )
    throw new PatchRecoveryError();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameIdentity(opened, expected) || opened.size !== before.size)
      throw new PatchRecoveryError();
    // The file may grow concurrently: read at most the pinned size plus one byte.
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const count = requireRead(fd, bytes);
    const after = fstatSync(fd, { bigint: true });
    if (
      BigInt(count) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      !sameIdentity(exists(path), expected)
    )
      throw new PatchRecoveryError();
    return createHash("sha256").update(bytes.subarray(0, count)).digest("hex") === expected.hash;
  } finally {
    closeSync(fd);
  }
}
function requireRead(fd: number, bytes: Buffer) {
  let count = 0;
  while (count < bytes.length) {
    const next = readSync(fd, bytes, count, bytes.length - count, null);
    if (!next) break;
    count += next;
  }
  return count;
}
function unchangedContent(path: string, stat: BigIntStats, text: string) {
  const identity = fileIdentity(stat);
  return matchesPatchContent(path, {
    dev: identity.device,
    ino: identity.inode,
    hash: createHash("sha256").update(text).digest("hex"),
  });
}
function parents(file: StagedFile, context: FileContext) {
  for (const root of context.rootIdentities ?? []) {
    const stat = lstatSync(root.canonicalPath, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonicalExistingPathSync(root.canonicalPath) !== root.canonicalPath ||
      !matchesFileIdentity(stat, root)
    )
      throw new ExecError("outside_workplace");
  }
  const parent = lstatSync(dirname(file.path), { bigint: true });
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !sameFile(parent, file.parent) ||
    canonicalExistingPathSync(dirname(file.path)) !== dirname(file.path)
  )
    throw new ExecError("outside_workplace");
}

/** No asynchronous boundary during publication: Stop is observed before the entire commit. */
export function publishPatch(files: StagedFile[], context: FileContext, assertCurrent: () => void) {
  context.signal.throwIfAborted();
  assertCurrent();
  for (const file of files) {
    parents(file, context);
    const current = exists(file.path);
    if (file.before ? !current || !sameFileVersion(file.before.stat, current) : !!current)
      throw new ExecError("file_conflict");
    if (
      !sameFileVersion(file.backup.stat, lstatSync(file.backup.path, { bigint: true })) ||
      (file.stage &&
        !sameFileVersion(file.stage.stat, lstatSync(file.stage.path, { bigint: true })))
    )
      throw new ExecError("file_conflict");
  }
  try {
    for (const file of files) {
      parents(file, context);
      const current = exists(file.path);
      if (file.before ? !current || !sameFileVersion(file.before.stat, current) : !!current)
        throw new ExecError("file_conflict");
      if (file.before) {
        renameSync(file.path, file.backup.path);
        file.moved = true;
      }
      if (file.stage) {
        // Exclusive publication cannot overwrite a file created after the preflight check.
        linkSync(file.stage.path, file.path);
        file.published = true;
        unlinkSync(file.stage.path);
      }
    }
  } catch (error) {
    let failed = false;
    for (const file of [...files].reverse()) {
      try {
        if (!file.moved && !file.published) continue;
        parents(file, context);
        if (file.published) {
          const current = lstatSync(file.path, { bigint: true });
          if (
            !file.stage ||
            !sameFile(current, file.stage.stat) ||
            current.nlink !== 1n ||
            !unchangedContent(file.path, file.stage.stat, file.next ?? "")
          )
            throw new ExecError("file_conflict");
          unlinkSync(file.path);
        }
        if (file.moved) {
          const backup = lstatSync(file.backup.path, { bigint: true });
          if (
            !file.before ||
            !sameFile(backup, file.before.stat) ||
            backup.nlink !== 1n ||
            !unchangedContent(file.backup.path, file.before.stat, file.before.text)
          )
            throw new ExecError("file_conflict");
          linkSync(file.backup.path, file.path);
          unlinkSync(file.backup.path);
        }
      } catch {
        failed = true;
      }
    }
    // Never delete the only surviving original or silently overwrite a concurrent user's edit.
    if (failed) throw new PatchRecoveryError();
    throw error;
  }
}
