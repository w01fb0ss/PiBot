// Deterministic pure-Node ZIP writer matching packages/import/src/brain/exports/zip.ts.
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipInputEntry {
  name: string;
  content: Buffer | string;
}

// Fixed DOS timestamp: 2026-11-18 10:00:00 (deterministic ZIP bytes across runs).
const FIXED_DOS_TIME = (10 << 11) | (0 << 5) | 0;
const FIXED_DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 18;
// General purpose bit 11 (0x0800): UTF-8 encoded filename.
const UTF8_FLAG = 0x0800;
const METHOD_DEFLATE = 8;

/** Builds a valid, deterministic ZIP archive without external dependencies. */
export function buildDeterministicZip(entries: readonly ZipInputEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (!entry.name || /^[/]|[\\:\0]|(?:^|\/)\.\.?($|\/)|\/\//.test(entry.name)) {
      throw new Error(`Invalid ZIP member name: ${entry.name}`);
    }
    const nameBytes = Buffer.from(entry.name, "utf8");
    const raw =
      typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
    const compressed = deflateRawSync(raw, { level: 6 });
    const checksum = crc32(raw) >>> 0;

    // Local file header (30 bytes + filename).
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(METHOD_DEFLATE, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBytes, compressed);

    // Central directory file header (46 bytes + filename).
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4); // version made by: Unix, ZIP 2.0
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(METHOD_DEFLATE, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file rw-r--r--
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}
