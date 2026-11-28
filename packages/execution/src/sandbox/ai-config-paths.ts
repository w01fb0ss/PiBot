import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { denyTargets } from "../core/paths.ts";

const common = [".claude", ".codex", ".cursor", ".gemini", ".config/opencode", ".continue"];

/** User configuration roots, never project-scoped files with a similar name. */
export async function aiConfigReadBoundary(
  platform: NodeJS.Platform,
  homes: string[],
  env: Readonly<NodeJS.ProcessEnv>,
  resolveDenyTargets = denyTargets,
) {
  const names = new Set<string>();
  const globs = new Set<string>();
  for (const home of new Set(homes)) {
    for (const entry of common) names.add(join(home, ...entry.split("/")));
    if (platform === "darwin") names.add(join(home, "Library", "Application Support", "Claude"));
    if (platform === "win32") names.add(join(home, "AppData", "Roaming", "Claude"));
    // SRT globs also protect a .aider* file created after the command sandbox was prepared.
    globs.add(join(home, ".aider*"));
    try {
      for (const entry of await readdir(home))
        if (entry.toLowerCase().startsWith(".aider")) names.add(join(home, entry));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const variable = (name: string) =>
    Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const appdata = variable("APPDATA");
  if (platform === "win32" && appdata && isAbsolute(appdata)) names.add(join(appdata, "Claude"));
  const xdg = variable("XDG_CONFIG_HOME");
  if (platform !== "win32" && xdg && isAbsolute(xdg)) names.add(join(xdg, "opencode"));
  const roots = [
    ...new Set((await Promise.all([...names].map((path) => resolveDenyTargets(path)))).flat()),
  ];
  return { roots, globs: [...globs] };
}
