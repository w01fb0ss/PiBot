import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  packagePath,
  readFolder,
  readScannedFile,
  type SkillSourceFile,
  scriptLike,
  textOf,
} from "@pibot/brain/kit";
import {
  envExampleFilter,
  SKILL_BODY_MAX_BYTES,
  SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
  SkillDirSchema,
  type SkillPackageFile,
} from "@pibot/skills-contract/full";

import { sharedPackagePath } from "./shared-packages.ts";

export type SkillLocation = string | { path: string; packageId?: string; packageDataDir: string };

/** Front matter adds at most ~4 KB to the body (name, 1 KB description, 20 params). */
const FILE_MAX_BYTES = SKILL_BODY_MAX_BYTES + 64 * 1024;

export function botSkillsRoot(dataDir: string, botId: string) {
  return join(dataDir, "bots", botId, "skills");
}
/** `dir` is the repository's relative `skills/<slug>`; the schema keeps it inside the Bot folder. */
export function skillFolder(dataDir: string, botId: string, dir: SkillLocation) {
  if (typeof dir !== "string" && dir.packageId)
    return sharedPackagePath(dir.packageDataDir, dir.packageId);
  return join(
    dataDir,
    "bots",
    botId,
    ...SkillDirSchema.parse(typeof dir === "string" ? dir : dir.path).split("/"),
  );
}
export function skillFilePath(dataDir: string, botId: string, dir: SkillLocation) {
  return join(skillFolder(dataDir, botId, dir), "SKILL.md");
}

// The skills folder is app-owned; a link planted there must not redirect writes or deletes.
async function assertRealFolder(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("skill_folder_unsafe");
}

export async function writeSkillFile(dataDir: string, botId: string, dir: string, text: string) {
  const root = botSkillsRoot(dataDir, botId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertRealFolder(root);
  const folder = skillFolder(dataDir, botId, dir);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await assertRealFolder(folder);
  const target = join(folder, "SKILL.md");
  const temp = join(folder, `.SKILL.md.${randomUUID()}.tmp`);
  const file = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const IMPORT_PREFIX = ".import-";

async function writeNewFile(path: string, data: string | Buffer) {
  // 0600 and never an executable bit: archive modes are ignored, scripts run via an interpreter.
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(data);
  } finally {
    await file.close();
  }
}

/**
 * Sync every new file before the staging folder is renamed into place, then the
 * folder itself. A directory fsync alone only persists the directory entries, so a power loss
 * after the rename could leave names without their data. Files are synced with bounded
 * concurrency (32) so 13k files cost a fraction of the old serial per-file fsync. Windows cannot
 * open a directory for fsync, so there only the files are synced.
 */
const SYNC_CONCURRENCY = 32;

async function syncTree(root: string, signal?: AbortSignal) {
  const files: string[] = [];
  const folders: string[] = [];
  const walk = async (folder: string) => {
    folders.push(folder);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk(root);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const path = files[next++];
      if (path === undefined) return;
      signal?.throwIfAborted();
      const file = await open(path, constants.O_RDONLY);
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SYNC_CONCURRENCY, files.length) }, () => worker()),
  );
  if (process.platform === "win32") return;
  for (const folder of folders) {
    const dir = await open(folder, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}

// `.backup-<slug>.<uuid>`: the package a write replaced, kept until its row change commits.
const BACKUP_PREFIX = ".backup-";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Writes are serialized by SkillService, so anything staged here is from a crash: a half-written
 * staging folder is dropped; a backup comes back only if its skill folder is gone (the crash hit
 * between the two renames), otherwise the new package won and the backup is stale.
 */
async function recoverStaging(root: string) {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    if (name.startsWith(IMPORT_PREFIX)) await rm(path, { recursive: true, force: true });
    else if (name.startsWith(BACKUP_PREFIX)) {
      const slug = name.slice(BACKUP_PREFIX.length, name.lastIndexOf("."));
      const folder = join(root, slug);
      const parsed = SkillDirSchema.safeParse(`skills/${slug}`);
      const present = await lstat(folder).then(
        () => true,
        (error: unknown) => {
          if (missing(error)) return false;
          throw error;
        },
      );
      if (parsed.success && !present) await rename(path, folder);
      else await rm(path, { recursive: true, force: true });
    }
  }
}

export interface PackageWrite {
  /** The row change committed: the replaced package is no longer needed. */
  commit(): Promise<void>;
  /** The row change failed: put the previous package (or nothing) back. */
  rollback(): Promise<void>;
}

/**
 * Saves a whole skill package (SKILL.md plus supporting files) atomically: everything is written
 * into a hidden staging folder next to the skills, then swapped in by rename while the previous
 * folder is kept aside, so a crash or failed write never leaves a half-written skill and the
 * caller can still undo the swap if its database change fails. Hidden names can never be a slug.
 */
export async function writeSkillPackage(
  dataDir: string,
  botId: string,
  dir: string,
  text: string,
  files: readonly { path: string; data: Buffer }[],
  populate?: (staging: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<PackageWrite> {
  const root = botSkillsRoot(dataDir, botId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertRealFolder(root);
  await recoverStaging(root);
  const staging = join(root, `${IMPORT_PREFIX}${randomUUID()}`);
  const target = skillFolder(dataDir, botId, dir);
  const backup = join(root, `${BACKUP_PREFIX}${dir.slice("skills/".length)}.${randomUUID()}`);
  let replaced = false;
  await mkdir(staging, { mode: 0o700 });
  try {
    await populate?.(staging);
    for (const file of files) {
      const path = join(staging, ...file.path.split("/"));
      const inside = relative(staging, path);
      if (!inside || inside.startsWith("..") || isAbsolute(inside))
        throw new Error("skill_path_unsafe");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeNewFile(
        path,
        basename(path).toLowerCase() === ".env.example" ? envExampleFilter()(file.data) : file.data,
      );
    }
    await writeNewFile(join(staging, "SKILL.md"), text);
    signal?.throwIfAborted();
    await syncTree(staging, signal);
    try {
      await assertRealFolder(target);
      await rename(target, backup);
      replaced = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // If this fails too, the next write's recovery restores the backup (its folder is missing).
    if (replaced) await rename(backup, target).catch(() => undefined);
    throw error;
  }
  return {
    commit: () => rm(backup, { recursive: true, force: true }),
    rollback: async () => {
      await rm(target, { recursive: true, force: true });
      if (replaced) await rename(backup, target);
    },
  };
}

/**
 * Supporting files as saved, for an edit that keeps the ones it does not name. The same reader
 * as a folder import: links refused, sizes and counts capped.
 */
export async function readSkillPackageFiles(
  dataDir: string,
  botId: string,
  dir: SkillLocation,
  signal: AbortSignal,
): Promise<{ path: string; data: Buffer }[]> {
  const folder = skillFolder(dataDir, botId, dir);
  await assertRealFolder(folder);
  return (await readFolder(folder, signal)).filter(
    (entry) => entry.path !== "SKILL.md" && !entry.path.startsWith(".SKILL.md."),
  );
}

/**
 * One supporting file's text for the editor; null when it is not UTF-8 text. Every folder on the
 * way is checked to be a real folder and the file is opened without following links.
 */
export async function readSupportingFile(
  dataDir: string,
  botId: string,
  dir: SkillLocation,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  const parts = packagePath(path).split("/");
  const name = parts.pop() ?? "";
  if (!parts.length && name.toLowerCase() === "skill.md") throw new Error("skill_path_unsafe");
  let folder = skillFolder(dataDir, botId, dir);
  await assertRealFolder(folder);
  for (const part of parts) {
    signal?.throwIfAborted();
    folder = join(folder, part);
    await assertRealFolder(folder);
  }
  const file = await open(
    join(folder, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > SKILL_IMPORT_FILE_MAX_BYTES)
      throw new Error("skill_file_invalid");
    const data = await file.readFile({ signal });
    return name.toLowerCase() === ".env.example"
      ? envExampleFilter()(data)
      : (textOf(data) ?? null);
  } finally {
    await file.close();
  }
}

const TEXT_HEAD_BYTES = 8192;
/** The list only reads the start of each file; a later full read settles it (`textOf`). */
function looksText(head: Buffer, complete: boolean) {
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: !complete });
    return true;
  } catch {
    return false;
  }
}

/**
 * Supporting files of a saved skill (everything but SKILL.md), for the detail view. Only the first
 * bytes are read to tell scripts apart; links are not followed and the walk is capped.
 */
export async function listSkillFiles(
  dataDir: string,
  botId: string,
  dir: SkillLocation,
  signal?: AbortSignal,
): Promise<(SkillPackageFile & { text: boolean })[]> {
  const folder = skillFolder(dataDir, botId, dir);
  const files: (SkillPackageFile & { text: boolean })[] = [];
  const walk = async (path: string, parts: string[]) => {
    signal?.throwIfAborted();
    for (const entry of await readdir(path, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (files.length >= SKILL_IMPORT_MAX_FILES) return;
      const absolute = join(path, entry.name);
      const name = [...parts, entry.name].join("/");
      if (entry.isDirectory()) await walk(absolute, [...parts, entry.name]);
      else if (entry.isFile() && name !== "SKILL.md" && !name.startsWith(".SKILL.md.")) {
        const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const head = Buffer.alloc(TEXT_HEAD_BYTES);
          const { bytesRead } = await file.read(head, 0, TEXT_HEAD_BYTES, 0);
          const { size } = await file.stat();
          const read = head.subarray(0, bytesRead);
          files.push({
            path: name,
            bytes: Math.min(size, SKILL_IMPORT_FILE_MAX_BYTES),
            script: scriptLike(name, read),
            text: size <= SKILL_IMPORT_FILE_MAX_BYTES && looksText(read, bytesRead >= size),
          });
        } finally {
          await file.close();
        }
      }
    }
  };
  try {
    await walk(folder, []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function readSkillFile(
  dataDir: string,
  botId: string,
  dir: SkillLocation,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const file = await open(
    skillFilePath(dataDir, botId, dir),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > FILE_MAX_BYTES) throw new Error("skill_file_invalid");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await file.readFile({ signal }),
    );
  } finally {
    await file.close();
  }
}

/** Removes one skill's folder; a missing folder is already the desired state. */
export async function removeSkillFolder(dataDir: string, botId: string, dir: string) {
  const folder = skillFolder(dataDir, botId, dir);
  try {
    await assertRealFolder(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(folder, { recursive: true, force: true });
}

/** A one-file edit never reads unrelated resources; only its old bytes are retained for rollback. */
export async function writeSkillAttachment(
  dataDir: string,
  botId: string,
  dir: string,
  text: string,
  before: string,
  old: SkillSourceFile | undefined,
  next: { path: string; data: Buffer } | undefined,
  signal: AbortSignal,
  touch: () => void,
): Promise<PackageWrite> {
  const folder = skillFolder(dataDir, botId, dir);
  await assertRealFolder(folder);
  const previous = old
    ? await readScannedFile(old, signal, SKILL_IMPORT_FILE_MAX_BYTES, touch)
    : undefined;
  const save = async (name: string, data: Buffer) => {
    const parts = packagePath(name).split("/");
    const leaf = parts.pop() ?? "";
    let parent = folder;
    for (const part of parts) {
      parent = join(parent, part);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await assertRealFolder(parent);
    }
    const temp = join(parent, `.attachment-${randomUUID()}.tmp`);
    try {
      await writeNewFile(
        temp,
        leaf.toLowerCase() === ".env.example" ? envExampleFilter()(data) : data,
      );
      await rename(temp, join(parent, leaf));
    } finally {
      await rm(temp, { force: true });
    }
  };
  const undo = async () => {
    if (next && next.path !== old?.path)
      await rm(join(folder, ...next.path.split("/")), { force: true });
    if (old && previous) await save(old.path, previous);
    await writeSkillFile(dataDir, botId, dir, before);
  };
  try {
    signal.throwIfAborted();
    if (old && old.path !== next?.path)
      await rm(join(folder, ...old.path.split("/")), { force: true });
    if (next) await save(next.path, next.data);
    await writeSkillFile(dataDir, botId, dir, text);
  } catch (error) {
    await undo();
    throw error;
  }
  return { commit: async () => {}, rollback: undo };
}
