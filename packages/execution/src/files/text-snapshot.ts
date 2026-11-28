import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { sameFile } from "../core/file-identity.ts";
import { missing } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";

export interface TextSnapshot {
  text: string;
  // Bigint: exact NTFS file IDs and nanosecond times; numbers can alias neighbouring entities.
  stat: BigIntStats;
}
export function statVersion(stat: BigIntStats, hash: string) {
  return `${stat.mtimeNs}:${stat.size}:${hash}`;
}

export function textVersion(stat: BigIntStats, text: string) {
  return statVersion(stat, createHash("sha256").update(text).digest("hex"));
}

export const MAX_WRITE_BYTES = 64 * 1024 * 1024;
/** Same entity and unchanged content metadata (not only identity). */
export function sameFileVersion(left: BigIntStats, right: BigIntStats) {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === 1n &&
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
}

/** Bind the bounded UTF-8 read to both the opened inode and its original pathname. */
export async function textSnapshot(
  path: string,
  signal: AbortSignal,
): Promise<TextSnapshot | null> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(MAX_WRITE_BYTES)
  )
    throw new ExecError("file_failed");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFileVersion(before, await file.stat({ bigint: true })))
      throw new ExecError("file_conflict");
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, length, Math.min(32768, bytes.length - length));
      if (!bytesRead) throw new ExecError("file_conflict");
      length += bytesRead;
    }
    if (
      (await file.read(Buffer.alloc(1))).bytesRead ||
      !sameFileVersion(before, await file.stat({ bigint: true })) ||
      !sameFileVersion(before, await lstat(path, { bigint: true }))
    )
      throw new ExecError("file_conflict");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new ExecError("file_failed");
    return { text, stat: before };
  } finally {
    await file.close();
  }
}
