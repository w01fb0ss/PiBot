import { createHash } from "node:crypto";
import { optionalPageOffset } from "@pibot/protocol-base";
import type { PreparedTool } from "../../../core/local-types.ts";

/** The 2nd identical read is still useful; from the 3rd the answer only repeats what was read. */
export const REPEAT_READ_LIMIT = 2;
/** One run is one turn, but reading many ranges must not grow this list without bound. */
const MAX_ENTRIES = 32;

export interface RepeatedRead {
  /** Digest of the text handed to the model: a changed range is a new answer, not a repeat. */
  digest: string;
  count: number;
}

/**
 * Identify "the same range of the same file" by path plus offset/limit, because the same
 * file read from a different offset is a different question and must not be counted as a repeat.
 *
 * Only `read_file` qualifies: it is the tool a run once looped on, and its answer is a pure
 * function
 * of the file content — unlike a command, whose answer may also depend on time or other processes.
 */
export function repeatedReadKey(prepared: PreparedTool): string | undefined {
  if (prepared.call.tool !== "read_file") return;
  const input = prepared.call.input as { offset?: unknown; limit?: unknown };
  // The resolved path, not what the model typed, so "./x" and the absolute path are one range.
  const path = prepared.result.path?.path;
  if (!path) return;
  const offset = optionalPageOffset.safeParse(input.offset).data ?? 0;
  const limit = typeof input.limit === "number" ? input.limit : 0;
  return `${path}\u0000${offset}\u0000${limit}`;
}

/**
 * Counting is by content digest, so a file that changed under the reader (or a different range
 * answering differently) restarts at 1 instead of pretending the model has seen it before.
 */
export function noteRepeatedRead(
  cache: Map<string, RepeatedRead>,
  key: string,
  text: string,
): number {
  const digest = createHash("sha256").update(text).digest("hex");
  const previous = cache.get(key);
  const count = previous?.digest === digest ? previous.count + 1 : 1;
  // Re-insert so the least recently read range is the first one dropped.
  cache.delete(key);
  cache.set(key, { digest, count });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return count;
}

/**
 * The hint only nudges: the content is still returned in full and nothing is blocked. It stays in
 * the tool result (never the prompt prefix) so prompt-cache prefixes keep matching across turns.
 */
export function repeatReadHint(count: number): string {
  return `这一段你已经读过 ${count} 次，内容没有变化；请根据已读内容开始修改，或说明还缺什么信息 / You have read this section ${count} times with no change; start editing from what you have read, or say what information is missing.`;
}
