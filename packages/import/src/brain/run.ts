// Keep cancellation, publication, and failure cleanup within the same job lifetime.
import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { attachmentDirectory, type CapabilityContext } from "@pibot/brain/kit";
import type {
  ImportCounts,
  ImportFolderTarget,
  ImportPreview,
  ImportStatus,
} from "@pibot/import-contract";
import { FILE_LIMIT, RpcError } from "@pibot/protocol-base";
import { storedAttachmentPath, transaction } from "@pibot/storage";
import type { ImportStore } from "../store/index.ts";
import type { ImportMemoryScope, ReviewedMemory } from "../store/memories.ts";
import type { PersonaSelection } from "../store/personas.ts";
import { type ImportAdapter, ImportFailure, type ImportInput } from "./adapter.ts";
import type { ImportCleanup } from "./cleanup.ts";
import { type DistillationPlan, distilImport } from "./distillation.ts";
import { createFolder, registerFolder, resolveFolder } from "./folders.ts";
import type { ProjectImport, ProjectInfo, ProjectReview } from "./project.ts";
import { type SavedText, type TopicTarget, writeRecords } from "./records.ts";

/** Fail if no forward progress happens for this long. */
const STALL_MS = 60_000;
/** Generous ceiling scaled by preview size so active large exports finish without a fixed cap. */
const MIN_CEILING_MS = 10 * 60_000;
const MAX_CEILING_MS = 4 * 60 * 60_000;
const CEILING_MS_PER_TOPIC = 200;
const CEILING_MS_PER_MESSAGE = 50;
const PROGRESS_MS = 200;

function ceilingMs(preview: Pick<ImportPreview, "topics" | "messages">) {
  return Math.min(
    MAX_CEILING_MS,
    MIN_CEILING_MS +
      preview.topics * CEILING_MS_PER_TOPIC +
      preview.messages * CEILING_MS_PER_MESSAGE,
  );
}

function createWatchdog(stallMs: number, totalMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(new ImportFailure("timeout"));
  let lastBeat = performance.now();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const checkStall = () => {
    if (controller.signal.aborted) return;
    const remaining = stallMs - (performance.now() - lastBeat);
    if (remaining > 50) {
      stallTimer = setTimeout(checkStall, remaining);
      stallTimer.unref?.();
      return;
    }
    abort();
  };
  stallTimer = setTimeout(checkStall, stallMs);
  stallTimer.unref?.();
  const ceilingTimer = setTimeout(abort, totalMs);
  ceilingTimer.unref?.();
  return {
    signal: controller.signal,
    beat() {
      lastBeat = performance.now();
    },
    stop() {
      if (stallTimer) clearTimeout(stallTimer);
      clearTimeout(ceilingTimer);
    },
  };
}

export function failureReason(error: unknown): NonNullable<ImportStatus["reason"]> {
  if (error instanceof ImportFailure) return error.reason;
  if (error instanceof RpcError && error.message === "import_project_review_changed")
    return "project_review_changed";
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ELOOP" ||
      error.code === "EACCES" ||
      error.code === "EPERM")
  )
    return "source_changed";
  return "internal";
}

/** One included source project: where its folder comes from, its Bot, and an approved diff. */
export type ProjectPlan = {
  info: ProjectInfo;
  botId: string;
  target: ImportFolderTarget;
  review?: ProjectReview;
};

type RunOptions = {
  ctx: CapabilityContext;
  adapter: ImportAdapter;
  input: ImportInput;
  preview: ImportPreview;
  /** Owner of the chats outside any project and of the batch record. */
  botId: string;
  conversations: boolean;
  projects: ProjectPlan[];
  projectService: ProjectImport;
  /** Confirmed memories by destination: "user" (关于你) or a Bot id. */
  memories: Map<string, ReviewedMemory[]>;
  persona?: { botId: string; selection: PersonaSelection };
  distillation?: DistillationPlan;
  store: ImportStore;
  cleanup: ImportCleanup;
  cancel: AbortSignal;
  closing: AbortSignal;
  redactor: CapabilityContext["redactor"];
  logger: CapabilityContext["logger"];
  progress: (status: ImportStatus) => void;
};

function throttledProgress({ preview, progress }: RunOptions) {
  let last = -Infinity;
  return (counts: ImportCounts) => {
    const now = performance.now();
    if (now - last < PROGRESS_MS) return;
    last = now;
    progress({
      importId: preview.importId,
      source: preview.source,
      ...counts,
      state: "running",
      reason: null,
    });
  };
}

/** Every Bot the batch writes for; one that was archived meanwhile fails the whole batch. */
export function batchBots(opts: Pick<RunOptions, "botId" | "projects" | "memories" | "persona">) {
  return [
    ...new Set([
      opts.botId,
      ...opts.projects.map(({ botId }) => botId),
      ...[...opts.memories.keys()].filter((target) => target !== "user"),
      ...(opts.persona ? [opts.persona.botId] : []),
    ]),
  ];
}

/**
 * Writes a long message's whole text into the Bot's attachment folder, like a file the user
 * added to a topic. Over the file limit nothing is written and the message says it was cut.
 */
async function saveFullText(
  ctx: CapabilityContext,
  botId: string,
  text: string,
  signal: AbortSignal,
): Promise<SavedText | undefined> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > FILE_LIMIT) return undefined;
  const dataDir = await realpath(ctx.local.deps.dataDir);
  const root = await attachmentDirectory(dataDir, botId);
  const id = randomUUID();
  const path = join(root, `${id}.txt`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600, signal });
  return {
    metadata: {
      id,
      kind: "file",
      name: "full-message.txt",
      mimeType: "text/plain",
      size: bytes.length,
    },
    stored: storedAttachmentPath(dataDir, path),
  };
}

/** Creates missing folders (with receipts) and registers each project's folder for its Bot. */
async function prepareFolders(opts: RunOptions, signal: AbortSignal, beat: () => void) {
  const { ctx, store, preview } = opts;
  const folders = new Map<string, TopicTarget & { path?: string }>();
  for (const plan of opts.projects) {
    signal.throwIfAborted();
    beat();
    // The Bot's own folder: topics carry no work folder and nothing is created or written.
    if (plan.target.kind === "home") {
      folders.set(plan.info.key, { botId: plan.botId });
      continue;
    }
    try {
      const resolved = await resolveFolder(ctx, plan.target, plan.info, signal);
      if (plan.review) await opts.projectService.assertReview(plan.review, resolved, signal);
      const path = resolved.exists
        ? resolved.path
        : await createFolder(
            ctx.local.deps,
            store.projects,
            preview.importId,
            resolved.path,
            signal,
          );
      const folderId = transaction(ctx.local.deps.db, () =>
        registerFolder(
          ctx,
          (botId, id) => store.rememberFolderRecord(preview.importId, botId, id),
          plan.botId,
          path,
        ),
      );
      folders.set(plan.info.key, { botId: plan.botId, folderId, path });
      beat();
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ImportFailure || failureReason(error) === "project_review_changed")
        throw error;
      throw new ImportFailure("project");
    }
  }
  return folders;
}

export async function runImport(opts: RunOptions) {
  const { preview, botId, store, cancel, closing } = opts;
  const id = preview.importId;
  const watchdog = createWatchdog(STALL_MS, ceilingMs(preview));
  const lifetime = AbortSignal.any([cancel, closing]);
  const signal = AbortSignal.any([lifetime, watchdog.signal]);
  const progress = throttledProgress(opts);
  const bots = batchBots(opts);
  const available = () => bots.every((bot) => store.availableBot(bot));
  let mandatoryComplete = false;
  try {
    await yieldToLoop(undefined, { signal });
    progress({ topics: 0, messages: 0 });
    const folders = await prepareFolders(opts, signal, watchdog.beat);
    // A selected project note (CLAUDE.md, AGENTS.md, a rule) has no chats to read.
    if (preview.topics > 0 && (opts.conversations || folders.size))
      await writeRecords({
        ...opts,
        bots,
        signal,
        heartbeat: watchdog.beat,
        progress,
        route: (key) => (key ? folders.get(key) : opts.conversations ? { botId } : undefined),
        saveFullText: (owner, text, current) => saveFullText(opts.ctx, owner, text, current),
      });
    signal.throwIfAborted();
    if (!available()) throw new ImportFailure("target");
    for (const [position, plan] of opts.projects.entries()) {
      const folder = folders.get(plan.info.key);
      if (!plan.review || !folder?.path) continue;
      watchdog.beat();
      try {
        await opts.projectService.apply(id, plan.botId, position, plan.review, folder.path, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (failureReason(error) === "project_review_changed") throw error;
        throw new ImportFailure("project");
      }
      watchdog.beat();
    }
    signal.throwIfAborted();
    if (!available()) throw new ImportFailure("target");
    mandatoryComplete = true;
    watchdog.stop();
    const derived = opts.distillation
      ? await distilImport(
          opts.distillation,
          id,
          botId,
          lifetime,
          store,
          opts.redactor,
          opts.logger,
        )
      : undefined;
    lifetime.throwIfAborted();
    if (!available()) throw new ImportFailure("target");
    return store.complete(id, () => {
      const memories: { scope: ImportMemoryScope; botId: string }[] = [];
      const add = (owner: string, scope: ImportMemoryScope, selected: ReviewedMemory[]) => {
        if (!selected.length) return;
        const changed = store.memories.add(id, owner, { scope, selected });
        if (changed) memories.push(changed);
      };
      for (const [target, selected] of opts.memories)
        add(target === "user" ? botId : target, target === "user" ? "user" : "bot", selected);
      if (derived) {
        let distilledMemories = 0;
        try {
          if (derived.selected.length) {
            const changed = store.addDistilledMemories(id, botId, derived.selected);
            if (changed) {
              memories.push(changed);
              distilledMemories = changed.added;
            }
          }
        } catch (error) {
          const failureCode =
            error instanceof ImportFailure && error.reason === "memory_quota"
              ? "memory_quota"
              : "internal";
          derived.result.state = "failed";
          derived.result.reason = failureCode;
          opts.logger.warn(
            JSON.stringify({
              module: "import",
              importId: id,
              reasonCode: "import_distillation_write_failed",
              failureCode,
            }),
          );
        }
        derived.result.memories = distilledMemories;
        store.recordDistillation(id, derived.result);
      }
      const persona =
        opts.persona && store.personas.apply(id, opts.persona.botId, opts.persona.selection)
          ? opts.persona.botId
          : undefined;
      return { memories, persona };
    });
  } catch (error) {
    watchdog.stop();
    const state = cancel.aborted || closing.aborted ? "cancelled" : "failed";
    const reason =
      state === "cancelled"
        ? null
        : watchdog.signal.aborted && !mandatoryComplete
          ? "timeout"
          : failureReason(error);
    if (reason === "internal") opts.logger.error("import_job_failed");
    store.discard(id, state, reason);
    const discarding = store.get(id);
    if (discarding) opts.progress(discarding);
    await opts.cleanup.wake();
    const status = opts.cleanup.status(id);
    if (!status) throw new Error("import_job_missing");
    return { status, change: undefined };
  } finally {
    watchdog.stop();
  }
}
