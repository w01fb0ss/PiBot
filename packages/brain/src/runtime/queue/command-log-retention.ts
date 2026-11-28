import { type BigIntStats, constants } from "node:fs";
import { lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { commandLogRoot, sameFile } from "@pibot/execution";
import { IdSchema } from "@pibot/protocol-base";
import { AuditRepo, SettingsRepo } from "@pibot/storage";
import type { LocalDependencies } from "../../core/local-types.ts";

/** Only Pi Bot's UUID log files are owned; active runs/jobs and replaced paths are never deleted. */
export async function pruneCommandLogs(
  deps: LocalDependencies,
  botId: string,
  signal: AbortSignal,
) {
  if (!IdSchema.safeParse(botId).success) return;
  const settings = new SettingsRepo(deps.db).get().commandLogRetention?.[botId] ?? {
    days: 30,
    megabytes: 200,
  };
  const home = join(await realpath(deps.dataDir), "bots", botId, "home");
  const files: {
    path: string;
    size: number;
    mtime: number;
    identity: BigIntStats;
  }[] = [];
  let entries = 0;
  const logs = [commandLogRoot(home), join(home, ".pibot")];
  for (const { root, directory } of logs.flatMap((base) =>
    ["runs", "background"].map((directory) => ({ directory, root: join(base, directory) })),
  )) {
    signal.throwIfAborted();
    try {
      if ((await realpath(root)) !== resolve(root)) continue;
      const dir = await opendir(root);
      for await (const item of dir) {
        signal.throwIfAborted();
        // Bound both the scan and in-memory sort; do not partially prune an incomplete scan.
        if (++entries > 100_000) throw new Error("command_log_scan_limit");
        const owned = /^(.+)\.log(\.1)?$/.exec(item.name);
        if (
          !item.isFile() ||
          !owned?.[1] ||
          !IdSchema.safeParse(owned[1]).success ||
          (owned[2] && directory !== "background")
        )
          continue;
        const path = join(root, item.name);
        const identity = await lstat(path, { bigint: true });
        if (!identity.isFile() || identity.nlink !== 1n) continue;
        files.push({
          path,
          size: Number(identity.size),
          mtime: Number(identity.mtimeMs),
          identity,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  // Waiting runs may resume writing the same log. Unknown future states are also protected
  // until their lifecycle explicitly declares them terminal.
  const liveRuns = "status NOT IN ('done','error','aborted')";
  const liveJobs = "status NOT IN ('exited','stopped','failed')";
  const active = new Set(
    [
      ["runs", liveRuns],
      ["background_commands", liveJobs],
    ].flatMap(([table, live]) =>
      deps.db
        .prepare(`SELECT id FROM ${table} WHERE bot_id=? AND ${live}`)
        .all(botId)
        .flatMap((row) =>
          logs.map((base) => join(base, table === "runs" ? "runs" : "background", `${row.id}.log`)),
        ),
    ),
  );
  const runActive = deps.db.prepare(`SELECT 1 FROM runs WHERE id=? AND bot_id=? AND ${liveRuns}`);
  const jobActive = deps.db.prepare(
    `SELECT 1 FROM background_commands WHERE id=? AND bot_id=? AND ${liveJobs}`,
  );
  const currentlyActive = (path: string) => {
    const id = basename(path).replace(/\.log(?:\.1)?$/, "");
    return basename(dirname(path)) === "runs"
      ? !!runActive.get(id, botId)
      : !!jobActive.get(id, botId);
  };
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const cutoff = Date.now() - settings.days * 86_400_000;
  let removed = 0,
    bytes = 0;
  const audit = new AuditRepo(deps.db, deps.redactor);
  for (const file of files.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path))) {
    signal.throwIfAborted();
    if (file.mtime >= cutoff && total <= settings.megabytes * 1024 * 1024) break;
    if (active.has(file.path.replace(/\.log\.1$/, ".log"))) continue;
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat({ bigint: true });
      const pathInfo = await lstat(file.path, { bigint: true });
      if (
        !sameFile(current, file.identity) ||
        !sameFile(current, pathInfo) ||
        current.size !== BigInt(file.size) ||
        current.nlink !== 1n ||
        current.mtimeNs !== file.identity.mtimeNs ||
        current.ctimeNs !== file.identity.ctimeNs ||
        (await realpath(dirname(file.path))) !== dirname(file.path) ||
        (await realpath(file.path)) !== file.path
      )
        continue;
      signal.throwIfAborted();
      if (currentlyActive(file.path)) continue;
      // Intent survives a crash between unlink and the completed receipt; no output or path enters audit.
      audit.append({
        botId,
        kind: "command.logs.prune",
        summary: "Command log retention / 命令日志保留清理",
        detail: { actor: "system", reasonCode: "command_log_retention_requested", entryCount: 1 },
      });
      await unlink(file.path);
      audit.append({
        botId,
        kind: "command.logs.prune",
        summary: "Command log deleted / 命令日志已删除",
        detail: {
          actor: "system",
          reasonCode: "command_log_retention_deleted",
          entryCount: 1,
          bytes: file.size,
        },
      });
      total -= file.size;
      removed++;
      bytes += file.size;
    } finally {
      await handle.close();
    }
  }
  if (removed)
    deps.logger.info(
      JSON.stringify({ module: "command-logs", event: "retained", botId, removed, bytes }),
    );
}
