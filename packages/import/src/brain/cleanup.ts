// Resume private batch reclamation without making it part of the latency of a desktop RPC.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { ImportStatus } from "@pibot/import-contract";
import type { CleanupWork } from "../store/cleanup-work.ts";
import type { ImportStore } from "../store/index.ts";

export class ImportCleanup {
  private work?: Promise<void>;
  private readonly blocked = new Set<string>();
  private readonly retries = new Set<string>();
  private requested = false;

  constructor(
    private readonly store: ImportStore,
    private readonly signal: AbortSignal,
    private readonly publish: (status: ImportStatus, resetBots?: string[]) => void,
    private readonly failed: () => void,
    private readonly restore: (id: string, work: CleanupWork, signal: AbortSignal) => Promise<void>,
  ) {}

  idle() {
    return !this.work;
  }

  status(id: string): ImportStatus | undefined {
    const status = this.store.get(id);
    if (
      status?.cleanup &&
      (!this.work ||
        (this.blocked.has(id) && !this.retries.has(id)) ||
        this.store.projects.hasDependents(id))
    )
      return { ...status, cleanupBlocked: true };
    return status;
  }

  wake(retryId?: string) {
    if (this.signal.aborted) return;
    if (retryId) this.retries.add(retryId);
    this.requested = true;
    if (!this.work) {
      this.work = this.drainRequested().finally(() => {
        this.work = undefined;
        if (this.requested && !this.signal.aborted) void this.wake();
      });
      // SQLite failures keep their durable phase; project refusals stay scoped to their batch.
      void this.work.catch(this.failed);
    }
    return this.work;
  }

  wait() {
    return this.work;
  }

  private async drainRequested() {
    while (this.requested && !this.signal.aborted) {
      this.requested = false;
      for (const id of this.retries) this.blocked.delete(id);
      this.retries.clear();
      const work = this.store.cleanupWork();
      try {
        await this.drain(work);
        while (!this.signal.aborted && this.store.searchRebuilding()) {
          await yieldToLoop();
          if (this.signal.aborted) break;
          await work.run({ kind: "search" }, this.signal);
        }
      } catch (error) {
        if (!this.signal.aborted) throw error;
        // The worker either committed its current page or left it to be retried.
      } finally {
        await work.close();
      }
    }
  }

  private async drain(work: CleanupWork) {
    let last = -Infinity;
    let progressed: boolean;
    do {
      progressed = false;
      let cursor = 0;
      let readyId: string | undefined;
      let resetBots: string[] = [];
      while (!this.signal.aborted) {
        await yieldToLoop();
        if (this.signal.aborted) return;
        const next = this.store.nextCleanup(cursor);
        if (!next) break;
        const { id } = next;
        if (this.blocked.has(id) || this.store.projects.hasDependents(id)) {
          cursor = next.cursor;
          continue;
        }
        let finished: ImportStatus | undefined;
        try {
          if (readyId !== id) {
            await this.restore(id, work, this.signal);
            if (this.signal.aborted) return;
            resetBots = this.store.topicBots(id);
            readyId = id;
          }
          const { finish } = await work.run({ kind: "import", id }, this.signal);
          if (this.signal.aborted) return;
          if (finish) finished = this.store.finishCleanup(id);
        } catch {
          if (this.signal.aborted) return;
          // A fresh explicit retry can ask again; unrelated imports never repeat a refused card.
          this.blocked.add(id);
          this.failed();
          const status = this.status(id);
          if (status) this.publish(status);
          cursor = next.cursor;
          continue;
        }
        progressed = true;
        if (finished) cursor = next.cursor;
        if (finished || performance.now() - last >= 200) {
          const status = finished ?? this.store.get(id);
          if (status) this.publish(status, finished?.state === "undone" ? resetBots : undefined);
          last = finished ? -Infinity : performance.now();
        }
      }
      // Restoring a later batch may have made an earlier dependent eligible in this pass.
    } while (progressed && !this.signal.aborted);
  }
}
