import { randomUUID } from "node:crypto";
import { AgentError } from "@pibot/agent";
import type { WorkspaceLocal as LocalService, ToolRunContext } from "@pibot/brain/kit";
import { allowedByYolo } from "@pibot/brain/kit";
import { sensitiveReadBoundary } from "@pibot/execution";
import { containsPath, explainPolicyResult, type PolicyResult } from "@pibot/policy";
import { ToolCallsRepo } from "@pibot/storage";
import { RpcError, type WorkspaceSnapshot } from "@pibot/workspaces-contract/full";
import { auditYolo, authorizationSnapshot, runPermissions, runYolo } from "../runtime.ts";

export class UnansweredWorktreeApproval extends AgentError {
  constructor() {
    super("permission_denied");
  }
}

const approvalInterruptionCodes = new Set([
  "approval_expired",
  "approval_paused",
  "approval_cancelled",
  "aborted",
]);

function approvalInterrupted(error: unknown, signal: AbortSignal) {
  if (typeof error === "string") return approvalInterruptionCodes.has(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return (
    (typeof code === "string" && approvalInterruptionCodes.has(code)) ||
    (error instanceof Error &&
      (approvalInterruptionCodes.has(error.message) ||
        error.name === "AbortError" ||
        (error === signal.reason && error.name === "TimeoutError")))
  );
}

/** Derived management capabilities exist only for one checked lifecycle operation. */
export async function groupWorktreeAuthority(
  local: LocalService,
  context: ToolRunContext,
  boundary: WorkspaceSnapshot,
  writes: string[],
  signal: AbortSignal,
  stage: "create" | "integrate" | "discard",
  options?: { planStep: true },
) {
  const actor = { ...context, signal };
  const snapshot = authorizationSnapshot(local, actor.botId, actor);
  const settings = runPermissions(local, actor);
  if (
    local.execution.get({ botId: actor.botId, conversationId: actor.conversationId as string })
      .mode !== "execute" ||
    settings.levels.run_command === "never" ||
    settings.levels.write_file === "never"
  )
    throw new RpcError(-32602, "group_workspace_readonly");
  // Runner paths follow the runner's rules; its own sensitive folders are enforced there,
  // and this desktop's protected list does not describe another machine's disk.
  const remote = !!boundary.location && boundary.location.target !== "local";
  const platform = remote
    ? (boundary.location?.platform ?? local.deps.platform)
    : local.deps.platform;
  if (!remote) {
    const protectedPaths = await sensitiveReadBoundary(
      local.deps.platform,
      [local.deps.userHome],
      local.deps.env,
      { dataDir: local.deps.dataDir, botHome: local.workplaces.repo.home(actor.botId) },
    );
    if (writes.some((path) => !protectedPaths.permitsWriteRoot(path)))
      throw new RpcError(-32602, "group_workspace_readonly");
  }
  const policy = await local.getPolicy(signal);
  const temporary: WorkspaceSnapshot = {
    ...boundary,
    readRoots: [...new Set([...boundary.readRoots, ...writes])],
    writeRoots: writes,
    denyWriteRoots: boundary.denyWriteRoots.filter(
      (root) => !writes.some((path) => containsPath(root, path, platform)),
    ),
  };
  const assertAuthorized = () => {
    signal.throwIfAborted();
    local.shutdown.signal.throwIfAborted();
    if (
      local.execution.get({ botId: actor.botId, conversationId: actor.conversationId as string })
        .mode !== "execute"
    )
      throw new RpcError(-32602, "group_workspace_readonly");
    if (snapshot !== authorizationSnapshot(local, actor.botId, actor))
      throw new RpcError(-32602, "group_workspace_authority_changed");
  };
  for (const path of writes) {
    const evaluate = async (): Promise<PolicyResult> => {
      assertAuthorized();
      const result = await policy.evaluate({
        botId: actor.botId,
        request: { category: "write_file", path },
        settings: runPermissions(local, actor),
        permissionSources: local.permissions.sources(actor.botId, actor.groupId),
        workplace: { home: boundary.primaryPath, currentId: "home", folders: [] },
        boundary: temporary,
        cwd: boundary.primaryPath,
        // Runner paths resolve on the runner, as for its file tools; the desktop has no such path.
        // canonicalize: one runner round trip per path (the relay made the walk exceed 10 s).
        ...(remote && boundary.location
          ? {
              realpath: (path: string, current: AbortSignal) =>
                local
                  .targetFor(boundary.location as NonNullable<typeof boundary.location>)
                  .realpath(path, current),
              canonicalize: async (path: string, current: AbortSignal) => {
                const result = await local
                  .targetFor(boundary.location as NonNullable<typeof boundary.location>)
                  .canonicalizePath(path, path, current);
                return { path: result.path, exists: result.device !== null };
              },
            }
          : {}),
        yolo: runYolo(local, actor),
        signal,
      });
      assertAuthorized();
      return explainPolicyResult(
        { ...result, canRemember: false, grantScope: undefined },
        "boundary",
        "consent_scope_narrowed",
        "narrow",
      );
    };
    const result = await evaluate();
    if (allowedByYolo(result))
      auditYolo(
        local,
        actor,
        { id: randomUUID(), tool: "write_file", input: { path, content: "" } },
        result,
      );
    if (result.decision === "deny") {
      // Which of the fixed write roots was refused and why (policy reason code, never the path).
      local.deps.logger.warn(
        JSON.stringify({
          module: "group",
          event: "worktree_authority_denied",
          stage,
          write: writes.indexOf(path),
          remote,
          reason: result.reason,
        }),
      );
      throw new RpcError(-32602, "group_workspace_readonly");
    }
    if (result.decision === "ask") {
      // An approval belongs to a recorded tool call of the run; this lifecycle step has none of
      // its own, so it is recorded like one and closed with the user's answer.
      const callId = randomUUID();
      const calls = new ToolCallsRepo(local.deps.db);
      const record = calls.create({
        messageId: actor.messageId,
        toolCallId: callId,
        tool: "write_file",
        summary: `group_workspace.${stage}`,
        status: "pending",
      });
      let status: Awaited<ReturnType<typeof local.approvals.request>> | undefined;
      try {
        status = await local.approvals.request(
          actor,
          { id: callId, tool: "write_file", input: { path, content: "" } },
          result,
          { available: true },
          evaluate,
          undefined,
          undefined,
          undefined,
          {
            title: (language) =>
              language === "zh"
                ? stage === "create"
                  ? "建立此并行任务的独立工作区"
                  : stage === "discard"
                    ? "清理此任务未合入的独立工作区（保留分支）"
                    : "将此并行任务成果合入群主工作区"
                : stage === "create"
                  ? "Create this parallel task's workspace"
                  : stage === "discard"
                    ? "Clean up this task's unmerged workspace (its branch is kept)"
                    : "Integrate this parallel task's work into the group workspace",
          },
        );
      } catch (error) {
        if (options?.planStep && approvalInterrupted(error, signal))
          throw new UnansweredWorktreeApproval();
        throw error;
      } finally {
        calls.update(record.id, {
          status: status === "allowed" ? "done" : "blocked",
          finishedAt: new Date().toISOString(),
        });
      }
      if (
        options?.planStep &&
        (status === "expired" || status === "auto_denied" || status === "cancelled")
      )
        throw new UnansweredWorktreeApproval();
      if (status !== "allowed") throw new RpcError(-32602, "group_workspace_not_approved");
    }
  }
  assertAuthorized();
  return { assertAuthorized };
}
