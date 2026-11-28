// The synthetic, size-limited JSON source exercises the same iterator boundary as larger exports.
import { z } from "zod";
import {
  type ImportAdapter,
  ImportFailure,
  type ImportInput,
  ImportMessageSchema,
  ImportTopicSchema,
  previewMessage,
} from "./adapter.ts";

const fixture = z.object({
  format: z.literal("pibot-import-fixture-v1"),
  topics: z
    .array(
      z.object({
        ...ImportTopicSchema.omit({ kind: true }).shape,
        messages: z.array(z.object(ImportMessageSchema.omit({ kind: true }).shape)).max(1000),
      }),
    )
    .max(100),
});
const MAX_BYTES = 256 * 1024;

async function* records(input: ImportInput, signal: AbortSignal) {
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input(signal)) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new ImportFailure("limit");
    buffers.push(chunk);
  }
  signal.throwIfAborted();
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers, bytes)),
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new ImportFailure("format");
    throw error;
  }
  const parsed = fixture.safeParse(raw);
  if (!parsed.success) throw new ImportFailure("format");
  for (const { messages, ...topic } of parsed.data.topics) {
    signal.throwIfAborted();
    yield { kind: "topic" as const, ...topic };
    for (const message of messages) {
      signal.throwIfAborted();
      yield { kind: "message" as const, ...message };
    }
  }
}

export const fixtureAdapter: ImportAdapter = {
  async *detect(signal) {
    signal.throwIfAborted();
    yield true;
  },
  async *preview(input, signal) {
    for await (const record of records(input, signal)) {
      if (record.kind === "topic")
        yield {
          kind: "topic",
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          ...(record.project ? { project: record.project } : {}),
          ...(record.memoryExcluded ? { memoryExcluded: true } : {}),
        };
      else yield previewMessage(record);
    }
  },
  read: records,
};
