import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import {
  type BrainHost,
  importedDocument,
  PackageError,
  parseSkillFile,
  readScannedFile,
  redactValue,
  type ScannedSkillPackage,
  type SkillCopyProgress,
  scanSkillPackage,
  textOf,
  ZipError,
} from "@pibot/brain/kit";
import {
  envExampleFilter,
  type MethodParams,
  progressDeadline,
  RpcError,
  RpcErrorCodes,
  SKILL_IMPORT_PREVIEW_TEXT_MAX_BYTES,
  type Skill,
  type SkillDocument,
  SkillDocumentSchema,
  type SkillImportDetails,
  SkillImportDetailsSchema,
} from "@pibot/skills-contract/full";
import {
  allowedToolValues,
  compatibilityFrontmatter,
  skillCompatibility,
} from "./skill-compatibility.ts";
import type { SkillService } from "./skill-service.ts";

const TEXT = new Set([".md", ".markdown", ".txt"]);
/** Only documents SKILL.md itself points at, bounded so a preview stays cheap. */
const MAX_DOCUMENTS = 8;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const PREVIEW_MS = 10 * 60 * 1000;
const invalid = (message: string) => new RpcError(RpcErrorCodes.invalidParams, message);
interface Source {
  document: SkillDocument;
  kind: "file" | "folder" | "zip";
  name: string;
  pack: ScannedSkillPackage;
  /** Recognized source frontmatter names; written to the skill only on confirmed import. */
  sourceFields: NonNullable<SkillDocument["sourceFields"]>;
}
export function importError(error: unknown): never {
  // F6/F7: a cancel and a stalled copy need their own codes — the caller decides whether to try
  // again, and 「请重试」 is wrong for both.
  if (error instanceof RpcError) throw error;
  const reason = error instanceof PackageError || error instanceof ZipError ? error.message : "";
  // One oversized file is not the same fix as a package that is too big overall.
  if (reason === "file_too_large") throw invalid("skill_import_file_too_large");
  if (reason === "too_large") throw invalid("skill_import_too_large");
  if (reason === "too_many_files") throw invalid("skill_import_too_many_files");
  // The refused entry's name rides after the code, so the model and the logs can say which file
  // to remove instead of reporting only "unsafe".
  if (reason === "unsafe")
    throw invalid(
      error instanceof PackageError && error.path
        ? `skill_import_unsafe\n${error.path}`
        : "skill_import_unsafe",
    );
  if (reason === "no_skill" || error instanceof ZipError) throw invalid("skill_import_invalid");
  throw error;
}
/** Shared by interactive import and other-tool discovery; never retains resource buffers. */
export async function readImportSource(
  path: string,
  from: "file" | "folder",
  signal: AbortSignal,
  activity?: () => void,
): Promise<Source> {
  const extension = extname(path).toLowerCase();
  const kind = from === "folder" ? "folder" : extension === ".zip" ? "zip" : "file";
  if (kind === "file" && !TEXT.has(extension)) throw invalid("skill_import_unsupported");
  let pack: ScannedSkillPackage;
  try {
    pack = await scanSkillPackage(path, kind, signal, activity);
  } catch (error) {
    importError(error);
  }
  let document: SkillDocument;
  let sourceFields: Source["sourceFields"];
  try {
    const parsed = parseSkillFile(pack.skillText);
    document = importedDocument(parsed, pack.folder || basename(path, extension));
    sourceFields = document.sourceFields ?? parsed.sourceFields ?? [];
  } catch {
    throw invalid("skill_import_invalid");
  }
  return { document, kind, name: basename(path), pack, sourceFields };
}
/**
 * A skill's own commands often live in the documents SKILL.md points at, so the report reads
 * those too — but only the files the body names, capped, so a preview never reads the whole pack.
 */
async function referencedDocuments(
  pack: ScannedSkillPackage,
  body: string,
  signal: AbortSignal,
): Promise<string[]> {
  const texts: string[] = [];
  for (const file of pack.files) {
    if (texts.length >= MAX_DOCUMENTS) break;
    if (!/\.(?:md|markdown)$/i.test(file.path)) continue;
    if (!body.includes(file.path) && !body.includes(basename(file.path))) continue;
    if (file.bytes > MAX_DOCUMENT_BYTES) continue;
    try {
      const text = textOf(await readScannedFile(file, signal, MAX_DOCUMENT_BYTES));
      if (text) texts.push(text);
    } catch {
      // Advisory only: a document that changed since the scan leaves the report slightly poorer,
      // while failing the preview would block an import that is otherwise fine.
      signal.throwIfAborted();
    }
  }
  return texts;
}

interface PreviewOptions {
  linkOrigin?: SkillDocument["linkOrigin"];
  rename?: (name: string) => string;
  create?: Pick<
    NonNullable<Parameters<SkillService["create"]>[3]>,
    "enabled" | "afterInsert" | "expectedHash" | "importSource"
  >;
  /**
   * Previews held at once. A picked file or link candidate is one at a time, so 8 is plenty;
   * 「带过来」 previews every chosen skill in one batch (up to its 100-key limit) before the person
   * confirms, and with 8 every skill after the eighth failed as "busy".
   */
  maxPending?: number;
}
interface Pending {
  preview: SkillImportDetails;
  source: Source;
  abort: AbortController;
  options?: PreviewOptions;
  /** The package's own name, before `rename` picked a free one for the preview. */
  originalName: string;
  running?: Promise<Skill>;
  onRelease?: () => void;
}

/** Source versions are rechecked while copying; expiry/dispose also cancel real work. */
export class SkillImports {
  private readonly previews = new Map<string, Pending>();
  private picking = false;
  private readonly stopped = new AbortController();
  get retained() {
    this.prune();
    return this.picking || this.previews.size > 0;
  }
  constructor(
    private readonly skills: SkillService,
    private readonly host: BrainHost,
  ) {}
  async preview(
    botId: string,
    from: "file" | "folder",
    signal: AbortSignal,
  ): Promise<SkillImportDetails | null> {
    this.skills.activeBot(botId);
    if (this.picking) throw new RpcError(RpcErrorCodes.busy, "skill_picker_busy");
    this.picking = true;
    const workSignal = AbortSignal.any([signal, this.stopped.signal, AbortSignal.timeout(660_000)]);
    try {
      let path: string | null;
      if (from === "folder") {
        if (!this.host.pickFolder)
          throw new RpcError(RpcErrorCodes.unsupported, "skill_picker_unavailable");
        path = await this.host.pickFolder(workSignal);
      } else {
        if (!this.host.skills)
          throw new RpcError(RpcErrorCodes.unsupported, "skill_picker_unavailable");
        path = await this.host.skills.pickFile(workSignal);
      }
      return path ? await this.previewPath(botId, path, from, signal) : null;
    } finally {
      this.picking = false;
    }
  }
  /** Brain-only path entry for discovery/link adapters; renderer must only receive previewId. */
  async previewPath(
    botId: string,
    path: string,
    from: "file" | "folder",
    signal: AbortSignal,
    options?: PreviewOptions,
  ): Promise<SkillImportDetails> {
    this.skills.activeBot(botId);
    const work = progressDeadline(AbortSignal.any([signal, this.stopped.signal]));
    const deadline = work.signal;
    let source: Source;
    try {
      source = await readImportSource(path, from, deadline, work.touch);
    } catch (error) {
      this.throwIfStopped(deadline, signal);
      if (error instanceof RpcError) throw error;
      throw invalid("skill_import_unreadable");
    } finally {
      work.dispose();
    }
    deadline.throwIfAborted();
    // Values stay names only; prose in that list never reaches the report.
    const allowedTools = allowedToolValues(
      parseSkillFile(source.pack.skillText).fields["allowed-tools"],
    );
    const documents = await referencedDocuments(source.pack, source.document.body, deadline);
    const document = SkillDocumentSchema.parse(
      redactValue(source.document, this.skills.deps.redactor),
    );
    source.document = {
      ...document,
      ...(options?.linkOrigin ? { linkOrigin: options.linkOrigin } : {}),
      name: options?.rename?.(document.name) ?? this.freeName(botId, document.name),
    };
    this.prune();
    if (this.previews.size >= (options?.maxPending ?? 8))
      throw new RpcError(RpcErrorCodes.busy, "skill_busy");
    const pack = source.pack;
    const parsed = SkillImportDetailsSchema.safeParse(
      redactValue(
        {
          previewId: randomUUID(),
          botId,
          document: source.document,
          source: source.kind,
          sourceName: source.name.slice(0, 255),
          files: [
            { path: "SKILL.md", bytes: pack.skillFile.bytes, script: false, text: true },
            ...pack.files.map(({ path, bytes, script, text }) => ({ path, bytes, script, text })),
          ],
          totalBytes: pack.totalBytes,
          skipped: pack.skipped,
          summary: pack.summary,
          compatibility: skillCompatibility({
            frontmatter: compatibilityFrontmatter(source.sourceFields),
            body: source.document.body,
            allowedTools,
            documents,
            files: pack.files,
          }),
          expiresAt: new Date(Date.now() + PREVIEW_MS).toISOString(),
        },
        this.skills.deps.redactor,
      ),
    );
    if (!parsed.success) throw invalid("skill_import_invalid");
    this.previews.set(parsed.data.previewId, {
      preview: parsed.data,
      source,
      options,
      originalName: document.name,
      abort: new AbortController(),
    });
    return parsed.data;
  }
  async file(
    previewId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<{ path: string; text: string | null; tooLarge?: true }> {
    this.prune();
    const entry = this.previews.get(previewId);
    if (!entry) throw invalid("skill_preview_expired");
    const index = entry.preview.files.findIndex((item) => item.path === path);
    const file = index > 0 ? entry.source.pack.files[index - 1] : undefined;
    if (!file) throw invalid("skill_not_found");
    const deadline = AbortSignal.any([
      signal,
      this.stopped.signal,
      entry.abort.signal,
      AbortSignal.timeout(30_000),
    ]);
    if (file.bytes > SKILL_IMPORT_PREVIEW_TEXT_MAX_BYTES)
      return { path, text: null, tooLarge: true };
    const text = file.text
      ? (textOf(await readScannedFile(file, deadline, SKILL_IMPORT_PREVIEW_TEXT_MAX_BYTES)) ?? null)
      : null;
    return {
      path,
      text:
        text === null
          ? null
          : this.skills.deps.redactor.redact(
              basename(path).toLowerCase() === ".env.example"
                ? envExampleFilter()(Buffer.from(text))
                : text,
            ),
    };
  }
  private freeName(botId: string, name: string) {
    if (!this.skills.repo.findByName(botId, name)) return name;
    for (let n = 2; n < 100; n++) {
      const suffix = ` ${n}`,
        candidate = `${name.slice(0, 80 - suffix.length)}${suffix}`;
      if (!this.skills.repo.findByName(botId, candidate)) return candidate;
    }
    throw invalid("skill_name_exists");
  }
  /**
   * An explicit cancel is the person's decision; a stalled copy is a failure. The
   * deadline owns both timers, so only its abort reason tells them apart.
   */
  private throwIfStopped(deadline: AbortSignal, signal: AbortSignal, entry?: Pending) {
    if (!deadline.aborted) return;
    if (deadline.reason instanceof DOMException && deadline.reason.name === "TimeoutError")
      throw new RpcError(RpcErrorCodes.timeout, "skill_import_timeout");
    if (entry?.abort.signal.aborted || this.stopped.signal.aborted || signal.aborted)
      throw new RpcError(RpcErrorCodes.cancelled, "skill_import_cancelled");
  }
  isImporting(previewId: string) {
    return Boolean(this.previews.get(previewId)?.running);
  }
  /** A picker batch follows the slot's lifetime even if its RPC response never arrives. */
  onPreviewRelease(previewId: string, release: () => void) {
    const entry = this.previews.get(previewId);
    if (entry) entry.onRelease = release;
    else release();
  }
  private release(previewId: string) {
    const entry = this.previews.get(previewId);
    this.previews.delete(previewId);
    entry?.onRelease?.();
  }
  private prune() {
    for (const [id, entry] of this.previews) {
      if (Date.parse(entry.preview.expiresAt) <= Date.now() && !entry.running) {
        entry.abort.abort();
        this.release(id);
      }
    }
  }
  async cancel(previewId: string) {
    const entry = this.previews.get(previewId);
    entry?.abort.abort();
    // Import owns the staging directory; wait until its finally/rollback has completed.
    if (entry?.running) await entry.running.catch(() => undefined);
    this.release(previewId);
    return { ok: true as const };
  }
  import(
    previewId: string,
    signal: AbortSignal,
    bindings?: MethodParams["skills.import"]["bindings"],
  ): Promise<Skill> {
    this.prune();
    const entry = this.previews.get(previewId);
    if (!entry) return Promise.reject(invalid("skill_preview_expired"));
    if (entry.running) return entry.running;
    const variables = entry.source.pack.summary.bindableEnvironmentVariables ?? [];
    if (bindings?.length)
      this.skills.validateSecretBindings(entry.preview.botId, bindings, variables);
    const work = progressDeadline(
      AbortSignal.any([signal, this.stopped.signal, entry.abort.signal]),
      entry.source.pack.summary.fileCount,
      entry.source.pack.totalBytes,
    );
    const deadline = work.signal;
    let last = 0;
    let progress: SkillCopyProgress = {
      files: 0,
      bytes: 0,
      totalFiles: entry.source.pack.summary.fileCount,
      totalBytes: entry.source.pack.totalBytes,
    };
    const emit = (phase: "copying" | "done" | "cancelled" | "failed", value = progress) => {
      work.touch();
      progress = value;
      const now = Date.now();
      if (phase === "copying" && last && now - last < 200) return;
      last = now;
      try {
        this.skills.deps.peer.emit("skills.importProgress", {
          ...(this.skills.groupId ? { groupId: this.skills.groupId } : {}),
          botId: entry.preview.botId,
          previewId,
          phase,
          ...value,
        });
      } catch {
        // A disconnected progress subscriber must not turn a committed import into a failed RPC.
        this.skills.deps.logger.warn(
          JSON.stringify({ module: "skills", event: "import_progress_unavailable" }),
        );
      }
    };
    // 「带过来」 previews a whole batch before importing any of it, so two same-name skills (Codex
    // and pi both have `review`) were both offered `review` and the second import failed with
    // skill_name_exists. A renaming caller picks the free name again now, as `review 2`.
    const name = entry.options?.rename?.(entry.originalName) ?? entry.preview.document.name;
    entry.running = this.skills
      .create(
        entry.preview.botId,
        { ...entry.preview.document, name, sourceFields: entry.source.sourceFields },
        "imported",
        {
          ...entry.options?.create,
          reason: "imported",
          scannedPackage: entry.source.pack,
          queueSignal: deadline,
          copySignal: deadline,
          onProgress: (value) => emit("copying", value),
          // The digest and seal passes after the copy report no file progress; on ppt-master
          // (13,000 files) they outlasted this deadline's 60 s idle limit and the import failed.
          onActivity: () => work.touch(),
          afterInsert: (record) => {
            entry.options?.create?.afterInsert?.(record);
            if (!bindings?.length) return;
            this.skills.validateSecretBindings(record.botId, bindings, variables);
            this.skills.writeSecretBindings(record, bindings);
          },
        },
      )
      .then(
        (skill) => {
          emit("done");
          return skill;
        },
        (error: unknown) => {
          const timedOut =
            deadline.reason instanceof DOMException && deadline.reason.name === "TimeoutError";
          const cancelled =
            !timedOut &&
            (entry.abort.signal.aborted || this.stopped.signal.aborted || signal.aborted);
          emit(cancelled ? "cancelled" : "failed");
          this.throwIfStopped(deadline, signal, entry);
          importError(error);
        },
      )
      .finally(() => {
        work.dispose();
        this.release(previewId);
      });
    return entry.running;
  }
  dispose() {
    this.stopped.abort();
    for (const [id, entry] of this.previews) {
      entry.abort.abort();
      // A running import releases its slot only after rollback; SkillService.settled drains it.
      if (!entry.running) this.release(id);
    }
  }
}
