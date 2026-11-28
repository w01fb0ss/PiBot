// Bound adapter output and page writes so the brain remains responsive during large imports.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { BrainRedactor } from "@pibot/brain/kit";
import type {
  ExportDetails,
  ImportPreview,
  ImportProject,
  ImportStatus,
} from "@pibot/import-contract";
import type { Attachment } from "@pibot/protocol-base";
import type { ImportStore } from "../store/index.ts";
import {
  type ImportAdapter,
  ImportFailure,
  type ImportInput,
  ImportRecordSchema,
  MESSAGE_CHARS,
  PreviewRecordSchema,
  type ProjectRef,
} from "./adapter.ts";

const PREVIEW_RECORDS = 32;
const PAGE_RECORDS = 4;
const PAGE_TEXT_BYTES = 128 * 1024;
const PAGE_WORK_MS = 18;
const MAX_TOPICS = 20_000;
const MAX_MESSAGES = 500_000;
const MAX_TEXT_BYTES = 512 * 1024 * 1024;
const MAX_PROJECTS = 200;

class Summary {
  readonly counts = { topics: 0, messages: 0 };
  from: string | null = null;
  through: string | null = null;
  readonly projects = new Map<string, ImportProject>();
  readonly paths = new Map<string, string>();
  /** The tracked project of the topic whose messages follow. */
  private current?: ImportProject;

  include(record: {
    kind: "topic" | "message";
    createdAt: string;
    updatedAt?: string;
    project?: ProjectRef;
  }) {
    const { kind, createdAt, updatedAt = createdAt } = record;
    if (kind === "topic") {
      if (updatedAt < createdAt || ++this.counts.topics > MAX_TOPICS)
        throw new ImportFailure(updatedAt < createdAt ? "format" : "limit");
      this.current = record.project ? this.track(record.project) : undefined;
      if (this.current) this.current.topics++;
    } else if (!this.counts.topics || ++this.counts.messages > MAX_MESSAGES) {
      throw new ImportFailure(this.counts.topics ? "limit" : "format");
    } else if (this.current) {
      this.current.messages++;
    }
    if (!this.from || createdAt < this.from) this.from = createdAt;
    if (!this.through || updatedAt > this.through) this.through = updatedAt;
  }

  /** Projects past the cap stay untracked; their chats then count as chats outside a project. */
  track(ref: ProjectRef) {
    let project = this.projects.get(ref.key);
    if (!project) {
      if (this.projects.size >= MAX_PROJECTS) return undefined;
      project = { key: ref.key, name: ref.name, topics: 0, messages: 0, knowledge: 0 };
      this.projects.set(ref.key, project);
    }
    if (!project.name && ref.name) project.name = ref.name;
    if (ref.path && !this.paths.has(ref.key)) this.paths.set(ref.key, ref.path);
    return project;
  }
}

export type DistillationSource = { projectKey?: string; bytes: number };

export function distillationText(role: string, text: string) {
  if (!text.trim()) return "";
  // Long-message attachments stay local. Use the prefix present in the imported topic.
  let end = MESSAGE_CHARS - 256;
  if (/[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
  return `${role}: ${text.slice(0, end)}\n\n`;
}

export async function summarize(
  adapter: ImportAdapter,
  input: ImportInput,
  signal: AbortSignal,
  redactor: Pick<BrainRedactor, "redact">,
) {
  const summary = new Summary();
  let pending = 0;
  let skippedRecords = 0;
  let skippedTooLong = 0;
  let longMessages = 0;
  let exportDetails: ExportDetails | undefined;
  const distillationSources: DistillationSource[] = [];
  let current: DistillationSource | undefined;
  for await (const record of adapter.preview(input, signal)) {
    signal.throwIfAborted();
    const parsed = PreviewRecordSchema.safeParse(record);
    if (!parsed.success) throw new ImportFailure("format");
    if (parsed.data.kind === "exportSummary") {
      const { kind: _kind, ...details } = parsed.data;
      if (exportDetails) throw new ImportFailure("format");
      exportDetails = details;
    } else if (parsed.data.kind === "skipped") {
      skippedRecords++;
    } else if (parsed.data.kind === "skippedTooLong") {
      skippedTooLong++;
    } else if (parsed.data.kind === "projectKnowledge") {
      const project = summary.track(parsed.data.project);
      if (project) project.knowledge += parsed.data.pieces;
    } else {
      if (parsed.data.kind === "message" && parsed.data.long) longMessages++;
      summary.include(parsed.data);
      if (parsed.data.kind === "topic") {
        current = undefined;
        if (!parsed.data.memoryExcluded) {
          const key = parsed.data.project?.key;
          current = { projectKey: key && summary.projects.has(key) ? key : undefined, bytes: 0 };
          distillationSources.push(current);
        }
      } else if (current && parsed.data.message?.text) {
        const { role, text } = parsed.data.message;
        current.bytes += Buffer.byteLength(
          distillationText(role, redactImportText(redactor, text)),
        );
      }
    }
    if (++pending % PREVIEW_RECORDS === 0) await yieldToLoop(undefined, { signal });
  }
  signal.throwIfAborted();
  return {
    summary: {
      ...summary.counts,
      from: summary.from,
      through: summary.through,
      ...(skippedRecords ? { skippedRecords } : {}),
      ...(skippedTooLong ? { skippedTooLong } : {}),
      ...(longMessages ? { longMessages } : {}),
      ...(exportDetails ? { exportDetails } : {}),
      ...(summary.projects.size ? { projects: [...summary.projects.values()] } : {}),
    },
    /** Local working directories stay in the brain; the preview only names the project. */
    paths: summary.paths,
    distillationSources,
  };
}

/** Where one topic goes; undefined leaves the topic (and its messages) out of the batch. */
export type TopicTarget = { botId: string; folderId?: string };

type WriteOptions = {
  adapter: ImportAdapter;
  input: ImportInput;
  preview: ImportPreview;
  route(project: string | undefined): TopicTarget | undefined;
  bots: readonly string[];
  store: ImportStore;
  redactor: Pick<BrainRedactor, "redact">;
  signal: AbortSignal;
  heartbeat?: () => void;
  progress: (counts: Pick<ImportStatus, "topics" | "messages">) => void;
  /** Saves a long message's whole (redacted) text as a topic file; undefined when too large. */
  saveFullText(botId: string, text: string, signal: AbortSignal): Promise<SavedText | undefined>;
};

export type SavedText = { metadata: Attachment; stored: string };

/** The start of a long message plus a line saying where the rest went (both languages). */
export function longPreview(text: string, attached: boolean) {
  const kb = Math.ceil(Buffer.byteLength(text) / 1024);
  let end = MESSAGE_CHARS - 256;
  // Never split a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
  const note = attached
    ? `…（全文见附件，原文 ${kb} KB）/ …(full text attached, ${kb} KB)`
    : `…（内容过长，已截断，原文 ${kb} KB）/ …(too long, cut here; ${kb} KB)`;
  return `${text.slice(0, end)}\n\n${note}`;
}

export async function writeRecords(opts: WriteOptions) {
  const { adapter, input, preview, store, signal, progress } = opts;
  const { importId, source } = preview;
  const tracked = new Set(preview.projects?.map(({ key }) => key));
  const summary = new Summary();
  const written = { topics: 0, messages: 0 };
  const page: Array<() => void> = [];
  let conversationId: string | undefined;
  let target: TopicTarget | undefined;
  let bytes = 0;
  let pageBytes = 0;
  let pageStart = performance.now();
  async function mismatchedRecords() {
    // An early exit from the adapter can skip its end-of-read identity and write checks.
    for await (const _file of input.file?.(signal) ?? []) signal.throwIfAborted();
    throw new ImportFailure("source_changed");
  }
  function flush() {
    signal.throwIfAborted();
    if (!page.length) return;
    store.page(
      importId,
      () => {
        if (!opts.bots.every((bot) => store.availableBot(bot))) throw new ImportFailure("target");
        for (const write of page) write();
      },
      written,
    );
    page.length = 0;
    pageBytes = 0;
    opts.heartbeat?.();
    progress({ ...written });
  }
  for await (const record of adapter.read(input, signal)) {
    signal.throwIfAborted();
    opts.heartbeat?.();
    const parsed = ImportRecordSchema.safeParse(record);
    if (!parsed.success) throw new ImportFailure("format");
    const item = parsed.data;
    summary.include(item);
    if (summary.counts.topics > preview.topics || summary.counts.messages > preview.messages)
      await mismatchedRecords();
    if (item.kind === "topic") {
      const key = item.project?.key;
      target = opts.route(key && tracked.has(key) ? key : undefined);
    }
    if (!target) continue;
    const size =
      item.kind === "topic"
        ? Buffer.byteLength(item.title)
        : Buffer.byteLength(item.text) + Buffer.byteLength(JSON.stringify(item.historyParts ?? []));
    if (
      page.length &&
      (page.length >= PAGE_RECORDS ||
        pageBytes + size > PAGE_TEXT_BYTES ||
        performance.now() - pageStart >= PAGE_WORK_MS)
    ) {
      flush();
      await yieldToLoop(undefined, { signal });
      pageStart = performance.now();
    }
    bytes += size;
    pageBytes += size;
    if (bytes > MAX_TEXT_BYTES) throw new ImportFailure("limit");
    const owner = target;
    if (item.kind === "topic") {
      const title = redactImportText(opts.redactor, item.title).slice(0, 200);
      const topic = {
        title,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        memoryExcluded: item.memoryExcluded,
      };
      written.topics++;
      page.push(() => {
        conversationId = store.addTopic(importId, owner.botId, source, topic, owner.folderId);
      });
    } else {
      const full = redactImportText(opts.redactor, item.text);
      // A long message keeps a readable start in the topic; the whole text becomes a file.
      const saved =
        full.length > MESSAGE_CHARS
          ? await opts.saveFullText(owner.botId, full, signal)
          : undefined;
      const text = full.length > MESSAGE_CHARS ? longPreview(full, !!saved) : full;
      const historyParts = item.historyParts?.map((part) => ({
        ...part,
        name: redactImportText(opts.redactor, part.name).slice(0, 200) || "tool",
        ...(part.summary
          ? { summary: redactImportText(opts.redactor, part.summary).slice(0, 200) }
          : {}),
      }));
      written.messages++;
      page.push(() => {
        if (!conversationId) throw new ImportFailure("format");
        const messageId = store.addMessage(importId, owner.botId, conversationId, {
          ...item,
          text,
          historyParts,
        });
        if (saved) store.addAttachment(messageId, owner.botId, saved);
      });
    }
  }
  if (
    summary.counts.topics !== preview.topics ||
    summary.counts.messages !== preview.messages ||
    summary.from !== preview.from ||
    summary.through !== preview.through
  )
    await mismatchedRecords();
  flush();
}

export function redactImportText(redactor: Pick<BrainRedactor, "redact">, input: string) {
  return redactor
    .redact(input)
    .replace(
      /\b(password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[REDACTED]",
    )
    .replace(/\bBearer[ \t]+[A-Za-z0-9_./+~=-]+/gi, "Bearer [REDACTED]");
}
