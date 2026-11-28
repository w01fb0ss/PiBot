import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { abortable, folderEntries, type PackageFile, packagePath } from "@pibot/brain/kit";
import {
  envExampleFilter,
  RpcError,
  RpcErrorCodes,
  SKILL_PACKAGE_VERIFY_TIMEOUT_MS,
} from "@pibot/skills-contract/full";

import { SharedSkillPackagesRepo } from "../../store/index.ts";

const RETAIN_MS = 7 * 86400_000;
export function sharedPackagePath(dataDir: string, id: string) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error("skill_package_invalid");
  return join(dataDir, "skill-packages", id);
}
async function realDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== resolve(path))
    throw new Error("skill_package_unsafe");
}
async function write(path: string, bytes: string | Buffer) {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function digestFolder(
  path: string,
  signal: AbortSignal,
  touch: () => void,
  { ignoreJunk = false }: { ignoreJunk?: boolean } = {},
) {
  const entries = await folderEntries(path, signal, touch);
  // Old private imports may contain Finder metadata; shared packages must remain exact trees.
  if (entries.skipped && !ignoreJunk) throw new Error("skill_package_unsafe");
  const hash = createHash("sha256");
  for (const file of entries.files.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    // Length frames arbitrary binary contents, so an embedded path/NUL cannot mimic a new file.
    hash.update(file.path).update("\0").update(String(file.bytes)).update("\0");
    for await (const chunk of file.chunks(signal, 0, file.bytes, touch)) hash.update(chunk);
  }
  return { digest: hash.digest("hex"), files: entries.files };
}
/** No links are followed while making our own read-only tree removable after retirement. */
async function removeTree(path: string, signal?: AbortSignal, touch: () => void = () => {}) {
  signal?.throwIfAborted();
  touch();
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("skill_package_unsafe");
  await chmod(path, 0o700);
  for await (const entry of await opendir(path)) {
    signal?.throwIfAborted();
    touch();
    const child = join(path, entry.name);
    if (entry.isDirectory()) await removeTree(child, signal, touch);
    else if (entry.isFile()) {
      await chmod(child, 0o600);
      await rm(child);
    } else throw new Error("skill_package_unsafe");
  }
  await rmdir(path);
}
async function seal(path: string, signal: AbortSignal, touch: () => void) {
  touch();
  signal.throwIfAborted();
  for await (const entry of await opendir(path)) {
    signal?.throwIfAborted();
    touch();
    const child = join(path, entry.name);
    if (entry.isDirectory()) await seal(child, signal, touch);
    else if (entry.isFile()) {
      await chmod(child, 0o400);
      touch();
    } else throw new Error("skill_package_unsafe");
  }
  await chmod(path, 0o500);
}

/** One owner per application data root; group stores share it rather than using their scoped root. */
export class SharedSkillPackages {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly repo: SharedSkillPackagesRepo;
  private readonly damaged = new Set<string>();
  private readonly verified = new Set<string>();
  constructor(
    readonly dataDir: string,
    db: DatabaseSync,
    private readonly logger?: { warn(message: string): void },
  ) {
    this.repo = new SharedSkillPackagesRepo(db);
  }
  digest(id: string) {
    return this.repo.get(id)?.digest;
  }
  has(id: string) {
    return this.verified.has(id) && !this.damaged.has(id) && this.repo.get(id) !== undefined;
  }
  /** A reader can request its own package without waiting for the whole startup sweep. */
  async ensureReadable(id: string, parent?: AbortSignal): Promise<boolean> {
    parent?.throwIfAborted();
    if (this.has(id)) return true;
    if (this.damaged.has(id) || !this.repo.get(id)) return false;
    const timeout = AbortSignal.timeout(SKILL_PACKAGE_VERIFY_TIMEOUT_MS);
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    let started = false;
    const work = this.exclusive(() => {
      signal.throwIfAborted();
      started = true;
      return this.verifyRegistered(id, signal, () => {});
    });
    try {
      return await abortable(work, signal);
    } catch (error) {
      // Queued work will do no I/O after cancellation. A started hash owns open handles and
      // must unwind before its reader returns or the next writer enters the queue.
      if (started && signal.aborted) await Promise.allSettled([work]);
      parent?.throwIfAborted();
      if (timeout.aborted)
        throw new RpcError(RpcErrorCodes.timeout, "skill_package_verify_timeout");
      throw error;
    }
  }
  private exclusive<T>(action: () => Promise<T>, queuedTouch?: () => void): Promise<T> {
    // Waiting is progress: another publisher owns the disk, not a stalled copy.
    const timer = queuedTouch ? setInterval(queuedTouch, 10_000) : undefined;
    timer?.unref();
    const start = () => {
      clearInterval(timer);
      return action();
    };
    const work = this.queue.then(start, start).finally(() => clearInterval(timer));
    this.queue = work.catch(() => undefined);
    return work;
  }
  private warn(event: string, id?: string) {
    this.logger?.warn(
      JSON.stringify({ module: "skills", event, ...(id ? { packageId: id } : {}) }),
    );
  }
  reuse(id: string, signal: AbortSignal, touch: () => void) {
    return this.exclusive(async () => {
      try {
        await this.verify(id, signal, touch);
      } catch (error) {
        signal.throwIfAborted();
        this.damaged.add(id);
        this.warn("skill_package_damaged", id);
        throw error;
      }
    }, touch);
  }
  private async verify(id: string, signal: AbortSignal, touch: () => void) {
    signal.throwIfAborted();
    const row = this.repo.get(id);
    if (!row) throw new Error("skill_package_missing");
    const path = sharedPackagePath(this.dataDir, id);
    await realDirectory(path);
    if (
      row.digest.slice(0, 16) !== id ||
      (await digestFolder(path, signal, touch)).digest !== row.digest
    ) {
      throw new Error("skill_package_changed");
    }
    signal.throwIfAborted();
    this.verified.add(id);
  }
  private async verifyRegistered(id: string, signal: AbortSignal, touch: () => void) {
    signal.throwIfAborted();
    if (this.has(id)) return true;
    if (this.damaged.has(id) || !this.repo.get(id)) return false;
    try {
      await this.verify(id, signal, touch);
      return true;
    } catch {
      signal.throwIfAborted();
      this.damaged.add(id);
      this.warn("skill_package_damaged", id);
      return false;
    }
  }
  async publish(
    text: string,
    files: readonly PackageFile[],
    populate: ((staging: string) => Promise<void>) | undefined,
    signal: AbortSignal,
    touch: () => void,
    expectedHash?: string,
  ): Promise<string> {
    return this.exclusive(async () => {
      signal.throwIfAborted();
      const root = join(this.dataDir, "skill-packages");
      await mkdir(root, { recursive: true, mode: 0o700 });
      await realDirectory(root);
      const stage = join(root, `.import-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 });
      try {
        await populate?.(stage);
        for (const file of files) {
          signal.throwIfAborted();
          const path = join(stage, ...packagePath(file.path).split("/"));
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await write(
            path,
            basename(path).toLowerCase() === ".env.example"
              ? envExampleFilter()(file.data)
              : file.data,
          );
          touch();
        }
        await write(join(stage, "SKILL.md"), text);
        const { digest } = await digestFolder(stage, signal, touch);
        if (expectedHash && digest !== expectedHash)
          throw new RpcError(RpcErrorCodes.invalidParams, "skill_link_source_changed");
        const id = digest.slice(0, 16);
        const target = sharedPackagePath(this.dataDir, id);
        const row = this.repo.get(id);
        if (row && row.digest !== digest) throw new Error("skill_package_collision");
        const exists = await lstat(target).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (exists) {
          await realDirectory(target);
          if ((await digestFolder(target, signal, touch)).digest !== digest) {
            this.damaged.add(id);
            throw new Error("skill_package_changed");
          }
        } else {
          await seal(stage, signal, touch);
          signal.throwIfAborted();
          for (let attempt = 0; ; attempt++) {
            try {
              await rename(stage, target);
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt >= 3) throw error;
              await delay(100 * (attempt + 1), undefined, { signal });
              touch();
            }
          }
        }
        const now = new Date().toISOString();
        this.repo.register(id, digest, now);
        this.damaged.delete(id);
        this.verified.add(id);
        return id;
      } finally {
        await removeTree(stage);
      }
    }, touch);
  }
  private retained(id: string, now: number) {
    const at = this.repo.get(id)?.unreferencedAt;
    return this.repo.referenced(id) || (!!at && now - Date.parse(at) < RETAIN_MS);
  }
  /** Queue orphan collection before accepting publications, then yield between package hashes. */
  async maintain(signal: AbortSignal, touch: () => void, now = Date.now()) {
    try {
      await this.exclusive(() => this.collect(signal, touch, now));
      let after = "";
      for (;;) {
        signal.throwIfAborted();
        const rows = this.repo.page(after);
        if (!rows.length) break;
        for (const id of rows) {
          touch();
          if (!this.retained(id, now) || this.has(id) || this.damaged.has(id)) continue;
          await this.exclusive(() => this.verifyRegistered(id, signal, touch), touch);
        }
        after = rows.at(-1) as string;
      }
    } catch {
      signal.throwIfAborted();
      this.warn("skill_packages_maintenance_failed");
    }
  }
  private async collect(signal: AbortSignal, touch: () => void, now: number) {
    const root = join(this.dataDir, "skill-packages");
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await realDirectory(root);
      for await (const entry of await opendir(root)) {
        signal.throwIfAborted();
        touch();
        try {
          if (entry.name.startsWith(".import-")) {
            await removeTree(join(root, entry.name), signal, touch);
            continue;
          }
          if (!/^[0-9a-f]{16}$/.test(entry.name)) continue;
          if (this.retained(entry.name, now)) continue;
          await removeTree(sharedPackagePath(this.dataDir, entry.name), signal, touch);
          this.repo.remove(entry.name);
        } catch {
          signal.throwIfAborted();
          // Never leak a path or raw OS error; one locked or corrupt tree must not stop startup.
          if (/^[0-9a-f]{16}$/.test(entry.name) && this.repo.referenced(entry.name)) {
            this.damaged.add(entry.name);
            this.warn("skill_package_damaged", entry.name);
          } else this.warn("skill_package_gc_failed");
        }
      }
      // A crash between directory removal and row removal leaves no directory to enumerate.
      let after = "";
      for (;;) {
        const rows = this.repo.page(after);
        if (!rows.length) break;
        for (const id of rows) {
          signal.throwIfAborted();
          touch();
          try {
            await lstat(sharedPackagePath(this.dataDir, id));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              this.warn("skill_package_stat_failed", id);
              continue;
            }
            if (this.repo.referenced(id)) {
              this.damaged.add(id);
              this.warn("skill_package_missing", id);
            } else this.repo.remove(id);
          }
        }
        after = rows.at(-1) as string;
      }
    } catch {
      signal.throwIfAborted();
      this.warn("skill_packages_maintenance_failed");
    }
  }
}
