// Binds a native picker or brain-resolved local selection to read-only, policy-checked file access.
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import type { CapabilityContext } from "@pibot/brain/kit";
import { sensitiveReadBoundary } from "@pibot/execution";
import type { ImportSource } from "@pibot/import-contract";
import { containsPath, nodeFileSystem, protectedPaths } from "@pibot/policy";
import { ImportFailure, type ImportFile, type ImportInput } from "./adapter.ts";
import {
  aiBoundaryRootFor,
  isLocalSource,
  type LocalSource,
  localSelection,
  sameLocalPath,
  supportsLocalSources,
} from "./local/locations.ts";

export type HostPaths = Pick<
  CapabilityContext["local"]["deps"],
  "dataDir" | "env" | "platform" | "userHome"
>;

export const MAX_FILE_BYTES = 1024n * 1024n * 1024n;
// Consumer ZIP64 exports (ChatGPT / Claude / Google Takeout) can exceed 4 GiB because of media
// attachments that we never read; the ZIP readers still bound directory and JSON member sizes.
const MAX_ARCHIVE_BYTES = 16n * 1024n * 1024n * 1024n;
const MAX_DECOMPRESSED_BYTES = Number(MAX_FILE_BYTES);
const CHUNK_BYTES = 64 * 1024;

function isConsumerArchive(source: ImportSource, resolved: string): boolean {
  return (
    (source === "chatgpt" || source === "claude" || source === "gemini") &&
    extname(resolved).toLowerCase() === ".zip"
  );
}

function checkFile(selected: BigIntStats, localSession: boolean, ...current: BigIntStats[]) {
  if (
    current.some(
      (stat) =>
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.dev !== selected.dev ||
        stat.ino !== selected.ino,
    )
  )
    throw new ImportFailure("source_changed");
  if (current.some((stat) => stat.mtimeNs !== selected.mtimeNs || stat.size !== selected.size))
    throw new ImportFailure(localSession ? "source_in_use" : "source_changed");
  if (current.some((stat) => stat.ctimeNs !== selected.ctimeNs))
    throw new ImportFailure("source_changed");
}

async function assertProtected(
  deps: HostPaths,
  paths: readonly string[],
  narrowRoots: ReadonlySet<string>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { platform, userHome, env, dataDir } = deps;
  const sensitive = await sensitiveReadBoundary(platform, [userHome], env);
  // The narrow grant excludes just the relevant AI root, never overlapping credentials or dataDir.
  const excluded = narrowRoots.size
    ? [
        ...sensitive.credentialReadRoots,
        ...sensitive.aiConfigReadBoundary.roots.filter((root) => !narrowRoots.has(root)),
      ]
    : sensitive.denyRead;
  const policy = await protectedPaths(
    {
      platform,
      home: userHome,
      cwd: userHome,
      roots: [...paths],
      fs: nodeFileSystem,
      signal,
    },
    [...excluded, dataDir],
  );
  signal.throwIfAborted();
  if (paths.some((candidate) => policy.covers(candidate)))
    throw new ImportFailure("source_changed");
}

async function authorize(
  deps: HostPaths,
  source: ImportSource,
  path: string,
  resolved: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { platform, userHome, env } = deps;
  const narrowRoots = new Set<string>();
  let projectNote = false;
  if (source === "gemini") {
    const exts = [path, resolved].map((name) => extname(name).toLowerCase());
    if (exts.some((ext) => ext === ".html" || ext === ".htm"))
      throw new ImportFailure("gemini_html");
    if (exts.some((ext) => ext !== ".zip" && ext !== ".json")) throw new ImportFailure("format");
  }
  if (isLocalSource(source)) {
    if (!supportsLocalSources(platform)) throw new ImportFailure("unsupported");
    const requested = localSelection(source, platform, userHome, path, env);
    const home = await realpath(userHome);
    if (
      containsPath(userHome, path, platform) &&
      !sameLocalPath(platform, userHome, home, path, resolved)
    )
      throw new ImportFailure("source_changed");
    const actual = localSelection(source, platform, home, resolved, env);
    if (requested.configRoot && actual.configRoot) {
      narrowRoots.add(requested.configRoot);
      narrowRoots.add(actual.configRoot);
      if (requested.aiRoot) narrowRoots.add(requested.aiRoot);
      if (actual.aiRoot) narrowRoots.add(actual.aiRoot);
    }
    projectNote = requested.kind === "projectNote";
  }
  await assertProtected(deps, [path, resolved], narrowRoots, signal);
  return projectNote;
}

/**
 * Authorizes a brain-resolved file strictly inside one of `allowedRoots`, applying the same
 * realpath containment, link-count, and sensitive-read boundary checks as picker selection.
 */
export async function authorizeRootedFile(
  deps: HostPaths,
  source: LocalSource,
  allowedRoots: readonly string[],
  filePath: string,
  signal: AbortSignal,
  options?: { allowAiRoot?: boolean },
): Promise<{ selected: BigIntStats; resolved: string }> {
  signal.throwIfAborted();
  const { platform, userHome, env } = deps;
  if (!supportsLocalSources(platform)) throw new ImportFailure("unsupported");
  const selected = await lstat(filePath, { bigint: true });
  if (!selected.isFile() || selected.nlink !== 1n) throw new ImportFailure("source_changed");
  const resolved = await realpath(filePath);
  let contained = false;
  const narrowRoots = new Set<string>();
  for (const root of allowedRoots) {
    if (!containsPath(root, filePath, platform)) continue;
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (!canonicalRoot || !containsPath(canonicalRoot, resolved, platform)) continue;
    contained = true;
    if (options?.allowAiRoot !== false) {
      narrowRoots.add(root);
      narrowRoots.add(canonicalRoot);
    }
    break;
  }
  if (!contained) throw new ImportFailure("source_changed");
  if (options?.allowAiRoot !== false) {
    const home = await realpath(userHome).catch(() => userHome);
    const aiRequested = aiBoundaryRootFor(source, platform, userHome, env);
    const aiCanonical = aiBoundaryRootFor(source, platform, home, env);
    if (aiRequested) narrowRoots.add(aiRequested);
    if (aiCanonical) narrowRoots.add(aiCanonical);
  }
  await assertProtected(deps, [filePath, resolved], narrowRoots, signal);
  return { selected, resolved };
}

/** Streams zstd-compressed bytes through `node:zlib`, bounding the decompressed size. */
export async function* zstdDecompressStream(
  rawChunks: AsyncIterable<Buffer>,
  signal: AbortSignal,
  maxBytes = MAX_DECOMPRESSED_BYTES,
): AsyncGenerator<Buffer> {
  const input = Readable.from(rawChunks, { objectMode: false, signal });
  const output = input.compose(createZstdDecompress(), { signal });
  let total = 0;
  try {
    for await (const chunk of output) {
      signal.throwIfAborted();
      if (!Buffer.isBuffer(chunk)) throw new ImportFailure("format");
      total += chunk.length;
      if (total > maxBytes) throw new ImportFailure("limit");
      yield chunk;
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportFailure) throw error;
    if (error instanceof Error && "code" in error && String(error.code).startsWith("Z"))
      throw new ImportFailure("format");
    if (error instanceof Error && /zstd|decompress/i.test(error.message))
      throw new ImportFailure("format");
    throw error;
  } finally {
    output.destroy();
    input.destroy();
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
}

export async function selectedInput(
  deps: HostPaths,
  path: string,
  signal: AbortSignal,
  source: ImportSource = "fixture",
): Promise<ImportInput> {
  signal.throwIfAborted();
  if (isLocalSource(source)) {
    if (!supportsLocalSources(deps.platform)) throw new ImportFailure("unsupported");
    localSelection(source, deps.platform, deps.userHome, path, deps.env);
  }
  const selected = await lstat(path, { bigint: true });
  if (!selected.isFile() || selected.nlink !== 1n) throw new ImportFailure("source_changed");
  const resolved = await realpath(path);
  const projectNote = await authorize(deps, source, path, resolved, signal);
  const maxBytes = isConsumerArchive(source, resolved) ? MAX_ARCHIVE_BYTES : MAX_FILE_BYTES;
  if (selected.size > maxBytes) throw new ImportFailure("limit");
  const localSession = !projectNote && isLocalSource(source);
  const compressedZst = source === "codex" && path.toLowerCase().endsWith(".jsonl.zst");
  const file = (readSignal: AbortSignal) =>
    openSelected(deps, source, path, resolved, selected, localSession, readSignal);
  const rawChunks = async function* (readSignal: AbortSignal) {
    for await (const selectedFile of file(readSignal)) {
      if (selectedFile.size > Number(MAX_FILE_BYTES)) throw new ImportFailure("limit");
      for (let offset = 0; offset < selectedFile.size; offset += CHUNK_BYTES) {
        yield await selectedFile.read(offset, Math.min(CHUNK_BYTES, selectedFile.size - offset));
      }
    }
  };
  const input: ImportInput = compressedZst
    ? (readSignal) => zstdDecompressStream(rawChunks(readSignal), readSignal)
    : rawChunks;
  input.file = file;
  input.modifiedAt = new Date(Number(selected.mtimeMs)).toISOString();
  input.sourcePath = resolved;
  if (projectNote) input.projectNote = true;
  return input;
}

/** Binds a brain-resolved rooted local file to an `ImportInput` with full identity verification. */
export async function rootedLocalInput(
  deps: HostPaths,
  source: LocalSource,
  allowedRoots: readonly string[],
  filePath: string,
  signal: AbortSignal,
  options?: { allowAiRoot?: boolean; title?: string; localSession?: boolean },
): Promise<ImportInput> {
  const { selected, resolved } = await authorizeRootedFile(
    deps,
    source,
    allowedRoots,
    filePath,
    signal,
    options,
  );
  if (selected.size > MAX_FILE_BYTES) throw new ImportFailure("limit");
  const localSession = options?.localSession ?? true;
  const compressedZst = source === "codex" && filePath.toLowerCase().endsWith(".jsonl.zst");
  const file = (readSignal: AbortSignal) =>
    openRooted(
      deps,
      source,
      allowedRoots,
      filePath,
      resolved,
      selected,
      localSession,
      options,
      readSignal,
    );
  const rawChunks = async function* (readSignal: AbortSignal) {
    for await (const selectedFile of file(readSignal)) {
      for (let offset = 0; offset < selectedFile.size; offset += CHUNK_BYTES) {
        yield await selectedFile.read(offset, Math.min(CHUNK_BYTES, selectedFile.size - offset));
      }
    }
  };
  const input: ImportInput = compressedZst
    ? (readSignal) => zstdDecompressStream(rawChunks(readSignal), readSignal)
    : rawChunks;
  input.file = file;
  input.modifiedAt = new Date(Number(selected.mtimeMs)).toISOString();
  input.sourcePath = resolved;
  if (options?.title) input.title = options.title;
  return input;
}

async function* openHandle(
  path: string,
  resolved: string,
  selected: BigIntStats,
  localSession: boolean,
  signal: AbortSignal,
): AsyncGenerator<ImportFile> {
  checkFile(selected, localSession, await lstat(path, { bigint: true }));
  signal.throwIfAborted();
  const file = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const checkOpenFile = async () => {
      if ((await realpath(path)) !== resolved) throw new ImportFailure("source_changed");
      checkFile(
        selected,
        localSession,
        await lstat(path, { bigint: true }),
        await file.stat({ bigint: true }),
      );
    };
    await checkOpenFile();
    const size = Number(selected.size);
    yield {
      size,
      async read(position, length) {
        if (position < 0 || length < 0 || position + length > size)
          throw new ImportFailure("format");
        const buffer = Buffer.allocUnsafe(length);
        for (let offset = 0; offset < length; ) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
          if (!bytesRead) {
            await checkOpenFile();
            throw new ImportFailure("source_changed");
          }
          offset += bytesRead;
        }
        signal.throwIfAborted();
        return buffer;
      },
    };
    await checkOpenFile();
    signal.throwIfAborted();
  } finally {
    await file.close();
  }
}

async function* openSelected(
  deps: HostPaths,
  source: ImportSource,
  path: string,
  resolved: string,
  selected: BigIntStats,
  localSession: boolean,
  signal: AbortSignal,
): AsyncGenerator<ImportFile> {
  signal.throwIfAborted();
  const current = await realpath(path);
  await authorize(deps, source, path, current, signal);
  if (current !== resolved) throw new ImportFailure("source_changed");
  yield* openHandle(path, resolved, selected, localSession, signal);
}

async function* openRooted(
  deps: HostPaths,
  source: LocalSource,
  allowedRoots: readonly string[],
  path: string,
  resolved: string,
  selected: BigIntStats,
  localSession: boolean,
  options: { allowAiRoot?: boolean } | undefined,
  signal: AbortSignal,
): AsyncGenerator<ImportFile> {
  signal.throwIfAborted();
  const { resolved: current } = await authorizeRootedFile(
    deps,
    source,
    allowedRoots,
    path,
    signal,
    options,
  );
  if (current !== resolved) throw new ImportFailure("source_changed");
  yield* openHandle(path, resolved, selected, localSession, signal);
}
