import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";

export interface StorageUsageInfo {
  totalBytes: number;
  categories: {
    databaseBytes: number;
    botsAndMediaBytes: number;
    runtimesBytes: number;
    logsAndCacheBytes: number;
    otherBytes: number;
  };
  truncated: boolean;
}

const MAX_ENTRIES = 60_000;
const DATABASE_FILES = new Set(["pibot.db", "pibot.db-wal", "pibot.db-shm"]);
const BOTS_AND_MEDIA = new Set(["bots", "groups", "file-patches"]);
const RUNTIMES = new Set([
  "runtimes",
  "skill-envs",
  "skill-packages",
  "skill-downloads",
  "skill-updates",
]);
const LOGS_AND_CACHE = new Set([
  "logs",
  "host-logs",
  "gui-logs",
  "run-events",
  "cache",
  "main-compile-cache",
]);

function bucketFor(name: string): keyof StorageUsageInfo["categories"] {
  if (DATABASE_FILES.has(name)) return "databaseBytes";
  if (BOTS_AND_MEDIA.has(name)) return "botsAndMediaBytes";
  if (RUNTIMES.has(name)) return "runtimesBytes";
  if (LOGS_AND_CACHE.has(name)) return "logsAndCacheBytes";
  return "otherBytes";
}

/** Measures approximate disk usage inside `dataDir` without following symlinks. */
export async function measureStorageInfo(
  dataDir: string,
  signal: AbortSignal,
): Promise<StorageUsageInfo> {
  const root = await realpath(dataDir);
  const categories = {
    databaseBytes: 0,
    botsAndMediaBytes: 0,
    runtimesBytes: 0,
    logsAndCacheBytes: 0,
    otherBytes: 0,
  };
  type Bucket = keyof typeof categories;
  const stack: { path: string; bucket?: Bucket }[] = [{ path: root }];
  let seen = 0;
  let truncated = false;
  while (stack.length > 0 && seen < MAX_ENTRIES) {
    const current = stack.pop();
    if (!current) break;
    signal.throwIfAborted();
    try {
      // Revalidate queued directories before opening them, including their ancestors.
      const resolved = await realpath(current.path);
      if (resolved !== current.path || !(await lstat(current.path)).isDirectory()) {
        truncated = true;
        continue;
      }
      for await (const entry of await opendir(current.path)) {
        signal.throwIfAborted();
        if (++seen > MAX_ENTRIES) {
          truncated = true;
          break;
        }
        if (seen % 256 === 0) await yieldToLoop(undefined, { signal });
        if (entry.isSymbolicLink()) continue;
        const full = join(current.path, entry.name);
        const bucket = current.bucket ?? bucketFor(entry.name);
        if (entry.isDirectory()) stack.push({ path: full, bucket });
        else if (entry.isFile()) {
          const info = await lstat(full).catch(() => undefined);
          if (info?.isFile() && !info.isSymbolicLink()) categories[bucket] += info.size;
          else truncated = true;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (current.path === root) throw error;
      // An unreadable or concurrently removed subdirectory makes the estimate partial.
      truncated = true;
    }
  }
  const totalBytes = Object.values(categories).reduce((sum, bytes) => sum + bytes, 0);
  return { totalBytes, categories, truncated: truncated || stack.length > 0 };
}
