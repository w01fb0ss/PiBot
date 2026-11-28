// Decode one bounded JSON record at a time while keeping archive-size memory independent.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { ImportFailure } from "../adapter.ts";

const MAX_RECORD_CHARS = 32 * 1024 * 1024;
const MAX_DEPTH = 96;
/** Structural JSON tokens (outside strings) per record; allows long conversations within the byte cap. */
const MAX_RECORD_TOKENS = 1_500_000;
/** Hard nesting ceiling while streaming past a skipped oversized record. */
const MAX_SKIP_DEPTH = 10_000;

export const SKIPPED_RECORD = Symbol("skipped_json_record");
export type JsonRecordsOptions = { allowSingleObject?: boolean; skipOversized?: boolean };

function invalid(): never {
  throw new ImportFailure("format");
}

function decode(decoder: TextDecoder, chunk?: Buffer) {
  try {
    return decoder.decode(chunk, { stream: chunk !== undefined });
  } catch {
    return invalid();
  }
}

async function* textChunks(input: AsyncIterable<Buffer>) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of input) yield decode(decoder, chunk);
  yield decode(decoder);
}

class RecordScanner {
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private parts: string[] = [];
  private size = 0;
  private tokenCount = 0;
  private tokens = /["\\{}[\]]/g;
  oversized = false;

  constructor(private readonly skipOversized: boolean) {}

  private markOversized() {
    if (!this.skipOversized) throw new ImportFailure("limit");
    if (!this.oversized) {
      this.oversized = true;
      this.parts.length = 0;
    }
  }

  finishAt(chunk: string, start: number) {
    const { tokens } = this;
    tokens.lastIndex = start + (this.escaped ? 1 : 0);
    if (start < chunk.length) this.escaped = false;
    for (let match = tokens.exec(chunk); match; match = tokens.exec(chunk)) {
      const token = match[0];
      if (this.quoted) {
        if (token === "\\") {
          if (tokens.lastIndex === chunk.length) this.escaped = true;
          else tokens.lastIndex++;
        }
        if (token === '"') this.quoted = false;
      } else {
        if (++this.tokenCount > MAX_RECORD_TOKENS) this.markOversized();
        if (token === '"') {
          this.quoted = true;
        } else if (token === "{" || token === "[") {
          if (++this.depth > MAX_SKIP_DEPTH) throw new ImportFailure("limit");
          if (this.depth > MAX_DEPTH) this.markOversized();
        } else if (token === "}" || token === "]") {
          if (--this.depth < 0) invalid();
        } else {
          invalid();
        }
      }
      if (this.depth === 0 && !this.quoted) return tokens.lastIndex;
    }
    return undefined;
  }

  append(text: string) {
    if (this.oversized) return;
    this.size += text.length;
    if (this.size > MAX_RECORD_CHARS) {
      this.markOversized();
      return;
    }
    this.parts.push(text);
  }

  value(): unknown {
    if (this.oversized) return SKIPPED_RECORD;
    try {
      return JSON.parse(this.parts.join(""));
    } catch {
      return invalid();
    }
  }
}

function whitespace(char: string) {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

export async function* jsonRecords(
  input: AsyncIterable<Buffer>,
  signal: AbortSignal,
  options: boolean | JsonRecordsOptions = false,
): AsyncGenerator<unknown> {
  const allowSingleObject = typeof options === "boolean" ? options : !!options.allowSingleObject;
  const skipOversized = typeof options === "boolean" ? false : !!options.skipOversized;
  let state: "start" | "first" | "item" | "separator" | "end" = "start";
  let scanner: RecordScanner | undefined;
  let array = false;
  let skipChunks = 0;
  for await (const chunk of textChunks(input)) {
    signal.throwIfAborted();
    if (scanner?.oversized && ++skipChunks % 16 === 0) await yieldToLoop(undefined, { signal });
    for (let offset = 0; offset < chunk.length; ) {
      const char = chunk.charAt(offset);
      if (!scanner) {
        if (whitespace(char)) {
          offset++;
          continue;
        }
        if (state === "start" && char === "[") {
          array = true;
          state = "first";
        } else if ((state === "first" || state === "separator") && char === "]") {
          state = "end";
        } else if (state === "separator" && char === ",") {
          state = "item";
        } else if (
          ((state === "first" || state === "item") && (char === "{" || char === '"')) ||
          (state === "start" && allowSingleObject && char === "{")
        ) {
          scanner = new RecordScanner(array && skipOversized);
          skipChunks = 0;
        } else {
          invalid();
        }
        if (!scanner) {
          offset++;
          continue;
        }
      }
      const end = scanner.finishAt(chunk, offset);
      if (!scanner.oversized) scanner.append(chunk.slice(offset, end));
      if (end === undefined) break;
      yield scanner.value();
      scanner = undefined;
      state = array ? "separator" : "end";
      offset = end;
    }
  }
  if (state !== "end" || scanner) invalid();
}
