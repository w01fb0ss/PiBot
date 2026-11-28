import type { ChatNotice } from "@pibot/protocol-base";

type Warning = Extract<ChatNotice, { kind: "agent_warning" }>;
const RETRY_MS = 120_000;

/** An in-memory, one-use receipt. A stored notice alone can never run a command. */
export class WebsiteRetries {
  private readonly pending = new Map<string, (confirmed: boolean) => void>();

  canRetry(id: string) {
    return this.pending.has(id);
  }

  resolve(id: string, confirmed: boolean) {
    this.pending.get(id)?.(confirmed);
  }

  wait(
    signal: AbortSignal,
    record: (until: string) => Warning | undefined,
    publish: (notice: Warning) => void,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const notice = record(new Date(Date.now() + RETRY_MS).toISOString());
    if (!notice) return Promise.resolve(false);
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(RETRY_MS)]);
    return new Promise<boolean>((resolve, reject) => {
      const finish = (confirmed: boolean) => {
        this.pending.delete(notice.id);
        lifetime.removeEventListener("abort", abort);
        resolve(confirmed);
      };
      const abort = () => finish(false);
      this.pending.set(notice.id, (confirmed) => finish(confirmed && !lifetime.aborted));
      lifetime.addEventListener("abort", abort, { once: true });
      try {
        if (lifetime.aborted) abort();
        else publish(notice);
      } catch (error) {
        this.pending.delete(notice.id);
        lifetime.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }
}
