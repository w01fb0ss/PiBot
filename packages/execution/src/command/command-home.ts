import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { missing } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";

export const commandHomePath = (botHome: string) => join(dirname(botHome), "command-home");
export const commandLogRoot = (botHome: string) => join(dirname(botHome), "command-logs");

export function verifyBotHomeLayout(dataDir: string, home: string) {
  if (basename(home) !== "home" || dirname(dirname(home)) !== join(dataDir, "bots"))
    throw new ExecError("invalid_input");
}

export async function prepareCommandHome(botHome: string) {
  const home = commandHomePath(botHome);
  await mkdir(home, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  if ((await realpath(home)) !== home || !(await lstat(home)).isDirectory())
    throw new ExecError("outside_workplace", "workspace_root_alias");

  // Git reads this before repository config, so user.name/email (including -C and
  // shell cd) still win. Explicit GIT_AUTHOR_* and GIT_COMMITTER_* would override them.
  const gitConfig = join(home, ".gitconfig");
  try {
    await lstat(gitConfig);
  } catch (error) {
    if (!missing(error)) throw error;
    await writeFile(gitConfig, "[user]\n\tname = Pi Bot\n\temail = pibot@users.noreply.local\n", {
      flag: "wx",
      mode: 0o600,
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }
  const config = await lstat(gitConfig);
  if (!config.isFile() || config.nlink !== 1 || (await realpath(gitConfig)) !== gitConfig)
    throw new ExecError("outside_workplace", "workspace_root_alias");
  return home;
}
