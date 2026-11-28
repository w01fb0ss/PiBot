import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";

/**
 * External agents get their temp folder here, not under the brain's temp root: tools such as
 * Claude Code put Unix sockets below TMPDIR and want it ~30 bytes long (sockets are capped at
 * ~104), and SRT otherwise hands the agent TMPDIR=/tmp/claude, a folder shared by every sandbox.
 * One parent per user: every sandbox hides it, each agent gets back only its own child.
 */
export async function agentTempParent() {
  const parent = join(await realpath("/tmp"), `pibot-a${process.getuid?.() ?? "u"}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    // Not a private directory of this user: someone else could watch or plant files there.
    throw new ExecError("isolation_unavailable", "isolation_start_failed");
  return parent;
}

/** A fresh private temp folder for one external agent process; the caller removes it. */
export async function agentTempDir() {
  return mkdtemp(join(await agentTempParent(), "t"));
}

/** Hide the shared namespace, including directories another run creates after profile generation. */
export async function commandTempBoundary(
  temp: string,
  own: string | undefined,
  platform: NodeJS.Platform,
  roots: readonly string[] = [],
  runtimeReadRoots: readonly string[] = [],
) {
  const parents = [...new Set([await realpath(tmpdir()), await realpath(temp)])];
  // This path comes only from the resolved bundled seccomp helper, never from a tool request.
  const runtimes = await Promise.all(
    runtimeReadRoots.map(async (root) => realpath(root).catch(() => undefined)),
  );
  const runtimeRoots = runtimes.filter((root): root is string => root !== undefined);
  if (runtimeRoots.some((root) => parents.some((parent) => parent === root)))
    throw new ExecError("isolation_unavailable", "seccomp_helper_unavailable");
  const projectRoots = [...roots, ...(platform === "linux" ? runtimeRoots : [])].filter((root) =>
    parents.some((parent) => within(parent, root) && parent !== root),
  );
  // A selected project in OS temp is still readable, but cannot re-open another run's namespace.
  for (const root of projectRoots)
    for (const parent of parents)
      if (
        within(parent, root) &&
        /^(?:pibot-(?:run|job)-|office-convert-[A-Za-z0-9]{6}$)/.test(
          relative(parent, root).split(/[\\/]/)[0] ?? "",
        ) &&
        !(own && within(own, root))
      )
        throw new ExecError("outside_workplace", "profile_temp_namespace");
  const hidden = platform === "win32" ? parents : [...parents, await agentTempParent()];
  return {
    denyRead: hidden.map((path) => ({ path, literal: true as const })),
    allowRead: [
      ...projectRoots.filter((root) => !parents.some((parent) => within(root, parent))),
      ...(own ? [await realpath(own)] : []),
      // Linux bubblewrap replaces /tmp with a private namespace. Packaged helpers may live
      // under /tmp when an AppImage is extracted, so explicitly bind their real paths read-only.
      ...runtimeRoots,
    ].map((path) => ({ path, literal: true as const })),
    // The fallback socket root is outside temp on long data-directory paths.
    denyWrite: platform === "win32" ? [] : [join(await realpath("/tmp"), "pibot-srt-*")],
  };
}
