import { type Group, type ResolvedWorkplace, RpcError } from "@pibot/protocol-base";
import { ManagedWorktreesRepo } from "@pibot/storage";
import type { LocalService } from "../../local-service.ts";
import { runnerWorkplace } from "../workplaces/runner-workplace.ts";
import { workspaceBoundary } from "../workplaces/workspace-boundary.ts";

export async function groupWorkplace(
  local: LocalService,
  botId: string,
  group: Group,
  signal: AbortSignal,
): Promise<ResolvedWorkplace> {
  try {
    const primary = group.folders?.find((folder) => folder.id === group.primaryFolderId);
    const remote = await runnerWorkplace(
      {
        home: primary?.path ?? "home",
        currentId: primary?.id ?? "home",
        revision: group.workspaceRevision ?? 0,
        folders: (group.folders ?? []).map(({ id, name, path, location }) => ({
          id,
          name,
          path,
          location,
          role: id === primary?.id ? "primary" : "readonly",
        })),
      },
      local.executionTargets,
      signal,
    );
    if (remote) return remote;
    const home = await local.workplaces.botHome(botId, signal);
    const cwd = primary?.path ?? (await local.workplaces.groupHome(group.id, signal));
    const boundary = await workspaceBoundary(
      [
        ...(primary ? [] : [{ id: "home", path: cwd, role: "primary" as const }]),
        ...(group.folders ?? []).map((folder) => ({
          id: folder.id,
          path: folder.path,
          role: folder.id === primary?.id ? ("primary" as const) : ("readonly" as const),
        })),
      ],
      group.workspaceRevision ?? 0,
      local.deps.platform,
      signal,
      new ManagedWorktreesRepo(local.deps.db).byPath(cwd),
    );
    return {
      value: {
        home: cwd,
        currentId: "home" as const,
        // The policy DTO is strict: group display metadata is not a working-folder field.
        folders: (group.folders ?? [])
          .filter((folder) => folder.id !== primary?.id)
          .map(({ id, name, path }) => ({ id, name, path })),
      },
      ...(local.deps.platform === "win32"
        ? {
            displayFolders: group.folders
              ?.filter((folder) => !folder.location && folder.displayPath !== folder.path)
              .map(({ path, displayPath }) => ({ path, displayPath })),
          }
        : {}),
      cwd,
      roots: boundary.readRoots,
      home,
      boundary,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
    )
      throw new RpcError(-32602, "Group workplace unavailable");
    throw error;
  }
}
