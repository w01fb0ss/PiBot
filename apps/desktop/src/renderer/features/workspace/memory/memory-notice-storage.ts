import { IdSchema } from "@pibot/protocol";
import { z } from "zod";

export interface MemoryNoticeStorage {
  read(): ReadonlySet<string>;
  write(ids: ReadonlySet<string>): void;
}
// proposal@message: a note the brain moves under the finished reply counts as a new notice there.
const NoticeKeySchema = z.string().refine((key) => {
  const [proposalId, messageId, ...rest] = key.split("@");
  return (
    rest.length === 0 &&
    IdSchema.safeParse(proposalId).success &&
    (messageId === "" || IdSchema.safeParse(messageId).success)
  );
});
const idsSchema = z.array(NoticeKeySchema).max(100);

// Only dismissed proposal/message ids are cached, never memory text or private undo images.
export function memoryNoticeStorage(botId: string): MemoryNoticeStorage {
  const key = `pibot.auto-memory-notices.v2.${botId}`;
  return {
    read() {
      try {
        const parsed = idsSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? "[]"));
        return new Set(parsed.success ? parsed.data : []);
      } catch {
        // Storage may be unavailable; the persisted proposal age remains a restart fallback.
        return new Set();
      }
    },
    write(ids) {
      try {
        if (ids.size) localStorage.setItem(key, JSON.stringify([...ids].slice(-100)));
        else localStorage.removeItem(key);
      } catch {
        // Dismissing a hint must not block chat or mutate memory if the UI cache is unavailable.
      }
    },
  };
}
