// Adapters yield bounded records rather than exposing provider-specific objects to storage.
import {
  ExportDetailsSchema,
  ImportProjectKeySchema,
  type ImportSource,
} from "@pibot/import-contract";
import { z } from "zod";

import { ImportFailure } from "../store/failure.ts";

export { LONG_MESSAGE_CHARS, MESSAGE_CHARS } from "./limits.ts";
export { ImportFailure };

import { HistoryPartsSchema } from "./history-parts.ts";
import { LONG_MESSAGE_CHARS, MESSAGE_CHARS } from "./limits.ts";
import { geminiAdapter } from "./local/gemini.ts";
import { opencodeAdapter } from "./local/opencode.ts";
import { transcriptAdapter } from "./local/transcript.ts";

const time = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
/** The source project a topic or note belongs to; `path` is a local tool's working directory. */
export const ProjectRefSchema = z.strictObject({
  key: ImportProjectKeySchema,
  name: z.string().max(200),
  path: z.string().min(1).max(4096).optional(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;
export const ImportTopicSchema = z.strictObject({
  kind: z.literal("topic"),
  title: z.string().max(200),
  createdAt: time,
  updatedAt: time,
  project: ProjectRefSchema.optional(),
  memoryExcluded: z.boolean().optional(),
});
export const ImportMessageSchema = z.strictObject({
  kind: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(LONG_MESSAGE_CHARS),
  historyParts: HistoryPartsSchema.optional(),
  createdAt: time,
});
export const ImportRecordSchema = z.discriminatedUnion("kind", [
  ImportTopicSchema,
  ImportMessageSchema,
]);
export type ImportRecord = z.input<typeof ImportRecordSchema>;

const exportSummary = ExportDetailsSchema.extend({ kind: z.literal("exportSummary") });
export const PreviewRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("topic"),
    createdAt: time,
    updatedAt: time,
    project: ProjectRefSchema.optional(),
    memoryExcluded: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("message"),
    createdAt: time,
    /** Over MESSAGE_CHARS: imported as a preview plus a text attachment. */
    long: z.literal(true).optional(),
    /** Local sizing only. Never part of the RPC preview. */
    message: z
      .object({ role: ImportMessageSchema.shape.role, text: ImportMessageSchema.shape.text })
      .optional(),
  }),
  z.strictObject({ kind: z.literal("skipped") }),
  z.strictObject({ kind: z.literal("skippedTooLong") }),
  /** A knowledge piece of a source project (its chats may be elsewhere in the export or absent). */
  z.strictObject({
    kind: z.literal("projectKnowledge"),
    project: ProjectRefSchema,
    /** 0 names a project that has no knowledge of its own. */
    pieces: z.union([z.literal(0), z.literal(1)]),
  }),
  exportSummary,
]);
export type PreviewRecord = z.input<typeof PreviewRecordSchema>;

/** The preview record of one message, flagging the ones that need a text attachment. */
export function previewMessage(
  record: Pick<z.input<typeof ImportMessageSchema>, "createdAt" | "text" | "role">,
): PreviewRecord {
  return {
    kind: "message",
    createdAt: record.createdAt,
    message: { role: record.role, text: record.text },
    ...(record.text.length > MESSAGE_CHARS ? { long: true as const } : {}),
  };
}

export interface ImportFile {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface ImportInput {
  (signal: AbortSignal): AsyncIterable<Buffer>;
  modifiedAt?: string;
  projectNote?: true;
  /** Optional topic title override for a single transcript file (e.g. from Codex session_index). */
  title?: string;
  /** Canonical path when bound to a local file (e.g. opencode.db). */
  sourcePath?: string;
  /** Pre-built batch stream for multi-conversation / memory / rule selection imports. */
  batch?: {
    preview(signal: AbortSignal): AsyncIterable<PreviewRecord>;
    read(signal: AbortSignal): AsyncIterable<ImportRecord>;
    supplements?(signal: AbortSignal): AsyncIterable<import("./exports/supplement.ts").Supplement>;
    assertSource?(signal: AbortSignal): Promise<void>;
  };
  file?(signal: AbortSignal): AsyncIterable<ImportFile>;
}

export interface ImportAdapter {
  detect(signal: AbortSignal): AsyncIterable<boolean>;
  preview(input: ImportInput, signal: AbortSignal): AsyncIterable<PreviewRecord>;
  /** Every topic precedes its messages. Topics and messages from different topics never interleave. */
  read(input: ImportInput, signal: AbortSignal): AsyncIterable<ImportRecord>;
}

function unsupportedIterable<T>(signal: AbortSignal): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          signal.throwIfAborted();
          return Promise.reject(new ImportFailure("unsupported"));
        },
      };
    },
  };
}

const antigravityFileAdapter: ImportAdapter = {
  async *detect(signal) {
    signal.throwIfAborted();
    yield true;
  },
  preview: (_input, signal) => unsupportedIterable<PreviewRecord>(signal),
  read: (_input, signal) => unsupportedIterable<ImportRecord>(signal),
};

export const batchAdapter: ImportAdapter = {
  async *detect(signal) {
    signal.throwIfAborted();
    yield true;
  },
  async *preview(input, signal) {
    if (!input.batch) throw new ImportFailure("format");
    yield* input.batch.preview(signal);
  },
  async *read(input, signal) {
    if (!input.batch) throw new ImportFailure("format");
    yield* input.batch.read(signal);
  },
};

export function adapters(
  fixture: ImportAdapter,
  chatgpt: ImportAdapter,
  claude: ImportAdapter,
): Record<ImportSource, ImportAdapter> {
  return {
    fixture,
    chatgpt,
    claude,
    "claude-code": transcriptAdapter("claude-code"),
    codex: transcriptAdapter("codex"),
    cursor: transcriptAdapter("cursor"),
    opencode: opencodeAdapter,
    antigravity: antigravityFileAdapter,
    gemini: geminiAdapter,
  };
}
