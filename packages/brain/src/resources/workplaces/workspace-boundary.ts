import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileIdentity, samePathSpelling } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import {
  type ExecutionLocationTarget,
  RpcError,
  type WorkspaceSnapshot,
  WorkspaceSnapshotSchema,
} from "@pibot/protocol-base";
import type { ManagedRecord } from "@pibot/storage";

export async function workspaceBoundary(
  inputs: { id: string; path: string; role: "primary" | "readonly" | "writable" }[],
  revision: number,
  platform: "darwin" | "linux" | "win32",
  signal: AbortSignal,
  managed?: ManagedRecord,
  location?: {
    target: ExecutionLocationTarget;
    platform: "darwin" | "linux" | "win32";
  },
): Promise<WorkspaceSnapshot> {
  const roots: WorkspaceSnapshot["roots"] = [];
  for (const root of inputs) {
    signal.throwIfAborted();
    const canonical = await realpath(root.path),
      info = await lstat(root.path, { bigint: true });
    signal.throwIfAborted();
    if (
      !samePathSpelling(canonical, resolve(root.path)) ||
      !info.isDirectory() ||
      info.isSymbolicLink()
    )
      throw new RpcError(-32602, "workspace_boundary_changed");
    const existing = roots.find((r) => r.canonicalPath === canonical);
    if (existing) {
      if (existing.role !== root.role) throw new RpcError(-32602, "workspace_conflict");
      continue;
    }
    // Only the snapshot's own fields: callers pass folder records (a group topic's picked folder
    // carries `location`), and the strict root schema refused the extra key as a ZodError.
    roots.push({
      id: root.id,
      role: root.role,
      path: root.path,
      canonicalPath: canonical,
      // Same canonical spelling every checker (task authority, execution, runner) compares to.
      ...fileIdentity(info),
    });
  }
  const primary = roots.find((r) => r.role === "primary");
  if (!primary) throw new RpcError(-32602, "workspace_primary_missing");
  const source = roots.find(
    (r) => r.role === "readonly" && r.canonicalPath === managed?.sourcePath,
  );
  const readonlySource =
    managed?.state === "ready" &&
    managed.path === primary.canonicalPath &&
    managed.identity?.root.path === primary.canonicalPath &&
    managed.identity?.root.device === primary.device &&
    managed.identity.root.inode === primary.inode &&
    source?.device === managed.sourceIdentity.device &&
    source.canonicalPath === managed.sourceIdentity.path &&
    source?.inode === managed.sourceIdentity.inode &&
    source.canonicalPath !== primary.canonicalPath &&
    containsPath(source.canonicalPath, primary.canonicalPath, platform)
      ? source.canonicalPath
      : undefined;
  const denyWriteRoots = roots
    .filter((r) => r.role === "readonly" && r.canonicalPath !== readonlySource)
    .map((r) => r.canonicalPath);
  const writable = roots.filter((r) => r.role === "writable");
  if (
    writable.some((r) =>
      roots.some(
        (other) =>
          other.role === "readonly" &&
          (containsPath(other.canonicalPath, r.canonicalPath, platform) ||
            containsPath(r.canonicalPath, other.canonicalPath, platform)),
      ),
    )
  )
    throw new RpcError(-32602, "workspace_conflict");
  const conflict = denyWriteRoots.some((root) =>
    containsPath(root, primary.canonicalPath, platform),
  )
    ? "readonly_overlaps_primary"
    : "none";
  return WorkspaceSnapshotSchema.parse({
    boundaryVersion: 1,
    location: location ?? { target: "local", platform },
    conflict,
    roots,
    revision,
    primaryId: primary.id,
    primaryPath: primary.canonicalPath,
    ...(readonlySource ? { readonlySource } : {}),
    readRoots: roots.map((r) => r.canonicalPath),
    writeRoots:
      conflict === "none" ? [primary.canonicalPath, ...writable.map((r) => r.canonicalPath)] : [],
    denyWriteRoots,
  });
}
