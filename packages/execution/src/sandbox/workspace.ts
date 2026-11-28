import { lstat, opendir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileIdentity, matchesFileIdentity } from "../core/file-identity.ts";
import { samePathSpelling } from "../core/paths.ts";
import { type AliasFileSystem, ExecError, type RunCommandOptions } from "../core/types.ts";
import { scanCommandAliases } from "./alias-scan.ts";

/**
 * Identity proof for a directory Pi Bot itself manages (a Bot's attachments folder), for reads
 * that have no policy-approved workspace boundary to take root identities from.
 */
export async function directoryIdentity(path: string) {
  const canonical = await realpath(path);
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new ExecError("outside_workplace", "workspace_identity_changed");
  return { canonicalPath: canonical, ...fileIdentity(info) };
}

export async function verifyWorkspace(
  identities: RunCommandOptions["rootIdentities"],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!identities?.length) throw new ExecError("outside_workplace", "workspace_identity_missing");
  for (const identity of identities) {
    signal.throwIfAborted();
    const info = await lstat(identity.canonicalPath, { bigint: true }),
      canonical = await realpath(identity.canonicalPath);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !samePathSpelling(canonical, resolve(identity.canonicalPath)) ||
      !matchesFileIdentity(info, identity)
    )
      throw new ExecError("outside_workplace", "workspace_identity_changed");
    signal.throwIfAborted();
  }
}
// A pre-existing hard link can write a readonly inode under a writable name. Deny every such
// name; Seatbelt resolves symlinks and blocks new links out of denied roots at dispatch time.
export async function verifyCommandAliases(
  roots: string[],
  denied: string[],
  signal: AbortSignal,
  filesystem: AliasFileSystem = { lstat, opendir, realpath },
  readonlyReferences = false,
) {
  if (!denied.length && !readonlyReferences) return [];
  return scanCommandAliases(roots, denied, signal, filesystem);
}
