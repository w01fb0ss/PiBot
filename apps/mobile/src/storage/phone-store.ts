import { ApprovalSchema, type Message, MessageSchema } from "@pibot/protocol";
import { z } from "zod";
import type { LocalData } from "./types.ts";

/**
 * Proposal 4 (maintainers 2026-11-14): what the main screens show lives on the phone first. Screens
 * render the copy here at once (synchronously when this process already read it), then apply
 * what the computer says changed. Keys are the ones the caches used before, so copies written
 * by an older app version still open. Everything sits under `cache:<computer>:`, so unpairing
 * deletes it with the other caches; nothing here is a key or token.
 */
export const HISTORY_MESSAGES = 100;
/** Topics with a stored history per computer; the least recently written goes first. */
export const HISTORY_TOPICS = 30;
/** Parsed copies kept in memory; each is at most one LocalData value. */
const MEMORY_ENTRIES = 48;

export const storeKeys = {
  conversations: (computerId: string) => `cache:${computerId}:conversations`,
  approvals: (computerId: string) => `cache:${computerId}:approvals`,
  topics: (computerId: string, kind: "bot" | "group", id: string) =>
    `cache:${computerId}:topics:${kind}:${id}`,
  history: (computerId: string, scope: string) => `cache:${computerId}:history:${scope}`,
  historyIndex: (computerId: string) => `cache:${computerId}:history-index`,
};
/** The first page of pending approvals: what the tab, its badge and the chat cards show. */
export const STORED_APPROVALS = 50;
export const StoredApprovalsSchema = z.array(ApprovalSchema).max(STORED_APPROVALS);
/** A Bot's or group's topics and which one the computer has current. */
export const StoredTopicsSchema = z.object({
  current: z.uuid().optional(),
  topics: z
    .array(
      z.object({
        id: z.uuid(),
        title: z.string().max(200).optional(),
        importSource: z.string().min(1).max(32).optional(),
        isCurrent: z.boolean(),
        updatedAt: z.string().max(40),
      }),
    )
    .max(50),
});
const HistorySchema = z.array(MessageSchema).max(HISTORY_MESSAGES);
const IndexSchema = z.array(z.string().max(400)).max(HISTORY_TOPICS * 2);

export class PhoneStore {
  private memory = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly data: LocalData) {}
  private remember(key: string, value: unknown) {
    this.memory.delete(key);
    this.memory.set(key, value);
    while (this.memory.size > MEMORY_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined); // The caller owns the error; later writes still run.
    return next;
  }
  /** The copy this process already holds, validated; undefined until it was read or written. */
  peek<T extends z.ZodType>(key: string, schema: T): z.infer<T> | undefined {
    if (!this.memory.has(key)) return undefined;
    const parsed = schema.safeParse(this.memory.get(key));
    return parsed.success ? parsed.data : undefined;
  }
  /** Memory first, then the phone's database; an unreadable copy reads as none. */
  async read<T extends z.ZodType>(key: string, schema: T): Promise<z.infer<T> | undefined> {
    const known = this.peek(key, schema);
    if (known !== undefined) return known;
    const parsed = schema.safeParse(await this.data.get(key).catch(() => undefined));
    if (!parsed.success) return undefined;
    this.remember(key, parsed.data);
    return parsed.data;
  }
  write(key: string, value: unknown) {
    // Memory first: a screen opened while the write is still on its way sees the new copy.
    this.remember(key, value);
    return this.serial(() => this.data.put(key, value));
  }
  peekHistory(computerId: string, scope: string): Message[] | undefined {
    return this.peek(storeKeys.history(computerId, scope), HistorySchema);
  }
  async history(computerId: string, scope: string): Promise<Message[]> {
    return (await this.read(storeKeys.history(computerId, scope), HistorySchema)) ?? [];
  }
  /** The newest messages of one topic; the oldest stored topics beyond the cap are deleted. */
  writeHistory(computerId: string, scope: string, messages: readonly unknown[]) {
    const value = HistorySchema.parse(messages.slice(-HISTORY_MESSAGES));
    const key = storeKeys.history(computerId, scope);
    this.remember(key, value);
    return this.serial(async () => {
      await this.data.put(key, value);
      const indexKey = storeKeys.historyIndex(computerId);
      const parsed = IndexSchema.safeParse(await this.data.get(indexKey).catch(() => undefined));
      const order = [scope, ...(parsed.success ? parsed.data : []).filter((s) => s !== scope)];
      for (const old of order.slice(HISTORY_TOPICS)) {
        const oldKey = storeKeys.history(computerId, old);
        this.memory.delete(oldKey);
        // Scopes are JSON objects ending in "}", so the prefix matches exactly that one key.
        await this.data.removePrefix(oldKey);
      }
      await this.data.put(indexKey, order.slice(0, HISTORY_TOPICS));
    });
  }
  /** Unpair: the database rows go with the `cache:<id>:` prefix; this drops the parsed copies. */
  forget(computerId: string) {
    const prefix = `cache:${computerId}:`;
    for (const key of [...this.memory.keys()]) if (key.startsWith(prefix)) this.memory.delete(key);
  }
  settled() {
    return this.tail;
  }
}
