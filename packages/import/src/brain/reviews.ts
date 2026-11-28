// Own the short-lived user approvals bound to one source and import identity.
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { CapabilityContext } from "@pibot/brain/kit";
import type { ImportMemoryReview, ImportPlan, ImportPreview } from "@pibot/import-contract";
import type { ImportParams } from "@pibot/import-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { ImportStore } from "../store/index.ts";
import type { ImportInput } from "./adapter.ts";
import { type DistillationPlan, type DistillationScope, quoteImport } from "./distillation.ts";
import {
  assertFolderAllowed,
  displayPath,
  documentsFolder,
  folderName,
  resolveFolder,
  sameName,
} from "./folders.ts";
import {
  type ReviewedImport,
  type ReviewedPlan,
  reviewMemories,
  reviewPlan,
} from "./memory-review.ts";
import type { ProjectImport, ProjectInfo, ProjectReview, ProjectReviewOutcome } from "./project.ts";
import type { DistillationSource } from "./records.ts";
import { failureReason, type ProjectPlan } from "./run.ts";

const PREVIEW_MS = 90_000;
const PREVIEW_VALID_MS = 10 * 60_000;

export type ImportSelection = Selection;
type Selection = {
  preview: ImportPreview;
  input: ImportInput;
  expiresAt: number;
  distillationSources: readonly DistillationSource[];
  projects: Map<string, ProjectInfo>;
  plan?: ReviewedPlan;
  persona?: ReviewedImport;
  /** The last reviewed AGENTS.md change per project key. */
  reviewed: Map<string, ProjectReview>;
  quote?: DistillationPlan & { botId: string; scope: DistillationScope };
};

/** Each project gets a distinct folder name; unnamed ChatGPT projects are numbered. */
function projectInfos(preview: ImportPreview, paths: ReadonlyMap<string, string>) {
  const used = new Set<string>();
  const infos = new Map<string, ProjectInfo>();
  let unnamed = 0;
  for (const project of preview.projects ?? []) {
    const fallback =
      preview.source === "chatgpt" ? `ChatGPT project ${++unnamed}` : "Imported project";
    const base = folderName(project.name, fallback);
    let newName = base;
    for (let n = 2; used.has(newName.toLowerCase()); n++) newName = `${base} ${n}`;
    used.add(newName.toLowerCase());
    const source = paths.get(project.key);
    infos.set(project.key, {
      key: project.key,
      name: project.name,
      newName,
      ...(source ? { source } : {}),
    });
  }
  return infos;
}

export class ImportReviews {
  private selection?: Selection;
  private reviewing?: Promise<unknown>;

  constructor(
    private readonly ctx: CapabilityContext,
    private readonly store: ImportStore,
    private readonly project: ProjectImport,
    private readonly signal: AbortSignal,
    private readonly previewing: () => boolean,
  ) {}

  busy() {
    return !!this.reviewing;
  }

  set(
    preview: ImportPreview,
    input: ImportInput,
    paths: ReadonlyMap<string, string>,
    distillationSources: readonly DistillationSource[] = [],
  ) {
    this.selection = {
      preview,
      input,
      distillationSources,
      expiresAt: Date.now() + PREVIEW_VALID_MS,
      projects: projectInfos(preview, paths),
      reviewed: new Map(),
    };
  }

  clear() {
    this.selection = undefined;
  }

  async wait() {
    // The RPC owns and reports an aborted review.
    await this.reviewing?.catch(() => undefined);
  }

  requireSelection(importId: string) {
    const selection = this.selection;
    if (!selection || selection.preview.importId !== importId || Date.now() > selection.expiresAt)
      throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_expired");
    return selection;
  }

  /** Runs one review at a time, bounded by the preview deadline and shutdown. */
  private async exclusive<T>(caller: AbortSignal, work: (signal: AbortSignal) => Promise<T>) {
    this.signal.throwIfAborted();
    if (this.reviewing || this.previewing())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_busy");
    const deadline = AbortSignal.timeout(PREVIEW_MS);
    const signal = AbortSignal.any([caller, this.signal, deadline]);
    const running = work(signal);
    this.reviewing = running;
    try {
      const result = await running;
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (deadline.aborted)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_timeout");
      signal.throwIfAborted();
      if (error instanceof RpcError) throw error;
      const reason = failureReason(error);
      if (reason === "internal") throw error;
      throw new RpcError(RpcErrorCodes.invalidParams, `import_${reason}`);
    } finally {
      this.reviewing = undefined;
    }
  }

  /** The role comparison (scope "persona"); memories now go through `plan`. */
  async review(
    { importId, botId, scope }: ImportParams<"import.reviewMemories">,
    caller: AbortSignal,
  ): Promise<ImportMemoryReview> {
    if (!this.store.availableBot(botId))
      throw new RpcError(RpcErrorCodes.invalidParams, "import_target");
    const selection = this.requireSelection(importId);
    if (scope === "persona") selection.persona = undefined;
    const review = await this.exclusive(caller, (signal) =>
      reviewMemories({
        ...selection,
        botId,
        scope,
        signal,
        memories: this.store.memories,
        personas: this.store.personas,
        redactor: this.ctx.redactor,
      }),
    );
    if (scope === "persona") this.requireSelection(importId).persona = review;
    return review.dto;
  }

  async plan(importId: string, caller: AbortSignal): Promise<ImportPlan> {
    const selection = this.requireSelection(importId);
    selection.plan = undefined;
    const bots = this.store.chatBots();
    const { review, dto } = await this.exclusive(caller, (signal) =>
      reviewPlan({
        ...selection,
        bots,
        signal,
        memories: this.store.memories,
        redactor: this.ctx.redactor,
      }),
    );
    const targets = await this.targets(selection, caller);
    this.requireSelection(importId).plan = review;
    return { ...dto, ...targets };
  }

  /** Work folders to offer and, per project, its ~/Documents folder, source folder and match. */
  private async targets(selection: Selection, signal: AbortSignal) {
    const deps = this.ctx.local.deps;
    const api = deps.platform === "win32" ? win32 : posix;
    const directory = (path: string) =>
      stat(path).then(
        (info) => info.isDirectory(),
        () => false,
      );
    // A record whose folder was moved or deleted would only fail later; offer what exists now.
    const registered = this.store.workFolders().filter(({ path }) => api.isAbsolute(path));
    const present = await Promise.all(registered.map(({ path }) => directory(path)));
    signal.throwIfAborted();
    const folders = registered.filter((_, index) => present[index]);
    const projects: ImportPlan["projects"] = [];
    for (const info of selection.projects.values()) {
      signal.throwIfAborted();
      const newPath = api.join(documentsFolder(deps), info.newName);
      const match = folders.find(
        (folder) =>
          sameName(api.basename(folder.path), info.newName) ||
          sameName(api.basename(folder.path), info.name),
      );
      // A working directory that is gone, or inside a protected tree (a tool's own worktree under
      // ~/.codex, ~/.claude), cannot hold the project; the UI then defaults to the Bot's folder.
      const source =
        info.source &&
        (await directory(info.source)) &&
        (await assertFolderAllowed(deps, info.source, signal).then(
          () => true,
          () => false,
        ))
          ? info.source
          : undefined;
      projects.push({
        key: info.key,
        newDisplay: displayPath(deps, newPath),
        newExists: await directory(newPath),
        ...(source ? { source: displayPath(deps, source) } : {}),
        ...(info.source && !source ? { sourceMissing: true as const } : {}),
        ...(match ? { match: match.id } : {}),
      });
    }
    return {
      folders: folders.map(({ id, botId, name, path }) => ({
        id,
        botId,
        name,
        display: displayPath(deps, path),
      })),
      projects,
    };
  }

  async reviewProject(
    { importId, key, folder }: ImportParams<"import.reviewProject">,
    caller: AbortSignal,
  ) {
    const selection = this.requireSelection(importId);
    const info = selection.projects.get(key);
    if (!info) throw new RpcError(-32602, "import_project_unavailable");
    selection.reviewed.delete(key);
    let outcome: ProjectReviewOutcome;
    try {
      outcome = await this.exclusive(caller, (signal) =>
        this.project.review(selection.preview, selection.input, info, folder, signal),
      );
    } catch (error) {
      caller.throwIfAborted();
      this.signal.throwIfAborted();
      if (error instanceof RpcError) throw error;
      throw new RpcError(-32602, "import_project_unavailable");
    }
    this.requireSelection(importId);
    if ("unchanged" in outcome) {
      return {
        reviewId: randomUUID(),
        file: "AGENTS.md" as const,
        ...this.project.display(outcome),
        diff: "",
        lines: 0,
      };
    }
    this.requireSelection(importId).reviewed.set(key, outcome);
    return {
      reviewId: outcome.reviewId,
      file: "AGENTS.md" as const,
      ...this.project.display(outcome),
      diff: outcome.diff,
      lines: outcome.lines,
      ...(!outcome.folder.exists
        ? { create: "folder" as const }
        : outcome.before === null
          ? { create: "file" as const }
          : {}),
    };
  }

  async assertProjectsCurrent(projects: ProjectPlan[], caller: AbortSignal) {
    await this.exclusive(caller, async (signal) => {
      for (const { info, target, review } of projects) {
        if (!review) continue;
        const folder = await resolveFolder(this.ctx, target, info, signal);
        await this.project.assertReview(review, folder, signal);
      }
    });
  }

  estimateDistillation(
    {
      importId,
      botId,
      conversations = true,
      projectKeys = [],
    }: ImportParams<"import.estimateDistillation">,
    caller: AbortSignal,
  ) {
    const selection = this.requireSelection(importId);
    return this.exclusive(caller, async (signal) => {
      selection.quote = undefined;
      const port = this.ctx.local.memoryImportDistillation;
      if (!port || !selection.preview.messages) return null;
      const keys = [...new Set(projectKeys)];
      if (keys.some((key) => !selection.projects.has(key)))
        throw new RpcError(RpcErrorCodes.invalidParams, "import_memory_selection_invalid");
      const projects = selection.preview.projects ?? [];
      const scope = {
        projectKeys: keys.filter((key) =>
          projects.some((project) => project.key === key && project.topics > 0),
        ),
        conversations:
          conversations &&
          selection.preview.topics > projects.reduce((sum, project) => sum + project.topics, 0),
      };
      if (!scope.conversations && !scope.projectKeys.length) return null;
      const model = await port.estimate(botId, signal);
      if (!model) return null;
      const quote = quoteImport(model, selection.distillationSources, scope);
      signal.throwIfAborted();
      if (!quote) return null;
      selection.quote = { botId, scope, port, model, quote };
      return quote;
    });
  }
}
