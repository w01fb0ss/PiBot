/**
 * What a skill package needs at run time, inferred from its manifests and script names.
 *
 * Detection is a proposal, never a permission: the result fills the import preview and the skill
 * detail, and the user approves the concrete commands before anything is installed. Only three
 * well-known manifests are read, each with an explicit size bound, so an imported package cannot
 * make the scanner read arbitrary content.
 */
export interface SkillRuntimeRequirement {
  runtime: "python" | "node";
  version?: string;
  packages?: string[];
}

export interface SkillRuntimeDetection {
  requirements: SkillRuntimeRequirement[];
  /** Compiled-extension packages that often lack a wheel; a hint for the approval card, not a gate. */
  native: string[];
  /** Requirement lines verbatim, so prepare installs exactly what the author pinned. */
  pythonSpecs: string[];
  nodeDependenciesUnreviewable?: true;
}

/** A requirements file larger than this is treated as absent instead of being read. */
export const RUNTIME_MANIFEST_MAX_BYTES = 256 * 1024;

/** `-r` includes are followed like pip does, but a package cannot chain them forever. */
const MAX_INCLUDE_DEPTH = 3;
const MAX_PACKAGES = 1000;
const MAX_SPEC = 500;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}/;
const IGNORED = /(?:^|\/)(?:node_modules|\.venv|venv|\.git|site-packages)\//;
export const NODE_SCRIPT_GLOB = "**/*.{[jJ][sS],[cC][jJ][sS],[mM][jJ][sS]}";
const NODE_SCRIPT = /\.[cm]?js$/i;

/** Packages that compile or load a platform library on at least one OS (skia-pathops, uharfbuzz, ...). */
const NATIVE_MODULES = new Set([
  "cairocffi",
  "cryptography",
  "lxml",
  "matplotlib",
  "numpy",
  "opencv-python",
  "orjson",
  "pandas",
  "pillow",
  "pillow-heif",
  "pycairo",
  "pydantic-core",
  "pyyaml",
  "rpds-py",
  "scikit-image",
  "shapely",
  "skia-pathops",
  "uharfbuzz",
  "weasyprint",
]);

function depthOf(path: string): number {
  return path.split("/").length;
}

function include(base: string, target: string): string | undefined {
  if (target.startsWith("/") || target.includes("..") || target.includes("://")) return undefined;
  const folder = base.slice(0, base.lastIndexOf("/") + 1);
  return `${folder}${target}`;
}

async function requirementLines(
  manifest: string,
  read: (path: string) => Promise<string | undefined>,
  depth: number,
  out: string[],
  seen: Set<string>,
  signal: AbortSignal,
): Promise<void> {
  if (depth > MAX_INCLUDE_DEPTH || seen.has(manifest) || out.length >= MAX_PACKAGES) return;
  seen.add(manifest);
  const text = await read(manifest);
  if (text === undefined) return;
  for (const raw of text.split(/\r?\n/)) {
    signal.throwIfAborted();
    const line = (raw.split("#")[0] ?? "").trim();
    if (!line || out.length >= MAX_PACKAGES) continue;
    const nested = /^(?:-r|--requirement)(?:\s+|=)(\S+)$/.exec(line);
    if (nested?.[1]) {
      const next = include(manifest, nested[1]);
      if (next) await requirementLines(next, read, depth + 1, out, seen, signal);
      continue;
    }
    // Options, local paths and VCS URLs are not installable by name; the approval card shows what
    // was understood, so silently skipping the rest is safer than guessing at it.
    if (line.startsWith("-") || line.startsWith("/") || line.includes("://")) continue;
    if (line.length > MAX_SPEC || !NAME.test(line)) continue;
    out.push(line);
  }
}

function pyproject(text: string): { specs: string[]; version?: string } {
  const start = text.search(/^\[project\]\s*$/m);
  if (start < 0) return { specs: [] };
  const rest = text.slice(start + "[project]".length);
  const end = rest.search(/^\[/m);
  const block = end < 0 ? rest : rest.slice(0, end);
  const specs: string[] = [];
  for (const match of (block.match(/dependencies\s*=\s*\[([\s\S]*?)\]?\]/)?.[1] ?? "").matchAll(
    /["']([^"']+)["']/g,
  )) {
    const spec = match[1]?.trim();
    if (spec && spec.length <= MAX_SPEC && NAME.test(spec) && specs.length < MAX_PACKAGES)
      specs.push(spec);
  }
  const version = /requires-python\s*=\s*["']([^"']+)["']/.exec(block)?.[1];
  return { specs, ...(version ? { version: version.slice(0, 200) } : {}) };
}

function nodeManifest(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A malformed package.json is a package problem the preview already shows as no runtime.
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const names = (dependencies: unknown) =>
    dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
      ? Object.keys(dependencies)
      : [];
  // npm resolves root peers and installs optional packages for the current platform.
  const direct = [
    ...new Set([
      ...names(record.dependencies),
      ...names(record.optionalDependencies),
      ...names(record.peerDependencies),
    ]),
  ];
  const unreviewable =
    Object.hasOwn(record, "workspaces") ||
    direct.length > MAX_PACKAGES ||
    direct.some((name) => !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name) || name.length > 214);
  const engines = record.engines;
  const engine =
    engines && typeof engines === "object" && !Array.isArray(engines)
      ? (engines as Record<string, unknown>).node
      : undefined;
  return {
    packages: unreviewable ? [] : direct,
    unreviewable,
    ...(typeof engine === "string" ? { version: engine.slice(0, 200) } : {}),
  };
}

export async function detectRuntimeRequirements(
  files: readonly string[],
  read: (path: string) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<SkillRuntimeDetection> {
  const aborted = signal ?? new AbortController().signal;
  const requirements: SkillRuntimeRequirement[] = [];
  const native = new Set<string>();
  const specs: string[] = [];
  let nodeDependenciesUnreviewable: true | undefined;

  const root = files
    .filter(
      (path) => !IGNORED.test(path) && path.endsWith("requirements.txt") && depthOf(path) <= 2,
    )
    .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b))[0];
  if (root) await requirementLines(root, read, 0, specs, new Set(), aborted);

  let version: string | undefined;
  if (files.includes("pyproject.toml")) {
    const text = await read("pyproject.toml");
    if (text !== undefined) {
      const parsed = pyproject(text);
      // requirements.txt wins when both exist: it is what the author told pip to install, and
      // pyproject only adds a Python range that requirements cannot express.
      if (!specs.length) specs.push(...parsed.specs);
      version = parsed.version;
    }
  }

  const names = [...new Set(specs.map((spec) => NAME.exec(spec)?.[0] ?? "").filter(Boolean))];
  if (names.length || version) {
    requirements.push({
      runtime: "python",
      ...(version ? { version } : {}),
      ...(names.length ? { packages: names.slice(0, MAX_PACKAGES) } : {}),
    });
    for (const name of names) {
      const lower = name.toLowerCase();
      if (NATIVE_MODULES.has(lower)) native.add(lower);
    }
  }

  if (files.includes("package.json")) {
    const text = await read("package.json");
    if (text !== undefined) {
      const parsed = nodeManifest(text);
      if (parsed) {
        if (parsed.unreviewable) nodeDependenciesUnreviewable = true;
        requirements.push({
          runtime: "node",
          ...(parsed.version ? { version: parsed.version } : {}),
          ...(parsed.packages.length ? { packages: parsed.packages } : {}),
        });
        for (const name of parsed.packages) {
          const lower = name.toLowerCase();
          if (NATIVE_MODULES.has(lower)) native.add(lower);
        }
      }
    }
  }

  if (
    !requirements.some(({ runtime }) => runtime === "node") &&
    files.some((path) => !IGNORED.test(path) && NODE_SCRIPT.test(path))
  )
    requirements.push({ runtime: "node" });

  return {
    requirements,
    native: [...native].sort(),
    pythonSpecs: specs,
    nodeDependenciesUnreviewable,
  };
}
