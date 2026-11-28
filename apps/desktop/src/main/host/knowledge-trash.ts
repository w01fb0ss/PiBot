import { ExecError } from "@pibot/execution";
import { markdownSnapshot } from "@pibot/execution/markdown-files";
import { type HostParams, RpcError, RpcErrorCodes } from "@pibot/protocol";

export async function trashKnowledgeNote(
  input: HostParams["host.knowledge.trashNote"],
  signal: AbortSignal,
  moveToTrash: (path: string) => Promise<void>,
  fallback?: (path: string) => Promise<void>,
) {
  const verify = () =>
    markdownSnapshot(
      { path: input.vault.path, identity: input.vault },
      input.relativePath,
      input.expectedVersion,
      signal,
    ).catch((error: unknown) => {
      signal.throwIfAborted();
      throw new RpcError(
        RpcErrorCodes.invalidParams,
        error instanceof ExecError && error.code === "file_conflict"
          ? "knowledge_conflict"
          : "knowledge_path_invalid",
      );
    });
  const snapshot = await verify();
  if (!snapshot) throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_conflict");
  signal.throwIfAborted();
  try {
    await moveToTrash(snapshot.path).catch(async (error: unknown) => {
      if (!fallback) throw error;
      signal.throwIfAborted();
      // The desktop utility may have spent time trying or already moved the original note.
      const current = await verify();
      if (
        !current ||
        current.stat.dev !== snapshot.stat.dev ||
        current.stat.ino !== snapshot.stat.ino
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_conflict");
      await fallback(current.path);
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RpcError) throw error;
    // The OS can refuse Trash on a volume or in a headless session; there is no unlink fallback.
    throw new RpcError(RpcErrorCodes.unsupported, "knowledge_trash_unavailable");
  }
  return { trashed: true as const };
}
