import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { groupAlive } from "../command/background/processes.ts";
import { commandEnvironment } from "../command/environment.ts";
import { snapshot } from "../command/process-tree.ts";
import type { ExecOptions } from "../core/types.ts";
import { libreOfficePlatformSupported } from "./office-convert.ts";

const PREFIX = "office-convert-";
const DIRECTORY = /^office-convert-[A-Za-z0-9]{6}$/;
const RECORD_FILE = "cleanup.json";
const RECORD_LIMIT = 1024 * 1024;
const RETRY_MS = 30_000;
const pid = z.number().int().positive().max(0x7fffffff);
const ProcessTree = z.strictObject({
  group: pid,
  processes: z.array(z.strictObject({ pid, started: z.string().max(128) })),
});
type ProcessTree = z.infer<typeof ProcessTree>;
const CleanupRecord = z
  .union([z.strictObject({ owner: pid, tree: ProcessTree.optional() }), ProcessTree])
  .nullable();
type CleanupRecord = z.infer<typeof CleanupRecord>;

function treeFor(record: CleanupRecord): ProcessTree | undefined {
  if (record) return "owner" in record ? record.tree : record;
}

function ownerAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors or PID reuse retain the copy until exit can be confirmed.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/**
 * The recipe gets only the inner work folder. Its owner keeps the process record in the private
 * parent so even a restarted brain can prove that a retained copy is safe to remove.
 */
export function createOfficeConvertCleanup(options: ExecOptions, signal: AbortSignal) {
  const pending = new Map<string, CleanupRecord>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = () =>
    options.onDiagnostic?.({
      runId: "office-convert",
      stage: "dispatch",
      code: "office_temp_cleanup_failed",
      readonlyRoots: 0,
    });
  const schedule = () => {
    if (!pending.size || timer || signal.aborted) return;
    timer = setTimeout(() => {
      void recover()
        .catch(report)
        .finally(() => {
          timer = undefined;
          schedule();
        });
    }, RETRY_MS);
    timer.unref();
  };
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  async function recover() {
    const batch: [string, CleanupRecord][] = [];
    for (const [dir, record] of pending) {
      if (signal.aborted) return;
      if (record && "owner" in record) {
        if (ownerAlive(record.owner)) continue;
        // The owner could have armed the converter after the startup scan read its record.
        const latest = await readRecord(dir).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            pending.delete(dir);
          else report();
          return undefined;
        });
        if (latest === undefined) continue;
        batch.push([dir, latest]);
      } else batch.push([dir, record]);
    }
    const processes = batch.some(([, record]) => treeFor(record)?.processes.length)
      ? new Map(
          (
            await snapshot(
              commandEnvironment(
                options.platform,
                options.env,
                options.systemHome,
                options.tempDir,
              ),
              options.platform,
            )
          ).map(({ pid, started }) => [pid, started]),
        )
      : new Map<number, string>();
    for (const [dir, record] of batch) {
      if (signal.aborted) return;
      const tree = treeFor(record);
      // Treat failed group checks and still-live reparented descendants as unconfirmed.
      if (
        tree &&
        (groupAlive([tree], options.platform) ||
          tree.processes.some(({ pid, started }) => processes.get(pid) === started))
      )
        continue;
      try {
        await remove(dir);
        pending.delete(dir);
      } catch {
        report();
      }
    }
  }

  async function remove(dir: string) {
    // Keep the recovery record if removal of any of the document data fails.
    const opts = { recursive: true, force: true, maxRetries: 3 };
    await rm(join(dir, "work"), opts);
    await rm(dir, opts);
  }

  async function save(dir: string, record: CleanupRecord) {
    const temp = join(dir, "cleanup.new");
    try {
      await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      await rename(temp, join(dir, RECORD_FILE));
    } finally {
      await rm(temp, { force: true });
    }
  }

  async function readRecord(dir: string) {
    const owner = process.getuid?.();
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== owner || (info.mode & 0o077) !== 0) return;
    const file = await open(
      join(dir, RECORD_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== owner ||
        info.nlink !== 1 ||
        info.size > RECORD_LIMIT ||
        (info.mode & 0o077) !== 0
      )
        return;
      const bytes = Buffer.alloc(info.size);
      if ((await file.read({ buffer: bytes })).bytesRead !== info.size) return;
      const parsed = CleanupRecord.safeParse(JSON.parse(bytes.toString("utf8")));
      return parsed.success ? parsed.data : undefined;
    } finally {
      await file.close();
    }
  }

  async function restore() {
    const base = await realpath(options.tempDir);
    for (const name of await readdir(base)) {
      if (signal.aborted) return;
      if (!DIRECTORY.test(name)) continue;
      try {
        const dir = join(base, name);
        const record = await readRecord(dir);
        if (record !== undefined && !pending.has(dir)) pending.set(dir, record);
      } catch (error) {
        // A new conversion writes its record first, and another owner may already have removed it.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) report();
      }
    }
  }
  if (libreOfficePlatformSupported(options.platform))
    void restore().then(recover).catch(report).finally(schedule);

  return {
    async create() {
      const dir = await mkdtemp(join(await realpath(options.tempDir), PREFIX));
      try {
        await save(dir, { owner: process.pid });
        return dir;
      } catch (error) {
        await remove(dir).catch(report);
        throw error;
      }
    },
    async arm(dir: string, tree: ProcessTree) {
      await save(dir, { owner: process.pid, tree });
    },
    async finish(dir: string, record?: ProcessTree) {
      if (!record) {
        try {
          await remove(dir);
          pending.delete(dir);
          return;
        } catch {
          // Process exit is already proven. Retry the filesystem operation independently.
          report();
        }
      }
      pending.set(dir, record ?? null);
      try {
        await save(dir, record ?? null);
      } catch {
        // The live owner still retries if this filesystem could not store a restart record.
        report();
      } finally {
        schedule();
      }
    },
  };
}
