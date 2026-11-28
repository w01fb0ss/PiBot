import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { RpcError } from "@pibot/protocol-base";
import { MessagesRepo, RunsRepo, SettingsRepo, transaction } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import { resolvePersonaLanguage } from "../../core/personas/language.ts";
import type { LocalService } from "../../local-service.ts";
import { workspaceBoundary } from "../../resources/workplaces/workspace-boundary.ts";

/**
 * Reuses one hidden internal conversation per Bot for synthetic project-notes receipts so writes
 * keep run/tool/audit records without creating an empty visible "新话题" or polluting chat history.
 */
function internalProjectNotesTopic(db: DatabaseSync, botId: string): string {
  const key = `project-notes:${botId}`;
  return transaction(db, () => {
    const existing = db
      .prepare("SELECT id FROM conversations WHERE internal_task_id=? AND bot_id=? LIMIT 1")
      .get(key, botId);
    if (typeof existing?.id === "string") return existing.id;
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO conversations(id,kind,bot_id,pi_session_file,created_at,updated_at,internal_task_id) VALUES (?,'dm',?,NULL,?,?,?)",
    ).run(id, botId, now, now, key);
    return id;
  });
}

/** Capability-only entry for a single synthetic policy-checked project write. */
export async function writeReviewedProjectNotes(
  local: LocalService,
  input: {
    botId: string;
    root: string;
    device: string;
    inode: string;
    content: string;
    /** `null` creates AGENTS.md and refuses if it appeared since the review. */
    expectedHash: string | null;
    diff: string;
    review?: NonNullable<ToolRunContext["projectNotesChange"]>["review"];
    assertSource?(signal: AbortSignal): Promise<void>;
    assertCurrent?(): void;
  },
  caller: AbortSignal,
) {
  const signal = AbortSignal.any([caller, local.shutdown.signal, AbortSignal.timeout(90_000)]);
  signal.throwIfAborted();
  const { botId, root, device, inode, content, expectedHash, diff } = input;
  if (local.deps.redactor.redact(content) !== content)
    throw new RpcError(-32602, "project_notes_invalid");
  const folderId = randomUUID();
  const boundary = await workspaceBoundary(
    [{ id: folderId, path: root, role: "primary" }],
    0,
    local.deps.platform,
    signal,
  );
  const identity = boundary.roots[0];
  if (identity?.canonicalPath !== root || identity.device !== device || identity.inode !== inode)
    throw new RpcError(-32602, "workspace_boundary_changed");
  const home = local.workplaces.repo.home(botId);
  const topicId = internalProjectNotesTopic(local.deps.db, botId);
  const messages = new MessagesRepo(local.deps.db);
  const runs = new RunsRepo(local.deps.db);
  const runId = randomUUID();
  const message = transaction(local.deps.db, () => {
    const reply = messages.create({
      conversationId: topicId,
      botId,
      role: "assistant",
      content: "",
      status: "streaming",
      runId,
    });
    runs.create({
      id: runId,
      botId,
      conversationId: topicId,
      groupId: null,
      kind: "chat",
      messageId: reply.id,
      userMessageId: null,
      taskId: null,
      cycleId: null,
      automatic: false,
      parentRunId: null,
      afterRunId: null,
      ancestry: [],
      triggerKey: null,
    });
    runs.start(runId);
    return reply;
  });
  const callId = randomUUID();
  const context = {
    botId,
    runId,
    messageId: message.id,
    conversationId: topicId,
    runWorkplace: { cwd: root, boundary },
    signal,
    language: resolvePersonaLanguage(
      new SettingsRepo(local.deps.db).get().language,
      Intl.DateTimeFormat().resolvedOptions().locale,
    ),
    projectNotesChange: Object.freeze({
      callId,
      diff,
      expectedHash,
      review: input.review,
      assertSource: input.assertSource,
      assertCurrent: input.assertCurrent,
      workplace: {
        value: {
          home,
          currentId: folderId,
          folders: [{ id: folderId, path: root, name: basename(root), role: "primary" as const }],
        },
        cwd: root,
        roots: [root],
        home,
        boundary,
      },
    }),
  };
  let run: ReturnType<LocalService["run"]> | undefined;
  let applied = false;
  try {
    run = local.run(context);
    const outcome = await run.runSynthetic(
      {
        id: callId,
        tool: "write_file",
        input: { path: join(root, "AGENTS.md"), content },
      },
      signal,
    );
    if (input.review && outcome.allowed && outcome.result.details?.errorCode === "file_conflict")
      throw new RpcError(-32602, "project_notes_review_changed");
    if (!outcome.allowed || outcome.result.isError)
      throw new RpcError(-32602, "project_notes_not_applied");
    applied = true;
  } finally {
    try {
      run?.finish();
      await local.runCleanup.drain(runId);
    } finally {
      local.releaseContext(runId);
      if (applied) messages.update(message.id, { status: "done" });
      runs.finish(
        runId,
        applied ? "done" : signal.aborted ? "aborted" : "error",
        applied ? "stop" : signal.aborted ? "aborted" : "error",
        applied ? null : signal.aborted ? "aborted" : "permission_denied",
      );
    }
  }
}
