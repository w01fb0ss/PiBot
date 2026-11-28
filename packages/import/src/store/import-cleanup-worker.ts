import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { configureChatSearchRedactor } from "@pibot/storage/chat-search-index";
import { z } from "zod";
import { CleanupRequest, type CleanupResult } from "./cleanup-messages.ts";
import { ImportReclamation } from "./reclamation.ts";

const port = parentPort;
if (!port) throw new Error("import_cleanup_worker_missing_port");
const path = z.string().min(1).parse(workerData);
const db = new DatabaseSync(path);
// Cleanup intent is committed before we touch files. NORMAL keeps pages atomic and
// restartable while avoiding a sync with the writer lock held for every page.
db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=40; PRAGMA synchronous=NORMAL;
  PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=-16384`);
configureChatSearchRedactor(db);
const store = new ImportReclamation(db);
// Keep checkpointing if the next batch is waiting for project-file confirmation.
const checkpoint = setInterval(() => {
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch {
    // Passive checkpoints are best-effort; remaining WAL frames retry on the next tick.
  }
}, 1000);
port.on("message", (message: unknown) => {
  const request = CleanupRequest.parse(message);
  if (request.kind === "close") {
    clearInterval(checkpoint);
    try {
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      // Closing cleanup; the main connection checkpoints any remaining WAL frames.
    } finally {
      db.close();
      port.close();
    }
    return;
  }
  let result: CleanupResult;
  try {
    result = store.run(request);
  } catch (error) {
    const busy = z.object({ errcode: z.number().int() }).safeParse(error);
    // SQLite's extended result codes keep SQLITE_BUSY (5) in the low byte.
    result = { kind: busy.success && (busy.data.errcode & 0xff) === 5 ? "busy" : "failed" };
  }
  port.postMessage(result);
});
