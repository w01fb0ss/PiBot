import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrationSteps } from "./migration-steps.ts";
import { readTransaction, transaction } from "./transactions.ts";

export { readTransaction, transaction };

/** Pre-create privately so SQLite also inherits 0600 for WAL/SHM, even under a permissive umask. */
function privateDatabaseFile(path: string, create: boolean) {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0),
      0o600,
    );
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error("database_file_identity_invalid");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

export function openDatabase(path: string): DatabaseSync {
  const privateFiles = process.platform !== "win32" && path !== ":memory:" && path !== "";
  if (privateFiles) {
    privateDatabaseFile(path, true);
    privateDatabaseFile(`${path}-wal`, false);
    privateDatabaseFile(`${path}-shm`, false);
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (privateFiles) {
      privateDatabaseFile(`${path}-wal`, false);
      privateDatabaseFile(`${path}-shm`, false);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Runs every migration file in `dir`; the entry's `runMigrations` supplies the bundled directory. */
type Migration = { file: string; version: number };

/** Versions to consider, validated; creates the ledger table. Shared by both apply paths. */
function planMigrations(db: DatabaseSync, dir: string): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .map((file) => ({ file, version: Number(file.split("_")[0]) }))
    .sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const { version } of migrations) {
    if (!Number.isSafeInteger(version) || version < 1 || versions.has(version)) {
      throw new Error("Invalid or duplicate migration version");
    }
    versions.add(version);
  }
  if (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get()
  ) {
    const stored = Number(
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0,
    );
    if (stored > (migrations.at(-1)?.version ?? 0)) throw new Error("database_newer_than_app");
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  return migrations;
}

function applyMigration(db: DatabaseSync, dir: string, { file, version }: Migration): void {
  const sql = readFileSync(join(dir, file), "utf8");
  const rebuild = /^\uFEFF?-- pibot:rebuild-referenced-tables\r?\n/.test(sql);
  const stepName = /^\uFEFF?-- pibot:step ([a-z0-9-]+)\r?\n/.exec(sql)?.[1];
  const step = stepName === undefined ? undefined : migrationSteps[stepName];
  if (stepName !== undefined && !step) throw new Error("Unknown migration step");
  // SQLite's DROP of a referenced table leaves deferred violations even when IDs are restored.
  // Disable only this connection, outside BEGIN; the write lock and explicit FK check protect the rebuild.
  if (rebuild && db.isTransaction)
    throw new Error("Referenced-table migration requires its own transaction");
  const foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? 0);
  if (rebuild) db.exec("PRAGMA foreign_keys = OFF");
  try {
    transaction(db, () => {
      // Check under the write lock so simultaneous startup cannot apply a version twice.
      if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version))
        return;
      db.exec(sql);
      // Seed only with the initial schema, atomically: upgrades must retain the old missing-key default.
      if (file === "0001_init.sql")
        db.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run("openAtLogin", "false");
      step?.(db);
      if (rebuild && db.prepare("PRAGMA foreign_key_check").get())
        throw new Error("Migration would leave invalid foreign keys");
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
    });
  } finally {
    if (rebuild) db.exec(foreignKeys ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF");
  }
}

export function applyMigrations(db: DatabaseSync, dir: string): void {
  for (const migration of planMigrations(db, dir)) applyMigration(db, dir, migration);
}

/**
 * The same, yielding to the event loop between migrations once ~250 ms of work has passed. A
 * fresh install applies 160+ migrations (11.6 s on kali, more on a slow disk); done in one
 * synchronous call, the background process could neither report startup progress nor use the
 * CPU the host's watchdog counts, so first launches were killed mid-migration three times
 * (Linux acceptance 2026-11-15). Each migration is still one transaction.
 */
export async function applyMigrationsYielding(
  db: DatabaseSync,
  dir: string,
  between: () => Promise<void>,
): Promise<void> {
  let since = performance.now();
  for (const migration of planMigrations(db, dir)) {
    applyMigration(db, dir, migration);
    if (performance.now() - since >= 250) {
      await between();
      since = performance.now();
    }
  }
}
