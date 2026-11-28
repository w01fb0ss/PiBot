import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";

function validPath(path: string) {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path))
    throw new RpcError(RpcErrorCodes.invalidParams, "invalid_path");
}

function unavailablePath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
  );
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (unavailablePath(error)) throw new RpcError(RpcErrorCodes.invalidParams, "path_unavailable");
    throw error;
  }
}

export async function selectedFolder(path: string, preserveSelection = false): Promise<string> {
  validPath(path);
  const canonical = await canonicalPath(path);
  if (!(await stat(canonical)).isDirectory())
    throw new RpcError(RpcErrorCodes.invalidParams, "invalid_folder");
  // The brain pins the canonical target. The picker must also report the drive the person chose.
  return preserveSelection && process.platform === "win32" ? path : canonical;
}

async function availableRoot(root: string): Promise<string | null> {
  try {
    return await selectedFolder(root);
  } catch (error) {
    // An offline or removed grant provides no access, but must not invalidate other grants.
    if (
      unavailablePath(error) ||
      (error instanceof RpcError &&
        error.code === RpcErrorCodes.invalidParams &&
        ["path_unavailable", "invalid_folder"].includes(error.message))
    )
      return null;
    throw error;
  }
}

/**
 * Roots are supplied only by trusted brain handlers, never by a renderer host port. `folders`
 * (reveal only) also accepts a directory: showing one never opens or runs anything.
 */
export async function allowedFile(
  path: string,
  allowedRoots: string[],
  options: { folders?: boolean } = {},
): Promise<string> {
  validPath(path);
  for (const root of allowedRoots) validPath(root);
  const [canonical, roots] = await Promise.all([
    canonicalPath(path),
    Promise.all(allowedRoots.map(availableRoot)),
  ]);
  const inside = roots.some((root) => {
    if (root === null) return false;
    const suffix = relative(root, canonical);
    return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
  });
  const info = inside ? await stat(canonical) : undefined;
  if (!info || !(info.isFile() || (options.folders === true && info.isDirectory())))
    throw new RpcError(RpcErrorCodes.invalidParams, "path_not_allowed");
  // Open the checked target, rather than following the original symlink again.
  return canonical;
}
