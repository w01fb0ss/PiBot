import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import { obsidianConfigs } from "./knowledge-detect.ts";

// The host half of "open the note this reply links". The brain has already proved the
// reply, the current assignment and the vault/note identities; this module proves the folder and
// file still match those exact identities, asks the brain once more, and either opens the note in
// Obsidian (when uniquely listed in obsidian.json) or falls back cleanly to revealing the exact
// verified file in the system file manager (Finder / Explorer / Linux file manager).

/** Obsidian's own list; anything bigger or unparsable cannot prove uniqueness, so it fails closed. */
const MAX_CONFIG_BYTES = 1024 * 1024;
/** A crafted list must not fan out: past this many entries the answer is "cannot prove it". */
const MAX_VAULTS = 200;
/** The host's slow read stays inside the brain's RPC budget even on a stalled network share. */
const OPEN_TIMEOUT_MS = 15_000;

const SUPPORTED_NOTE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx"]);

export interface OpenKnowledgeNoteParams {
  requestId: string;
  sourceId: string;
  vault: { path: string; device: string; inode: string };
  note: { relativePath: string; device: string; inode: string };
  preferReveal?: boolean;
}

export type OpenKnowledgeFallbackReason =
  | "obsidian_unavailable"
  | "duplicate_vault"
  | "not_in_obsidian"
  | "document_file";

export interface OpenKnowledgeNoteResult {
  opened: true;
  method: "obsidian" | "revealed";
  fallbackReason?: OpenKnowledgeFallbackReason;
}

type MatchIdentity = (
  stats: { dev: bigint; ino: bigint },
  expected: { device: string; inode: string },
) => boolean;

type TargetProof =
  | { mode: "obsidian"; vaultPath: string; notePath: string }
  | {
      mode: "reveal";
      vaultPath: string;
      notePath: string;
      fallbackReason: OpenKnowledgeFallbackReason;
    };

/**
 * Re-checks what the brain verified, asks it once more (the click may have been revoked while the
 * configuration was read) and only then lets the system open the note or reveal the file.
 */
export async function openKnowledgeNote(options: {
  platform: NodeJS.Platform;
  home: string;
  env: (name: string) => string | undefined;
  params: OpenKnowledgeNoteParams;
  signal: AbortSignal;
  /** The desktop injects execution's exact identity comparison without loading it in this entry. */
  matchesFileIdentity: MatchIdentity;
  confirm(): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealFile?(path: string, signal: AbortSignal): Promise<void>;
  /** True when the OS has a registered handler for `obsidian://` URIs (false for portable installs). */
  hasObsidianHandler?(): boolean;
}): Promise<OpenKnowledgeNoteResult> {
  const deadline = AbortSignal.any([options.signal, AbortSignal.timeout(OPEN_TIMEOUT_MS)]);
  try {
    const first = await proveTarget(options, deadline);
    deadline.throwIfAborted();
    await options.confirm();
    deadline.throwIfAborted();
    // `confirm()` is asynchronous (brain RPC, IPC round trip) and the system open is still ahead:
    // the note, its folders or Obsidian's own mapping can change meanwhile, so the whole proof is
    // repeated and has to describe the same vault and note. The confirm callback must not be the
    // last moment anything was checked.
    const last = await proveTarget(options, deadline);
    if (last.vaultPath !== first.vaultPath || last.notePath !== first.notePath) throw changed();
    deadline.throwIfAborted();

    if (last.mode === "obsidian") {
      const rel = last.notePath.slice(last.vaultPath.length + 1).replaceAll("\\", "/");
      const stripped = rel.replace(/\.md$/, "");
      const file = !basename(stripped).includes(".") ? stripped : rel;
      const url = `obsidian://open?vault=${encodeURIComponent(
        basename(last.vaultPath),
      )}&file=${encodeURIComponent(file)}`;
      // From here the URI may already have reached the system: a thrown error cannot prove the note
      // did not open, so it is reported as an unknown outcome and never retried on the person's
      // behalf (a second open would be a second side effect, not a retry).
      try {
        await options.openExternal(url);
      } catch {
        throw unknown();
      }
      return { opened: true, method: "obsidian" };
    }

    if (!options.revealFile) throw unsupported();
    try {
      await options.revealFile(last.notePath, deadline);
    } catch (error) {
      if (error instanceof RpcError && error.message === "path_reveal_unsupported") {
        throw unsupported();
      }
      throw unknown();
    }
    return { opened: true, method: "revealed", fallbackReason: last.fallbackReason };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    // An aborted read is the person closing the app or giving up, not a broken configuration.
    if (deadline.aborted) throw new RpcError(RpcErrorCodes.internal, "knowledge_open_cancelled");
    throw unsupported();
  }
}

/** Everything that must be true of the target, checked again after the brain's confirmation. */
async function proveTarget(
  options: {
    platform: NodeJS.Platform;
    home: string;
    env: (name: string) => string | undefined;
    params: OpenKnowledgeNoteParams;
    matchesFileIdentity: MatchIdentity;
    revealFile?(path: string, signal: AbortSignal): Promise<void>;
    hasObsidianHandler?(): boolean;
  },
  deadline: AbortSignal,
): Promise<TargetProof> {
  const vaultPath = await canonicalVault(
    options.params.vault,
    deadline,
    options.matchesFileIdentity,
  );
  const notePath = await noteInside(
    vaultPath,
    options.params.note,
    deadline,
    options.matchesFileIdentity,
  );
  if (options.params.preferReveal || extname(notePath).toLowerCase() !== ".md") {
    if (!options.revealFile) throw unsupported();
    return { mode: "reveal", vaultPath, notePath, fallbackReason: "document_file" };
  }
  // A portable Obsidian install can have a valid obsidian.json without a registered `obsidian://`
  // URI handler; fall back to revealing the verified file instead of failing with an unknown outcome.
  if (options.hasObsidianHandler && !options.hasObsidianHandler()) {
    if (!options.revealFile) throw unsupported();
    return { mode: "reveal", vaultPath, notePath, fallbackReason: "obsidian_unavailable" };
  }
  // Obsidian resolves `vault` by folder name, so the name has to be unique among the vaults it
  // knows *and* resolve to this exact folder; two same-named vaults or plain folders fall back
  // cleanly to revealing the verified file in the system file manager.
  const lookup = await configuredVaults(options, deadline);
  if (lookup.status === "ok") {
    const named = lookup.paths.filter((path) => basename(path) === basename(vaultPath));
    if (named.length === 1 && named[0] === vaultPath) {
      return { mode: "obsidian", vaultPath, notePath };
    }
    if (!options.revealFile) throw unsupported();
    return {
      mode: "reveal",
      vaultPath,
      notePath,
      fallbackReason: named.length > 1 ? "duplicate_vault" : "not_in_obsidian",
    };
  }
  if (!options.revealFile) throw unsupported();
  return { mode: "reveal", vaultPath, notePath, fallbackReason: "obsidian_unavailable" };
}

/** The recorded folder must still be the same entity: same canonical path, same device and inode. */
async function canonicalVault(
  vault: { path: string; device: string; inode: string },
  deadline: AbortSignal,
  matchesFileIdentity: MatchIdentity,
): Promise<string> {
  let real: string;
  try {
    real = await bounded(realpath(vault.path), deadline);
  } catch {
    if (deadline.aborted) throw deadline.reason;
    throw changed();
  }
  if (real !== resolve(vault.path)) throw changed();
  const info = await stats(real, deadline);
  if (!info.isDirectory() || info.isSymbolicLink() || !matchesFileIdentity(info, vault))
    throw changed();
  return real;
}

/**
 * Every vault Obsidian itself lists. A missing, oversized, unreadable or malformed configuration
 * cannot prove which vault the name means, so Obsidian URI open is refused and the caller falls
 * back to revealing the verified local file instead.
 */
async function configuredVaults(
  options: {
    platform: NodeJS.Platform;
    home: string;
    env: (name: string) => string | undefined;
  },
  deadline: AbortSignal,
): Promise<{ status: "ok"; paths: string[] } | { status: "unavailable" }> {
  const configs = obsidianConfigs(options.platform, options.home, options.env);
  const paths: string[] = [];
  const seen = new Set<string>();
  let found = false;
  let candidates = 0;
  for (const config of configs) {
    let text: string;
    try {
      const info = await bounded(lstat(config, { bigint: true }), deadline);
      const limit = BigInt(MAX_CONFIG_BYTES);
      if (!info.isFile() || info.isSymbolicLink() || info.size > limit) {
        return { status: "unavailable" };
      }
      found = true;
      // The size `lstat` saw can be stale by the time the bytes arrive, so the bytes actually read
      // are what the limit is applied to as well.
      const bytes = await bounded(readFile(config, { signal: deadline }), deadline);
      if (bytes.byteLength > MAX_CONFIG_BYTES) return { status: "unavailable" };
      text = bytes.toString("utf8");
    } catch (error) {
      if (deadline.aborted) throw deadline.reason;
      // A platform keeps its list in more than one place; only "this one is not here" is fine.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return { status: "unavailable" };
    }
    const listed = vaultPaths(text);
    if (!listed) return { status: "unavailable" };
    // Counted before dedup and before skipping invalid entries: a list padded with junk or repeats
    // must not be able to hide how many vaults it names.
    candidates += listed.length;
    if (candidates > MAX_VAULTS) return { status: "unavailable" };
    for (const path of listed) {
      const canonical = resolve(path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      paths.push(canonical);
    }
  }
  if (!found) return { status: "unavailable" };
  return { status: "ok", paths };
}

/**
 * Every entry has to be a complete mapping. Skipping the ones we do not understand would let a
 * truncated or hostile list pass as "these are all the vaults", which is exactly the uniqueness
 * question this function answers.
 */
function vaultPaths(text: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const vaults = isRecord(parsed) ? parsed.vaults : undefined;
  if (!isRecord(vaults)) return null;
  const paths: string[] = [];
  for (const entry of Object.values(vaults)) {
    if (!isRecord(entry)) return null;
    const path = entry.path;
    // A relative path would be resolved against the host's cwd, which is not a folder anyone chose.
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 32768 ||
      !isAbsolute(path) ||
      /[\p{Cc}\p{Cf}]/u.test(path)
    )
      return null;
    paths.push(path);
  }
  return paths;
}

/**
 * The note must resolve inside this vault, through no link, and still be the file the brain read:
 * the relative path is re-checked here because this is the last place before the system open.
 */
async function noteInside(
  vaultPath: string,
  note: { relativePath: string; device: string; inode: string },
  deadline: AbortSignal,
  matchesFileIdentity: MatchIdentity,
): Promise<string> {
  const parts = note.relativePath.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
    !SUPPORTED_NOTE_EXTENSIONS.has(extname(note.relativePath).toLowerCase())
  )
    throw invalid();
  const absolute = join(vaultPath, ...parts);
  // Every folder between the vault and the note has to be a real folder: a link standing in for a
  // folder would make this relative path name a file the brain never read.
  let current = vaultPath;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await stats(current, deadline);
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  }
  const info = await stats(absolute, deadline);
  if (!info.isFile() || info.isSymbolicLink()) throw invalid();
  // A hard link is the same bytes under a second name, so this path is not the only way to reach
  // them and cannot stand for "the note the reply showed".
  if (info.nlink !== 1n) throw invalid();
  if (!matchesFileIdentity(info, note)) throw changed();
  let real: string;
  try {
    real = await bounded(realpath(absolute), deadline);
  } catch {
    if (deadline.aborted) throw deadline.reason;
    throw invalid();
  }
  // `realpath` resolves every link in the path, so a different answer means one of the checks above
  // missed a link component (a junction or a race); the URI or reveal must name this exact path.
  if (real !== absolute) throw invalid();
  return absolute;
}

async function stats(path: string, deadline: AbortSignal) {
  try {
    return await bounded(lstat(path, { bigint: true }), deadline);
  } catch {
    if (deadline.aborted) throw deadline.reason;
    throw changed();
  }
}

/**
 * `lstat` and `realpath` take no AbortSignal, and a stalled network volume can keep them waiting
 * past the click's own deadline. The underlying call is left to finish on its own; what matters is
 * that nothing is opened on behalf of a request that was already cancelled.
 */
function bounded<T>(pending: Promise<T>, deadline: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (deadline.aborted) {
      reject(deadline.reason);
      return;
    }
    const onAbort = () => reject(deadline.reason);
    deadline.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        deadline.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        deadline.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupported(): RpcError {
  return new RpcError(RpcErrorCodes.unsupported, "knowledge_reference_unsupported");
}

function invalid(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_invalid");
}

function changed(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_changed");
}

/** The system call was made; whether it opened is no longer knowable from here. */
function unknown(): RpcError {
  return new RpcError(RpcErrorCodes.internal, "knowledge_reference_unknown");
}
