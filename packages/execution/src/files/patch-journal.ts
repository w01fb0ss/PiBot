import { createHash, randomUUID } from "node:crypto";
import { constants, fsyncSync, linkSync, lstatSync, unlinkSync, writeSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  type ExactStatIdentity,
  fileIdentity,
  matchesFileIdentity,
} from "../core/file-identity.ts";
import { canonicalExistingPathSync, missing, writablePath } from "../core/paths.ts";
import type { FileContext } from "../core/types.ts";
import { matchesPatchContent, PatchRecoveryError, type StagedFile } from "./patch-publish.ts";

const entity = z.object({ dev: z.string(), ino: z.string() });
const blob = entity.extend({ hash: z.string().regex(/^[a-f0-9]{64}$/u) });
const temp = blob.extend({ path: z.string().min(1).max(32768) });
const schema = z.object({
  roots: z.array(z.object({ path: z.string(), dev: z.string(), ino: z.string() })).max(64),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(32768),
        parent: entity,
        before: blob.nullable(),
        stage: temp.nullable(),
        backup: temp,
      }),
    )
    .min(1)
    .max(50),
});
type Journal = z.infer<typeof schema>;
type Identity = z.infer<typeof entity>;
// Journals survive restarts: entries use the canonical encoding so recovery compares exactly.
const identity = (value: ExactStatIdentity): Identity => {
  const { device, inode } = fileIdentity(value);
  return { dev: device, ino: inode };
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function exists(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
const owns = (stat: ExactStatIdentity | null, expected: Identity) =>
  !!stat && matchesFileIdentity(stat, { device: expected.dev, inode: expected.ino });

function checkParents(journal: Journal, file: Journal["files"][number]) {
  for (const root of journal.roots) {
    const current = lstatSync(root.path, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !owns(current, root) ||
      canonicalExistingPathSync(root.path) !== root.path
    )
      throw new PatchRecoveryError();
  }
  const parent = dirname(file.path);
  const current = lstatSync(parent, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !owns(current, file.parent) ||
    canonicalExistingPathSync(parent) !== parent
  )
    throw new PatchRecoveryError();
  for (const entry of [file.backup, file.stage])
    if (
      entry &&
      (dirname(entry.path) !== parent ||
        !/^\.pibot-[a-f0-9-]{36}\.tmp$/u.test(entry.path.slice(parent.length + 1)))
    )
      throw new PatchRecoveryError();
}
function remove(path: string, expected: z.infer<typeof blob>) {
  if (!exists(path)) return;
  if (!matchesPatchContent(path, expected)) throw new PatchRecoveryError();
  unlinkSync(path);
}
function recover(journal: Journal, committed: boolean) {
  for (const file of [...journal.files].reverse()) {
    checkParents(journal, file);
    if (!committed) {
      if (file.before && matchesPatchContent(file.path, file.before)) {
        // Rollback may have linked the original back but crashed before dropping the backup name.
        if (owns(exists(file.backup.path), file.before)) remove(file.backup.path, file.before);
      } else {
        if (file.before && !matchesPatchContent(file.backup.path, file.before))
          throw new PatchRecoveryError();
        if (exists(file.path)) {
          if (!file.stage || !matchesPatchContent(file.path, file.stage))
            throw new PatchRecoveryError();
          remove(file.path, file.stage);
        }
        if (file.before) {
          if (!matchesPatchContent(file.backup.path, file.before)) throw new PatchRecoveryError();
          linkSync(file.backup.path, file.path);
          unlinkSync(file.backup.path);
        }
      }
    }
    if (file.stage) remove(file.stage.path, file.stage);
    if (exists(file.backup.path)) {
      const original =
        file.before && owns(exists(file.backup.path), file.before) ? file.before : file.backup;
      remove(file.backup.path, original);
    }
  }
}
async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await realpath(path)) !== resolve(path) || !(await lstat(path)).isDirectory())
    throw new PatchRecoveryError();
}

/** Startup is lazy at the next mutation, while the shared writer is exclusively held. */
export async function recoverPatches(dir: string, signal: AbortSignal, context: FileContext) {
  await directory(dir);
  const names = await readdir(dir);
  if (names.length > 128) throw new PatchRecoveryError();
  let count = 0;
  for (const name of names) {
    signal.throwIfAborted();
    if (!/^[a-f0-9-]{36}\.json$/u.test(name)) throw new PatchRecoveryError();
    const path = join(dir, name);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
        throw new PatchRecoveryError();
      const bytes = Buffer.alloc(stat.size);
      let length = 0;
      while (length < bytes.length) {
        signal.throwIfAborted();
        const next = await file.read(bytes, length, bytes.length - length);
        if (!next.bytesRead) throw new PatchRecoveryError();
        length += next.bytesRead;
      }
      data = bytes.toString("utf8");
    } finally {
      await file.close();
    }
    const [body, marker] = data.split("\n");
    const parsed = schema.safeParse(JSON.parse(body ?? ""));
    if (!parsed.success) throw new PatchRecoveryError();
    if (marker !== "COMMITTED") {
      const paths = parsed.data.files.map((file) => file.path);
      for (const path of paths)
        if (
          (await writablePath(path, context.cwd, context.writeRoots, context.denyWriteRoots)) !==
          path
        )
          throw new PatchRecoveryError();
      await context.authorizeRecovery?.(paths, signal);
      signal.throwIfAborted();
      context.assertCurrent?.();
    }
    recover(parsed.data, marker === "COMMITTED");
    await unlink(path);
    count++;
  }
  return count;
}

export async function patchJournal(
  dir: string,
  files: StagedFile[],
  context: FileContext,
  next: readonly (string | null)[],
) {
  await directory(dir);
  const value: Journal = {
    roots: (context.rootIdentities ?? []).map((root) => ({
      path: root.canonicalPath,
      dev: root.device ?? "",
      ino: root.inode ?? "",
    })),
    files: files.map((file, i) => ({
      path: file.path,
      parent: identity(file.parent),
      before: file.before ? { ...identity(file.before.stat), hash: hash(file.before.text) } : null,
      stage: file.stage
        ? { ...identity(file.stage.stat), path: file.stage.path, hash: hash(next[i] ?? "") }
        : null,
      backup: { ...identity(file.backup.stat), path: file.backup.path, hash: hash("") },
    })),
  };
  const path = join(dir, `${randomUUID()}.json`);
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(path);
    throw error;
  }
  // Keep the descriptor through the synchronous commit; no later reopen can select a swapped journal.
  let closed = false;
  return {
    commit() {
      const marker = Buffer.from("\nCOMMITTED\n");
      let offset = 0;
      while (offset < marker.length) {
        const written = writeSync(file.fd, marker, offset, marker.length - offset);
        if (!written) throw new PatchRecoveryError();
        offset += written;
      }
      fsyncSync(file.fd);
    },
    async close() {
      if (!closed) {
        closed = true;
        await file.close();
      }
    },
    async clear() {
      recover(value, true);
      await unlink(path);
    },
  };
}
