import { type BigIntStats, close as closeFd, constants, fstat, open as openFd } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import {
  envExampleFilter,
  SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
  skillPackagePathSafe,
} from "@pibot/plugins-contract/full";
import { type Entry, fromFd, type ZipFile } from "yauzl";
import { rejectSymlink } from "./import-error.ts";

function fdStat(fd: number): Promise<BigIntStats> {
  return new Promise((resolve, reject) =>
    fstat(fd, { bigint: true }, (error, stat) => (error ? reject(error) : resolve(stat))),
  );
}
function invalid(): never {
  throw new Error("connector_import_invalid_source");
}
function openZip(fd: number): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromFd(
      fd,
      { autoClose: false, lazyEntries: true, decodeStrings: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("connector_import_invalid_source"));
        else resolve(zip);
      },
    );
  });
}
function nextEntry(zip: ZipFile, signal: AbortSignal): Promise<Entry | null> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off("entry", entry);
      zip.off("end", end);
      zip.off("error", error);
    };
    const entry = (value: Entry) => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    };
    const end = () => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve(null);
    };
    const error = (value: unknown) => {
      cleanup();
      reject(value);
    };
    // Metadata reads are bounded. Drain their callback before closing the fd on cancellation,
    // otherwise yauzl could issue its next header read against a recycled descriptor.
    zip.once("entry", entry);
    zip.once("end", end);
    zip.once("error", error);
    zip.readEntry();
  });
}

/** Random-access ZIP metadata and one streamed resource at a time, always into private staging. */
export async function extractPluginZip(
  source: string,
  destination: string,
  signal: AbortSignal,
  activity?: () => void,
): Promise<string> {
  const fd = await new Promise<number>((resolve, reject) =>
    openFd(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, (error, fd) =>
      error ? reject(error) : resolve(fd),
    ),
  );
  let zip: ZipFile | undefined;
  let created = false;
  try {
    const stat = await fdStat(fd);
    if (!stat.isFile() || stat.size > BigInt(SKILL_IMPORT_MAX_BYTES)) invalid();
    zip = await openZip(fd);
    await mkdir(destination, { recursive: false, mode: 0o700 });
    created = true;
    const root = await realpath(destination);
    const names = new Map<string, string>();
    const files = new Set<string>();
    const directories = new Set<string>();
    const top = new Set<string>();
    let count = 0,
      total = 0,
      raw = 0;
    for (;;) {
      const entry = await nextEntry(zip, signal);
      activity?.();
      if (!entry) break;
      if (++raw > 100_000) invalid();
      const directory = entry.fileName.endsWith("/");
      const name = (directory ? entry.fileName.slice(0, -1) : entry.fileName).normalize("NFC");
      if (!skillPackagePathSafe(name) || entry.generalPurposeBitFlag & 1) invalid();
      const mode =
        entry.versionMadeBy >>> 8 === 3 ? (entry.externalFileAttributes >>> 16) & 0o170000 : 0;
      if (mode === 0o120000) rejectSymlink(entry.fileName);
      if (mode && mode !== (directory ? 0o040000 : 0o100000)) invalid();
      const parts = name.split("/");
      if (parts[0]) top.add(parts[0]);
      for (let i = 1; i <= parts.length; i++) {
        const part = parts.slice(0, i).join("/"),
          key = part.toLowerCase();
        const existing = names.get(key);
        if (existing && existing !== part) invalid();
        if (i < parts.length || directory) {
          if (files.has(key)) invalid();
          directories.add(key);
        }
        names.set(key, part);
      }
      const key = name.toLowerCase();
      const target = join(root, ...parts);
      if (directory) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      if (
        files.has(key) ||
        directories.has(key) ||
        ++count > SKILL_IMPORT_MAX_FILES ||
        entry.uncompressedSize > SKILL_IMPORT_FILE_MAX_BYTES
      )
        invalid();
      files.add(key);
      total += entry.uncompressedSize;
      if (total > SKILL_IMPORT_MAX_BYTES) invalid();
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const output = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stream = await new Promise<import("node:stream").Readable>((resolve, reject) => {
          zip?.openReadStream(entry, (error, value) =>
            error || !value
              ? reject(error ?? new Error("connector_import_invalid_source"))
              : resolve(value),
          );
        });
        const abort = () => stream.destroy(new Error("connector_import_cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        const sanitize =
          entry.fileName.split("/").at(-1)?.toLowerCase() === ".env.example"
            ? envExampleFilter()
            : undefined;
        let size = 0,
          checksum = 0;
        try {
          for await (const chunk of stream) {
            signal.throwIfAborted();
            activity?.();
            checksum = crc32(chunk, checksum);
            size += chunk.length;
            if (size > entry.uncompressedSize) invalid();
            await output.writeFile(sanitize ? sanitize(chunk) : chunk);
          }
          if (size !== entry.uncompressedSize || checksum !== entry.crc32) invalid();
        } finally {
          signal.removeEventListener("abort", abort);
          stream.destroy();
        }
      } finally {
        await output.close();
      }
    }
    const latest = await fdStat(fd);
    if (
      !count ||
      stat.dev !== latest.dev ||
      stat.ino !== latest.ino ||
      stat.size !== latest.size ||
      stat.mtimeNs !== latest.mtimeNs ||
      stat.ctimeNs !== latest.ctimeNs
    )
      invalid();
    signal.throwIfAborted();
    if (top.size === 1) {
      const only = [...top][0];
      if (only) {
        const candidate = join(root, only);
        if ((await lstat(candidate)).isDirectory()) return candidate;
      }
    }
    return root;
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    if (zip) {
      const owned = zip;
      await new Promise<void>((resolve, reject) => {
        owned.once("close", resolve);
        owned.once("error", reject);
        owned.close();
      });
    } else
      await new Promise<void>((resolve, reject) =>
        closeFd(fd, (error) => (error ? reject(error) : resolve())),
      );
  }
}
