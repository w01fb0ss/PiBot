import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

/** JVMs parse this variable themselves, including quoted paths containing spaces. */
function javaProperty(name: string, value: string) {
  if (/["\r\n\0]/.test(value)) throw new Error("command_temp_changed");
  return `"-D${name}=${value}"`;
}

/** Cache and lock roots belong to the same run; none of these settings grant filesystem access. */
export async function prepareToolEnvironment(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  temp: string,
  systemHome: string,
  signal: AbortSignal,
) {
  const state = join(temp, "tool-state");
  const runtime = join(state, "runtime");
  // The owner creates these before the first command. Never follow a later planted symlink,
  // repair permissions on a model-controlled path, or fall back to shared /tmp for locks.
  for (const directory of [temp, state, runtime]) {
    signal.throwIfAborted();
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)) !== directory ||
      (platform !== "win32" && (info.mode & 0o022) !== 0)
    )
      throw new Error("command_temp_changed");
  }
  Object.assign(env, {
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_HOME: join(state, "config"),
    XDG_DATA_HOME: join(state, "data"),
    XDG_CACHE_HOME: join(state, "cache"),
    XDG_STATE_HOME: join(state, "state"),
    PNPM_HOME: join(state, "pnpm"),
    COREPACK_HOME: join(state, "corepack"),
    npm_config_cache: join(state, "npm-cache"),
    npm_config_devdir: join(state, "node-gyp"),
    YARN_CACHE_FOLDER: join(state, "yarn-cache"),
    GOPATH: join(state, "go"),
    GOCACHE: join(state, "go-build"),
    GOMODCACHE: join(state, "go-mod"),
    GOTMPDIR: temp,
    PYTHONPYCACHEPREFIX: join(state, "python-bytecode"),
    PIP_CACHE_DIR: join(state, "pip-cache"),
    UV_CACHE_DIR: join(state, "uv-cache"),
    POETRY_CACHE_DIR: join(state, "poetry-cache"),
    CARGO_HOME: join(state, "cargo"),
    RUSTUP_AUTO_INSTALL: "0",
    GRADLE_USER_HOME: join(state, "gradle"),
    MAVEN_USER_HOME: join(state, "maven"),
    COMPOSER_HOME: join(state, "composer"),
    COMPOSER_CACHE_DIR: join(state, "composer-cache"),
    GEM_HOME: join(state, "gems"),
    GEM_SPEC_CACHE: join(state, "gem-spec-cache"),
    NUGET_PACKAGES: join(state, "nuget-packages"),
    DOTNET_CLI_HOME: join(state, "dotnet"),
    // Maven 3 does not honor MAVEN_USER_HOME. A JVM-parsed option avoids shell splitting
    // in MAVEN_OPTS (especially app-data paths with spaces) and also covers Java 8.
    _JAVA_OPTIONS: [
      javaProperty("user.home", join(state, "java-home")),
      javaProperty("java.io.tmpdir", temp),
      javaProperty("maven.repo.local", join(state, "maven-repository")),
    ].join(" "),
  });
  // rustup's proxies still need their installed toolchains after CARGO_HOME is isolated.
  // Registry credentials/config remain excluded; sandbox write rules protect this host path.
  const installed = join(systemHome, ".rustup");
  try {
    signal.throwIfAborted();
    if ((await lstat(installed)).isDirectory()) {
      env.RUSTUP_HOME = await realpath(installed);
    }
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR"].includes(String(error.code))
      )
    )
      throw error;
    // A missing host toolchain is reported by the tool; never install one implicitly here.
  }
  signal.throwIfAborted();
}
