import { lstatSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalExistingPathSync, fileIdentity, samePathSpelling } from "@pibot/execution";
import { OUTSIDE_WRITE_REASON } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import { BotsRepo, ConversationsRepo, RunsRepo, TopicFoldersRepo } from "@pibot/storage";
import { abortable } from "../../../core/abort.ts";
import type { ApprovalFolderChange } from "../../../core/approval-folder-change.ts";
import { auditText } from "../../../core/audit-fields.ts";
import type { PreparedTool, ToolRunContext } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";
import { topicWorkplaceSnapshot } from "../../../resources/workplaces/run-workplace.ts";

/** This is a user association at a parked tool gate, never an approval to dispatch that tool. */
export function approvalFolderChange(
  local: LocalService,
  context: ToolRunContext,
  prepared: PreparedTool,
  assertIdle: () => void,
  committed: () => void,
): ApprovalFolderChange | undefined {
  const topicId = context.conversationId;
  const original = context.runWorkplace;
  const topicSnapshot = context.topicWorkplace;
  if (
    !topicId ||
    !original ||
    !topicSnapshot ||
    context.groupId ||
    context.permissionGroupId ||
    context.routineRunId ||
    context.routineWorkplace ||
    context.executionTaskId ||
    context.workflowReadRoots?.length ||
    prepared.docker ||
    (original.boundary.location?.target ?? "local") !== "local" ||
    prepared.result.reason !== OUTSIDE_WRITE_REASON ||
    !prepared.result.outsideWriteRoots?.length ||
    (local.workplaces.topic(topicId).selection.writable?.length ?? 0) >= 4
  )
    return;
  const beforeTopic = JSON.stringify(context.topicWorkplace);
  const beforeRun = JSON.stringify(original);
  const assertCurrent = () => {
    context.signal.throwIfAborted();
    assertIdle();
    const bot = new BotsRepo(local.deps.db).get(context.botId);
    const topic = new ConversationsRepo(local.deps.db).get(topicId);
    const run = new RunsRepo(local.deps.db).get(context.runId);
    if (
      !bot ||
      bot.archivedAt ||
      topic?.kind !== "dm" ||
      topic.botId !== context.botId ||
      topic.archivedAt ||
      new ConversationsRepo(local.deps.db).isInternal(topicId) ||
      topic.routineId ||
      run?.status !== "running" ||
      run.botId !== context.botId ||
      run.conversationId !== topicId ||
      run.messageId !== context.messageId ||
      JSON.stringify(context.runWorkplace) !== beforeRun ||
      JSON.stringify(context.topicWorkplace) !== beforeTopic ||
      JSON.stringify(topicWorkplaceSnapshot(local, context)) !== beforeTopic
    )
      throw new RpcError(-32602, "workspace_boundary_changed");
    if (local.tasks.tasks.sourceBusy(topicId)) throw new RpcError(-32011, "topic_workplace_busy");
  };
  return async (parent, assertPending) => {
    const check = () => {
      assertPending();
      assertCurrent();
    };
    check();
    const before = local.workplaces.topic(topicId);
    let defaultPath = prepared.result.outsideWriteRoots?.[0];
    if (defaultPath && !(await abortable(stat(defaultPath), parent)).isDirectory())
      defaultPath = dirname(defaultPath);
    check();
    const { folder } = await local.workplaces.pick(
      context.botId,
      false,
      undefined,
      parent,
      defaultPath,
    );
    check();
    if (!folder) return null;
    if (
      folder.id === before.selection.primary ||
      before.selection.readonly.includes(folder.id) ||
      before.selection.writable?.includes(folder.id)
    )
      throw new RpcError(-32602, "workspace_conflict");
    const selection = {
      ...before.selection,
      writable: [...(before.selection.writable ?? []), folder.id],
    };
    const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
    const place = await local.workplaces.context(context.botId, signal, {
      selection,
      revision: (before.revision ?? 0) + 1,
    });
    check();
    if (place.boundary.conflict !== "none") throw new RpcError(-32602, "workspace_conflict");
    // Adding a root must not replace any root identity, role, default directory or readonly ceiling.
    const base = {
      ...place.boundary,
      revision: original.boundary.revision,
      roots: place.boundary.roots.filter((r) => r.id !== folder.id),
      readRoots: place.boundary.readRoots.filter((r) => r !== folder.path),
      writeRoots: place.boundary.writeRoots.filter((r) => r !== folder.path),
    };
    if (place.cwd !== original.cwd || JSON.stringify(base) !== JSON.stringify(original.boundary))
      throw new RpcError(-32602, "workspace_boundary_changed");
    return {
      commit() {
        check();
        try {
          for (const root of place.boundary.roots) {
            const info = lstatSync(root.canonicalPath, { bigint: true }),
              identity = fileIdentity(info);
            if (
              !info.isDirectory() ||
              info.isSymbolicLink() ||
              !samePathSpelling(canonicalExistingPathSync(root.path), root.canonicalPath) ||
              identity.device !== root.device ||
              identity.inode !== root.inode
            )
              throw new RpcError(-32602, "workspace_boundary_changed");
          }
        } catch {
          // A disappeared or replaced root is a stale boundary, never a system-path error in UI.
          throw new RpcError(-32602, "workspace_boundary_changed");
        }
        new TopicFoldersRepo(local.deps.db).set(context.botId, topicId, selection);
        local.approvals.audit.append({
          botId: context.botId,
          runId: context.runId,
          kind: "topic.folder.added",
          summary: "Topic writable folder added / 话题追加可写文件夹",
          detail: {
            actor: "user",
            conversationId: topicId,
            reasonCode: "topic_writable",
            path: auditText(folder.path, local.deps.redactor, 4096),
          },
        });
      },
      committed() {
        // No await or I/O here: only the next fresh tool call may consume the new ceiling.
        context.topicWorkplace = { ...topicSnapshot, revision: place.boundary.revision };
        context.runWorkplace = { cwd: place.cwd, boundary: place.boundary };
        committed();
      },
    };
  };
}
