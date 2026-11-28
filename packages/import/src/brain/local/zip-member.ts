// Streams one allowlisted Takeout member through the policy-bound file handle.
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { ImportFailure, type ImportFile } from "../adapter.ts";

const TAIL_BYTES = 65_557;
const CHUNK = 64 * 1024;
const MAX_MEMBER = 512 * 1024 * 1024;
const MAX_DIRECTORY = 16 * 1024 * 1024;

type Member = {
  nameBytes: Buffer;
  method: number;
  flags: number;
  length: number;
  packed: number;
  crc: number;
  header: number;
};

function readSafeUint64(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ImportFailure("limit");
  return Number(value);
}

function parseZip64Extra(
  extra: Buffer,
  values: { length: number; packed: number; header: number; disk: number },
) {
  const needLength = values.length === 0xffffffff;
  const needPacked = values.packed === 0xffffffff;
  const needHeader = values.header === 0xffffffff;
  const needDisk = values.disk === 0xffff;
  if (!needLength && !needPacked && !needHeader && !needDisk) return values;
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const len = extra.readUInt16LE(pos + 2);
    pos += 4;
    if (pos + len > extra.length) throw new ImportFailure("format");
    if (id === 0x0001) {
      let cursor = pos;
      const end = pos + len;
      let { length, packed, header, disk } = values;
      if (needLength) {
        if (cursor + 8 > end) throw new ImportFailure("format");
        length = readSafeUint64(extra, cursor);
        cursor += 8;
      }
      if (needPacked) {
        if (cursor + 8 > end) throw new ImportFailure("format");
        packed = readSafeUint64(extra, cursor);
        cursor += 8;
      }
      if (needHeader) {
        if (cursor + 8 > end) throw new ImportFailure("format");
        header = readSafeUint64(extra, cursor);
        cursor += 8;
      }
      if (needDisk) {
        if (cursor + 4 > end) throw new ImportFailure("format");
        disk = extra.readUInt32LE(cursor);
        cursor += 4;
      }
      return { length, packed, header, disk };
    }
    pos += len;
  }
  throw new ImportFailure("format");
}

async function readZip64Directory(reader: ImportFile, eocdPos: number) {
  if (eocdPos < 20) throw new ImportFailure("format");
  const locator = await reader.read(eocdPos - 20, 20);
  if (
    locator.readUInt32LE(0) !== 0x07064b50 ||
    locator.readUInt32LE(4) !== 0 ||
    locator.readUInt32LE(16) !== 1
  )
    throw new ImportFailure("format");
  const eocd64Pos = readSafeUint64(locator, 8);
  if (eocd64Pos + 56 > eocdPos - 20) throw new ImportFailure("format");
  const eocd64 = await reader.read(eocd64Pos, 56);
  if (
    eocd64.readUInt32LE(0) !== 0x06064b50 ||
    readSafeUint64(eocd64, 4) !== eocdPos - 20 - eocd64Pos - 12 ||
    eocd64.readUInt32LE(16) !== 0 ||
    eocd64.readUInt32LE(20) !== 0
  )
    throw new ImportFailure("format");
  const diskEntries = readSafeUint64(eocd64, 24);
  const count = readSafeUint64(eocd64, 32);
  const bytes = readSafeUint64(eocd64, 40);
  const offset = readSafeUint64(eocd64, 48);
  if (diskEntries !== count || offset + bytes > eocd64Pos) throw new ImportFailure("format");
  if (bytes > MAX_DIRECTORY) throw new ImportFailure("limit");
  return { count, offset, limit: offset + bytes };
}

async function directory(reader: ImportFile) {
  const start = Math.max(0, reader.size - TAIL_BYTES);
  const first = Math.min(reader.size - start, CHUNK);
  const tail = Buffer.concat([
    await reader.read(start, first),
    await reader.read(start + first, reader.size - start - first),
  ]);
  for (let end = tail.length - 22; end >= 0; end--) {
    if (tail.readUInt32LE(end) !== 0x06054b50) continue;
    if (end + 22 + tail.readUInt16LE(end + 20) !== tail.length) continue;
    const eocdPos = start + end;
    const disk = tail.readUInt16LE(end + 4);
    const cdDisk = tail.readUInt16LE(end + 6);
    const diskCount = tail.readUInt16LE(end + 8);
    const count = tail.readUInt16LE(end + 10);
    const bytes = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    // A classic directory can use the full 16-bit entry count. When it ends at
    // the EOCD, there is no intervening ZIP64 record or locator.
    const classicEnd = offset + bytes === eocdPos;
    if (
      disk === 0xffff ||
      cdDisk === 0xffff ||
      bytes === 0xffffffff ||
      offset === 0xffffffff ||
      (!classicEnd &&
        eocdPos >= 20 &&
        (await reader.read(eocdPos - 20, 4)).readUInt32LE(0) === 0x07064b50)
    )
      return readZip64Directory(reader, eocdPos);
    if (disk !== 0 || cdDisk !== 0 || diskCount !== count || !classicEnd)
      throw new ImportFailure("format");
    if (bytes > MAX_DIRECTORY) throw new ImportFailure("limit");
    return { count, offset, limit: offset + bytes };
  }
  throw new ImportFailure("format");
}

function safeMemberName(nameBytes: Buffer, decoder: TextDecoder): string {
  let name: string;
  try {
    name = decoder.decode(nameBytes);
  } catch {
    throw new ImportFailure("format");
  }
  if (/^[/]|[\\:\0]|(?:^|\/)\.\.?($|\/)|\/\//.test(name)) throw new ImportFailure("format");
  return name;
}

const GEMINI_TAKEOUT = /^Takeout\/(?:[^/]+\/)?[^/]*gemini[^/]*\/([^/]+)$/i;
const ACTIVITY_JSON = /^(?:My ?Activity|我的活动记录|我的活動記錄)\.json$/i;
const ACTIVITY_HTML = /^(?:My ?Activity|我的活动记录|我的活動記錄)\.html?$/i;

async function findMatchedMember(
  reader: ImportFile,
  signal: AbortSignal,
  matcher: {
    exact?: string;
    takeoutGemini?: boolean;
  },
) {
  const index = await directory(reader);
  const bytes = await reader.read(index.offset, index.limit - index.offset);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = 0;
  let exactMatch: Member | undefined;
  let activityMatch: Member | undefined;
  let activityCount = 0;
  let fallbackMatch: Member | undefined;
  let fallbackCount = 0;
  let foundGeminiHtml = false;
  for (let n = 0; n < index.count; n++) {
    signal.throwIfAborted();
    if (n % 256 === 255) await yieldToLoop(undefined, { signal });
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new ImportFailure("format");
    const nameLen = bytes.readUInt16LE(cursor + 28);
    const extraLen = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const nameEnd = cursor + 46 + nameLen;
    const extraEnd = nameEnd + extraLen;
    const next = extraEnd + commentLen;
    if (next > bytes.length || nameLen === 0) throw new ImportFailure("format");
    const nameBytes = bytes.subarray(cursor + 46, nameEnd);
    const name = safeMemberName(nameBytes, decoder);
    const isExact = matcher.exact !== undefined && name === matcher.exact;
    const activityName = matcher.takeoutGemini ? GEMINI_TAKEOUT.exec(name)?.[1] : undefined;
    const isLocalizedJson = !!activityName && /\.json$/i.test(activityName);
    if (activityName && ACTIVITY_HTML.test(activityName)) foundGeminiHtml = true;
    if (isExact || isLocalizedJson) {
      const resolved = parseZip64Extra(bytes.subarray(nameEnd, extraEnd), {
        packed: bytes.readUInt32LE(cursor + 20),
        length: bytes.readUInt32LE(cursor + 24),
        header: bytes.readUInt32LE(cursor + 42),
        disk: bytes.readUInt16LE(cursor + 34),
      });
      if (resolved.disk !== 0) throw new ImportFailure("format");
      const mode = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0o170000;
      if (bytes[cursor + 5] === 3 && mode && mode !== 0o100000) throw new ImportFailure("format");
      const candidate: Member = {
        nameBytes,
        flags: bytes.readUInt16LE(cursor + 8),
        method: bytes.readUInt16LE(cursor + 10),
        crc: bytes.readUInt32LE(cursor + 16),
        packed: resolved.packed,
        length: resolved.length,
        header: resolved.header,
      };
      if (isExact) {
        if (exactMatch) throw new ImportFailure("format");
        exactMatch = candidate;
      } else if (activityName && ACTIVITY_JSON.test(activityName)) {
        activityCount++;
        activityMatch = candidate;
      } else {
        fallbackCount++;
        if (fallbackCount === 1) fallbackMatch = candidate;
      }
    }
    cursor = next;
  }
  if (cursor !== bytes.length) throw new ImportFailure("format");
  const match = exactMatch ?? (activityCount === 1 ? activityMatch : undefined);
  if (match) return { match, dataEnd: index.offset };
  if (activityCount === 0 && foundGeminiHtml) throw new ImportFailure("gemini_html");
  if (activityCount !== 0 || fallbackCount !== 1 || !fallbackMatch)
    throw new ImportFailure("format");
  return { match: fallbackMatch, dataEnd: index.offset };
}

async function dataOffset(reader: ImportFile, member: Member, end: number) {
  const { header, flags, method, crc, packed, length, nameBytes } = member;
  if (flags & ~0x080e || (method !== 0 && method !== 8)) throw new ImportFailure("unsupported");
  if (length > MAX_MEMBER || length > Math.max(1024 * 1024, packed * 300))
    throw new ImportFailure("limit");
  if (header + 30 + nameBytes.length > end) throw new ImportFailure("format");
  const local = await reader.read(header, 30);
  const offset = header + 30 + nameBytes.length + local.readUInt16LE(28);
  const localPacked = local.readUInt32LE(18);
  const localLength = local.readUInt32LE(22);
  if (
    local.readUInt32LE(0) !== 0x04034b50 ||
    local.readUInt16LE(6) !== flags ||
    local.readUInt16LE(8) !== method ||
    local.readUInt16LE(26) !== nameBytes.length ||
    (!(flags & 8) &&
      (local.readUInt32LE(14) !== crc ||
        (localPacked !== 0xffffffff && localPacked !== packed) ||
        (localLength !== 0xffffffff && localLength !== length))) ||
    offset + packed > end ||
    !(await reader.read(header + 30, nameBytes.length)).equals(nameBytes)
  )
    throw new ImportFailure("format");
  return offset;
}

async function* packedChunks(reader: ImportFile, offset: number, packed: number) {
  for (let read = 0; read < packed; read += CHUNK)
    yield await reader.read(offset + read, Math.min(CHUNK, packed - read));
}

async function* streamMember(
  reader: ImportFile,
  match: Member,
  dataEnd: number,
  signal: AbortSignal,
) {
  const offset = await dataOffset(reader, match, dataEnd);
  const input = Readable.from(packedChunks(reader, offset, match.packed), {
    objectMode: false,
    signal,
  });
  const output = match.method === 8 ? input.compose(createInflateRaw(), { signal }) : input;
  let size = 0;
  let checksum = 0;
  try {
    for await (const chunk of output) {
      signal.throwIfAborted();
      if (!Buffer.isBuffer(chunk)) throw new ImportFailure("format");
      size += chunk.length;
      if (size > match.length) throw new ImportFailure("format");
      checksum = crc32(chunk, checksum);
      yield chunk;
    }
    if (size !== match.length || checksum !== match.crc) throw new ImportFailure("format");
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportFailure) throw error;
    // zlib errors may carry library details; the caller only receives a format code.
    if (error instanceof Error && "code" in error && String(error.code).startsWith("Z_"))
      throw new ImportFailure("format");
    throw error;
  } finally {
    output.destroy();
    input.destroy();
    // The iterator reports any read failure; drain here before the owner closes its handle.
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
}

export async function* zipMember(reader: ImportFile, path: string, signal: AbortSignal) {
  const { match, dataEnd } = await findMatchedMember(reader, signal, { exact: path });
  yield* streamMember(reader, match, dataEnd, signal);
}

/**
 * Matches the Gemini My Activity JSON inside English or localized Google Takeout ZIP archives,
 * rejecting path traversal and flagging HTML-only exports with a dedicated `gemini_html` error.
 */
export async function* zipTakeoutGeminiMember(
  reader: ImportFile,
  exactPath: string,
  signal: AbortSignal,
) {
  const { match, dataEnd } = await findMatchedMember(reader, signal, {
    exact: exactPath,
    takeoutGemini: true,
  });
  yield* streamMember(reader, match, dataEnd, signal);
}
