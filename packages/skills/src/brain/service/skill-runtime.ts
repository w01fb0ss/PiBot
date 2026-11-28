import { createHash, randomUUID } from "node:crypto";
import {
  glob,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  type CapabilityContext,
  detectRuntimeRequirements,
  NODE_SCRIPT_GLOB,
  RUNTIME_MANIFEST_MAX_BYTES,
  type SkillRuntimeRequirement,
} from "@pibot/brain/kit";
import {
  CHILD_NODE_VERSION,
  childNodeRuntime,
  directoryIdentity,
  ExecError,
  SKILL_NODE_DOMAINS,
  skillPythonDomains,
} from "@pibot/execution";
import {
  RpcError,
  RpcErrorCodes,
  type SkillManagedRuntime,
  type SkillRuntimeStatus,
} from "@pibot/skills-contract/full";
import { z } from "zod";
import { reviewNodeInputs } from "./skill-node-inputs.ts";
import { pythonPreparationCommand } from "./skill-runtime-command.ts";
import { runtimeOutputTail } from "./skill-runtime-log.ts";
import { ensurePrivateDir, SkillUv, SkillUvError, UV_VERSION } from "./skill-runtime-uv.ts";

/**
 * The skill's own virtual environment.
 *
 * Pi Bot does not run scripts shipped with the skill. Package builds can execute third-party
 * code; the local execution target confines writes and network access.
 */
export interface SkillRuntimeTarget {
  skillId: string;
  botId: string;
  name: string;
  /** Absolute folder that holds SKILL.md. */
  folder: string;
  groupId?: string;
}

export interface SkillRuntimeAudit {
  botId: string;
  groupId?: string;
  skillId: string;
  skillName: string;
  runtime: "python" | "node";
  packages: number;
  result: "ready" | "failed" | "removed" | "approved";
  planHash?: string;
  mirror?: true;
  reasonCode?: string;
}

export interface SkillRuntimeDeps {
  dataDir: string;
  platform: NodeJS.Platform;
  arch?: string;
  proxy?: CapabilityContext["local"]["deps"]["proxy"];
  redact?(text: string): string;
  local: Pick<CapabilityContext["local"], "target">;
  logger: Pick<CapabilityContext["logger"], "info" | "warn">;
  audit(input: SkillRuntimeAudit): void;
  emit?(target: SkillRuntimeTarget, status: SkillRuntimeStatus, progress: Active["progress"]): void;
}

interface EnvironmentState {
  version: 1;
  skillId: string;
  botId: string;
  runtime: "python" | "node";
  envId: string;
  status: "ready" | "failed" | "resolved";
  reason?: string;
  packages: number;
  interpreter: string;
  interpreterVersion: string;
  preparedAt: string;
  uvVersion?: string;
  planHash?: string;
  groupId?: string;
}

interface Plan {
  runtime: "python" | "node";
  interpreter: string;
  interpreterVersion: string;
  packages: string[];
  pythonSpecs?: string[];
  pythonLock?: PythonLock;
  resolvesPythonPackages?: true;
  nodeManifest?: string;
  nodeLock?: string;
  envId: string;
  hash: string;
  steps: { phase: Phase; command: string; verifyLock?: true }[];
}

type Phase = "create" | "dependencies" | "verify";

interface Active {
  envId: string;
  runtime: SkillManagedRuntime;
  abort: AbortController;
  done: Promise<void>;
  progress: { phase: Phase; done: number; total: number };
}

const STATE_FILE = "pibot-env.json";
const PYTHON_LOCK_FILE = "windows-python-packages.json";
const PYTHON_RESOLUTION_FILE = "resolved-requirements.txt";
const pythonPin = z
  .string()
  .max(500)
  .regex(/^[a-z0-9][a-z0-9._-]{0,213}==[a-z0-9.!+_-]+$/i);
const pythonLockSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$/),
  specs: z.array(pythonPin).max(1000),
});
type PythonLock = z.infer<typeof pythonLockSchema>;
const LOG_FILE = "prepare.log";
const MAX_LOG_BYTES = 4 * 1024 * 1024;

function quote(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Only the constraints skills actually use; an unparsable constraint never blocks a probe. */
function satisfies(found: string, constraint: string | undefined): boolean {
  if (!constraint) return true;
  const major = Number(found.split(".")[0] ?? 0);
  const minor = Number(found.split(".")[1] ?? 0);
  for (const part of constraint.split(",")) {
    const match = /^\s*(>=|<=|==|=|>|<|\^|~)?\s*(\d+)(?:\.(\d+))?/.exec(part.trim());
    if (!match) continue;
    const wanted = [Number(match[2]), Number(match[3] ?? 0)];
    const order = (wanted[0] ?? 0) - major || (wanted[1] ?? 0) - minor;
    switch (match[1] ?? "") {
      case ">=":
        if (order > 0) return false;
        break;
      case ">":
        if (order >= 0) return false;
        break;
      case "<=":
        if (order < 0) return false;
        break;
      case "<":
        if (order <= 0) return false;
        break;
      case "^":
      case "~":
        if (wanted[0] !== major) return false;
        break;
      default:
        if (order !== 0) return false;
    }
  }
  return true;
}

function pythonRequest(value: string | undefined): string | undefined {
  if (!value) return "3.12";
  const request = value.replace(/\s/g, "");
  if (
    request.length <= 100 &&
    /^(?:(?:~=|==|!=|>=|<=|>|<)\d+(?:\.\d+){0,2}(?:\.\*)?)(?:,(?:~=|==|!=|>=|<=|>|<)\d+(?:\.\d+){0,2}(?:\.\*)?)*$/.test(
      request,
    )
  )
    return request;
}

/** Only package names/extras with version constraints and optional environment markers. */
function indexRequirement(spec: string): boolean {
  const [requirement, ...marker] = spec.split(";");
  return (
    /^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9._, -]+\])?(?:\s*(?:===|~=|==|!=|<=|>=|<|>)\s*[a-z0-9.*!+_-]+(?:\s*,\s*(?:===|~=|==|!=|<=|>=|<|>)\s*[a-z0-9.*!+_-]+)*)?\s*$/i.test(
      requirement ?? "",
    ) &&
    marker.length <= 1 &&
    marker.every((part) => /^[a-z0-9.\s_'"()<>=!+-]+$/i.test(part)) &&
    !/[\r\n]/.test(spec)
  );
}

function below(root: string, path: string) {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function installFailure(output: string): string {
  if (
    /no (?:compatible )?wheels?|no usable (?:wheels?|binary)|wheels? (?:are|is) not available|no binaries|disallow.*(?:source|sdist)|doesn't have a source distribution/i.test(
      output,
    )
  )
    return "install_wheel_missing";
  if (
    /not found in the (?:package )?registry|no matching distribution|could not find a version|no versions of|\bE404\b|\b404\s*\(?not found\b|\bHTTP(?:\/[\d.]+)?\s+404\b/i.test(
      output,
    )
  )
    return "install_package_missing";
  if (
    /certificate|\bTLS\b|network is unreachable|timed? ?out|connection (?:refused|reset)|could not resolve host|failed to (?:download|fetch)|ENOTFOUND|EAI_AGAIN/i.test(
      output,
    )
  )
    return "install_network_failed";
  return "install_failed";
}

export class SkillRuntimeService {
  private readonly uv: SkillUv;
  private readonly active = new Map<string, Active>();
  private readonly removing = new Set<string>();
  constructor(private readonly deps: SkillRuntimeDeps) {
    this.uv = new SkillUv(deps.dataDir, deps.platform, deps.arch ?? process.arch, deps.proxy);
  }

  private root(): string {
    return join(this.deps.dataDir, "skill-envs");
  }

  private envDir(envId: string): string {
    return join(this.root(), envId);
  }

  private async readText(folder: string, name: string): Promise<string | undefined> {
    try {
      const info = await lstat(join(folder, name));
      // A manifest above the bound is treated as absent: it never becomes a read of arbitrary size.
      if (!info.isFile() || info.size > RUNTIME_MANIFEST_MAX_BYTES) return undefined;
      return await readFile(join(folder, name), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Direct sub-folders that can hold a skill's own manifest; environments and caches are not. */
  private async subfolders(folder: string): Promise<string[]> {
    try {
      return (await readdir(folder, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !["node_modules", "venv", "site-packages", "__pycache__"].includes(entry.name),
        )
        .map((entry) => entry.name)
        .sort()
        .slice(0, 100);
    } catch {
      // An unreadable folder has no manifest to offer; detection then sees only the root.
      return [];
    }
  }

  private async detect(target: SkillRuntimeTarget): Promise<{
    requirements: SkillRuntimeRequirement[];
    native: string[];
    specs: string[];
    nodeDependenciesUnreviewable?: true;
    nodeManifest?: string;
  }> {
    const cache = new Map<string, string | undefined>();
    const read = async (path: string) => {
      if (!cache.has(path)) cache.set(path, await this.readText(target.folder, path));
      return cache.get(path);
    };
    const present: string[] = [];
    for (const name of ["requirements.txt", "pyproject.toml", "package.json"])
      if ((await read(name)) !== undefined) present.push(name);
    // The import preview also reads a requirements.txt one folder down (`scripts/requirements.txt`
    // is common); without the same look here the card promised Python packages that were never
    // planned, and the saved skill reported "no runtime needed".
    if (!present.includes("requirements.txt"))
      for (const folder of await this.subfolders(target.folder)) {
        const path = `${folder}/requirements.txt`;
        if ((await read(path)) !== undefined) present.push(path);
      }
    const detection = await detectRuntimeRequirements(present, read);
    if (!detection.requirements.some(({ runtime }) => runtime === "node"))
      for await (const file of glob(NODE_SCRIPT_GLOB, {
        cwd: target.folder,
        exclude: ["**/{node_modules,.venv,venv,.git,site-packages}/**"],
        withFileTypes: true,
      })) {
        if (!file.isFile()) continue;
        detection.requirements.push({ runtime: "node" });
        break;
      }
    return {
      requirements: detection.requirements,
      native: detection.native,
      specs: detection.pythonSpecs,
      nodeDependenciesUnreviewable: detection.nodeDependenciesUnreviewable,
      nodeManifest: cache.get("package.json"),
    };
  }

  private async usablePython(envId: string): Promise<boolean> {
    try {
      const env = this.venvDir(envId);
      if (!(await lstat(env)).isDirectory()) return false;
      const data = await realpath(this.deps.dataDir);
      const managed = join(data, "runtimes", "python");
      const file = await realpath(this.pythonPath(envId));
      return (
        (below(join(data, "skill-envs", envId, "venv"), file) || below(managed, file)) &&
        (await lstat(file)).isFile()
      );
    } catch {
      return false;
    }
  }

  private async readState(envId: string): Promise<EnvironmentState | undefined> {
    try {
      const dir = this.envDir(envId);
      if (!(await lstat(dir)).isDirectory()) return undefined;
      const path = join(dir, STATE_FILE);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 8192) return undefined;
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const state = value as EnvironmentState;
      return state && state.version === 1 && state.envId === envId ? state : undefined;
    } catch {
      return undefined;
    }
  }

  private async currentState(plan: Plan, target: SkillRuntimeTarget) {
    const state = await this.readState(plan.envId);
    if (
      state?.runtime !== plan.runtime ||
      state.skillId !== target.skillId ||
      state.botId !== target.botId
    )
      return undefined;
    // Earlier Node records omitted the group. The freshly derived envId already binds
    // the group, Bot, skill, interpreter and exact manifest bytes.
    if (
      state.groupId === target.groupId ||
      (plan.runtime === "node" && state.groupId === undefined)
    )
      return state;
  }

  private ready(plan: Plan, state: EnvironmentState | undefined) {
    return (
      state?.status === "ready" &&
      !plan.resolvesPythonPackages &&
      (!plan.pythonLock || state.planHash === plan.hash) &&
      (plan.runtime === "node" || (state.uvVersion === UV_VERSION && this.usablePython(plan.envId)))
    );
  }

  private async states(skillId: string): Promise<EnvironmentState[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root());
    } catch {
      return [];
    }
    const states: EnvironmentState[] = [];
    for (const name of entries) {
      if (!/^[a-f0-9]{16}$/.test(name)) continue;
      const state = await this.readState(name);
      if (state?.skillId === skillId) states.push(state);
    }
    return states;
  }

  private async plan(
    target: SkillRuntimeTarget,
    requestedRuntime?: SkillManagedRuntime,
  ): Promise<{ plan: Plan | null; status: SkillRuntimeStatus }> {
    const detected = await this.detect(target);
    const base: SkillRuntimeStatus = {
      skillId: target.skillId,
      state: "not_required",
      requirements: detected.requirements,
      nativeModules: detected.native,
      interpreter: null,
      envId: null,
      planHash: null,
      packages: 0,
      bytes: null,
      reason: null,
      logPath: null,
      progress: null,
    };
    const requirement = requestedRuntime
      ? detected.requirements.find((item) => item.runtime === requestedRuntime)
      : detected.requirements[0];
    if (!requirement) return { plan: null, status: base };
    const runtime = requirement.runtime;
    base.runtime = runtime;
    if (runtime === "python") return this.planPython(target, base, requirement, detected.specs);
    const lock = await this.readText(target.folder, "package-lock.json");
    const manifest = detected.nodeManifest;
    const windows = this.deps.platform === "win32";
    const installs = !!requirement.packages?.length;
    const reviewed =
      windows && installs && manifest
        ? reviewNodeInputs(manifest, lock, this.deps.arch ?? process.arch)
        : undefined;
    if (detected.nodeDependenciesUnreviewable || (windows && installs && !reviewed))
      return {
        plan: null,
        status: { ...base, state: "failed", reason: "node_dependencies_unreviewable" },
      };
    let node: ReturnType<typeof childNodeRuntime> | undefined;
    try {
      node = childNodeRuntime();
    } catch (error) {
      if (!(error instanceof ExecError) || error.code !== "isolation_unavailable") throw error;
    }
    const version = node?.source === "bundled" ? CHILD_NODE_VERSION : process.versions.node;
    // Keep platform packages such as Rollup's native binaries, even with lifecycle scripts off.
    const installMode = windows
      ? "--omit=dev --include=optional --ignore-scripts --no-audit --no-fund --allow-git=none"
      : "--omit=dev --include=optional --ignore-scripts --no-audit --no-fund";
    const packages = reviewed?.packages ?? requirement.packages ?? [];
    const networkDomains = { primary: [...SKILL_NODE_DOMAINS] };
    const envId = createHash("sha256")
      .update(
        [
          "managed-node-v3",
          target.botId,
          target.groupId ?? "",
          target.skillId,
          this.deps.platform,
          node?.executable ?? "",
          version,
          manifest ?? "",
          lock ?? "",
          requirement.version ?? "",
          JSON.stringify(requirement.packages ?? []),
        ].join("\n"),
      )
      .digest("hex")
      .slice(0, 16);
    if (!node)
      return {
        plan: null,
        status: { ...base, state: "failed", envId, reason: `${runtime}_not_found` },
      };
    const interpreter = { command: "Node.js", version };
    if (!satisfies(version, requirement.version))
      return {
        plan: null,
        status: {
          ...base,
          state: "failed",
          envId,
          interpreter,
          reason: `${runtime}_version_unsatisfied`,
        },
      };
    const q = (value: string) =>
      windows ? `'${value.replaceAll("'", "''")}'` : quote(value, this.deps.platform);
    const invoke = windows ? "& " : "";
    const nodeCommand = `${invoke}${q(node.executable)}`;
    const npm =
      node.source === "bundled"
        ? `${nodeCommand} ${q(join(dirname(node.executable), "npm", "bin", "npm-cli.js"))}`
        : windows
          ? "npm.cmd"
          : "npm";
    const steps: Plan["steps"] = [
      ...(reviewed
        ? [
            {
              phase: "dependencies" as const,
              command: `${npm} ci ${installMode} --dry-run --offline`,
              verifyLock: true as const,
            },
          ]
        : []),
      ...(installs
        ? [
            {
              phase: "dependencies" as const,
              command: `${npm} ${lock ? "ci" : "install"} ${installMode}`,
            },
          ]
        : []),
      ...(installs
        ? [{ phase: "verify" as const, command: `${npm} ls --all --omit=dev --offline` }]
        : []),
      { phase: "verify", command: `${nodeCommand} --version` },
    ];
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          envId,
          interpreter,
          steps: steps.map((step) => step.command),
          packages,
          reviewedPackages: reviewed?.packages,
          networkDomains,
        }),
      )
      .digest("hex");
    return {
      plan: {
        runtime,
        interpreter: node.executable,
        interpreterVersion: version,
        packages,
        nodeManifest: windows ? reviewed?.manifest : manifest,
        nodeLock: windows ? reviewed?.lock : lock,
        envId,
        hash,
        steps,
      },
      status: {
        ...base,
        state: "not_prepared",
        envId,
        planHash: hash,
        interpreter,
        packages: packages.length,
        ...(windows
          ? { requiresUnisolatedConfirmation: true as const, reviewedPackages: packages }
          : { networkDomains }),
      },
    };
  }

  private async planPython(
    target: SkillRuntimeTarget,
    base: SkillRuntimeStatus,
    requirement: SkillRuntimeRequirement,
    declared: string[],
  ): Promise<{ plan: Plan | null; status: SkillRuntimeStatus }> {
    const release = this.uv.release;
    if (!release)
      return {
        plan: null,
        status: { ...base, state: "failed", reason: "uv_unsupported_platform" },
      };
    const request = pythonRequest(requirement.version);
    if (!request || !declared.every(indexRequirement))
      return {
        plan: null,
        status: { ...base, state: "failed", reason: "python_requirement_unsupported" },
      };
    const windows = this.deps.platform === "win32";
    const envId = digest([
      windows ? "managed-python-windows-v2" : "managed-python-v1",
      target.botId,
      target.groupId,
      target.skillId,
      release.target,
      UV_VERSION,
      request,
      declared,
    ]).slice(0, 16);
    const lock = windows && declared.length ? await this.readPythonLock(envId) : undefined;
    const resolve = windows && !!declared.length && !lock;
    const specs = lock?.specs ?? declared;
    const pythonVersion = lock?.version ?? request;
    const dir = this.venvDir(envId);
    const q = (value: string) =>
      windows ? `'${value.replaceAll("'", "''")}'` : quote(value, this.deps.platform);
    const invoke = windows ? "& " : "";
    const uv = `${invoke}${q(this.uv.path)}`;
    const python = q(this.pythonPath(envId));
    const requirements = q(join(dir, "requirements.txt"));
    const steps: Plan["steps"] = [
      {
        phase: "create",
        command: `${uv} venv --no-project --python ${q(pythonVersion)} ${q(dir)}`,
      },
    ];
    const verify = { phase: "verify" as const, command: `${invoke}${python} --version` };
    if (resolve) {
      steps.push(verify, {
        phase: "dependencies",
        command: `${uv} pip compile --no-cache --no-build --only-binary :all: --python ${python} --no-header --no-annotate --output-file ${q(join(dir, PYTHON_RESOLUTION_FILE))} ${requirements}`,
      });
    } else {
      if (lock) steps.push(verify);
      if (specs.length)
        steps.push({
          phase: "dependencies",
          // Wheels only. Windows also disables resolution during installation.
          command: `${uv} pip install --no-cache --only-binary :all: --link-mode copy${lock ? " --no-deps" : ""} --python ${python} -r ${requirements}`,
        });
      if (!lock) steps.push(verify);
    }
    const packages = [
      ...new Set(
        (resolve ? [] : specs)
          .map((spec) => /^[A-Za-z0-9_.-]+/.exec(spec)?.[0])
          .filter((name): name is string => !!name),
      ),
    ];
    const managedPython = {
      uvVersion: UV_VERSION,
      uvBytes: release.bytes,
      pythonRequest: pythonVersion,
    };
    const networkDomains = { primary: skillPythonDomains(), withMirror: skillPythonDomains(true) };
    const hash = digest({ envId, steps, packages, managedPython, networkDomains, lock });
    return {
      plan: {
        runtime: "python",
        interpreter: "Python",
        interpreterVersion: pythonVersion,
        pythonSpecs: specs,
        pythonLock: lock,
        ...(resolve ? { resolvesPythonPackages: true as const } : {}),
        packages,
        envId,
        hash,
        steps,
      },
      status: {
        ...base,
        state: "not_prepared",
        envId,
        planHash: hash,
        packages: packages.length,
        managedPython,
        ...(windows
          ? {
              requiresUnisolatedConfirmation: true as const,
              ...(resolve
                ? { resolvesPythonPackages: true as const }
                : { reviewedPackages: lock?.specs ?? [] }),
            }
          : { networkDomains }),
      },
    };
  }

  private async readPythonLock(envId: string) {
    const text = await this.readText(this.envDir(envId), PYTHON_LOCK_FILE);
    if (!text) return undefined;
    try {
      return pythonLockSchema.parse(JSON.parse(text));
    } catch {
      // A partial or malformed resolution requires a fresh review.
      return undefined;
    }
  }

  private async writePythonLock(envId: string, lock: PythonLock) {
    const path = join(this.envDir(envId), PYTHON_LOCK_FILE);
    const text = JSON.stringify(lock);
    if (Buffer.byteLength(text) > RUNTIME_MANIFEST_MAX_BYTES)
      throw new Error("python_dependencies_unreviewable");
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
  }

  private venvDir(envId: string): string {
    return join(this.envDir(envId), "venv");
  }

  private pythonPath(envId: string): string {
    return join(
      this.venvDir(envId),
      this.deps.platform === "win32" ? "Scripts" : "bin",
      this.deps.platform === "win32" ? "python.exe" : "python",
    );
  }

  private async size(folder: string, signal?: AbortSignal): Promise<number | null> {
    let total = 0;
    const walk = async (path: string): Promise<void> => {
      signal?.throwIfAborted();
      for (const entry of await readdir(path, { withFileTypes: true })) {
        signal?.throwIfAborted();
        const child = join(path, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) total += (await stat(child)).size;
      }
    };
    try {
      await walk(folder);
      return total;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }

  async status(
    target: SkillRuntimeTarget,
    signal?: AbortSignal,
    runtime?: SkillManagedRuntime,
  ): Promise<SkillRuntimeStatus> {
    signal?.throwIfAborted();
    const selected = await this.plan(target, runtime);
    const { plan, status } =
      runtime && !selected.status.runtime && selected.status.requirements.length
        ? await this.plan(target)
        : selected;
    signal?.throwIfAborted();
    if (!plan) return status;
    const running = this.active.get(target.skillId);
    if (running?.envId === plan.envId)
      return {
        ...status,
        state: "preparing",
        logPath: join(this.envDir(plan.envId), LOG_FILE),
        progress: { ...running.progress },
      };
    const current = await this.currentState(plan, target);
    if (current && (await this.ready(plan, current)))
      return {
        ...status,
        state: "ready",
        bytes: await this.size(this.envDir(plan.envId), signal),
        interpreter: {
          command: current.runtime === "node" ? "Node.js" : "Python",
          version: current.interpreterVersion,
        },
      };
    if (current?.status === "ready") return { ...status, state: "needs_prepare" };
    if (current?.status === "resolved") return status;
    if (current)
      return {
        ...status,
        state: "failed",
        reason: current.reason ?? "install_failed",
        logPath: join(this.envDir(plan.envId), LOG_FILE),
      };
    // An environment built for another interpreter or manifest set cannot be reused; saying
    // "ready" would hide that it has to be prepared again.
    const previous = (await this.states(target.skillId)).some(
      (state) => state.status === "ready" && state.runtime === plan.runtime,
    );
    return previous ? { ...status, state: "needs_prepare" } : status;
  }

  private async append(file: string, text: string): Promise<void> {
    const handle = await open(file, "a", 0o600);
    try {
      const info = await handle.stat();
      if (info.size < MAX_LOG_BYTES)
        await handle.writeFile(Buffer.from(text).subarray(0, MAX_LOG_BYTES - info.size));
    } finally {
      await handle.close();
    }
  }

  async prepare(
    target: SkillRuntimeTarget,
    planHash: string,
    signal: AbortSignal,
    confirmWithoutIsolation = false,
    useMirror = false,
    runtime?: SkillManagedRuntime,
  ): Promise<SkillRuntimeStatus> {
    if (this.active.has(target.skillId) || this.removing.has(target.skillId))
      return this.status(target, signal, runtime);
    signal.throwIfAborted();
    const { plan, status } = await this.plan(target, runtime);
    if (!plan) return status;
    if (status.requiresUnisolatedConfirmation && !confirmWithoutIsolation)
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_runtime_confirmation_required");
    if (plan.hash !== planHash)
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_runtime_plan_changed");
    if (useMirror && plan.runtime !== "python")
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_runtime_plan_changed");
    if (await this.ready(plan, await this.currentState(plan, target)))
      return this.status(target, signal, runtime);
    if (this.active.has(target.skillId) || this.removing.has(target.skillId))
      return this.status(target, signal, runtime);
    signal.throwIfAborted();
    const abort = new AbortController();
    const active: Active = {
      envId: plan.envId,
      runtime: plan.runtime,
      abort,
      progress: { phase: "create", done: 0, total: plan.steps.length },
      done: Promise.resolve(),
    };
    this.active.set(target.skillId, active);
    active.done = this.runPlan(
      target,
      plan,
      status,
      active,
      AbortSignal.any([signal, abort.signal]),
      useMirror,
    ).finally(() => {
      this.active.delete(target.skillId);
    });
    await active.done;
    const final = await this.status(target, undefined, runtime);
    this.deps.emit?.(target, final, active.progress);
    return final;
  }

  private async runPlan(
    target: SkillRuntimeTarget,
    plan: Plan,
    status: SkillRuntimeStatus,
    active: Active,
    signal: AbortSignal,
    useMirror: boolean,
  ): Promise<void> {
    const metadata = this.envDir(plan.envId);
    const log = join(metadata, LOG_FILE);
    const python = plan.runtime === "python";
    const dir = python ? this.venvDir(plan.envId) : metadata;
    let created = false;
    let dispatched = false;
    let reason: string | undefined;
    // Read in the catch below to name the phase that hit the workspace boundary.
    let currentPhase: Plan["steps"][number]["phase"] | undefined;
    if (status.requiresUnisolatedConfirmation && !signal.aborted)
      this.deps.audit({
        botId: target.botId,
        groupId: target.groupId,
        skillId: target.skillId,
        skillName: target.name,
        runtime: plan.runtime,
        packages: plan.packages.length,
        result: "approved",
        planHash: plan.hash,
        ...(python && useMirror ? { mirror: true } : {}),
      });
    try {
      signal.throwIfAborted();
      if (python) {
        const previous = await this.readState(plan.envId);
        if (previous?.reason === "uv_cleanup_unconfirmed")
          await this.deps.local.target.isolationStatus(signal);
        await ensurePrivateDir(this.root());
        // A failed or interrupted build must never be the starting point for another install.
        await rm(metadata, { recursive: true, force: true });
        await ensurePrivateDir(metadata);
        await ensurePrivateDir(dir);
        created = true;
        if (plan.pythonLock) await this.writePythonLock(plan.envId, plan.pythonLock);
        this.deps.emit?.(target, { ...status, state: "preparing" }, active.progress);
        const isolation = await this.deps.local.target.isolationStatus(signal);
        if (
          !isolation.available &&
          !(status.requiresUnisolatedConfirmation && isolation.reason === "windows_unisolated")
        )
          throw new ExecError("isolation_unavailable");
        await this.uv.ensure(signal, useMirror);
        await ensurePrivateDir(join(this.deps.dataDir, "runtimes", "python"));
        await ensurePrivateDir(join(this.deps.dataDir, "runtimes"));
        await ensurePrivateDir(join(this.deps.dataDir, "runtimes", "uv-cache"));
      } else {
        await ensurePrivateDir(this.root());
        await rm(dir, { recursive: true, force: true });
        await ensurePrivateDir(dir);
        await this.copyNodeManifest(plan, dir);
      }
      await this.append(
        log,
        `# ${new Date().toISOString()} ${plan.runtime} ${plan.interpreterVersion}\n`,
      );
      for (const [index, step] of plan.steps.entries()) {
        signal.throwIfAborted();
        currentPhase = step.phase;
        active.progress = { phase: step.phase, done: index, total: plan.steps.length };
        this.deps.emit?.(target, { ...status, state: "preparing" }, active.progress);
        if (python && step.phase === "dependencies") await this.writeRequirements(plan, dir);
        const dataDir = this.deps.dataDir;
        if (python && step.phase !== "create" && !(await this.usablePython(plan.envId)))
          throw new Error("install_failed");
        let output = "";
        const preparation = python
          ? {
              envId: plan.envId,
              uvVersion: UV_VERSION,
              ...(useMirror ? { useMirror: true as const } : {}),
              phase: step.phase,
              ...(status.requiresUnisolatedConfirmation ? { windowsConfirmed: true as const } : {}),
            }
          : undefined;
        dispatched = true;
        const result = await this.deps.local.target
          .runCommand({
            ...(preparation
              ? await pythonPreparationCommand({
                  dataDir,
                  target,
                  preparation,
                  command: step.command,
                  signal,
                })
              : {
                  command: step.command,
                  cwd: dir,
                  rootIdentities: [await directoryIdentity(dir)],
                  dataDir,
                  botHome: join(dataDir, "bots", target.botId, "home"),
                  skillGroupId: target.groupId,
                  writeRoots: [dir],
                  network: status.requiresUnisolatedConfirmation
                    ? { allowAll: true, domains: [] }
                    : { allowAll: false, domains: [...SKILL_NODE_DOMAINS] },
                  ...(status.requiresUnisolatedConfirmation ? { allowUnisolated: true } : {}),
                  skillNodePreparation: {
                    envId: plan.envId,
                    windowsConfirmed: status.requiresUnisolatedConfirmation,
                  },
                  pathEntries: [dirname(plan.interpreter)],
                  runId: randomUUID(),
                  timeoutSec: 600,
                  signal,
                }),
            onOutput: (text) => {
              output = (output + text).slice(-32 * 1024);
            },
          })
          .catch(async (error: unknown) => {
            if (python) {
              try {
                const code = error instanceof ExecError ? error.code : "command_failed";
                const detail = error instanceof ExecError ? error.reason : undefined;
                const root = error instanceof ExecError ? error.profileWriteRoot : undefined;
                await this.append(
                  log,
                  `${step.phase}: failed error=${code}${detail ? ` reason=${detail}` : ""}${root ? ` root_index=${root.index} root_kind=${root.kind}` : ""}\n`,
                );
                const tail = runtimeOutputTail(
                  output,
                  { dataDir, venv: dir, skill: target.folder },
                  this.deps.redact,
                );
                await this.append(log, `${tail || "[no stdout/stderr received]"}\n`);
              } catch {
                // A full disk must not hide cleanup_failed and cause removal of a live venv.
                this.deps.logger.warn(
                  JSON.stringify({
                    module: "skills",
                    event: "runtime_diagnostic_write_failed",
                    botId: target.botId,
                    skillId: target.skillId,
                    phase: step.phase,
                  }),
                );
              }
            }
            throw error;
          });
        if (!python) signal.throwIfAborted();
        if (python) {
          await this.append(
            log,
            `${step.phase}: ${result.exitCode === 0 ? "ok" : "failed"} exit=${result.exitCode ?? "null"} timed_out=${result.timedOut} stopped=${result.stopped}\n`,
          );
          const tail = runtimeOutputTail(
            result.truncatedOutput || output,
            { dataDir, venv: dir, skill: target.folder },
            this.deps.redact,
          );
          await this.append(log, `${tail || "[no stdout/stderr received]"}\n`);
        } else {
          const text = await readFile(result.logPath, "utf8").catch(() => "");
          await this.append(log, `$ ${step.command}\n${this.deps.redact?.(text) ?? text}\n`);
        }
        signal.throwIfAborted();
        if (result.exitCode !== 0) {
          reason = step.verifyLock
            ? "node_dependencies_unreviewable"
            : installFailure(result.truncatedOutput || output);
          throw new Error(reason);
        }
        if (python && step.phase === "verify") {
          const version = /(?:^|\n)Python (\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?)\s*(?:$|\n)/.exec(
            output,
          )?.[1];
          if (
            !version ||
            (plan.pythonLock && version !== plan.pythonLock.version) ||
            !(await this.usablePython(plan.envId))
          )
            throw new Error("install_failed");
          plan.interpreterVersion = version;
        }
      }
      if (plan.resolvesPythonPackages) {
        reason = "python_dependencies_unreviewable";
        const text = await this.readText(dir, PYTHON_RESOLUTION_FILE);
        if (text === undefined) throw new Error(reason);
        const lock = pythonLockSchema.parse({
          version: plan.interpreterVersion,
          specs: text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        });
        await this.saveState(plan, target, { status: "resolved" });
        await this.writePythonLock(plan.envId, lock);
        return;
      }
      await this.saveState(plan, target, { status: "ready" });
    } catch (error) {
      const cleanupUnconfirmed = error instanceof ExecError && error.reason === "cleanup_failed";
      reason = cleanupUnconfirmed
        ? "uv_cleanup_unconfirmed"
        : signal.aborted
          ? "cancelled"
          : error instanceof SkillUvError
            ? error.reason
            : error instanceof ExecError && error.reason === "windows_proxy_credentials"
              ? "windows_proxy_credentials"
              : error instanceof ExecError && error.code === "isolation_unavailable"
                ? python
                  ? "uv_isolation_unavailable"
                  : "node_isolation_unavailable"
                : error instanceof ExecError && error.code === "outside_workplace"
                  ? "python_workspace_boundary"
                  : python && !dispatched
                    ? "uv_download_failed"
                    : (reason ?? "install_failed");
      // Execution may be retaining a tree whose teardown could not be confirmed. Do not remove
      // its working directory in that case; the failed state keeps it out of runtime selection.
      if (python && created && !cleanupUnconfirmed) {
        await rm(dir, { recursive: true, force: true });
        await ensurePrivateDir(dir);
        await this.append(
          log,
          reason === "python_workspace_boundary"
            ? `failed: ${reason} (${currentPhase ?? "preparation"}; ${
                error instanceof ExecError && error.reason?.startsWith("profile_")
                  ? error.reason
                  : "managed runtime root"
              })\n`
            : `failed: ${reason}\n`,
        );
      }
      if (!python || created) await this.saveState(plan, target, { status: "failed", reason });
    }
    this.deps.audit({
      botId: target.botId,
      groupId: target.groupId,
      skillId: target.skillId,
      skillName: target.name,
      runtime: plan.runtime,
      packages: plan.packages.length,
      result: reason ? "failed" : "ready",
      reasonCode: reason,
      planHash: plan.hash,
      ...(python && useMirror ? { mirror: true } : {}),
    });
  }

  private async writeRequirements(plan: Plan, dir: string): Promise<void> {
    const handle = await open(join(dir, "requirements.txt"), "wx", 0o600);
    try {
      await handle.writeFile(`${(plan.pythonSpecs ?? []).join("\n")}\n`);
    } finally {
      await handle.close();
    }
  }

  private async copyNodeManifest(plan: Plan, dir: string): Promise<void> {
    for (const [name, text] of [
      ["package.json", plan.nodeManifest],
      ["package-lock.json", plan.nodeLock],
    ] as const) {
      if (text === undefined) continue;
      const handle = await open(join(dir, name), "w", 0o600);
      try {
        await handle.writeFile(text);
      } finally {
        await handle.close();
      }
    }
  }

  private async saveState(
    plan: Plan,
    target: SkillRuntimeTarget,
    value: { status: EnvironmentState["status"]; reason?: string },
  ): Promise<void> {
    const state: EnvironmentState = {
      version: 1,
      skillId: target.skillId,
      botId: target.botId,
      runtime: plan.runtime,
      envId: plan.envId,
      status: value.status,
      ...(value.reason ? { reason: value.reason } : {}),
      packages: plan.packages.length,
      interpreter: plan.interpreter,
      interpreterVersion: plan.interpreterVersion,
      preparedAt: new Date().toISOString(),
      groupId: target.groupId,
      ...(plan.runtime === "python" ? { uvVersion: UV_VERSION } : {}),
      ...(plan.pythonLock ? { planHash: plan.hash } : {}),
    };
    const dir = this.envDir(plan.envId);
    const temp = join(dir, `.${randomUUID()}.json`);
    const handle = await open(temp, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(state));
      } finally {
        await handle.close();
      }
      await rename(temp, join(dir, STATE_FILE));
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** The ready environment for the skill this command invokes. */
  async commandRuntime(target: SkillRuntimeTarget, runtime?: SkillManagedRuntime) {
    const { plan, status } = await this.plan(target, runtime);
    if (!runtime && status.requirements.length > 1) return undefined;
    if (status.state === "not_required") return undefined;
    if (
      plan &&
      this.active.get(target.skillId)?.envId !== plan.envId &&
      !this.removing.has(target.skillId)
    ) {
      if (await this.ready(plan, await this.currentState(plan, target))) {
        const dir = this.envDir(plan.envId);
        const environment =
          plan.runtime === "node"
            ? {
                id: plan.envId,
                dir,
                sourceDir: target.folder,
                bin: "node_modules/.bin",
                node: plan.interpreter,
              }
            : {
                id: plan.envId,
                dir,
                sourceDir: target.folder,
                bin: this.deps.platform === "win32" ? "venv/Scripts" : "venv/bin",
                python: this.pythonPath(plan.envId),
              };
        return { environment };
      }
    }
    return {
      missing: {
        skillId: target.skillId,
        name: target.name,
        groupId: target.groupId,
        runtime: status.runtime,
      },
    };
  }

  async cancel(
    target: SkillRuntimeTarget,
    runtime?: SkillManagedRuntime,
  ): Promise<SkillRuntimeStatus> {
    const active = this.active.get(target.skillId);
    if (active && (!runtime || active.runtime === runtime)) {
      active.abort.abort();
      await active.done;
    }
    return this.status(target, undefined, runtime);
  }

  async remove(
    target: SkillRuntimeTarget,
    runtime?: SkillManagedRuntime,
  ): Promise<SkillRuntimeStatus> {
    if (this.removing.has(target.skillId)) return this.status(target, undefined, runtime);
    this.removing.add(target.skillId);
    try {
      const current = await this.cancel(target, runtime);
      for (const state of await this.states(target.skillId)) {
        // Only the current plan can establish group ownership of a scope-less Node record.
        if (
          (runtime && state.runtime !== runtime) ||
          state.botId !== target.botId ||
          (state.groupId !== target.groupId &&
            !(
              state.runtime === "node" &&
              state.groupId === undefined &&
              state.envId === current.envId
            ))
        )
          continue;
        if (state.reason === "uv_cleanup_unconfirmed")
          await this.deps.local.target.isolationStatus();
        await rm(this.envDir(state.envId), { recursive: true, force: true });
        this.deps.audit({
          botId: target.botId,
          groupId: target.groupId,
          skillId: target.skillId,
          skillName: target.name,
          runtime: state.runtime,
          packages: state.packages,
          result: "removed",
        });
      }
    } finally {
      this.removing.delete(target.skillId);
    }
    return this.status(target, undefined, runtime);
  }

  async log(
    target: SkillRuntimeTarget,
    runtime?: SkillManagedRuntime,
  ): Promise<{ path: string | null; text: string }> {
    const status = await this.status(target, undefined, runtime);
    if (!status.envId) return { path: null, text: "" };
    const path = join(this.envDir(status.envId), LOG_FILE);
    try {
      const info = await stat(path);
      const length = Math.min(info.size, 200_000);
      const buffer = Buffer.alloc(length);
      const handle = await open(path, "r");
      try {
        await handle.read(buffer, 0, length, Math.max(0, info.size - length));
      } finally {
        await handle.close();
      }
      return { path, text: buffer.toString("utf8") };
    } catch {
      return { path, text: "" };
    }
  }
}
