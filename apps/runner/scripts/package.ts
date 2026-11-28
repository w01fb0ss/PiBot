import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { copyRunnerComputerAssets } from "./computer-assets.ts";
import { buildLinuxInstallers } from "./installer/linux.ts";
import { buildWindowsInstaller } from "./installer/windows.ts";
import { inspectRunnerRtc } from "./rtc-prebuilt.ts";
import { bundleRunner } from "./sea/bundle.ts";
import { packageCommand as command } from "./sea/command.ts";
import { inspectRunnerKeyring } from "./sea/keyring-prebuilt.ts";
import { fileDigest, resourceManifest, writeRunnerManifest } from "./sea/manifest.ts";
import { nodeRuntime } from "./sea/node-runtime.ts";
import { copyRuntimeResources } from "./sea/resources.ts";
import { signRunner } from "./sea/sign.ts";
import { trimRuntime } from "./sea/trim-runtime.ts";
import type { Arch, Platform, Target } from "./sea/types.ts";
import { brandWindowsExecutable } from "./sea/windows-version.ts";
import { copyRunnerTrayAssets, createRunnerMacApp } from "./tray-assets.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultOutput = join(repo, "dist", "runner");

function isWithin(parent: string, target: string) {
  const value = relative(parent, target);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function parseTargets(args: readonly string[]) {
  let platform = process.platform as Platform;
  let arch = process.arch as Arch;
  let output = defaultOutput;
  let all = false;
  let fixture = false;
  let installer = false;
  let makensis: string | undefined;
  let fpm: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--all") all = true;
    else if (argument === "--fixture") fixture = true;
    else if (argument === "--installer") installer = true;
    else if (argument === "--makensis") {
      makensis = resolve(args[++index] ?? "");
      installer = true;
    } else if (argument === "--fpm") {
      fpm = resolve(args[++index] ?? "");
      installer = true;
    } else if (argument === "--platform") platform = args[++index] as Platform;
    else if (argument === "--arch") arch = args[++index] as Arch;
    else if (argument === "--out-dir") output = resolve(args[++index] ?? "");
    else throw new Error(`Unknown packaging argument: ${argument}`);
  }
  const platforms: Platform[] = ["darwin", "win32", "linux"];
  const architectures: Arch[] = ["x64", "arm64"];
  if (!platforms.includes(platform) || !architectures.includes(arch))
    throw new Error("Unsupported runner package target");
  if (!isWithin(repo, output) || output === repo)
    throw new Error("Runner package output must stay inside the repository");
  if (fixture && output === defaultOutput)
    throw new Error("Fixture packages require a separate --out-dir");
  const targets = all
    ? platforms.flatMap((item) =>
        architectures.map((targetArch) => ({ platform: item, arch: targetArch })),
      )
    : [{ platform, arch }];
  return { fpm, fixture, installer, makensis, output, targets };
}

async function packageTarget(
  target: Target,
  output: string,
  versions: { node: string; app: string },
  fixture: boolean,
) {
  if (process.version !== `v${versions.node}`) throw new Error("runner_build_node_version");
  const directory = join(output, `${target.platform}-${target.arch}`);
  if (!isWithin(output, directory) || directory === output)
    throw new Error("Unsafe runner package directory");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "pibot-runner-sea-"));
  try {
    const deployed = join(temporary, "deploy");
    const prepared = await Promise.allSettled([
      nodeRuntime(target, temporary, versions.node),
      command(
        "pnpm",
        [
          "--filter",
          "@pibot/runner-app",
          "deploy",
          deployed,
          "--prod",
          "--node-linker=hoisted",
          `--os=${target.platform}`,
          `--cpu=${target.arch}`,
        ],
        repo,
      ),
    ]);
    const failed = prepared.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    await trimRuntime(
      join(temporary, "runtime", target.platform === "win32" ? "node.exe" : "node"),
      target,
    );
    const rtc = await inspectRunnerRtc(deployed, target);
    const keyring = await inspectRunnerKeyring(deployed, target);
    const resources = join(directory, "resources");
    const closure = await copyRuntimeResources(deployed, resources, target);
    // The tray UI script and icons and runner computer use live beside the executable;
    // without them the Windows tray exited at once and runner computer use had no driver
    // (round-1 VM 2026-11-12). Maintainers 2026-11-12: computer use ships in the package (budget 230 MB).
    if (target.platform !== "linux") await copyRunnerTrayAssets(repo, resources, target.platform);
    await copyRunnerComputerAssets({
      dependencyRoot: deployed,
      resourcesDir: resources,
      platform: target.platform,
      arch: target.arch,
    });
    // The PAC sandbox (QuickJS in WebAssembly) loads its engine from here; the JS wrapper is
    // bundled and its license copied with the bundle's.
    await cp(
      createRequire(join(deployed, "package.json")).resolve("quickjs-wasi/quickjs.wasm"),
      join(resources, "quickjs.wasm"),
    );
    await cp(join(temporary, "runtime", "LICENSE"), join(resources, "NODE-LICENSE"));
    await cp(
      join(repo, "apps", "runner", "THIRD_PARTY_NOTICES.md"),
      join(resources, "THIRD_PARTY_NOTICES.md"),
    );
    const { main } = await bundleRunner(repo, directory, temporary, versions.app, fixture);
    const executableName = target.platform === "win32" ? "pibot.exe" : "pibot";
    const executable = join(directory, executableName);
    const config = join(temporary, "sea-config.json");
    await writeFile(
      config,
      JSON.stringify({
        main,
        mainFormat: "module",
        executable: join(temporary, "runtime", target.platform === "win32" ? "node.exe" : "node"),
        output: executable,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgvExtension: "none",
      }),
    );
    await command(process.execPath, ["--build-sea", config], repo);
    if (target.platform === "win32") await brandWindowsExecutable(executable, repo, versions.app);
    if (target.platform !== "win32") await chmod(executable, 0o755);
    // macOS ships as Pi Bot Runner.app (LSUIElement tray, login item, permission prompts that name
    // it); a fixture package keeps the bare layout its probes call. One copy of the resources only.
    const macApp = target.platform === "darwin" && !fixture;
    const bundle = join(directory, "Pi Bot Runner.app");
    const shippedPath = macApp ? "Pi Bot Runner.app/Contents/MacOS/runner-core" : executableName;
    // The runtime check compares this exact list with the digest built into the executable.
    const resourceList = macApp ? await resourceManifest(directory) : undefined;
    if (macApp) {
      await createRunnerMacApp({
        repo,
        executablePath: executable,
        resourcesDir: resources,
        bundleDir: bundle,
        version: versions.app,
      });
      await rm(executable);
      await rm(resources, { recursive: true });
      // runner-core verifies resources against manifest.json beside it at start. codesign refuses
      // a plain file in Contents/MacOS, so it lives in Resources and MacOS links to it (as the
      // resources link already does); written before the bundle is sealed.
      await writeFile(
        join(bundle, "Contents", "Resources", "runner-manifest.json"),
        `${JSON.stringify({ version: 2, resources: resourceList }, null, 2)}\n`,
      );
      await symlink(
        "../Resources/runner-manifest.json",
        join(bundle, "Contents", "MacOS", "manifest.json"),
      );
    }
    const shipped = join(directory, shippedPath);
    const signing = await signRunner(shipped, target, macApp ? bundle : undefined);
    if (fixture) {
      const wrapper = join(
        directory,
        target.platform === "win32" ? "pibot-fixture.cmd" : "pibot-fixture",
      );
      await writeFile(
        wrapper,
        target.platform === "win32"
          ? '@echo off\r\nset "PIBOT_RUNNER_FIXTURE=1"\r\n"%~dp0pibot.exe" --pibot-internal runner-fixture %*\r\n'
          : '#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nPIBOT_RUNNER_FIXTURE=1 exec "$base/pibot" --pibot-internal runner-fixture "$@"\n',
      );
      if (target.platform !== "win32") await chmod(wrapper, 0o755);
    }

    // The installer and all probes call the same executable; no second Node interpreter is shipped.
    await writeRunnerManifest(
      directory,
      {
        node: versions.node,
        appVersion: versions.app,
        platform: target.platform,
        arch: target.arch,
        fixture,
        rtc,
        keyring,
        signing,
        executable: { path: shippedPath, ...(await fileDigest(shipped)) },
        externalPackages: closure.externalPackages,
      },
      resourceList,
    );
    process.stdout.write(`runner package: ${basename(directory)} (${signing})\n`);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const options = parseTargets(process.argv.slice(2));
const nodeVersion = (await readFile(join(repo, ".nvmrc"), "utf8")).trim().replace(/^v/, "");
// The CLI and installer share the desktop version; .nvmrc only pins the bundled Node runtime.
const version = await desktopVersion();
for (const target of options.targets) {
  const directory = await packageTarget(
    target,
    options.output,
    { node: nodeVersion, app: version },
    options.fixture,
  );
  if (!options.installer) continue;
  if (target.platform === "win32")
    await buildWindowsInstaller({
      target: { platform: "win32", arch: target.arch },
      directory,
      output: options.output,
      version,
      repo,
      makensis: options.makensis,
      // Single executable: the installer checks for and launches pibot.exe, not the old pibot.cmd.
      executable: "pibot.exe",
    });
  else if (target.platform === "linux")
    await buildLinuxInstallers({
      target: { platform: "linux", arch: target.arch },
      directory,
      output: options.output,
      version,
      repo,
      fpm: options.fpm,
    });
  // macOS 的桌面本身就带执行端，不出安装包。
  else process.stdout.write(`runner installer: skipped ${target.platform}-${target.arch}\n`);
}

async function desktopVersion() {
  const manifest = JSON.parse(
    await readFile(join(repo, "apps", "desktop", "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+/u.test(manifest.version))
    throw new Error("The desktop package must declare a semantic version for the runner package");
  return manifest.version;
}
