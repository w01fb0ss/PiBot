import type { DatabaseSync } from "node:sqlite";

/** Keep a read-side gate and the reads it protects on one WAL snapshot. */
export function readTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) return operation();
  db.exec("BEGIN");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  // Repo operations remain atomic when brain groups approval, grant and audit in one transaction.
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT pibot_repo" : "BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec(nested ? "RELEASE pibot_repo" : "COMMIT");
    return result;
  } catch (error) {
    db.exec(nested ? "ROLLBACK TO pibot_repo; RELEASE pibot_repo" : "ROLLBACK");
    throw error;
  }
}
