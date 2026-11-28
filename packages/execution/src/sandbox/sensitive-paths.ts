import { basename, dirname, isAbsolute, join } from "node:path";
import { commandHomePath, verifyBotHomeLayout } from "../command/command-home.ts";
import { skillNodeDirectory, skillPythonPaths } from "../command/skill-python.ts";
import { createDenyTargetResolver, within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { aiConfigReadBoundary } from "./ai-config-paths.ts";
import { profilePath, profileRoot } from "./profile-paths.ts";

const common = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gcloud",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".pi",
  // More credential stores and histories that commonly hold tokens.
  ".config/gh",
  ".config/git/credentials",
  ".config/github-copilot",
  ".config/op",
  ".claude.json",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".terraform.d",
  ".vault-token",
  ".yarnrc.yml",
  ".m2/settings.xml",
  ".ollama",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".local/share/fish/fish_history",
] as const;

const HISTORIES = new Set<string>([
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".local/share/fish/fish_history",
]);

/**
 * The protected reads a command-line tool makes for its own login or configuration
 * (`aws` → ~/.aws, `gh` → ~/.config/gh). Blocking them makes the tool report "not logged in", so
 * they are told apart from other protected reads (browser profiles, Pi Bot data, histories).
 */
export const CREDENTIAL_STORES: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: [...common.filter((entry) => !HISTORIES.has(entry)), "Library/Keychains"],
  linux: [...common.filter((entry) => !HISTORIES.has(entry)), ".local/share/keyrings"],
  win32: [...common.filter((entry) => !HISTORIES.has(entry)), "AppData/Roaming/gcloud"],
};

/** Relative segments are data, not shell/glob patterns; adapters resolve both names and targets. */
export const SENSITIVE_PATHS = {
  darwin: [
    ...common,
    "Library/Keychains",
    "Library/Cookies",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Google/Chrome Beta",
    "Library/Application Support/Google/Chrome Canary",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Vivaldi",
    "Library/Thunderbird",
    "Library/Application Support/Chromium",
    "Library/Safari",
    "Library/Containers/com.apple.Safari",
    "Library/Group Containers/group.com.apple.Safari",
    "Library/Application Support/Firefox",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Arc",
  ],
  linux: [
    ...common,
    ".local/share/keyrings",
    ".config/google-chrome",
    ".config/google-chrome-beta",
    ".config/google-chrome-unstable",
    ".config/chromium",
    ".config/microsoft-edge",
    ".config/microsoft-edge-beta",
    ".config/microsoft-edge-dev",
    ".mozilla/firefox",
    ".config/BraveSoftware",
    ".config/vivaldi",
    ".thunderbird",
    "snap/firefox/common/.mozilla",
    "snap/chromium/common/chromium",
    ".var/app/org.mozilla.firefox",
    ".var/app/com.google.Chrome",
    ".var/app/com.brave.Browser",
    ".var/app/org.chromium.Chromium",
  ],
  win32: [
    ...common,
    "AppData/Roaming/gcloud",
    "AppData/Local/Google/Chrome",
    "AppData/Local/Chromium",
    "AppData/Roaming/Mozilla/Firefox",
    "AppData/Local/Microsoft/Edge",
    "AppData/Local/Arc",
    "AppData/Local/Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4",
    "AppData/Local/Apple Computer/Safari",
    "AppData/Roaming/Apple Computer/Safari",
    "AppData/Local/BraveSoftware",
    "AppData/Local/Vivaldi",
    "AppData/Roaming/Thunderbird",
  ],
} as const;

export interface BotReadContext {
  dataDir: string;
  botHome: string;
  commandHome?: boolean;
  skillGroupId?: string;
  skillPackageIds?: readonly string[];
  /** Prepared skill runtimes readable (and executable) but never writable. */
  skillEnvIds?: readonly string[];
  managedSkillPython?: boolean;
  skillPythonPreparation?: Parameters<typeof skillPythonPaths>[1];
  skillNodePreparation?: string;
}

/** A fixed recipe may protect app data without inheriting the Bot's app-data read grants. */
export type SandboxReadContext = BotReadContext | { dataDir: string; botHome?: never };

export async function sensitiveReadBoundary(
  platform: NodeJS.Platform,
  homes: string[],
  env: Readonly<NodeJS.ProcessEnv>,
  context?: SandboxReadContext,
) {
  const entries = SENSITIVE_PATHS[platform as keyof typeof SENSITIVE_PATHS] ?? common;
  const resolveDenyTargets = createDenyTargetResolver();
  const names = homes.flatMap((home) => entries.map((entry) => join(home, ...entry.split("/"))));
  const extra = (key: string, paths: string[]) => {
    const root = Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1];
    if (root && isAbsolute(root))
      names.push(...paths.map((path) => join(root, ...path.split("/"))));
  };
  if (platform === "win32") {
    extra("APPDATA", ["gcloud", "Mozilla/Firefox", "Apple Computer/Safari"]);
    extra("LOCALAPPDATA", [
      "Google/Chrome",
      "Chromium",
      "Microsoft/Edge",
      "Arc",
      "Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4",
      "Apple Computer/Safari",
    ]);
  }
  if (platform === "linux") {
    extra("XDG_CONFIG_HOME", [
      "gcloud",
      "google-chrome",
      "google-chrome-beta",
      "google-chrome-unstable",
      "chromium",
      "microsoft-edge",
      "microsoft-edge-beta",
      "microsoft-edge-dev",
      "BraveSoftware",
      "vivaldi",
      "gh",
      "git/credentials",
      "github-copilot",
      "op",
    ]);
    extra("XDG_DATA_HOME", ["keyrings", "fish/fish_history"]);
  }
  const [aiConfig, credentialTargets] = await Promise.all([
    aiConfigReadBoundary(platform, homes, env, resolveDenyTargets),
    Promise.all([...new Set(names)].map(resolveDenyTargets)),
  ]);
  const protectedRoots = [...new Set(credentialTargets.flat())];
  const credentialReadRoots = [...protectedRoots];
  protectedRoots.push(...aiConfig.roots.filter((path) => !protectedRoots.includes(path)));
  const dataRoot = context ? await profileRoot(context.dataDir, "profile_data_root") : undefined;
  const allowRead: string[] = [];
  const readOnly: string[] = [];
  if (dataRoot && context?.botHome !== undefined) {
    const bot = context;
    const home = await profileRoot(bot.botHome, "profile_bot_home");
    verifyBotHomeLayout(dataRoot, home);
    const sibling = async (name: "skills" | "attachments") => {
      const lexical = join(dirname(home), name);
      return profilePath(
        lexical,
        dirname(home),
        name === "skills" ? "profile_bot_skills" : "profile_bot_attachments",
      );
    };
    if (bot.skillPythonPreparation) {
      // A trusted preparation needs no skill/attachment/group read grants. Checking those
      // unrelated trees can reject a valid managed recipe before uv ever starts.
      const paths = skillPythonPaths(dataRoot, bot.skillPythonPreparation);
      const uv = await profilePath(paths.uv, dataRoot, "profile_uv_binary");
      allowRead.push(
        home,
        uv,
        await profilePath(paths.env, dataRoot, "profile_python_env"),
        await profilePath(paths.python, dataRoot, "profile_managed_python"),
        await profilePath(paths.cache, dataRoot, "profile_uv_cache"),
      );
      readOnly.push(uv);
      if (bot.skillPythonPreparation.phase !== "create") readOnly.push(paths.python, paths.cache);
      if (bot.skillPythonPreparation.phase === "verify") readOnly.push(paths.env);
    } else if (bot.skillNodePreparation) {
      allowRead.push(
        home,
        await profilePath(
          skillNodeDirectory(dataRoot, bot.skillNodePreparation),
          dataRoot,
          "profile_skill_env",
        ),
      );
    } else {
      // Skill packages ship scripts the Bot runs with run_command, so the Bot's own skills
      // folder is readable inside the sandbox, but never writable: skills change only through the app.
      let skills = await sibling("skills");
      if (bot.skillGroupId !== undefined) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            bot.skillGroupId,
          )
        )
          throw new ExecError("invalid_input");
        const lexical = join(
          dataRoot,
          "groups",
          bot.skillGroupId,
          "bots",
          basename(dirname(home)),
          "skills",
        );
        skills = await profilePath(lexical, dataRoot, "profile_group_skills");
        const groupHome = join(dataRoot, "groups", bot.skillGroupId, "home");
        await profilePath(groupHome, dataRoot, "profile_group_home");
        // This exact group's home is shared; databases, sessions and other groups stay denied.
        allowRead.push(groupHome);
      }
      if (
        bot.skillPackageIds &&
        (bot.skillPackageIds.length > 100 ||
          bot.skillPackageIds.some((id) => !/^[0-9a-f]{16}$/.test(id)))
      )
        throw new ExecError("invalid_input");
      for (const id of new Set(bot.skillPackageIds ?? [])) {
        const lexical = join(dataRoot, "skill-packages", id);
        const canonical = await profilePath(lexical, dataRoot, "profile_skill_package");
        allowRead.push(canonical);
        readOnly.push(canonical);
      }
      if (
        bot.skillEnvIds &&
        (bot.skillEnvIds.length > 2 || bot.skillEnvIds.some((id) => !/^[a-f0-9]{16}$/.test(id)))
      )
        throw new ExecError("invalid_input");
      for (const id of new Set(bot.skillEnvIds ?? [])) {
        const lexical = join(dataRoot, "skill-envs", id);
        const canonical = await profilePath(lexical, dataRoot, "profile_skill_env");
        allowRead.push(canonical);
        readOnly.push(canonical);
      }
      if (bot.managedSkillPython) {
        const python = await profilePath(
          join(dataRoot, "runtimes", "python"),
          dataRoot,
          "profile_managed_python",
        );
        allowRead.push(python);
        readOnly.push(python);
      }
      allowRead.push(home, await sibling("attachments"), skills);
      readOnly.push(skills);
    }
    if (bot.commandHome) {
      const commandHome = await profileRoot(commandHomePath(home), "profile_bot_home");
      allowRead.push(commandHome);
    }
    if (allowRead.some((path) => protectedRoots.some((root) => within(root, path))))
      throw new ExecError("invalid_input");
  }
  return {
    denyRead: [...protectedRoots, ...(dataRoot ? [dataRoot] : [])],
    /** Direct AI-config reads may ask, but cannot bypass overlapping credential roots. */
    credentialReadRoots,
    aiConfigReadBoundary: aiConfig,
    denyReadGlobs: aiConfig.globs,
    allowRead,
    /** Readable folders a write root may contain; the sandbox adds them as write denies. */
    readOnly,
    // Linux bind mounts for a write root also restore reads. Never restore protected regions.
    permitsWriteRoot(path: string) {
      if (protectedRoots.some((root) => within(root, path))) return false;
      if (readOnly.some((root) => within(root, path))) return false;
      return !dataRoot || !within(dataRoot, path) || allowRead.some((root) => within(root, path));
    },
  };
}
