import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  BackgroundStartOptions,
  CommandDiagnostic,
  ExecOptions,
  RunCommandOptions,
} from "../core/types.ts";
import { ExecError } from "../core/types.ts";
import { dockerArguments, verifyDockerConnection } from "../docker/docker.ts";
import { dockerProgram } from "../docker/docker-program.ts";
import { findGit } from "../git/git-process.ts";
import type { createSandboxProfiles } from "../sandbox/sandbox-profiles.ts";
import type { NetworkProxy } from "../web/network-proxy.ts";
import type { BackgroundProcessRecord, createBackgroundJobs } from "./background.ts";
import { commandLogRoot, prepareCommandHome, verifyBotHomeLayout } from "./command-home.ts";
import type { createCommandTemps } from "./command-temp.ts";
import { commandEnvironment, userTerminalEnvironment } from "./environment.ts";
import { preparePackageManagerEnvironment } from "./package-manager-environment.ts";
import { mergeSecretEnv } from "./secret-env.ts";
import {
  SKILL_NODE_DOMAINS,
  SKILL_PYTHON_MIRROR,
  skillNodeDirectory,
  skillPythonDomains,
  skillPythonPaths,
  skillPythonWriteRoots,
} from "./skill-python.ts";

export interface CommandDependencies {
  options: ExecOptions;
  sandbox: ReturnType<typeof createSandboxProfiles>;
  temps: ReturnType<typeof createCommandTemps>;
  /** The sandbox's own denial reports, per command (macOS; others report nothing). */
  violations: import("../sandbox/violation-monitor.ts").ViolationMonitor;
  background: ReturnType<typeof createBackgroundJobs>;
  lifetime: AbortController;
  /** `record` carries the failed foreground command's own tree when no job is involved. */
  failDrain(
    error: ExecError,
    jobId?: string,
    record?: BackgroundProcessRecord,
    runId?: string,
  ): void;
  drainFailed(runId: string): boolean;
  retainCommand(work: Promise<unknown>, runId: string): void;
  waitForForegroundCleanup(
    error: unknown,
    runId: string,
    record?: BackgroundProcessRecord,
  ): Promise<void> | undefined;
  adoptForeground(job: import("./background.ts").BackgroundJob): void;
}
export interface CommandStage {
  stage: CommandDiagnostic["stage"];
}
type Input = RunCommandOptions | BackgroundStartOptions;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function invalidBoundary(input: Input, id: string) {
  return (
    !input.command ||
    input.command.includes("\0") ||
    !UUID.test(id) ||
    !isAbsolute(input.cwd) ||
    !isAbsolute(input.dataDir) ||
    !isAbsolute(input.botHome) ||
    (input.skillGroupId !== undefined && !UUID.test(input.skillGroupId)) ||
    (input.homeDir !== undefined && !isAbsolute(input.homeDir)) ||
    input.writeRoots.some((root) => !isAbsolute(root)) ||
    input.denyWriteRoots?.some((root) => !isAbsolute(root))
  );
}
export async function commandIsolation(
  deps: CommandDependencies,
  input: Input,
  signal: AbortSignal,
  state: CommandStage,
) {
  const { options, sandbox } = deps;
  if (input.skillNodePreparation) {
    const dir = skillNodeDirectory(input.dataDir, input.skillNodePreparation.envId);
    const windowsConfirmed =
      options.platform === "win32" && input.skillNodePreparation.windowsConfirmed;
    const validNetwork = windowsConfirmed
      ? input.allowUnisolated && input.network.allowAll && input.network.domains.length === 0
      : !input.allowUnisolated &&
        !input.network.allowAll &&
        input.network.domains.length === 1 &&
        input.network.domains[0] === SKILL_NODE_DOMAINS[0];
    if (
      !validNetwork ||
      input.cwd !== dir ||
      input.writeRoots.length !== 1 ||
      input.writeRoots[0] !== dir ||
      input.docker ||
      input.outsideSandbox ||
      input.promotion ||
      input.gitHook ||
      input.gitOutput ||
      input.hostSsh ||
      input.skillEnv ||
      input.secretEnv ||
      input.skillPythonPreparation
    )
      throw new ExecError("invalid_input");
  }
  if (input.skillPythonPreparation) {
    const paths = skillPythonPaths(input.dataDir, input.skillPythonPreparation);
    const expected = skillPythonWriteRoots(paths, input.skillPythonPreparation.phase);
    const domains = skillPythonDomains(input.skillPythonPreparation.useMirror);
    const windowsConfirmed =
      options.platform === "win32" && input.skillPythonPreparation.windowsConfirmed === true;
    const validNetwork = windowsConfirmed
      ? input.allowUnisolated && input.network.allowAll && input.network.domains.length === 0
      : !input.allowUnisolated &&
        !input.network.allowAll &&
        input.network.domains.length === domains.length &&
        domains.every((host) => input.network.domains.includes(host));
    if (
      input.docker ||
      !validNetwork ||
      input.outsideSandbox ||
      input.promotion ||
      input.gitHook ||
      input.gitOutput ||
      input.hostSsh ||
      input.skillEnv ||
      input.secretEnv ||
      input.cwd !== paths.env ||
      input.writeRoots.length !== expected.length ||
      !expected.every((path) => input.writeRoots.includes(path))
    )
      throw new ExecError("invalid_input");
  }

  if (
    (input.denyWriteRoots?.length || input.rootIdentities?.some((r) => r.role === "readonly")) &&
    (options.platform !== "darwin" || input.docker)
  )
    throw new ExecError("isolation_unavailable");
  state.stage = "isolation";
  const isolation = await sandbox.isolationStatus(signal);
  signal.throwIfAborted();
  if (
    !input.docker &&
    !isolation.available &&
    (isolation.reason !== "windows_unisolated" ||
      !input.allowUnisolated ||
      !input.network.allowAll ||
      input.denyWriteRoots?.length ||
      input.rootIdentities?.some((r) => r.role === "readonly"))
  )
    throw new ExecError("isolation_unavailable");
  // An unisolated command sees Pi Bot's proxy only through environment variables, and a proxy's
  // username and password never go into a command's environment.
  if (!input.docker && !isolation.available && proxyCredentials(options.proxy?.()))
    throw new ExecError("isolation_unavailable", "windows_proxy_credentials");
  if (input.docker) {
    if ((options.platform === "darwin" && !isolation.available) || !input.assertDockerAuthorized)
      throw new ExecError("docker_unsupported");
    input.assertDockerAuthorized();
    await verifyDockerConnection(options.platform, options.systemHome, input.docker);
  }
  return isolation;
}
/** Bare ESM imports normally ignore NODE_PATH. Fall back to this skill's managed packages. */
const skillNodeImports = Buffer.from(`
  import { registerHooks } from "node:module";
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  const parentURL = pathToFileURL(join(process.env.NODE_PATH, "..", "package.json")).href;
  registerHooks({
    resolve(name, context, next) {
      try {
        return next(name, context);
      } catch (error) {
        if (error.code !== "ERR_MODULE_NOT_FOUND" ||
            !/^(?:@[a-z0-9._-]+\\/[a-z0-9._-]+|[a-z0-9_][a-z0-9._-]*)(?:\\/|$)/i.test(name))
          throw error;
        return next(name, { ...context, parentURL });
      }
    },
  });
`).toString("base64");
export async function commandResources(
  deps: CommandDependencies,
  input: Input,
  temp: string,
  signal: AbortSignal,
) {
  const { options } = deps;
  const cwd = await realpath(input.cwd),
    home = await realpath(input.botHome);
  verifyBotHomeLayout(await realpath(input.dataDir), home);
  if (input.homeDir && (await realpath(input.homeDir)) !== home)
    throw new ExecError("invalid_input");
  // Only an issued permit leads to an unsandboxed spawn (command-run consumes it first).
  const outside = "outsideSandbox" in input && input.outsideSandbox !== undefined;
  const commandHome = outside ? undefined : await prepareCommandHome(home);
  // Windows packages unpack their MinGit on first need (bundled-git.ts). A command that names Git
  // waits for it so `git` resolves on its PATH; any other command only starts the unpack.
  if (options.platform === "win32" && !input.docker) {
    const unpack = findGit(options);
    if (/\bgit\b/i.test(input.command))
      await new Promise<void>((resolve, reject) => {
        const stop = () => reject(signal.reason);
        if (signal.aborted) stop();
        signal.addEventListener("abort", stop, { once: true });
        // findGit settles undefined on any failure; the command then runs without bundled Git.
        void unpack.then(() => {
          signal.removeEventListener("abort", stop);
          resolve();
        });
      });
  }
  const env = mergeSecretEnv(
    outside
      ? userTerminalEnvironment(
          options.platform,
          options.env,
          options.systemHome,
          temp,
          input.pathEntries,
          options.resourcesDir,
        )
      : commandEnvironment(
          options.platform,
          options.env,
          commandHome ?? home,
          temp,
          input.pathEntries,
          options.resourcesDir,
        ),
    input.secretEnv,
  );
  if (commandHome) {
    env.GIT_CONFIG_GLOBAL = join(commandHome, ".gitconfig");
    if (options.platform === "win32") {
      env.APPDATA = join(commandHome, "AppData", "Roaming");
      env.LOCALAPPDATA = join(commandHome, "AppData", "Local");
    }
  }
  // Keep the selected skill's interpreter first on PATH even when the cwd is the workplace.
  if (input.skillEnv) {
    const { dir, sourceDir, bin, python, node } = input.skillEnv;
    env.PIBOT_SKILL_DIR = sourceDir ? await realpath(sourceDir) : dir;
    if (python) env.PIBOT_SKILL_PYTHON = python;
    if (node) {
      env.PIBOT_SKILL_NODE = node;
      env.NODE_PATH = join(dir, "node_modules");
      env.NODE_OPTIONS = `--import=data:text/javascript;base64,${skillNodeImports}`;
    }
    const prefix = join(dir, ...bin.split("/"));
    env.PATH = [node && dirname(node), prefix, env.PATH]
      .filter((part) => part !== undefined && part !== "")
      .join(options.platform === "win32" ? ";" : ":");
  }
  // Maintainers 2026-11-19: Windows commands run unisolated, so Pi Bot's proxy reaches them through
  // the variables tools read instead of the sandbox's network host. Local addresses stay direct.
  if (options.platform === "win32" && !input.docker)
    windowsProxyEnvironment(env, options.proxy?.());
  await preparePackageManagerEnvironment(
    options.platform,
    env,
    cwd,
    temp,
    signal,
    input.writeRoots,
    options.systemHome,
    !outside,
  );
  if (input.skillNodePreparation) {
    env.npm_config_cache = join(temp, "npm-cache");
    env.npm_config_registry = `https://${SKILL_NODE_DOMAINS[0]}/`;
    env.npm_config_userconfig = join(temp, "npm-user.npmrc");
    env.npm_config_globalconfig = join(temp, "npm-global.npmrc");
    env.npm_config_manage_package_manager_versions = "false";
  }
  if (input.skillPythonPreparation) {
    const paths = skillPythonPaths(input.dataDir, input.skillPythonPreparation);
    Object.assign(env, {
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_PYTHON_INSTALL_DIR: paths.python,
      UV_CACHE_DIR: paths.cache,
      UV_NO_CONFIG: "1",
      UV_NO_PROGRESS: "1",
      UV_PYTHON_NO_REGISTRY: "1",
      ...(input.skillPythonPreparation.useMirror
        ? {
            UV_PYTHON_INSTALL_MIRROR: `https://${SKILL_PYTHON_MIRROR}/github/python-build-standalone/releases/download`,
          }
        : {}),
    });
  }
  return { cwd, home, temp, env, commandHome };
}
export type CommandResources = Awaited<ReturnType<typeof commandResources>>;
export async function dockerResources(
  deps: CommandDependencies,
  input: RunCommandOptions,
  resources: CommandResources,
  signal: AbortSignal,
) {
  if (!input.docker) return undefined;
  const { options } = deps;
  const { env, temp } = resources;
  env.DOCKER_CONFIG = await mkdtemp(join(temp, "docker-config-"));
  env.DOCKER_HOST = input.docker.endpoint;
  const plugins = [join(options.systemHome, ".docker", "cli-plugins")];
  if (options.platform === "darwin")
    plugins.push(
      "/Applications/Docker.app/Contents/Resources/cli-plugins",
      "/Applications/OrbStack.app/Contents/MacOS/xbin",
    );
  await writeFile(
    join(env.DOCKER_CONFIG, "config.json"),
    JSON.stringify({ cliPluginsExtraDirs: plugins }),
    { flag: "wx", mode: 0o600 },
  );
  const args = dockerArguments(input.command, options.platform);
  const program = await dockerProgram(
    options.platform,
    options.env,
    [...input.writeRoots, temp],
    signal,
  );
  return { program, args };
}
export async function commandLog(home: string, directory: "runs" | "background", id: string) {
  const base = commandLogRoot(home);
  const root = join(base, directory);
  for (const path of [base, root]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await realpath(path)) !== resolve(path))
      throw new ExecError("outside_workplace", "workspace_root_alias");
  }
  return join(root, `${id}.log`);
}
export function openCommandLog(path: string) {
  return open(
    path,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
}
export const tempCommand = (command: string, temp: string) =>
  `export TMPDIR='${temp.replaceAll("'", "'\\''")}'\n${command}`;

function proxyCredentials(proxy: NetworkProxy | undefined) {
  if (!proxy) return false;
  const url = new URL(proxy.url);
  return url.username !== "" || url.password !== "";
}

/** Windows environment names are case-insensitive, so only the upper-case spelling is set. */
function windowsProxyEnvironment(env: NodeJS.ProcessEnv, proxy: NetworkProxy | undefined) {
  if (!proxy || proxyCredentials(proxy)) return;
  const value = new URL(proxy.url).href.replace(/\/$/, "");
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) env[name] = value;
  env.NO_PROXY = "localhost,127.0.0.1,::1";
}
