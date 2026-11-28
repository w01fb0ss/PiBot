// Read only selected ZIP members through the authorized file descriptor, without extracting files.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { ImportFailure, type ImportFile } from "../adapter.ts";

const CHUNK = 64 * 1024;
const MAX_INFLATED = 768 * 1024 * 1024;
const MAX_DIRECTORY = 16 * 1024 * 1024;

export interface ZipMember {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  checksum: number;
  compressed: number;
  size: number;
  offset: number;
  directoryOffset: number;
  symlink: boolean;
}

function invalid(): never {
  throw new ImportFailure("format");
}

function readSafeUint64(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ImportFailure("limit");
  return Number(value);
}

function parseZip64Extra(
  extra: Buffer,
  values: { size: number; compressed: number; offset: number; disk: number },
) {
  const needSize = values.size === 0xffffffff;
  const needCompressed = values.compressed === 0xffffffff;
  const needOffset = values.offset === 0xffffffff;
  const needDisk = values.disk === 0xffff;
  if (!needSize && !needCompressed && !needOffset && !needDisk) return values;
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const len = extra.readUInt16LE(pos + 2);
    pos += 4;
    if (pos + len > extra.length) invalid();
    if (id === 0x0001) {
      let cursor = pos;
      const end = pos + len;
      let { size, compressed, offset, disk } = values;
      if (needSize) {
        if (cursor + 8 > end) invalid();
        size = readSafeUint64(extra, cursor);
        cursor += 8;
      }
      if (needCompressed) {
        if (cursor + 8 > end) invalid();
        compressed = readSafeUint64(extra, cursor);
        cursor += 8;
      }
      if (needOffset) {
        if (cursor + 8 > end) invalid();
        offset = readSafeUint64(extra, cursor);
        cursor += 8;
      }
      if (needDisk) {
        if (cursor + 4 > end) invalid();
        disk = extra.readUInt32LE(cursor);
        cursor += 4;
      }
      return { size, compressed, offset, disk };
    }
    pos += len;
  }
  return invalid();
}

async function readZip64Directory(file: ImportFile, eocdPos: number) {
  if (eocdPos < 20) invalid();
  const locator = await file.read(eocdPos - 20, 20);
  if (
    locator.readUInt32LE(0) !== 0x07064b50 ||
    locator.readUInt32LE(4) !== 0 ||
    locator.readUInt32LE(16) !== 1
  )
    invalid();
  const eocd64Pos = readSafeUint64(locator, 8);
  if (eocd64Pos + 56 > eocdPos - 20) invalid();
  const eocd64 = await file.read(eocd64Pos, 56);
  if (
    eocd64.readUInt32LE(0) !== 0x06064b50 ||
    readSafeUint64(eocd64, 4) !== eocdPos - 20 - eocd64Pos - 12 ||
    eocd64.readUInt32LE(16) !== 0 ||
    eocd64.readUInt32LE(20) !== 0
  )
    invalid();
  const diskEntries = readSafeUint64(eocd64, 24);
  const count = readSafeUint64(eocd64, 32);
  const length = readSafeUint64(eocd64, 40);
  const offset = readSafeUint64(eocd64, 48);
  if (diskEntries !== count || offset + length > eocd64Pos) invalid();
  if (length > MAX_DIRECTORY) throw new ImportFailure("limit");
  return { count, offset, length };
}

async function directoryInfo(file: ImportFile) {
  const start = Math.max(0, file.size - 65_557);
  const tail = await file.read(start, file.size - start);
  for (let end = tail.length - 22; end >= 0; end--) {
    if (
      tail.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + tail.readUInt16LE(end + 20) !== tail.length
    )
      continue;
    const eocdPos = start + end;
    const disk = tail.readUInt16LE(end + 4);
    const cdDisk = tail.readUInt16LE(end + 6);
    const diskCount = tail.readUInt16LE(end + 8);
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    // A classic directory can use the full 16-bit entry count. When it ends at
    // the EOCD, there is no intervening ZIP64 record or locator.
    const classicEnd = offset + length === eocdPos;
    if (
      disk === 0xffff ||
      cdDisk === 0xffff ||
      length === 0xffffffff ||
      offset === 0xffffffff ||
      (!classicEnd &&
        eocdPos >= 20 &&
        (await file.read(eocdPos - 20, 4)).readUInt32LE(0) === 0x07064b50)
    )
      return readZip64Directory(file, eocdPos);
    if (disk !== 0 || cdDisk !== 0 || diskCount !== count || !classicEnd) invalid();
    if (length > MAX_DIRECTORY) throw new ImportFailure("limit");
    return { count, offset, length };
  }
  return invalid();
}

export async function zipDirectory(file: ImportFile, signal: AbortSignal) {
  const directory = await directoryInfo(file);
  const bytes = await file.read(directory.offset, directory.length);
  const members = new Map<string, ZipMember>();
  let cursor = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < directory.count; index++) {
    signal.throwIfAborted();
    if (index % 256 === 255) await yieldToLoop(undefined, { signal });
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const nameLen = bytes.readUInt16LE(cursor + 28);
    const extraLen = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const nameEnd = cursor + 46 + nameLen;
    const extraEnd = nameEnd + extraLen;
    const next = extraEnd + commentLen;
    if (next > bytes.length || nameLen === 0) invalid();
    const resolved = parseZip64Extra(bytes.subarray(nameEnd, extraEnd), {
      compressed: bytes.readUInt32LE(cursor + 20),
      size: bytes.readUInt32LE(cursor + 24),
      offset: bytes.readUInt32LE(cursor + 42),
      disk: bytes.readUInt16LE(cursor + 34),
    });
    if (resolved.disk !== 0) invalid();
    const nameBytes = bytes.subarray(cursor + 46, nameEnd);
    let name: string;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      invalid();
    }
    if (/^[/]|[\\:\0]|(?:^|\/)\.\.?($|\/)|\/\//.test(name) || members.has(name)) invalid();
    members.set(name, {
      name,
      nameBytes,
      flags: bytes.readUInt16LE(cursor + 8),
      method: bytes.readUInt16LE(cursor + 10),
      checksum: bytes.readUInt32LE(cursor + 16),
      compressed: resolved.compressed,
      size: resolved.size,
      offset: resolved.offset,
      directoryOffset: directory.offset,
      symlink: (bytes.readUInt16LE(cursor + 40) & 0xf000) === 0xa000,
    });
    cursor = next;
  }
  if (cursor !== bytes.length) invalid();
  return members;
}

async function memberOffset(file: ImportFile, entry: ZipMember) {
  if (entry.symlink || entry.flags & ~0x80e || (entry.method !== 0 && entry.method !== 8))
    invalid();
  if (entry.size > MAX_INFLATED) throw new ImportFailure("limit");
  if (entry.offset + 30 > entry.directoryOffset) invalid();
  const header = await file.read(entry.offset, 30);
  const nameLength = header.readUInt16LE(26);
  const offset = entry.offset + 30 + nameLength + header.readUInt16LE(28);
  if (
    header.readUInt32LE(0) !== 0x04034b50 ||
    header.readUInt16LE(6) !== entry.flags ||
    header.readUInt16LE(8) !== entry.method ||
    offset + entry.compressed > entry.directoryOffset ||
    nameLength !== entry.nameBytes.length ||
    (entry.method === 0 && entry.compressed !== entry.size)
  )
    invalid();
  const localCompressed = header.readUInt32LE(18);
  const localSize = header.readUInt32LE(22);
  if (
    !(entry.flags & 8) &&
    (header.readUInt32LE(14) !== entry.checksum ||
      (localCompressed !== 0xffffffff && localCompressed !== entry.compressed) ||
      (localSize !== 0xffffffff && localSize !== entry.size))
  )
    invalid();
  if (!(await file.read(entry.offset + 30, nameLength)).equals(entry.nameBytes)) invalid();
  return offset;
}

async function* compressed(file: ImportFile, offset: number, length: number) {
  for (let read = 0; read < length; read += CHUNK) {
    yield await file.read(offset + read, Math.min(CHUNK, length - read));
  }
}

async function* inflate(
  input: AsyncIterable<Buffer>,
  signal: AbortSignal,
  compressedLength: number,
): AsyncGenerator<Buffer> {
  const source = Readable.from(input);
  const stream = createInflateRaw();
  const done = pipeline(source, stream, { signal });
  // Await the original promise below after reading, including errors from the authorized input.
  void done.catch(() => undefined);
  try {
    for await (const chunk of stream) yield chunk as Buffer;
    await done;
    if (stream.bytesWritten !== compressedLength) invalid();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportFailure) throw error;
    invalid();
  } finally {
    source.destroy();
    stream.destroy();
    await done.catch(() => undefined);
  }
}

export async function* zipMember(file: ImportFile, entry: ZipMember, signal: AbortSignal) {
  const offset = await memberOffset(file, entry);
  const raw = compressed(file, offset, entry.compressed);
  const input = entry.method === 0 ? raw : inflate(raw, signal, entry.compressed);
  let count = 0;
  let checksum = 0;
  for await (const chunk of input) {
    signal.throwIfAborted();
    count += chunk.length;
    if (count > entry.size) invalid();
    checksum = crc32(chunk, checksum);
    yield chunk;
  }
  if (count !== entry.size || checksum !== entry.checksum) invalid();
}
