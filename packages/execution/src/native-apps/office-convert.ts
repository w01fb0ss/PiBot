import { existsSync, statSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { withDeadline } from "../core/deadline.ts";
import { ExecError } from "../core/types.ts";

export type OfficeConverterCapability = {
  engine: "libreoffice";
  installed: boolean;
  available: false;
  reason:
    | "office_layout_engine_unavailable"
    | "office_layout_isolation_unavailable"
    | "office_layout_platform_unsupported";
};

export const libreOfficePlatformSupported = (platform: NodeJS.Platform) =>
  platform === "darwin" || platform === "linux";

/**
 * Detection reads fixed installation metadata only; it never launches, installs or configures Office.
 * The path lookup is shared with the conversion recipe so a detected engine is the one that runs.
 */
export async function probeOfficeConverter(input: {
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  signal: AbortSignal;
}): Promise<OfficeConverterCapability> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(2_000)]);
  signal.throwIfAborted();
  const installed = await withDeadline(
    findEngine(engineCandidates(input.platform, input.env), signal),
    2_000,
    new ExecError("isolation_unavailable", "timeout"),
    signal,
  );
  return {
    engine: "libreoffice",
    installed: !!installed,
    available: false,
    // Existing exec recipes cannot yet prove NEVER_EXECUTE/NO_UPDATE for native Office import.
    reason: !libreOfficePlatformSupported(input.platform)
      ? "office_layout_platform_unsupported"
      : installed
        ? "office_layout_isolation_unavailable"
        : "office_layout_engine_unavailable",
  };
}

/** Absolute soffice paths, most specific first; never a name the model can supply. */
export function engineCandidates(
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
): string[] {
  if (platform === "darwin") return ["/Applications/LibreOffice.app/Contents/MacOS/soffice"];
  if (platform === "linux") {
    // The documented installers put soffice in a PATH directory; a package may also ship only
    // `libreoffice`, so both names are resolved from PATH before the fixed fallbacks.
    const names = ["soffice", "libreoffice"];
    const entries = (env.PATH ?? "")
      .split(":")
      .map((entry) => entry.trim())
      .filter((entry) => posix.isAbsolute(entry) && !/[\0\r\n]/.test(entry));
    return [
      ...new Set([
        ...entries.flatMap((entry) => names.map((name) => posix.join(entry, name))),
        "/usr/bin/libreoffice",
        "/usr/bin/soffice",
        "/usr/local/bin/libreoffice",
      ]),
    ];
  }
  if (platform === "win32")
    return [
      ...new Set(
        [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(
          (root): root is string =>
            !!root &&
            win32.isAbsolute(root) &&
            /^[A-Za-z]:[\\/]/.test(root) &&
            !/[\0\r\n]/.test(root),
        ),
      ),
    ].map((root) => win32.join(root, "LibreOffice", "program", "soffice.exe"));
  return [];
}

/** Policy runs synchronously, so it needs the same lookup without a signal or deadline. */
export function libreOfficeInstalled(
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
): boolean {
  return engineCandidates(platform, env).some((path) => {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      // Unreadable installation metadata means "not installed" for the recipe and the policy card.
      return false;
    }
  });
}

export async function findEngine(
  paths: string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  for (const path of paths) {
    signal.throwIfAborted();
    try {
      const canonical = await realpath(path);
      const stat = await lstat(canonical);
      signal.throwIfAborted();
      if (stat.isFile()) return canonical;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
        throw error;
      // Missing or unreadable installation metadata is an unavailable engine, never a launch fallback.
    }
  }
  return undefined;
}
