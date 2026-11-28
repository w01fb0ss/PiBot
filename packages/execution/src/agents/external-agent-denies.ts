// Security review: what an external agent must never write or read even inside the folders
// it may use. A file the agent writes there that another program later runs outside any sandbox
// (a Git hook, an agent hook or permission file, an OpenCode plugin) would be a sandbox escape.
import { realpathSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";

/**
 * Home-relative files and folders that configure code the agent's own program runs later (hooks,
 * permission rules, plugins, custom commands). They sit inside an agent's opened config folder,
 * so they are write-denied there; logins, sessions and caches stay writable. Owner-visible risk:
 * an agent that needs to rewrite one of these itself (Claude settings on a permission change,
 * Codex config on a trust prompt) fails that one write instead.
 */
export const HOME_HOOK_PATHS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks",
  ".claude/commands",
  ".claude/agents",
  ".claude/plugins",
  ".claude/skills",
  ".codex/config.toml",
  ".codex/rules",
  ".cursor/hooks.json",
  ".config/opencode/opencode.json",
  ".config/opencode/opencode.jsonc",
  ".config/opencode/plugin",
  ".config/opencode/plugins",
  // Antigravity's trusted workspaces (a folder trusted there runs without its trust prompt).
  ".gemini/antigravity-cli/settings.json",
] as const;

/**
 * Antigravity's workspace customization roots (`.agents`, or `.agent`, `_agents`, `_agent`) and the
 * files in them that start programs: lifecycle hooks, MCP servers, plugins and plugin lists.
 */
const ANTIGRAVITY_PROJECT_PATHS = [".agents", ".agent", "_agents", "_agent"].flatMap((root) =>
  ["hooks.json", "mcp_config.json", "plugins", "plugins.json"].map((name) => `${root}/${name}`),
);

/** The same kinds of files in a project folder, which the agent's program reads from its cwd. */
export const PROJECT_HOOK_PATHS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks",
  ".codex/config.toml",
  ".cursor/hooks.json",
  ".cursor/cli.json",
  ".opencode/plugin",
  ".opencode/plugins",
  "opencode.json",
  "opencode.jsonc",
  ...ANTIGRAVITY_PROJECT_PATHS,
] as const;

const exists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch {
    // Absent: macOS still denies the name; Linux leaves it (see hookDenies).
    return false;
  }
};

/**
 * Write denies for hook-capable files. macOS Seatbelt denies a name that does not exist yet.
 * Linux bubblewrap plants a placeholder for a missing deny path: accepted in the topic folder
 * (SRT does the same for its own dangerous names there and Pi Bot hides those), but not in the
 * user's own agent config folder, so missing home entries stay undenied on Linux (a known
 * residual risk).
 */
export async function hookDenies(
  platform: NodeJS.Platform,
  home: string,
  openedHome: readonly string[],
  roots: readonly string[],
) {
  const homeCandidates = HOME_HOOK_PATHS.map((path) => join(home, ...path.split("/"))).filter(
    (path) => openedHome.some((opened) => within(opened, path)),
  );
  const project = roots.flatMap((root) =>
    PROJECT_HOOK_PATHS.map((path) => join(root, ...path.split("/"))),
  );
  if (platform === "darwin") return [...homeCandidates, ...project];
  await projectParents(roots);
  const present = await Promise.all(homeCandidates.map(exists));
  return [...homeCandidates.filter((_, index) => present[index]), ...project];
}

/**
 * Linux: bubblewrap mounts a placeholder for a missing deny path and creates its missing parents
 * read-only, so a denied `.opencode/plugins` made `.opencode` itself uncreatable and OpenCode
 * exited before initialize (kali, 2026-11-14). The agent folders those paths sit in (`.claude`,
 * `.codex`, `.cursor`, `.opencode`, Antigravity's `.agents` and its variants) are created empty
 * in each topic folder first: the folder stays writable, the hook and plugin names inside it stay
 * denied. A name that already exists as anything but a real folder (a planted symlink) refuses
 * the start.
 */
async function projectParents(roots: readonly string[]) {
  const parents = [
    ...new Set(
      PROJECT_HOOK_PATHS.filter((path) => path.includes("/")).map((path) => path.split("/")[0]),
    ),
  ] as string[];
  for (const root of roots)
    for (const name of parents) {
      const folder = join(root, name);
      await mkdir(folder, { recursive: true });
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ExecError("outside_workplace", "workspace_root_alias");
    }
}

/**
 * The native keychain module shipped with Pi Bot (`@napi-rs/keyring`). An agent may read the
 * login keychain file and can start Pi Bot's own executable as Node; loading this module there
 * would ask the keychain as Pi Bot. Its folders are made unreadable for every agent.
 */
export function keyringModuleRoots(): string[] {
  const roots: string[] = [];
  const unpacked = (path: string) =>
    path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  try {
    const require = createRequire(import.meta.url);
    const main = dirname(require.resolve("@napi-rs/keyring/package.json"));
    roots.push(unpacked(main));
    const suffix =
      process.platform === "linux" ? "-gnu" : process.platform === "win32" ? "-msvc" : "";
    const native = `@napi-rs/keyring-${process.platform}-${process.arch}${suffix}`;
    roots.push(
      unpacked(
        dirname(createRequire(join(main, "package.json")).resolve(`${native}/package.json`)),
      ),
    );
  } catch {
    // Not installed in this build (or not for this platform): nothing to hide.
  }
  return [
    ...new Set(
      roots.flatMap((root) => {
        try {
          return [root, realpathSync(root)];
        } catch {
          return [root];
        }
      }),
    ),
  ];
}
