// A reviewed diff grants one conditional write to a project folder's AGENTS.md.
import { createHash, randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { type CapabilityContext, writeReviewedProjectNotes } from "@pibot/brain/kit";
import { createFileTools, directoryIdentity, sensitiveReadBoundary } from "@pibot/execution";
import type { ImportFolderTarget, ImportPreview } from "@pibot/import-contract";
import { nodeFileSystem, type ProjectNotesFingerprint, protectedPaths } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import type { ImportProjects, ProjectReceipt, StoredReceipt } from "../store/projects.ts";
import type { ImportInput } from "./adapter.ts";
import { exportItems } from "./exports/index.ts";
import { displayPath, type ResolvedFolder, removeFolder, resolveFolder } from "./folders.ts";
import { readProjectNote } from "./local/text.ts";
import { redactImportText } from "./records.ts";

const file = "AGENTS.md";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unavailable = () => new RpcError(-32602, "import_project_unavailable");
const reviewChanged = () => new RpcError(-32602, "import_project_review_changed");
type Identity = Pick<ProjectReceipt, "root" | "device" | "inode">;

/** What the brain knows about a source project besides its preview counts. */
export type ProjectInfo = { key: string; name: string; newName: string; source?: string };

export type ProjectReview = {
  reviewId: string;
  key: string;
  target: ImportFolderTarget;
  folder: ResolvedFolder;
  /** The folder's identity when it already existed at review time. */
  identity?: Identity;
  /** null: AGENTS.md does not exist yet and the write creates it. */
  before: string | null;
  content: string;
  diff: string;
  fingerprint: ProjectNotesFingerprint;
  lines: number;
  assertSource(signal: AbortSignal): Promise<void>;
};

export type ProjectReviewOutcome = ProjectReview | { unchanged: true; folder: ResolvedFolder };

function noteAlreadyPresent(before: string, text: string) {
  const normalizedBefore = before.replace(/\r\n/gu, "\n");
  const normalizedText = text.replace(/\r\n/gu, "\n").trim();
  if (!normalizedText) return true;
  if (normalizedBefore.includes(normalizedText)) return true;
  const quoted = normalizedText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return normalizedBefore.includes(quoted);
}

export function sameTarget(left: ImportFolderTarget, right: ImportFolderTarget) {
  return (
    left.kind === right.kind &&
    (left.kind !== "folder" || (right.kind === "folder" && left.folderId === right.folderId))
  );
}

export class ProjectImport {
  private readonly files = createFileTools();
  /** Undo-confirmed restore fingerprints keyed by importId → receipt position. */
  private readonly undoReviews = new Map<string, Map<number, ProjectNotesFingerprint>>();
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly store: ImportProjects,
  ) {}

  async review(
    preview: ImportPreview,
    input: ImportInput,
    project: ProjectInfo,
    target: ImportFolderTarget,
    signal: AbortSignal,
  ): Promise<ProjectReviewOutcome> {
    const notes = await this.notes(preview, input, project.key, signal);
    const folder = await resolveFolder(this.ctx, target, project, signal);
    let identity: Identity | undefined;
    let before: string | null = null;
    if (folder.exists) {
      const { canonicalPath: root, device, inode } = await directoryIdentity(folder.path);
      identity = { root, device, inode };
      before = await this.read(identity, signal);
      if (before !== null && redactImportText(this.ctx.redactor, before) !== before)
        throw unavailable();
    }
    const targetPath = join(identity?.root ?? folder.path, file);
    const sameFile = (left: string, right: string) =>
      this.ctx.local.deps.platform === "win32"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
    const remaining = notes
      .filter((note) => {
        if (note.sourcePath && sameFile(note.sourcePath, targetPath)) return false;
        if (before !== null && noteAlreadyPresent(before, note.text)) return false;
        return true;
      })
      .map((note) => note.text);
    if (!remaining.length) return { unchanged: true, folder };
    const eol = before?.includes("\r\n") ? "\r\n" : "\n";
    const section = [
      "## Imported project notes / 导入的项目笔记",
      "",
      ...remaining
        .join("\n\n")
        .split(/\r?\n/u)
        .map((line) => `> ${line}`),
      "",
    ];
    // A new file opens with the project's name so it reads as that project's notes.
    const added =
      before === null
        ? [`# ${project.name.replace(/[\r\n]+/gu, " ") || project.newName}`, "", ...section]
        : ["", ...section];
    const content = (before === null ? "" : before + eol) + added.join(eol);
    if (Buffer.byteLength(content) > 128 * 1024 || content.split("\n").length > 2000)
      throw unavailable();
    const diff = ["--- AGENTS.md", "+++ AGENTS.md", ...added.map((line) => `+${line}`)].join("\n");
    return {
      reviewId: randomUUID(),
      key: project.key,
      target,
      folder,
      ...(identity ? { identity } : {}),
      before,
      content,
      diff,
      fingerprint: {
        target: join(folder.path, file),
        diffHash: hash(diff),
        contentHash: hash(content),
        beforeHash: before === null ? null : hash(before),
      },
      lines: added.length,
      async assertSource(current: AbortSignal) {
        if (input.batch?.assertSource) {
          await input.batch.assertSource(current);
        } else if (input.file) {
          // The native source iterator rechecks permission and identity at both ends, even without reading its body.
          for await (const _file of input.file(current)) current.throwIfAborted();
        } else if (input.projectNote) {
          await readProjectNote(input, current);
        }
      },
    };
  }

  /** How the review names the folder and file; shown paths still pass through the redactor. */
  display(review: { folder: ResolvedFolder }) {
    const shown = (path: string) =>
      redactImportText(this.ctx.redactor, displayPath(this.ctx.local.deps, path)).slice(0, 4096);
    const api = this.ctx.local.deps.platform === "win32" ? win32 : posix;
    return {
      folder: shown(review.folder.path),
      path: shown(api.join(review.folder.path, file)),
    };
  }

  private async notes(
    preview: ImportPreview,
    input: ImportInput,
    key: string,
    signal: AbortSignal,
  ) {
    const notes: Array<{ text: string; sourcePath?: string }> = [];
    let size = 0;
    const items = input.batch?.supplements
      ? input.batch.supplements(signal)
      : input.projectNote
        ? [
            {
              kind: "projects" as const,
              text: await readProjectNote(input, signal),
              key,
              ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
            },
          ]
        : preview.source === "claude"
          ? exportItems("claude", input, signal)
          : [];
    for await (const item of items) {
      if (item.kind !== "projects") continue;
      if (("key" in item ? item.key : item.project?.key) !== key) continue;
      const text = redactImportText(this.ctx.redactor, item.text).replaceAll("\0", "").trim();
      size += Buffer.byteLength(text);
      if (size > 8000 || notes.length >= 100) throw unavailable();
      if (text) {
        const sourcePath = "sourcePath" in item ? item.sourcePath : undefined;
        notes.push({ text, ...(sourcePath ? { sourcePath } : {}) });
      }
    }
    if (!notes.length) throw unavailable();
    return notes;
  }

  async assertReview(review: ProjectReview, folder: ResolvedFolder, signal: AbortSignal) {
    if (folder.path !== review.folder.path || folder.exists !== review.folder.exists)
      throw reviewChanged();
    if (folder.exists) await this.currentReview(review, folder.path, signal);
  }

  private async currentReview(review: ProjectReview, root: string, signal: AbortSignal) {
    const current = await directoryIdentity(root);
    const identity = { root: current.canonicalPath, device: current.device, inode: current.inode };
    if (
      join(identity.root, file) !== review.fingerprint.target ||
      (review.identity &&
        (review.identity.device !== identity.device || review.identity.inode !== identity.inode)) ||
      (await this.read(identity, signal)) !== review.before
    )
      throw reviewChanged();
    return identity;
  }

  /** `root` is the folder as it exists now; a folder created by this batch has a new identity. */
  async apply(
    importId: string,
    botId: string,
    position: number,
    review: ProjectReview,
    root: string,
    signal: AbortSignal,
  ) {
    const { content, diff, before } = review;
    if (redactImportText(this.ctx.redactor, content) !== content) throw unavailable();
    const identity = await this.currentReview(review, root, signal);
    signal.throwIfAborted();
    const receipt = {
      ...identity,
      before: before ?? "",
      created: before === null,
      hash: hash(content),
    };
    this.store.remember(importId, botId, position, receipt);
    try {
      await writeReviewedProjectNotes(
        this.ctx.local,
        {
          botId,
          ...identity,
          content,
          expectedHash: review.fingerprint.beforeHash,
          diff,
          review: review.fingerprint,
          assertSource: review.assertSource,
          assertCurrent: () => this.store.assertCurrent(importId, position, receipt, "apply"),
        },
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      // A conditional write conflict never published this receipt's content. Any file there is the user's.
      if (error instanceof RpcError && error.message === "project_notes_review_changed") {
        this.store.settle(importId, position, "kept");
        throw reviewChanged();
      }
      throw error;
    }
  }

  assertUndoable(importId: string) {
    if (this.store.hasDependents(importId)) throw unavailable();
  }

  private restoreDiff(currentText: string, before: string) {
    return [
      "--- AGENTS.md",
      "+++ AGENTS.md",
      ...currentText.split(/\r?\n/u).map((line) => `-${line}`),
      ...before.split(/\r?\n/u).map((line) => `+${line}`),
    ].join("\n");
  }

  /**
   * Binds the user's explicit undo confirmation to the exact restore fingerprints of this batch's
   * pending AGENTS.md writes so policy's `project_notes_reviewed` path allows only those restores.
   */
  async confirmUndo(importId: string, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(30_000)]);
    const reviews = new Map<number, ProjectNotesFingerprint>();
    for (const receipt of this.store.pending(importId)) {
      if (receipt.created) continue;
      let currentText: string | null;
      try {
        currentText = await this.read(receipt, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof RpcError || (error as { code?: unknown })?.code) continue;
        throw error;
      }
      if (currentText === null || hash(currentText) !== receipt.hash) continue;
      const diff = this.restoreDiff(currentText, receipt.before);
      reviews.set(receipt.position, {
        target: join(receipt.root, file),
        diffHash: hash(diff),
        contentHash: hash(receipt.before),
        beforeHash: receipt.hash,
      });
    }
    if (reviews.size) this.undoReviews.set(importId, reviews);
    else this.undoReviews.delete(importId);
  }

  clearUndo(importId: string) {
    this.undoReviews.delete(importId);
  }

  /**
   * Puts every project file back, then removes the folders the batch created while they are
   * still empty. A hand-edited file or a folder with new content is kept and counted.
   */
  async restore(importId: string, batchBot: string, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(90_000)]);
    try {
      this.assertUndoable(importId);
      for (const receipt of this.store.pending(importId)) {
        await this.restoreFile(importId, receipt.botId ?? batchBot, receipt, signal);
      }
      for (const folder of this.store.folders(importId)) {
        const state = this.store.continuedUsesFolder(importId, folder.path)
          ? "kept"
          : await removeFolder(this.ctx.local.deps, folder, signal);
        this.store.settleFolder(importId, folder.path, state);
      }
    } finally {
      this.undoReviews.delete(importId);
    }
  }

  private async restoreFile(
    importId: string,
    botId: string,
    receipt: StoredReceipt,
    signal: AbortSignal,
  ) {
    const { position } = receipt;
    let currentText: string | null;
    try {
      currentText = await this.read(receipt, signal);
    } catch (error) {
      signal.throwIfAborted();
      // The folder was moved, replaced or made unreadable: what is there now is the user's.
      if (error instanceof RpcError || (error as { code?: unknown })?.code) {
        this.store.settle(importId, position, "kept");
        return;
      }
      throw error;
    }
    const current = currentText === null ? null : hash(currentText);
    if (receipt.created ? current === null : current === hash(receipt.before)) {
      this.store.assertCurrent(importId, position, receipt, "restore");
      this.store.settle(importId, position, "restored");
      return;
    }
    if (current !== receipt.hash) {
      this.store.settle(importId, position, "kept");
      return;
    }
    this.store.assertCurrent(importId, position, receipt, "restore");
    if (receipt.created) {
      // The file is exactly what the batch wrote, inside a checked folder: removing it is the
      // compensation of a create, not a new change the user has to approve.
      await this.context(receipt, signal);
      await unlink(join(receipt.root, file));
      this.store.settle(importId, position, "restored", true);
      return;
    }
    const reviews = this.undoReviews.get(importId);
    const review = reviews?.get(position);
    reviews?.delete(position);
    // A blocked or refused compensation keeps the durable receipt and cleanup phase for retry.
    try {
      await writeReviewedProjectNotes(
        this.ctx.local,
        {
          botId,
          root: receipt.root,
          device: receipt.device,
          inode: receipt.inode,
          content: receipt.before,
          expectedHash: receipt.hash,
          ...(review ? { review } : {}),
          assertCurrent: () => this.store.assertCurrent(importId, position, receipt, "restore"),
          diff: this.restoreDiff(currentText ?? "", receipt.before),
        },
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      // A conditional write conflict means the user edited the file meanwhile: keep their version.
      if (error instanceof RpcError && error.message === "project_notes_review_changed") {
        this.store.settle(importId, position, "kept");
        return;
      }
      throw error;
    }
    this.store.settle(importId, position, "restored", true);
  }

  /** The current AGENTS.md text, or null when the folder has none. */
  private async read(identity: Identity, signal: AbortSignal) {
    const context = await this.context(identity, signal);
    const missing = await lstat(context.path).then(
      () => false,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return true;
        throw error;
      },
    );
    if (missing) return null;
    const value = await this.files.readFile(context);
    if (value.type !== "text" || value.truncated || value.size > 128 * 1024) throw unavailable();
    return value.text;
  }

  private async context({ root, device, inode }: Identity, signal: AbortSignal) {
    const { platform, userHome, env, dataDir } = this.ctx.local.deps;
    const path = join(root, file);
    const assertPolicy = async () => {
      signal.throwIfAborted();
      const sensitive = await sensitiveReadBoundary(platform, [userHome], env);
      const policy = await protectedPaths(
        {
          platform,
          home: userHome,
          cwd: root,
          roots: [root],
          fs: nodeFileSystem,
          signal,
        },
        [...sensitive.denyRead, dataDir],
      );
      if (policy.covers(root) || policy.covers(path)) throw unavailable();
    };
    await assertPolicy();
    return {
      path,
      signal,
      expectedPath: path,
      cwd: root,
      writeRoots: [root],
      rootIdentities: [{ canonicalPath: root, device, inode }],
      confirmDispatch: assertPolicy,
    };
  }
}
