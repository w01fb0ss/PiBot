import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { ExecError, type ScriptPin } from "../core/types.ts";

/** Policy reads at most 64 KB of a script; a larger file now cannot be the one it judged. */
const SCRIPT_PIN_MAX_BYTES = 64 * 1024;

/**
 * Found in a security review: policy judged a script run by the file's bytes at decision time, and
 * the
 * shell opens the file by path later; another Bot can rewrite it in between (while a card waits,
 * or in the milliseconds before an automatic run). Re-read every pinned file immediately before
 * dispatch and refuse with `script_changed` when one is missing or differs, so the run is asked
 * for again. A window of a few milliseconds between this read and the interpreter's own open
 * remains; closing it would need the interpreter to read a descriptor policy opened.
 */
export async function verifyScriptPins(
  pins: readonly ScriptPin[] | undefined,
  signal: AbortSignal,
): Promise<void> {
  for (const pin of pins ?? []) {
    signal.throwIfAborted();
    if (
      pin.canonicalPath &&
      (await realpath(pin.path).catch(() => undefined)) !== pin.canonicalPath
    )
      throw new ExecError("script_changed");
    if ((await pinnedDigest(pin.path, !!pin.canonicalPath)) !== pin.sha256)
      throw new ExecError("script_changed");
  }
}

async function pinnedDigest(path: string, installed: boolean): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      installed ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : "r",
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > SCRIPT_PIN_MAX_BYTES) return undefined;
    // One byte more than allowed tells a file that grew after stat apart from one that fits.
    const buffer = Buffer.alloc(SCRIPT_PIN_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > SCRIPT_PIN_MAX_BYTES) return undefined;
    return createHash("sha256").update(buffer.subarray(0, length)).digest("hex");
  } catch (error) {
    // A missing or unreadable file is not the file policy judged; that is the refusal itself.
    if (error instanceof Error && "code" in error) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}
