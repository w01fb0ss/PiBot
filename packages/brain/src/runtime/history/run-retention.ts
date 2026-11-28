import { lstat, opendir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { resolveSessionFile } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import { IdSchema, type RunRetentionEstimate, type RunRetentionResult } from "@pibot/protocol-base";
import { RunRetentionRepo } from "@pibot/storage";
import { z } from "zod";

const manifestSchema = z.strictObject({
  sessionFiles: z.array(z.string()),
  resultFiles: z.array(z.string()),
});
const RESULT_FILE =
  /^run-events\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt)$/i;
const ORPHAN_MIN_AGE_MS = 10 * 60_000;
const ORPHAN_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt(?:\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)?$/i;

/** Explicit, serialized run-history cleanup plus crash recovery for its file manifests. */
export class RunRetention {
  private readonly shutdown = new AbortController();
  private chain: Promise<unknown> = Promise.resolve();
  private active = 0;
  private readonly repo: RunRetentionRepo;

  constructor(
    db: import("node:sqlite").DatabaseSync,
    private readonly dataDir: string,
    private readonly logger: Logger,
  ) {
    this.db = db;
    this.repo = new RunRetentionRepo(db);
  }
  private readonly db: import("node:sqlite").DatabaseSync;

  start() {
    void this.serial(async () => {
      await this.sweepJobs();
      await this.sweepOrphans();
    }).catch(() => {
      if (!this.shutdown.signal.aborted) this.logger.warn("Run file cleanup deferred");
    });
  }

  idle() {
    return this.active === 0;
  }

  pause() {
    return this.chain.then(() => undefined);
  }

  async estimate(olderThanDays: number, signal?: AbortSignal): Promise<RunRetentionEstimate> {
    const active = signal ? AbortSignal.any([this.shutdown.signal, signal]) : this.shutdown.signal;
    active.throwIfAborted();
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const candidates = this.repo.estimateBefore(cutoff);
    const sessionFiles = new Set(candidates.sessionFiles);
    const resultFiles = new Set(candidates.resultFiles);
    let files = 0;
    let bytes = 0;
    let checked = 0;
    let incomplete = false;
    for (const row of this.cleanupJobs(active)) {
      const manifest = this.readManifest(row.value);
      if (!manifest) {
        incomplete = true;
        continue;
      }
      for (const file of manifest.sessionFiles) {
        if (++checked % 128 === 0) await yieldLoop(undefined, { signal: active });
        if (!sessionFiles.has(file) && !this.repo.sessionReferenced(file)) sessionFiles.add(file);
      }
      for (const file of manifest.resultFiles) {
        if (++checked % 128 === 0) await yieldLoop(undefined, { signal: active });
        if (!resultFiles.has(file) && !this.repo.resultReferenced(file)) resultFiles.add(file);
      }
    }
    const root = await realpath(this.dataDir);
    for (const stored of sessionFiles) {
      active.throwIfAborted();
      if (++checked % 128 === 0) await yieldLoop(undefined, { signal: active });
      const file = await this.sessionForCleanup(root, stored).catch(() => {
        incomplete = true;
        return undefined;
      });
      if (file) {
        files++;
        bytes += file.bytes;
      }
    }
    const resultDir = await this.resultDirectory().catch(() => {
      incomplete = true;
      return undefined;
    });
    if (resultDir) {
      try {
        for await (const entry of await opendir(resultDir)) {
          active.throwIfAborted();
          if (++checked % 128 === 0) await yieldLoop(undefined, { signal: active });
          if (!ORPHAN_FILE.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
          const stored = `run-events/${entry.name}`;
          const candidate = RESULT_FILE.test(stored) && resultFiles.has(stored);
          if (!candidate && !entry.name.endsWith(".tmp") && this.repo.resultReferenced(stored))
            continue;
          const info = await lstat(join(resultDir, entry.name)).catch((error) => {
            // A file removed since the directory entry was read no longer takes up space.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
            return undefined;
          });
          if (
            info?.isFile() &&
            !info.isSymbolicLink() &&
            (candidate || Date.now() - info.mtimeMs >= ORPHAN_MIN_AGE_MS)
          ) {
            files++;
            bytes += info.size;
          }
        }
      } catch {
        active.throwIfAborted();
        incomplete = true;
      }
    }
    active.throwIfAborted();
    return { runs: candidates.runs, files, bytes, incomplete };
  }

  cleanup(olderThanDays: number): Promise<RunRetentionResult> {
    return this.serial(async () => {
      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
      const result: RunRetentionResult = {
        runs: 0,
        events: 0,
        executions: 0,
        sessionFiles: 0,
        resultFiles: 0,
        freedBytes: 0,
      };
      const keys = new Set<string>();
      for (;;) {
        this.shutdown.signal.throwIfAborted();
        const batch = this.repo.cleanupBefore(cutoff);
        result.runs += batch.runs;
        result.events += batch.events;
        result.executions += batch.executions;
        if (batch.cleanupKey) keys.add(batch.cleanupKey);
        if (batch.runs === 0) break;
        await yieldLoop(undefined, { signal: this.shutdown.signal });
      }
      const files = await this.sweepJobs(keys);
      result.sessionFiles += files.sessionFiles;
      result.resultFiles += files.resultFiles;
      const orphans = await this.sweepOrphans();
      result.resultFiles += orphans.removed;
      result.freedBytes = files.bytes + orphans.bytes;
      return result;
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      this.shutdown.signal.throwIfAborted();
      this.active++;
      try {
        return await operation();
      } finally {
        this.active--;
      }
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  private *cleanupJobs(signal: AbortSignal) {
    let before = "run-cleanup:";
    for (;;) {
      signal.throwIfAborted();
      const page = this.db
        .prepare(
          "SELECT key,value FROM settings WHERE key LIKE 'run-cleanup:%' AND key>? ORDER BY key LIMIT 50",
        )
        .all(before);
      for (const row of page) {
        signal.throwIfAborted();
        before = String(row.key);
        yield { key: before, value: String(row.value) };
      }
      if (page.length < 50) break;
    }
  }

  private readManifest(value: string) {
    try {
      return manifestSchema.parse(JSON.parse(value));
    } catch {
      // A malformed record cannot safely name files for the estimate or for deletion.
      return undefined;
    }
  }

  private async sweepJobs(owned = new Set<string>()) {
    const removed = { sessionFiles: 0, resultFiles: 0, bytes: 0 };
    let ownedFailure = false;
    for (const { key, value } of this.cleanupJobs(this.shutdown.signal)) {
      try {
        const manifest = this.readManifest(value);
        if (!manifest) throw new Error("Invalid run cleanup job");
        for (const file of manifest.sessionFiles) {
          if (this.repo.sessionReferenced(file)) continue;
          const step = await this.removeSession(file);
          if (step.removed) {
            removed.sessionFiles++;
            removed.bytes += step.bytes;
          }
        }
        for (const file of manifest.resultFiles) {
          if (this.repo.resultReferenced(file)) continue;
          const step = await this.removeResult(file);
          if (step.removed) {
            removed.resultFiles++;
            removed.bytes += step.bytes;
          }
        }
        this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
      } catch {
        this.shutdown.signal.throwIfAborted();
        if (owned.has(key)) ownedFailure = true;
        this.logger.warn("Run cleanup job retained for retry");
      }
    }
    if (ownedFailure) throw new Error("Run file cleanup deferred");
    return removed;
  }

  private async sessionForCleanup(root: string, stored: string) {
    const file = resolveSessionFile(this.dataDir, stored);
    const botId = IdSchema.parse(basename(dirname(dirname(file))));
    const owned = join(root, "bots", botId, "sessions");
    if (
      ![owned, join(resolve(this.dataDir), "bots", botId, "sessions")].includes(
        resolve(dirname(file)),
      )
    )
      throw new Error("Unsafe run session cleanup path");
    for (const path of [join(root, "bots"), join(root, "bots", botId), owned]) {
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(path)) !== path)
          throw new Error("Unsafe run session cleanup root");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe run session file");
      return { file, bytes: stat.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async removeSession(stored: string): Promise<{ removed: boolean; bytes: number }> {
    const candidate = await this.sessionForCleanup(await realpath(this.dataDir), stored);
    this.shutdown.signal.throwIfAborted();
    if (!candidate || this.repo.sessionReferenced(stored)) return { removed: false, bytes: 0 };
    await rm(candidate.file);
    return { removed: true, bytes: candidate.bytes };
  }

  private async resultDirectory(): Promise<string | undefined> {
    const root = await realpath(this.dataDir);
    const directory = join(root, "run-events");
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
        throw new Error("Unsafe run result directory");
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async removeResult(stored: string): Promise<{ removed: boolean; bytes: number }> {
    const match = RESULT_FILE.exec(stored);
    if (!match) throw new Error("Unsafe run result path");
    const directory = await this.resultDirectory();
    if (!directory) return { removed: false, bytes: 0 };
    const file = join(directory, match[1] as string);
    this.shutdown.signal.throwIfAborted();
    if (this.repo.resultReferenced(stored)) return { removed: false, bytes: 0 };
    let bytes = 0;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe run result file");
      bytes = stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: false, bytes: 0 };
      throw error;
    }
    await rm(file);
    return { removed: true, bytes };
  }

  private async sweepOrphans(): Promise<{ removed: number; bytes: number }> {
    const directory = await this.resultDirectory();
    if (!directory) return { removed: 0, bytes: 0 };
    let removed = 0;
    let bytes = 0;
    for await (const entry of await opendir(directory)) {
      this.shutdown.signal.throwIfAborted();
      if (!ORPHAN_FILE.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
      const stored = `run-events/${entry.name}`;
      if (!entry.name.endsWith(".tmp") && this.repo.resultReferenced(stored)) continue;
      // A result file is written before the transaction that references it commits (and a .tmp
      // may still be in flight), so only files untouched for a while count as orphans.
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || Date.now() - info.mtimeMs < ORPHAN_MIN_AGE_MS)
        continue;
      await rm(path);
      removed++;
      bytes += info.size;
    }
    return { removed, bytes };
  }

  async stop() {
    this.shutdown.abort();
    await this.chain;
  }
}
