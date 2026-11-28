import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { type CleanupRequest, type CleanupResponse, CleanupResult } from "./cleanup-messages.ts";
import { ImportReclamation } from "./reclamation.ts";

const PAGE_TIMEOUT_MS = 30_000;

/** A single worker owns bounded write transactions and checkpoints for the duration of cleanup. */
export class CleanupWork {
  private readonly path?: string;
  private readonly direct: ImportReclamation;
  private worker?: Worker;
  private exited?: Promise<number>;
  private autoPages?: number;
  private receive?: (value: CleanupResult) => void;
  private stopped = false;

  constructor(private readonly db: DatabaseSync) {
    const mode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    const file = db
      .prepare("PRAGMA database_list")
      .all()
      .find(({ name }) => name === "main")?.file;
    this.path = mode === "wal" && typeof file === "string" && file ? file : undefined;
    this.direct = new ImportReclamation(db);
  }

  private start(path: string) {
    const bundled = new URL("./import-cleanup-worker.js", import.meta.url);
    const source = new URL("./import-cleanup-worker.ts", import.meta.url);
    const worker = new Worker(existsSync(bundled) ? bundled : source, {
      workerData: path,
      stdout: true,
      stderr: true,
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    this.worker = worker;
    this.stopped = false;
    this.exited = new Promise((resolve) => {
      // Wait for exit even after an error so the database is closed before shutdown.
      worker.once("error", () => {});
      worker.once("exit", (code) => {
        this.stopped = true;
        this.receive?.({ kind: "failed" });
        resolve(code);
      });
    });
    worker.on("message", (value: unknown) => {
      this.receive?.(CleanupResult.safeParse(value).data ?? { kind: "failed" });
    });
    // PASSIVE checkpoints run on the worker without a writer lock. Keep SQLite from
    // doing the same disk work synchronously on this connection during cleanup.
    this.autoPages ??= Number(
      this.db.prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint,
    );
    this.db.exec("PRAGMA wal_autocheckpoint=0");
    return worker;
  }

  async run<Request extends Exclude<CleanupRequest, { kind: "close" }>>(
    request: Request,
    signal: AbortSignal,
  ): Promise<Extract<CleanupResponse, { kind: Request["kind"] }>> {
    signal.throwIfAborted();
    if (!this.path)
      return this.direct.run(request) as Extract<CleanupResponse, { kind: Request["kind"] }>;
    const worker = !this.worker || this.stopped ? this.start(this.path) : this.worker;
    const timeout = setTimeout(() => {
      // Exit resolves an in-flight request even if the worker stopped responding.
      void worker.terminate().catch(() => this.receive?.({ kind: "failed" }));
    }, PAGE_TIMEOUT_MS);
    try {
      while (!this.stopped) {
        signal.throwIfAborted();
        const result = await new Promise<CleanupResult>((resolve) => {
          this.receive = resolve;
          worker.postMessage(request);
        });
        if (result.kind === request.kind)
          return result as Extract<CleanupResponse, { kind: Request["kind"] }>;
        if (result.kind !== "busy") break;
        await delay(10, undefined, { signal });
      }
      throw new Error("import_cleanup_worker_failed");
    } finally {
      this.receive = undefined;
      clearTimeout(timeout);
    }
  }

  async close() {
    const worker = this.worker;
    const exited = this.exited;
    this.worker = undefined;
    this.exited = undefined;
    try {
      if (worker && !this.stopped) {
        const timeout = setTimeout(() => {
          // Ensure shutdown never hangs if a worker stops responding to close.
          void worker.terminate().catch(() => {});
        }, PAGE_TIMEOUT_MS);
        try {
          worker.postMessage({ kind: "close" });
          await exited;
        } finally {
          clearTimeout(timeout);
        }
      } else if (exited) {
        await exited;
      }
    } finally {
      if (Number.isInteger(this.autoPages)) {
        this.db.exec(`PRAGMA wal_autocheckpoint=${this.autoPages}`);
      }
      this.autoPages = undefined;
    }
  }
}
