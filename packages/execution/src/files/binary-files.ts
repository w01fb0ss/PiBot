import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sameFile } from "../core/file-identity.ts";
import { canonicalPath, missing, writablePath } from "../core/paths.ts";
import { ExecError, type FileContext } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import { createParents, newFileMode, verifyOpenedReadPath } from "./files.ts";

const LIMIT = 20 * 1024 * 1024;
export const binaryRevision = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export class BinaryPublicationError extends ExecError {
  readonly publication: { path: string; bytes: number; revision: string };
  constructor(publication: { path: string; bytes: number; revision: string }) {
    super("file_failed", "cleanup_failed");
    this.publication = publication;
  }
}

/** The caller supplies the exact canonical path approved by policy, not a fresh path grant. */
export async function readBinaryFile(options: FileContext & { path: string; maxBytes?: number }) {
  const limit = options.maxBytes ?? LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 * 1024 * 1024)
    throw new ExecError("invalid_input");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]);
  await verifyWorkspace(options.rootIdentities, signal);
  const path = await canonicalPath(options.path, options.cwd);
  if (!options.expectedPath || path !== options.expectedPath)
    throw new ExecError("outside_workplace");
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(limit)
  )
    throw new ExecError("file_failed");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !sameFile(stat, before) || stat.size > BigInt(limit))
      throw new ExecError("outside_workplace");
    await verifyOpenedReadPath(path, file);
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const part = await file.read(bytes, offset, Math.min(32768, bytes.length - offset));
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    if (offset !== bytes.length || (await file.read(Buffer.alloc(1))).bytesRead)
      throw new ExecError("file_failed");
    const current = await lstat(path, { bigint: true });
    const after = await file.stat({ bigint: true });
    if (
      (await realpath(path)) !== path ||
      !sameFile(current, stat) ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    )
      throw new ExecError("outside_workplace");
    await verifyWorkspace(options.rootIdentities, signal);
    signal.throwIfAborted();
    return { path, bytes, revision: binaryRevision(bytes) };
  } finally {
    await file.close();
  }
}

/** Publish a new name exclusively, following the existing image-file publication boundary. */
export async function writeBinaryFile(
  options: FileContext & {
    path: string;
    bytes: Uint8Array;
    maxBytes?: number;
    revalidate(): Promise<void>;
  },
) {
  if (!(options.bytes instanceof Uint8Array) || !options.bytes.length)
    throw new ExecError("invalid_input");
  return publishNewBinaryFile(options);
}

/** Internal command output may be empty; public binary-write input stays nonempty. */
export async function publishNewBinaryFile(
  options: FileContext & {
    path: string;
    bytes: Uint8Array;
    maxBytes?: number;
    revalidate(): Promise<void>;
  },
) {
  const limit = options.maxBytes ?? LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 * 1024 * 1024)
    throw new ExecError("invalid_input");
  if (
    !(options.bytes instanceof Uint8Array) ||
    options.bytes.length > limit ||
    !options.rootIdentities?.length
  )
    throw new ExecError("invalid_input");
  const bytes = Buffer.from(options.bytes);
  const context = {
    ...options,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]),
    rootIdentities: options.rootIdentities.map((item) => ({ ...item })),
    writeRoots: [...options.writeRoots],
    denyWriteRoots: options.denyWriteRoots ? [...options.denyWriteRoots] : undefined,
  };
  await verifyWorkspace(context.rootIdentities, context.signal);
  const target = await writablePath(
    options.path,
    options.cwd,
    context.writeRoots,
    context.denyWriteRoots,
  );
  if (!options.expectedPath || target !== options.expectedPath)
    throw new ExecError("outside_workplace");
  await createParents(dirname(target), context);
  const parent = await lstat(dirname(target), { bigint: true });
  const temporary = join(dirname(target), `.pibot-${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const owned = await file.stat({ bigint: true }).catch(async (error) => {
    await file.close();
    throw error;
  });
  const publication = { path: target, bytes: bytes.length, revision: binaryRevision(bytes) };
  let published = false;
  let removed = false;
  async function cleanup() {
    let failure: unknown;
    let failed = false;
    try {
      if (!published && (await file.stat()).nlink === 1) {
        await file.truncate(0);
        await file.sync();
      }
      if (!removed) {
        try {
          const current = await lstat(temporary, { bigint: true });
          if (sameFile(current, owned)) await unlink(temporary);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
    } catch (error) {
      failure = error;
      failed = true;
    }
    try {
      await file.close();
    } catch (error) {
      // Preserve the first cleanup failure while still attempting to release the handle.
      if (!failed) failure = error;
      failed = true;
    }
    if (failed) {
      if (published) throw new BinaryPublicationError(publication);
      throw failure;
    }
  }
  async function check(signal = context.signal) {
    await verifyWorkspace(context.rootIdentities, signal);
    const parentNow = await lstat(dirname(target), { bigint: true });
    if (
      !sameFile(parent, parentNow) ||
      (await realpath(dirname(target))) !== dirname(target) ||
      (await writablePath(target, options.cwd, context.writeRoots, context.denyWriteRoots)) !==
        target
    )
      throw new ExecError("outside_workplace");
    if (!removed) {
      const current = await lstat(temporary, { bigint: true });
      if (
        !sameFile(owned, current) ||
        current.nlink !== 1n ||
        (await realpath(temporary)) !== temporary
      )
        throw new ExecError("outside_workplace");
    }
    signal.throwIfAborted();
  }
  try {
    await check();
    await file.writeFile(bytes, { signal: context.signal });
    await file.sync();
    // The temp file is 0600 so nothing reads a half-written image; the published name is the
    // person's own file and needs the mode any other new file gets (L4-4: office_create images
    // arrived unreadable for other tools).
    await file.chmod(newFileMode());
    await context.revalidate();
    // Do not yield to a model/approval operation between the final path check and exclusive publish.
    await check();
    context.assertCurrent?.();
    context.signal.throwIfAborted();
    try {
      await link(temporary, target);
      published = true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new ExecError("file_conflict");
      throw error;
    }
    const staged = await lstat(temporary, { bigint: true });
    if (!sameFile(staged, owned)) throw new ExecError("file_conflict");
    await unlink(temporary);
    removed = true;
    await check(new AbortController().signal);
    const delivered = await lstat(target, { bigint: true });
    if (!sameFile(delivered, owned)) throw new ExecError("file_conflict");
    return publication;
  } catch (error) {
    if (published) throw new BinaryPublicationError(publication);
    throw error;
  } finally {
    await cleanup();
  }
}
