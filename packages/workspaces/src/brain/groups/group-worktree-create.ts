import { randomUUID } from "node:crypto";
import type { ToolRunContext } from "@pibot/brain/kit";
import { managedWorktreePath } from "@pibot/execution";
import { type ManagedRecord, transaction } from "@pibot/storage";
import { type Group, RpcError } from "@pibot/workspaces-contract/full";
import { preserveManagedFailure } from "../managed/managed-failure.ts";
import type { groupWorkplace } from "../runtime.ts";
import type { GroupMemberWorktrees } from "./group-member-worktrees.ts";
import { groupWorktreeAuthority } from "./group-worktree-authority.ts";
import type { WorktreeHost } from "./group-worktree-host.ts";
import { groupWorktreeOperation } from "./group-worktree-operation.ts";

type Place = Awaited<ReturnType<typeof groupWorkplace>>;
export type WorkspaceOperations = Pick<
  GroupMemberWorktrees,
  | "service"
  | "stage"
  | "registry"
  | "repo"
  | "git"
  | "host"
  | "exclusive"
  | "audit"
  | "current"
  | "verify"
  | "state"
>;
function fail(code: string): never {
  throw new RpcError(-32602, code);
}
export async function createMemberWorktree(
  owner: WorkspaceOperations,
  host: WorktreeHost,
  context: ToolRunContext,
  group: Group,
  baseline: Place,
  signal: AbortSignal,
  options?: { planStep: true },
) {
  const local = owner.service.deps.local;
  const { join } = host.paths;
  const mark = (name: string) => owner.stage(context.runId, name);
  mark("inspect_base");
  const base = await host.inspect(baseline.cwd, signal);
  if (!base.clean) fail("group_workspace_integration_dirty");
  const parentRecord = owner.registry.byPath(baseline.cwd);
  const original = parentRecord?.sourcePath ?? baseline.cwd;
  mark("inspect_source");
  const source = await host.inspect(original, signal);
  if (source.common.path !== base.common.path || source.git.path !== join(original, ".git"))
    fail("group_workspace_layout_unsupported");
  if (owner.registry.count(source.common.path) >= 8) fail("worktree_quota");
  const id = randomUUID(),
    requestId = randomUUID(),
    parentPath = join(original, ".pibot", "wt"),
    path = managedWorktreePath(parentPath, original, id, host.paths);
  mark("authority");
  const authority = await groupWorktreeAuthority(
    local,
    context,
    baseline.boundary,
    // A runner creates .pibot/wt itself on create; until then the path cannot be resolved on
    // the runner (target_realpath_unavailable), so the repository root it lives in is checked.
    [host.remote ? original : parentPath, source.common.path],
    signal,
    "create",
    options,
  );
  return owner.exclusive(
    `workspace:${id}`,
    context.botId,
    [source.common.path, path],
    signal,
    async () => {
      mark("locked");
      if (owner.registry.count(source.common.path) >= 8) fail("worktree_quota");
      owner.audit(context, "create", "started", id);
      // A runner prepares `.pibot/wt` itself on create and reports its identity afterwards; until
      // then the allocation holds an identity no folder has, so recovery never trusts it.
      const parent = (await host.project(source, signal, authority.assertAuthorized)) ?? {
        path: parentPath,
        device: "pending",
        inode: "pending",
      };
      const now = new Date().toISOString();
      let tree: ManagedRecord = {
        id,
        botId: context.botId,
        sourcePath: original,
        path,
        commonDir: source.common.path,
        branch: `pibot/worktrees/${id}`,
        baseHead: base.head,
        head: null,
        sourceIdentity: source.root,
        identity: null,
        state: "creating",
        version: 1,
        requestId,
        createdAt: now,
        updatedAt: now,
        bindingRequired: true,
      };
      let member = transaction(local.deps.db, () => {
        owner.registry.allocate({
          id: requestId,
          botId: context.botId,
          scopeKey: `group-task:${context.taskId}`,
          parentPath,
          identity: parent,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        });
        owner.registry.create(tree, requestId);
        return owner.repo.save({
          taskId: context.taskId as string,
          sourceConversationId: group.conversationId,
          groupId: group.id,
          botId: context.botId,
          worktreeId: id,
          integrationPath: baseline.cwd,
          executionLocation: host.remote ? (baseline.boundary.location?.target ?? null) : null,
          workspaceRevision: group.workspaceRevision ?? 0,
          state: "preparing",
          errorCode: null,
          runId: context.runId,
        });
      });
      try {
        owner.current(context, member);
        mark("write");
        const created = await groupWorktreeOperation(
          owner,
          host,
          tree,
          {
            kind: "create",
            source,
            base,
            parent,
            destination: path,
            managedId: id,
            baseHead: base.head,
          },
          { ...authority, home: baseline.home, dataDir: local.deps.dataDir, signal },
        );
        if (created.parent) owner.registry.setAllocationIdentity(requestId, created.parent);
        mark("inspect_created");
        const actual = await host.inspect(path, signal);
        tree = owner.registry.update(id, tree.version, {
          state: "ready",
          head: actual.head,
          identity: { root: actual.root, git: actual.git, common: actual.common },
        });
        member = owner.state(member, "working");
        context.groupMemberWorktreeId = id;
        owner.audit(context, "create", "done", id);
        return { context, member, tree };
      } catch (error) {
        throw preserveManagedFailure(error, [
          () => owner.state(member, "interrupted", "group_workspace_create_failed"),
          () => owner.audit(context, "create", "error", id),
        ]);
      }
    },
  );
}
