// A single job owner keeps preview authorizations, progress, and cancellation consistent.
import { randomUUID } from "node:crypto";
import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { CapabilityContext } from "@pibot/brain/kit";
import type { ImportPreview, ImportSource, ImportStatus } from "@pibot/import-contract";
import type { ImportParams } from "@pibot/import-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { isStoredAttachmentPath, TopicsRepo } from "@pibot/storage";
import type { CleanupWork } from "../store/cleanup-work.ts";
import type { ImportStore } from "../store/index.ts";
import type { ImportMemoryScope } from "../store/memories.ts";
import { adapters, batchAdapter } from "./adapter.ts";
import { ImportCleanup } from "./cleanup.ts";
import { exportAdapter } from "./exports/index.ts";
import { fixtureAdapter } from "./fixture.ts";
import { listLocalConversations, prepareLocalSelection } from "./local/agent-list.ts";
import {
  configRootFor,
  isLocalSource,
  noteSummary,
  supportsLocalSources,
} from "./local/locations.ts";
import { readProjectNote } from "./local/text.ts";
import { ProjectImport } from "./project.ts";
import { summarize } from "./records.ts";
import { ImportReviews } from "./reviews.ts";
import { failureReason, runImport } from "./run.ts";
import { selectedInput } from "./source.ts";
import { startPlan } from "./start.ts";

const PREVIEW_MS = 90_000;
const PREVIEW_SELECTION_MS = 180_000;

type Running = { importId: string; controller: AbortController; done: Promise<ImportStatus> };

export class ImportJobs {
  private readonly adapters = adapters(
    fixtureAdapter,
    exportAdapter("chatgpt"),
    exportAdapter("claude"),
  );
  private readonly closing = new AbortController();
  private readonly cleanup: ImportCleanup;
  private readonly project: ProjectImport;
  private previewing?: Promise<ImportPreview | null>;
  readonly reviews: ImportReviews;
  private active?: Running;
  private undoReservation?: Promise<void>;

  constructor(
    private readonly ctx: CapabilityContext,
    private readonly store: ImportStore,
  ) {
    this.project = new ProjectImport(ctx, store.projects);
    this.reviews = new ImportReviews(
      ctx,
      store,
      this.project,
      this.closing.signal,
      () => !!this.previewing,
    );
    this.cleanup = new ImportCleanup(
      store,
      this.closing.signal,
      (status, bots) => {
        if (bots) this.changedTopics(status.importId, bots);
        this.publish(status);
      },
      () => this.ctx.logger.error("import_cleanup_failed"),
      async (id, work, signal) => {
        const botId = this.store.target(id);
        if (typeof botId !== "string") throw new Error("import_job_missing");
        await this.project.restore(id, botId, signal);
        await this.removeAttachmentFiles(id, work, signal);
        await this.removeSessionFiles(id, work, signal);
      },
    );
  }

  /** Long-message files go with their messages; a startup sweep would also catch leftovers. */
  private async removeAttachmentFiles(importId: string, work: CleanupWork, signal: AbortSignal) {
    let after = 0;
    let dataDir: string | undefined;
    while (!signal.aborted) {
      const { cursor, files } = await work.run(
        { kind: "attachments", id: importId, after },
        signal,
      );
      if (cursor === undefined) return;
      if (files.length) {
        dataDir ??= await realpath(this.ctx.local.deps.dataDir);
        for (const { path, botId } of files) {
          signal.throwIfAborted();
          await this.removeAttachmentFile(dataDir, botId, path, signal);
        }
      }
      after = cursor;
      await yieldToLoop(undefined, { signal });
    }
  }

  private async removeAttachmentFile(
    dataDir: string,
    botId: string,
    stored: string,
    signal: AbortSignal,
  ) {
    const name = basename(stored);
    const relative = `bots/${botId}/attachments/${name}`;
    const dir = join(dataDir, "bots", botId, "attachments");
    const owned = isAbsolute(stored)
      ? resolve(stored) ===
          resolve(this.ctx.local.deps.dataDir, "bots", botId, "attachments", name) ||
        resolve(stored) === join(dir, name)
      : stored === relative;
    if (!owned || !isStoredAttachmentPath(relative, botId))
      throw new Error("import_attachment_path");
    const file = join(dir, name);
    try {
      if (!(await lstat(file)).isFile() || (await realpath(dir)) !== dir)
        throw new Error("import_attachment_path");
      signal.throwIfAborted();
      await unlink(file);
    } catch (error) {
      // A completed unlink (or a missing directory) can be retried after interruption.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async removeSessionFiles(importId: string, work: CleanupWork, signal: AbortSignal) {
    let after = 0;
    let dataDir: string | undefined;
    while (!signal.aborted) {
      const { cursor, ids, files } = await work.run(
        { kind: "sessions", id: importId, after },
        signal,
      );
      if (cursor === undefined) return;
      if (files.length) {
        dataDir ??= await realpath(this.ctx.dataDir);
        for (const { botId, file } of files) {
          signal.throwIfAborted();
          await this.removeSessionFile(dataDir, botId, file);
        }
        await work.run({ kind: "clearSessions", ids }, signal);
      }
      after = cursor;
      await yieldToLoop(undefined, { signal });
    }
  }

  private async removeSessionFile(dataDir: string, botId: string, file: string) {
    const relativeDir = `bots/${botId}/sessions`;
    const dir = join(dataDir, "bots", botId, "sessions");
    const name = basename(file);
    // Older absolute rows must match the same Bot directory before they can be removed.
    const owned = isAbsolute(file)
      ? resolve(dirname(file)) === resolve(this.ctx.dataDir, "bots", botId, "sessions")
      : file === `${relativeDir}/${name}`;
    if (!owned || !name.endsWith(".jsonl")) throw new Error("import_session_path");
    const actual = await realpath(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (actual === undefined) return;
    if (actual !== dir) throw new Error("import_session_path");
    await rm(join(dir, name), { force: true });
  }

  /** The import history, each batch with the same status (and cleanup state) as `status`. */
  history({ before, limit = 20 }: ImportParams<"import.history">) {
    const page = this.store.history(before, limit);
    return {
      items: page.rows.flatMap(({ id, createdAt }) => {
        const status = this.cleanup.status(id);
        return status ? [{ ...status, createdAt }] : [];
      }),
      next: page.next,
    };
  }

  idle() {
    return (
      !this.active &&
      !this.undoReservation &&
      !this.previewing &&
      !this.reviews.busy() &&
      this.cleanup.idle()
    );
  }

  recover() {
    this.store.recover();
    void this.cleanup.wake();
  }

  async detect(source: ImportSource, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.closing.signal, AbortSignal.timeout(PREVIEW_MS)]);
    if (isLocalSource(source) && !supportsLocalSources(this.ctx.local.deps.platform))
      return { available: false };
    for await (const available of this.adapters[source].detect(signal)) {
      signal.throwIfAborted();
      return { available: available && !!this.ctx.host.pickFile };
    }
    return { available: false };
  }

  async listConversations(params: ImportParams<"import.listConversations">, caller: AbortSignal) {
    this.closing.signal.throwIfAborted();
    const deadline = AbortSignal.timeout(PREVIEW_MS);
    const signal = AbortSignal.any([caller, this.closing.signal, deadline]);
    const workFolderPaths = this.store.workFolders().map(({ path }) => path);
    try {
      return await listLocalConversations(this.ctx, workFolderPaths, params, signal);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (deadline.aborted)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_timeout");
      signal.throwIfAborted();
      const reason = failureReason(error);
      if (reason === "internal") throw error;
      if (reason === "unsupported")
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      throw new RpcError(RpcErrorCodes.invalidParams, `import_${reason}`);
    }
  }

  async preview(source: ImportSource, caller: AbortSignal, filterLabel?: string) {
    this.closing.signal.throwIfAborted();
    if (this.previewing || this.reviews.busy())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_busy");
    const work = this.openPreview(source, caller, filterLabel);
    this.previewing = work;
    try {
      return await work;
    } finally {
      this.previewing = undefined;
    }
  }

  async previewSelection(
    params: ImportParams<"import.previewSelection">,
    caller: AbortSignal,
  ): Promise<ImportPreview> {
    this.closing.signal.throwIfAborted();
    if (this.previewing || this.reviews.busy())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_busy");
    const work = this.openSelectionPreview(params, caller);
    this.previewing = work;
    try {
      return await work;
    } finally {
      this.previewing = undefined;
    }
  }

  private async openSelectionPreview(
    params: ImportParams<"import.previewSelection">,
    caller: AbortSignal,
  ): Promise<ImportPreview> {
    this.reviews.clear();
    const deadline = AbortSignal.timeout(PREVIEW_SELECTION_MS);
    const signal = AbortSignal.any([caller, this.closing.signal, deadline]);
    const { source } = params;
    try {
      if (!(await this.detect(source, signal)).available)
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      const workFolderPaths = this.store.workFolders().map(({ path }) => path);
      const input = await prepareLocalSelection(this.ctx, workFolderPaths, params, signal);
      const { summary, paths, distillationSources } = await summarize(
        batchAdapter,
        input,
        signal,
        this.ctx.redactor,
      );
      const preview: ImportPreview = { importId: randomUUID(), source, ...summary };
      signal.throwIfAborted();
      this.reviews.set(preview, input, paths, distillationSources);
      return preview;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (deadline.aborted)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_timeout");
      signal.throwIfAborted();
      const reason = failureReason(error);
      if (reason === "internal") throw error;
      if (reason === "unsupported")
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      if (reason === "format")
        throw new RpcError(
          RpcErrorCodes.invalidParams,
          `import_format_${source.replace("-", "_")}`,
        );
      throw new RpcError(RpcErrorCodes.invalidParams, `import_${reason}`);
    }
  }

  private async openPreview(source: ImportSource, caller: AbortSignal, filterLabel?: string) {
    this.reviews.clear();
    const deadline = AbortSignal.timeout(PREVIEW_MS);
    const signal = AbortSignal.any([caller, this.closing.signal, deadline]);
    try {
      if (!(await this.detect(source, signal)).available)
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      const path = await this.ctx.host.pickFile?.(signal, this.pickerOptions(source, filterLabel));
      signal.throwIfAborted();
      if (!path) return null;
      const input = await selectedInput(this.ctx.local.deps, path, signal, source);
      const { summary, paths, distillationSources } = input.projectNote
        ? await readProjectNote(input, signal).then(() => ({
            ...noteSummary(this.ctx.local.deps.platform, path),
            distillationSources: [],
          }))
        : await summarize(this.adapters[source], input, signal, this.ctx.redactor);
      const preview = { importId: randomUUID(), source, ...summary };
      signal.throwIfAborted();
      this.reviews.set(preview, input, paths, distillationSources);
      return preview;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (deadline.aborted)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_timeout");
      signal.throwIfAborted();
      const reason = failureReason(error);
      if (reason === "internal") throw error;
      if (reason === "unsupported")
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      if (reason === "format" && source !== "fixture")
        throw new RpcError(
          RpcErrorCodes.invalidParams,
          `import_format_${source.replace("-", "_")}`,
        );
      throw new RpcError(RpcErrorCodes.invalidParams, `import_${reason}`);
    }
  }

  private pickerOptions(source: ImportSource, filterLabel = "ZIP / JSON") {
    if (source === "chatgpt" || source === "claude" || source === "gemini") {
      return { filters: [{ name: filterLabel, extensions: ["zip", "json"] }] };
    }
    const { platform, userHome, env } = this.ctx.local.deps;
    if (!isLocalSource(source) || !supportsLocalSources(platform)) return undefined;
    const root = configRootFor(source, platform, userHome, env);
    if (source === "codex") return { defaultPath: join(root, "sessions") };
    if (source === "claude-code" || source === "cursor")
      return { defaultPath: join(root, "projects") };
    if (source === "opencode") return { defaultPath: root };
    return { defaultPath: userHome };
  }

  async start(
    importId: string,
    botId: string,
    options: Omit<ImportParams<"import.start">, "importId" | "botId">,
    caller: AbortSignal,
  ) {
    this.closing.signal.throwIfAborted();
    const existing = this.store.get(importId);
    if (existing) {
      if (this.store.target(importId) !== botId)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_target");
      return this.status(importId);
    }
    if (this.active || this.undoReservation || this.reviews.busy() || this.store.unfinished())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
    const selection = this.reviews.requireSelection(importId);
    const plan = startPlan(selection, botId, options, {
      store: this.store,
      port: this.ctx.local.memoryImportDistillation,
    });
    if (plan.projects.some(({ review }) => review)) {
      await this.reviews.assertProjectsCurrent(plan.projects, caller);
      this.reviews.requireSelection(importId);
      this.closing.signal.throwIfAborted();
      caller.throwIfAborted();
      if (this.active || this.undoReservation || this.store.unfinished())
        throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
    }
    this.store.create(
      importId,
      selection.preview.source,
      botId,
      plan.distillation?.quote,
      selection.preview.skippedTooLong ?? 0,
    );
    this.reviews.clear();
    const controller = new AbortController();
    const done = runImport({
      ctx: this.ctx,
      preview: selection.preview,
      input: selection.input,
      botId,
      ...plan,
      projectService: this.project,
      cancel: controller.signal,
      closing: this.closing.signal,
      adapter: selection.input.batch ? batchAdapter : this.adapters[selection.preview.source],
      redactor: this.ctx.redactor,
      logger: this.ctx.logger,
      cleanup: this.cleanup,
      store: this.store,
      progress: (status) => this.publish(status),
    })
      .then(({ status, change }) => {
        if (status.state === "completed") {
          this.changedTopics(importId);
          for (const owner of change?.memories ?? []) this.changedMemories(owner, "added");
          if (change?.persona) this.changedPersona(change.persona);
          this.publish(status);
        }
        return status;
      })
      .finally(() => {
        this.active = undefined;
      });
    this.active = { importId, controller, done };
    // A later status/cancel call still receives the persisted result or the original failure.
    void done.catch(() => this.ctx.logger.error("import_cleanup_failed"));
    return this.status(importId);
  }

  status(importId: string) {
    const status = this.cleanup.status(importId);
    if (!status) throw new RpcError(RpcErrorCodes.invalidParams, "import_unknown");
    return status;
  }

  async cancel(importId: string) {
    const status = this.status(importId);
    if (status.state !== "running" || status.cleanup || this.active?.importId !== importId)
      return status;
    this.active.controller.abort();
    return this.active.done;
  }

  async undo(importId: string) {
    this.closing.signal.throwIfAborted();
    if (this.undoReservation || this.reviews.busy())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
    let release = () => {};
    this.undoReservation = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const job = this.store.jobState(importId);
      if (!job) throw new RpcError(RpcErrorCodes.invalidParams, "import_unknown");
      if (job.state === "undone") return this.status(importId);
      if (job.cleanup_phase) {
        if (job.cleanup_phase === "undoing") {
          await this.project.confirmUndo(importId, this.closing.signal);
        }
        void this.cleanup.wake(importId);
        return this.status(importId);
      }
      if (this.active) throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
      if (job.state !== "completed")
        throw new RpcError(RpcErrorCodes.invalidParams, "import_not_completed");
      // Hand-edited project files no longer block undo: cleanup keeps and counts them.
      this.project.assertUndoable(importId);
      await this.project.confirmUndo(importId, this.closing.signal);
      this.closing.signal.throwIfAborted();
      // No yield between these checks and the transaction; start and other undos hold the same reservation.
      try {
        const current = this.store.jobState(importId);
        if (
          this.active ||
          this.store.unfinished() ||
          current?.state !== "completed" ||
          current.cleanup_phase
        )
          throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
        const topics = new TopicsRepo(this.ctx.db);
        if (
          topics.busyInImport(importId) ||
          this.ctx.chat.hasBusyTopic((topicId) => this.store.ownsTopic(importId, topicId))
        )
          throw new RpcError(RpcErrorCodes.invalidParams, "import_topic_busy");
        const { status: pending, change, persona } = this.store.beginUndo(importId);
        this.changedTopics(importId);
        for (const owner of change) this.changedMemories(owner, "removed");
        if (persona) this.changedPersona(persona);
        this.publish(pending);
        void this.cleanup.wake(importId);
        return pending;
      } catch (error) {
        this.project.clearUndo(importId);
        throw error;
      }
    } finally {
      this.undoReservation = undefined;
      release();
    }
  }

  async stop() {
    this.closing.abort();
    this.reviews.clear();
    // A picker rejection after shutdown is expected; the RPC caller owns that error.
    await this.previewing?.catch(() => undefined);
    await this.reviews.wait();
    await Promise.all([this.active?.done, this.undoReservation, this.cleanup.wait()]);
  }

  private changedMemories(
    { scope, botId }: { scope: ImportMemoryScope; botId: string },
    reason: "added" | "removed",
  ) {
    try {
      this.ctx.peer.emit("memory.changed", {
        botId,
        scope,
        ownerId: scope === "user" ? "user" : botId,
        reason,
      });
    } catch {
      // Memory was already committed; readers can refresh from storage after reconnecting.
      this.ctx.logger.warn("import_memory_event_not_delivered");
    }
  }
  private changedPersona(botId: string) {
    try {
      this.ctx.peer.emit("bots.changed", { botId, reason: "updated" });
    } catch {
      // The stored persona is authoritative after a disconnect.
      this.ctx.logger.warn("import_persona_event_not_delivered");
    }
  }
  private changedTopics(importId: string, resetBots?: string[]) {
    const target = this.store.target(importId);
    const bots = new Set(resetBots ?? this.store.topicBots(importId));
    if (typeof target === "string") bots.add(target);
    try {
      for (const botId of bots) {
        const conversationKey = `dm:${botId}`;
        if (!resetBots) this.ctx.peer.emit("sidebar.topicsChanged", { conversationKey });
        this.ctx.peer.emit("sidebar.changed", {
          conversationKey,
          ...(resetBots ? { resetHistory: true } : {}),
        });
      }
    } catch {
      // The committed state is authoritative even if the peer disconnected.
      this.ctx.logger.warn("import_topics_not_delivered");
    }
  }

  private publish(status: ImportStatus) {
    try {
      this.ctx.peer.emit("import.progress", status);
    } catch {
      // The caller can recover authoritative status after a disconnect or delivery failure.
      this.ctx.logger.warn("import_progress_not_delivered");
    }
    return status;
  }
}
