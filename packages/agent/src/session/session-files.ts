import { isAbsolute, join, relative, sep } from "node:path";
import { AgentError } from "../core/errors.ts";

/**
 * Session files are stored relative to the data directory (`bots/<botId>/sessions/<file>`,
 * always `/`-separated) so restoring a backup, moving to another computer or opening the data
 * directory through a different (symlinked) spelling keeps old sessions usable.
 */
const STORED = /^bots\/([^/\\\0\r\n]+)\/sessions\/([^/\\\0\r\n]+)$/;

/** The stored form of a session file that lives in this data directory. */
export function storedSessionFile(dataDir: string, file: string): string {
  const path = relative(dataDir, file).split(sep).join("/");
  if (!STORED.test(path) || path.split("/").some((part) => part === "." || part === ".."))
    throw new AgentError("internal");
  return path;
}

/**
 * The absolute file for a stored value. Relative values are joined to this data directory;
 * absolute values are legacy rows the migration could not recognise and are returned unchanged
 * for the caller's own containment check.
 */
export function resolveSessionFile(dataDir: string, stored: string): string {
  if (isAbsolute(stored)) {
    // A legacy absolute row that names another copy of a data directory (moved, restored or
    // copied) points at this directory's own session of the same Bot and file name.
    const tail = /[/\\](bots[/\\][^/\\\0\r\n]+[/\\]sessions[/\\][^/\\\0\r\n]+)$/.exec(stored)?.[1];
    const local = tail?.split(/[/\\]/).join("/");
    if (
      local &&
      STORED.test(local) &&
      !local.split("/").some((part) => part === "." || part === "..")
    )
      return join(dataDir, ...local.split("/"));
    return stored;
  }
  const match = STORED.exec(stored);
  if (!match || stored.split("/").some((part) => part === "." || part === ".."))
    throw new AgentError("internal");
  return join(dataDir, "bots", match[1] as string, "sessions", match[2] as string);
}
