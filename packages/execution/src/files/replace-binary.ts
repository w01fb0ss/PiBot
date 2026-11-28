import { randomUUID } from "node:crypto";
import { type BigIntStats, constants, lstatSync, renameSync } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { matchesFileIdentity, sameFile } from "../core/file-identity.ts";
import { canonicalExistingPathSync, missing, writablePath } from "../core/paths.ts";
import { ExecError, type FileContext } from "../core/types.ts";
import { hashCheckpointFile } from "../managed/checkpoint-image.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import { BinaryPublicationError, binaryRevision } from "./binary-files.ts";

export async function replaceBinaryFile(
  options: FileContext & {
    path: string;
    bytes: Uint8Array;
    expectedRevision: string;
    expectedMode: number;
    revalidate(): Promise<void>;
  },
) {
  if (
    !options.rootIdentities?.length ||
    options.rootIdentities.some(({ device, inode }) => device === null || inode === null) ||
    !/^[a-f0-9]{64}$/u.test(options.expectedRevision) ||
    !(options.bytes instanceof Uint8Array) ||
    !options.bytes.length ||
    options.bytes.length > 100 * 1024 * 1024
  )
    throw new ExecError("invalid_input");
  const bytes = options.bytes;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]);
  const ctx = {
    ...options,
    signal,
    rootIdentities: options.rootIdentities.map((root) => ({ ...root })),
    writeRoots: [...options.writeRoots],
    denyWriteRoots: options.denyWriteRoots && [...options.denyWriteRoots],
  };
  await verifyWorkspace(ctx.rootIdentities, signal);
  const writable = () => writablePath(ctx.path, ctx.cwd, ctx.writeRoots, ctx.denyWriteRoots);
  const target = await writable();
  if (target !== ctx.expectedPath) throw new ExecError("outside_workplace");
  const parent = dirname(target);
  const directory = await lstat(parent, { bigint: true });
  const original = await lstat(target, { bigint: true });
  if (
    !original.isFile() ||
    original.nlink !== 1n ||
    Number(original.mode & 0o777n) !== ctx.expectedMode
  )
    throw new ExecError("file_conflict");
  const temp = join(parent, `.pibot-${randomUUID()}.tmp`);
  if ((await writablePath(temp, ctx.cwd, ctx.writeRoots, ctx.denyWriteRoots)) !== temp)
    throw new ExecError("outside_workplace");
  const file = await open(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const publication = { path: target, bytes: bytes.length, revision: binaryRevision(bytes) };
  let owned: BigIntStats | undefined;
  let published = false;
  let closed = false;
  try {
    const initial = await file.stat({ bigint: true });
    owned = initial;
    await file.writeFile(bytes, { signal });
    await file.chmod(Number(original.mode & 0o777n));
    await file.sync();
    const staged = await file.stat({ bigint: true });
    await ctx.revalidate();
    const beforeRead = await lstat(target, { bigint: true });
    const current = await hashCheckpointFile(target, signal, 100 * 1024 * 1024);
    if (
      current.hash !== ctx.expectedRevision ||
      !sameFile(original, beforeRead) ||
      beforeRead.ctimeNs !== original.ctimeNs ||
      beforeRead.mtimeNs !== original.mtimeNs
    )
      throw new ExecError("file_conflict");
    if ((await writable()) !== target) throw new ExecError("outside_workplace");
    await verifyWorkspace(ctx.rootIdentities, signal);
    await file.close();
    closed = true;
    signal.throwIfAborted();
    ctx.assertCurrent?.();
    // Node has no compare-and-rename syscall; remove JS yield points at publication and recheck
    // the exact observed version and parent. This does not lock out other applications.
    for (const identity of ctx.rootIdentities) {
      const root = lstatSync(identity.canonicalPath, { bigint: true });
      if (
        !root.isDirectory() ||
        canonicalExistingPathSync(identity.canonicalPath) !== identity.canonicalPath ||
        !matchesFileIdentity(root, identity)
      )
        throw new ExecError("outside_workplace");
    }
    const currentParent = lstatSync(parent, { bigint: true });
    if (!sameFile(directory, currentParent) || canonicalExistingPathSync(parent) !== parent)
      throw new ExecError("outside_workplace");
    const destination = lstatSync(target, { bigint: true });
    const prepared = lstatSync(temp, { bigint: true });
    if (
      !sameFile(beforeRead, destination) ||
      !destination.isFile() ||
      destination.nlink !== 1n ||
      destination.mtimeNs !== beforeRead.mtimeNs ||
      destination.ctimeNs !== beforeRead.ctimeNs ||
      destination.size !== beforeRead.size ||
      !sameFile(staged, prepared) ||
      !prepared.isFile() ||
      prepared.nlink !== 1n ||
      prepared.size !== BigInt(bytes.length) ||
      prepared.mtimeNs !== staged.mtimeNs ||
      prepared.ctimeNs !== staged.ctimeNs
    )
      throw new ExecError("file_conflict");
    try {
      renameSync(temp, target);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EBUSY" ||
        (process.platform === "win32" &&
          ["EPERM", "EACCES"].includes(String((error as NodeJS.ErrnoException).code)))
      )
        throw new ExecError("file_in_use");
      throw error;
    }
    published = true;
    if (!sameFile(staged, lstatSync(target, { bigint: true })))
      throw new BinaryPublicationError(publication);
    return publication;
  } catch (error) {
    if (published) throw new BinaryPublicationError(publication);
    throw error;
  } finally {
    try {
      if (owned && !published) {
        const current = await lstat(temp, { bigint: true }).catch((error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (current && sameFile(owned, current)) await unlink(temp);
      }
    } finally {
      if (!closed) await file.close();
    }
  }
}
