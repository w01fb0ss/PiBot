import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileIdentity } from "../core/file-identity.ts";
import { samePathSpelling, writablePath } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import { textSnapshot, textVersion } from "./text-snapshot.ts";

type MarkdownRoot = { path: string; identity: FileIdentity };

export async function checkedMarkdownPath(root: MarkdownRoot, ref: string, signal: AbortSignal) {
  // Checking the spelling first excludes aliases before the filesystem can normalize them away.
  const parts = ref.split("/");
  if (
    /[:\\<>"|?*\p{Cc}\p{Cf}]/u.test(ref) ||
    parts.some(
      (part) =>
        !part ||
        part.startsWith(".") ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
    ) ||
    !/\.md$/iu.test(ref)
  )
    throw new ExecError("outside_workplace");
  await verifyWorkspace([{ canonicalPath: root.path, ...root.identity }], signal);
  const path = join(root.path, ...parts);
  const canonical = await writablePath(path, root.path, [root.path]);
  // A write to one note must have no directory creation side effects.
  if (!samePathSpelling(await realpath(dirname(path)), dirname(path)))
    throw new ExecError("outside_workplace");
  signal.throwIfAborted();
  return canonical;
}

export async function markdownSnapshot(
  root: MarkdownRoot,
  ref: string,
  expectedVersion: string | null,
  signal: AbortSignal,
) {
  const path = await checkedMarkdownPath(root, ref, signal);
  const snapshot = await textSnapshot(path, signal);
  if ((snapshot ? textVersion(snapshot.stat, snapshot.text) : null) !== expectedVersion)
    throw new ExecError("file_conflict");
  await checkedMarkdownPath(root, ref, signal);
  return snapshot && { ...snapshot, path };
}
