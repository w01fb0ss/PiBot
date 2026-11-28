import { join, resolve } from "node:path";
import { ExecError, sensitiveReadBoundary } from "@pibot/execution";
import { containsPath, type Platform } from "@pibot/policy";
import { GroupsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runPermissionScope } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { resolveRunWorkplace } from "../../resources/workplaces/run-workplace.ts";
import { authorizationSnapshot } from "./local-prepare.ts";
import { pathPrefixMatcher, pathRegion } from "./path-prefix-matcher.ts";

/** One operation owns this snapshot; it is never a reusable permission or a process cache. */
export async function createReadPathBoundary(
  local: LocalService,
  context: ToolRunContext,
  signal: AbortSignal,
  scmRoot?: string,
  readAuthorization = () => authorizationSnapshot(local, context.botId, context),
) {
  const authorization = readAuthorization();
  const workplace = await resolveRunWorkplace(local, context, signal);
  const remote = workplace.boundary.location?.target.startsWith("runner:") === true;
  const platform = workplace.boundary.location?.platform ?? local.deps.platform;
  const protectedPaths = await sensitiveReadBoundary(
    local.deps.platform,
    [local.deps.userHome, workplace.home],
    local.deps.env,
    remote
      ? undefined
      : {
          dataDir: local.deps.dataDir,
          botHome: workplace.home,
          skillGroupId: runPermissionScope(local, context),
          skillPackageIds: local.skills?.packageIds?.(
            context.botId,
            runPermissionScope(local, context),
          ),
        },
  );
  const assertCurrent = (current: AbortSignal) => {
    current.throwIfAborted();
    if (readAuthorization() !== authorization) throw new ExecError("outside_workplace");
  };
  const group = context.groupId ? new GroupsRepo(local.deps.db).get(context.groupId) : undefined;
  const sharedHome =
    group?.members.some((member) => member.botId === context.botId) &&
    workplace.boundary.primaryPath === join(resolve(local.deps.dataDir), "groups", group.id, "home")
      ? workplace.boundary.primaryPath
      : undefined;
  const permits = createProtectedReadPathCheck(local.deps.userHome, protectedPaths, platform, {
    scmRoot,
    sharedHome,
    localPlatform: local.deps.platform,
  });
  assertCurrent(signal);
  return {
    workplace,
    authorization,
    assertCurrent,
    permits,
    sensitiveReadRoots: protectedPaths.denyRead,
  };
}

/** Apply the protected-path rules to local reads whether or not they belong to a tool run. */
export function createProtectedReadPathCheck(
  userHome: string,
  protectedPaths: Awaited<ReturnType<typeof sensitiveReadBoundary>>,
  platform: Platform,
  options?: { scmRoot?: string; sharedHome?: string; localPlatform: Platform },
) {
  const { scmRoot, sharedHome, localPlatform = platform } = options ?? {};
  const match = pathPrefixMatcher(platform);
  const denied = pathRegion(protectedPaths.denyRead, platform);
  const allowed = pathRegion(protectedPaths.allowRead, platform);
  return (path: string) => {
    const contains = match(path);
    // AI login files are not project instructions. Their ordinary dot-directory exclusion is
    // insufficient when a model explicitly chooses one of them as the search root.
    if (
      [".claude", ".codex", ".cursor"].some(
        (name) =>
          contains(join(userHome, name)) &&
          !(
            scmRoot &&
            containsPath(join(userHome, name, "worktrees"), scmRoot, localPlatform) &&
            containsPath(scmRoot, path, localPlatform)
          ),
      )
    )
      return false;
    if (denied(path) >= 0 && allowed(path) < 0 && !(sharedHome && contains(sharedHome)))
      return false;
    const segments = path.split(/[/\\]/).map((segment) => segment.toLowerCase());
    return !segments.some(
      (segment) =>
        segment === ".env" ||
        segment.startsWith(".env.") ||
        [
          ".ssh",
          ".gnupg",
          ".aws",
          ".azure",
          ".kube",
          ".pi",
          ".netrc",
          ".npmrc",
          ".pypirc",
          ".git-credentials",
        ].includes(segment),
    );
  };
}
