import type { PlanStepWorkspace, ToolRunContext } from "@pibot/brain/kit";
import {
  ExecError,
  findGit,
  ManagedExecError,
  ManagedFolderError,
  managedFolderRepository,
} from "@pibot/execution";
import { type Group, RpcError } from "@pibot/workspaces-contract/full";
import { isManagedCleanupFailure } from "../managed/managed-failure.ts";
import type { groupWorkplace } from "../runtime.ts";
import type { GroupMemberWorktrees } from "./group-member-worktrees.ts";
import { seedStepOutput } from "./group-step-output.ts";
import { groupWorktreeAuthority, UnansweredWorktreeApproval } from "./group-worktree-authority.ts";
import { createMemberWorktree } from "./group-worktree-create.ts";
import type { WorktreeHost } from "./group-worktree-host.ts";

type Place = Awaited<ReturnType<typeof groupWorkplace>>;
/** Setup facts that mean "no workspace here", never a broken one: the step takes turns instead. */
const TURNS = new Set([
  "runner_update_required",
  "worktree_quota",
  "group_workspace_integration_dirty",
  "group_workspace_layout_unsupported",
]);
/**
 * Answers about this step's permission or its group, not about setting a workspace up: they end
 * the step as before. Any other setup failure takes turns (see setupFailed).
 */
const DECISIONS = new Set([
  "group_workspace_changed",
  "group_workspace_authority_changed",
  "group_workspace_readonly",
  "group_workspace_not_approved",
]);
/** Error code of a member row whose setup failed; the step took turns, so it has no workspace. */
export const SETUP_FAILED = "group_workspace_setup_failed";
const CLEANUP_PENDING = "group_workspace_cleanup_pending";

/** A fixed code for the log: RPC codes and ExecError codes, never messages or paths. */
export function prepareFailureCode(error: unknown) {
  return error instanceof RpcError && /^[a-z0-9_.-]{1,80}$/i.test(error.message)
    ? error.message
    : // Its ExecError code is always invalid_input; the managed code says which check refused.
      error instanceof ManagedExecError
      ? `exec_${error.code}.${error.managedCode}`
      : error instanceof ExecError
        ? `exec_${error.code}${error.reason ? `.${error.reason}` : ""}`
        : error instanceof Error
          ? error.name
          : "unknown";
}

/**
 * Where a writing plan step works (maintainers 2026-11-14): a clean Git repository gets an ordinary
 * managed worktree; any other folder on this desktop gets one branched from Pi Bot's own
 * repository for the plan inside that folder; a runner folder needs the runner's managed Git.
 * Whatever cannot have a workspace takes turns in the shared folder, with a fixed reason.
 */
export async function prepareStepWorktree(
  owner: GroupMemberWorktrees,
  context: ToolRunContext,
  group: Group,
  baseline: Place,
  task: { id: string; status: string },
  step: PlanStepWorkspace,
  signal: AbortSignal,
) {
  const local = owner.service.deps.local;
  const remote = !!baseline.boundary.location && baseline.boundary.location.target !== "local";
  const location = remote ? (baseline.boundary.location?.target ?? null) : null;
  const primary = baseline.boundary.primaryPath;
  // One line per shared folder: steps taking turns there run one after another.
  const folder = `${location ?? "local"}\0${primary}`;
  const turns = (reason: string) => owner.takeTurns(context, task.id, reason, folder);
  const setupFailed = (error: unknown) => {
    if (error instanceof UnansweredWorktreeApproval) throw error;
    // Only the prepare limit is a setup failure; a stop or shutdown ends the step as before, and
    // so does an approval nobody answered in time (that is the person's decision, not a setup).
    const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
    if (signal.aborted && timedOut && owner.stageOf(context.runId) === "authority")
      throw new RpcError(-32602, "group_workspace_not_approved");
    if (
      (signal.aborted && !timedOut) ||
      (error instanceof RpcError && DECISIONS.has(error.message))
    )
      throw error;
    return stepSetupFailed(owner, context, task.id, error, primary, turns);
  };
  owner.stage(context.runId, "host");
  let host: WorktreeHost;
  try {
    host = owner.host(baseline.boundary);
  } catch (error) {
    if (error instanceof RpcError && TURNS.has(error.message)) return turns(error.message);
    throw error;
  }
  const retained = owner.repo.get(task.id);
  if (retained && retained.state !== "integrated")
    return owner.reattach(context, group, task, retained, host, location, signal);
  // A sibling already takes turns here: its run holds the folder, so a setup here would only
  // wait on it until the prepare limit. The reason is the same for this step.
  const sharing = owner.turns.reason(folder);
  if (sharing) return turns(sharing);
  if (owner.cleanupPending([primary])) return turns(CLEANUP_PENDING);
  // Without Git nothing below can work. Checked before the platform isolation check so Linux
  // reports the missing prerequisite and offers the Git install card.
  // another step holds only to learn that Git is missing.
  if (
    !remote &&
    !(await findGit({
      platform: local.deps.platform,
      env: local.deps.env,
      resourcesDir: local.deps.resourcesDir,
    }))
  )
    return turns("git_unavailable");
  // An own workspace keeps the group folder as a read-only reference. Only macOS can run
  // commands beside one, so other platforms take turns after Git availability is established.
  if (!remote && local.deps.platform !== "darwin") return turns("readonly_commands_unsupported");
  owner.stage(context.runId, "probe");
  const repository = (await host.isRepository(primary, signal).catch(() => false))
    ? await host.inspect(primary, signal).catch(() => undefined)
    : undefined;
  const usable =
    !!repository &&
    repository.clean &&
    repository.git.path === host.paths.join(primary, ".git") &&
    repository.common.path === repository.git.path;
  let place = baseline;
  if (!usable) {
    // Pi Bot's own repository is a desktop facility; a runner folder must already be Git.
    if (remote) return turns(repository ? "runner_folder_dirty" : "runner_folder_not_git");
    const managed = managedFolderRepository(primary, step.planKey);
    owner.stage(context.runId, "managed_folder");
    let authority: Awaited<ReturnType<typeof groupWorktreeAuthority>>;
    try {
      authority = await groupWorktreeAuthority(
        local,
        context,
        baseline.boundary,
        [managed],
        signal,
        "create",
        { planStep: true },
      );
    } catch (error) {
      // Windows retest 2026-11-21: the policy check's own 10 s limit fired right after a brain
      // stall and interrupted the step; setupFailed still rethrows stops and the person's answers.
      return setupFailed(error);
    }
    try {
      await owner.exclusive(`folder:${managed}`, context.botId, [managed], signal, async () => {
        authority.assertAuthorized();
        await owner.folders.sync({
          folder: primary,
          repository: managed,
          exclude: [local.deps.dataDir],
          signal,
        });
      });
    } catch (error) {
      if (error instanceof ManagedFolderError && error.folderCode === "managed_folder_too_large")
        return turns(error.folderCode);
      // Most Windows computers have no Git and Pi Bot ships none: parallel steps take turns in
      // the shared folder instead of failing every one of them as an internal error.
      if (error instanceof ExecError && error.code === "git_unavailable")
        return turns("git_unavailable");
      return setupFailed(error);
    }
    place = { ...baseline, cwd: managed };
  }
  let active: Awaited<ReturnType<typeof createMemberWorktree>>;
  try {
    active = await createMemberWorktree(owner, host, context, group, place, signal, {
      planStep: true,
    });
  } catch (error) {
    if (error instanceof RpcError && TURNS.has(error.message)) return turns(error.message);
    return setupFailed(error);
  }
  owner.active.set(context.runId, active);
  owner.stage(context.runId, "seed");
  await seedStepOutput(
    local,
    baseline.boundary,
    { taskId: task.id, primary, outputFolder: step.outputFolder, workspace: active.tree.path },
    signal,
  );
}

/**
 * The safety net for a workspace that could not be set up (a Git or process failure while
 * creating it): the step takes turns in the shared folder instead of ending as an internal error.
 * Only records change here. A half-created tree stays for the existing cleanup: inside Pi Bot's
 * folder repository it goes with the repository when the plan ends, and a tree whose cleanup
 * is uncertain keeps its lock until a restart (that folder then reports cleanup pending).
 */
function stepSetupFailed(
  owner: GroupMemberWorktrees,
  context: ToolRunContext,
  taskId: string,
  error: unknown,
  primary: string,
  turns: (reason: string) => void,
) {
  const code = prepareFailureCode(error);
  owner.service.deps.local.deps.logger.warn(
    JSON.stringify({
      module: "group",
      event: "step_workspace_setup_failed",
      groupId: context.groupId,
      runId: context.runId,
      taskId,
      stage: owner.stageOf(context.runId),
      code,
    }),
  );
  const member = owner.repo.get(taskId);
  // The row the failed create left (interrupted) would make the step look like it has its own
  // workspace to check and merge. Closed with this code, the task has none (workspace()).
  if (member && member.state !== "integrated" && member.state !== "removed")
    owner.state(member, "removed", SETUP_FAILED);
  turns(
    isManagedCleanupFailure(error) || code === CLEANUP_PENDING || owner.cleanupPending([primary])
      ? CLEANUP_PENDING
      : SETUP_FAILED,
  );
}
