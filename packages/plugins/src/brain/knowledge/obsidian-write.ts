import { relative, sep } from "node:path";
import { abortable } from "@pibot/brain/kit";
import { createFileTools } from "@pibot/execution";
import { checkedMarkdownPath, markdownSnapshot } from "@pibot/execution/markdown-files";
import { firstHeading, type ObsidianVault, titleFromPath, vaultRoot } from "./obsidian.ts";
import { type KnowledgeWriteInput, writeError, writeRef } from "./write-input.ts";

export async function vaultWriteTarget(
  vault: ObsidianVault,
  input: KnowledgeWriteInput,
  signal: AbortSignal,
) {
  const ref = writeRef(input);
  if (input.action === "create" && input.path === undefined) writeError("knowledge_path_invalid");
  const root = await vaultRoot(vault, signal);
  const path = await abortable(checkedMarkdownPath(root, ref, signal), signal);
  return { root, path, ref: relative(root.path, path).split(sep).join("/") };
}

export async function vaultWriteSnapshot(
  target: Awaited<ReturnType<typeof vaultWriteTarget>>,
  expectedVersion: string | null,
  signal: AbortSignal,
) {
  const snapshot = await abortable(
    markdownSnapshot(target.root, target.ref, expectedVersion, signal),
    signal,
  );
  return {
    text: snapshot?.text ?? null,
    title: (snapshot && firstHeading(snapshot.text)) || titleFromPath(target.ref),
  };
}

export async function applyVaultWrite(
  target: Awaited<ReturnType<typeof vaultWriteTarget>>,
  content: string,
  version: string | null,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  await abortable(checkedMarkdownPath(target.root, target.ref, signal), signal);
  return createFileTools().writeFile({
    path: target.path,
    expectedPath: target.path,
    cwd: target.root.path,
    writeRoots: [target.root.path],
    rootIdentities: [
      {
        canonicalPath: target.root.path,
        ...target.root.identity,
        role: "primary",
      },
    ],
    content,
    ...(version === null ? { expectedHash: null } : { expectedVersion: version }),
    signal,
    assertCurrent,
  });
}
