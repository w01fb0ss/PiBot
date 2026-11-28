// Domain directory rules: each listed package keeps its code in domain folders, only the named
// composition files sit at its source root, and `core/` never value-imports another domain.
// Type-only imports (`import type`, `import("x").T`) are free: they carry no runtime dependency.
// Run: node tools/dev/domain-boundaries.ts   (part of `pnpm lint`)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import {
  desktopMainInputs,
  isThirdPartyRuntimeDependency,
} from "../../apps/desktop/scripts/package/third-party-dependencies.ts";

interface PackageRule {
  /** Source root, relative to the repository. */
  src: string;
  /** Files allowed directly in the source root (the composition layer). */
  root: string[];
  domains: string[];
}

const rules: PackageRule[] = [
  {
    src: "packages/brain/src",
    root: ["index.ts", "local-service.ts", "kit.ts", "orchestration-kit.ts", "brain.test.ts"],
    domains: ["core", "runtime", "conversations", "resources", "integrations", "skills"],
  },
];

/**
 * Packages already organised into module folders. Their src/
 * root may hold only the entry; everything else lives in a module folder. Add a package here once
 * it has been reorganised.
 */
const modular: { src: string; root: string[] }[] = [
  { src: "packages/computer-use/src", root: [] },
  { src: "packages/computer-use-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/browser/src", root: [] },
  { src: "packages/browser-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/workspaces/src", root: [] },
  { src: "packages/workspaces-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/teams-contract/src", root: ["index.ts"] },
  { src: "packages/teams/src", root: [] },
  { src: "packages/models-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/models/src", root: [] },
  { src: "packages/memory/src", root: [] },
  { src: "packages/orchestration/src", root: ["index.ts", "full.ts"] },
  { src: "packages/office/src", root: [] },
  { src: "packages/import/src", root: [] },
  { src: "packages/import-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/images/src", root: [] },
  { src: "packages/videos/src", root: [] },
  { src: "packages/external-agents/src", root: [] },
  { src: "packages/external-agents-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/acp-schemas/src", root: ["index.ts"] },
  { src: "packages/office-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/images-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/videos-contract/src", root: ["index.ts"] },
  { src: "packages/credentials/src", root: [] },
  { src: "packages/credentials-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/client-core/src", root: ["index.ts", "full.ts"] },
  { src: "packages/link/src", root: ["index.ts", "full.ts"] },
  { src: "apps/relay/src", root: ["index.ts", "full.ts"] },
  { src: "packages/remote-contract/src", root: ["index.ts"] },
  { src: "packages/remote/src", root: [] },
  { src: "packages/protocol-base/src", root: ["index.ts", "full.ts"] },
  { src: "packages/protocol/src", root: ["index.ts", "full.ts"] },
  { src: "packages/routines-contract/src", root: ["index.ts"] },
  { src: "packages/plugins-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/skills-contract/src", root: ["index.ts", "full.ts"] },
  { src: "packages/skills/src", root: [] },
  { src: "packages/brain-app/src", root: ["index.ts", "full.ts"] },
  { src: "packages/routines/src", root: [] },
  { src: "packages/renderer-kit/src", root: ["index.ts", "full.ts"] },
  { src: "packages/policy/src", root: ["index.ts", "full.ts"] },
  { src: "packages/storage/src", root: ["index.ts", "full.ts"] },
  { src: "packages/execution/src", root: ["index.ts", "full.ts"] },
  { src: "packages/agent/src", root: ["index.ts", "full.ts"] },
  { src: "packages/computer/src", root: ["index.ts", "full.ts"] },
  { src: "packages/ui/src", root: ["index.ts", "full.ts"] },
  { src: "packages/scheduler/src", root: ["index.ts", "full.ts"] },
  { src: "packages/secrets/src", root: ["index.ts", "full.ts"] },
  { src: "packages/plugins/src", root: [] },
  { src: "sdk/plugin-sdk/src", root: ["index.ts", "full.ts"] },
  { src: "packages/observability/src", root: ["index.ts", "full.ts"] },
  { src: "packages/tools/src", root: ["index.ts", "full.ts"] },
];

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const valueImport =
  /(?:^|\n)\s*(import|export)\s+(?!type\s)(?:[^;'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']|(?<![.\w])import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)(?!\s*\.)/g;
const problems: string[] = [];

// Shared clients run in Hermes too: neither the desktop shell nor Node belongs in this package.
const clientRoot = join(repo, "packages/client-core");
const clientManifest = JSON.parse(readFileSync(join(clientRoot, "package.json"), "utf8"));
const clientDependencies = new Set(["@pibot/protocol", "@pibot/i18n"]);
for (const dep of Object.keys({
  ...clientManifest.dependencies,
  ...clientManifest.devDependencies,
}))
  if (!clientDependencies.has(dep))
    problems.push(`packages/client-core: forbidden dependency ${dep}`);
for (const file of files(join(clientRoot, "src"))) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
    const spec = match[1] ?? "";
    const permitted =
      !/\.(css|tsx)$/.test(spec) &&
      (spec.startsWith(".")
        ? resolve(dirname(file), spec).startsWith(`${clientRoot}${sep}`)
        : clientDependencies.has(spec));
    if (!permitted) problems.push(`${relative(repo, file)}: non-portable import ${spec}`);
  }
}

// The standalone runner is a narrow product root, not a second brain composition root.
const runnerAppRoot = join(repo, "apps/runner");
const runnerAppManifest = JSON.parse(readFileSync(join(runnerAppRoot, "package.json"), "utf8"));
const runnerAppDependencies = new Set([
  // 只在 scripts/installer 里用来复用 electron-builder 自带的 NSIS（不引入新的安装器
  // 工具），src/ 不导入，也不进安装包。
  "app-builder-lib",
  // Build-time only (scripts/sea/windows-version.ts): Pi Bot Runner's version strings and icon on
  // the SEA pibot.exe. Same version electron-builder already pulls in; never bundled or shipped.
  "resedit",
  // The standalone host reuses the computer boundary and a synchronous native image codec.
  "@pibot/computer",
  "@napi-rs/image",
  // Node-only discovery and authenticated WebSocket transport, no brain composition.
  "node-datachannel",
  "multicast-dns",
  "ws",
  "@types/multicast-dns",
  "@types/ws",
  // Proxy auto-config scripts are untrusted code: they run in QuickJS compiled to WebAssembly,
  // never in node:vm inside the runner's process.
  "quickjs-wasi",
  "@pibot/protocol-base",
  "@pibot/execution",
  // Target-local policy facts reuse the desktop parser; never a brain composition.
  "@pibot/policy",
  "@pibot/link",
  "@pibot/runner",
  "@pibot/secrets",
]);
for (const dep of Object.keys({
  ...runnerAppManifest.dependencies,
  ...runnerAppManifest.devDependencies,
}))
  if (!runnerAppDependencies.has(dep)) problems.push(`apps/runner: forbidden dependency ${dep}`);
for (const file of files(join(runnerAppRoot, "src"))) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(
    /from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm,
  )) {
    const spec = match[1] ?? match[2] ?? match[3] ?? "";
    const workspacePackage = spec.startsWith("@pibot/")
      ? spec.split("/").slice(0, 2).join("/")
      : spec;
    const allowed =
      spec.startsWith("node:") ||
      runnerAppDependencies.has(workspacePackage) ||
      (spec.startsWith(".") && resolve(dirname(file), spec).startsWith(`${runnerAppRoot}${sep}`));
    if (!allowed) problems.push(`${relative(repo, file)}: forbidden runner import ${spec}`);
  }
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

for (const rule of rules) {
  const src = join(repo, rule.src);
  for (const name of readdirSync(src)) {
    const path = join(src, name);
    if (statSync(path).isDirectory()) {
      if (!rule.domains.includes(name)) problems.push(`${rule.src}/${name}: not a known domain`);
    } else if (!rule.root.includes(name))
      problems.push(`${rule.src}/${name}: only composition files may sit at the source root`);
  }
  for (const file of files(join(src, "core"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(valueImport)) {
      const spec = match[2] ?? match[3];
      if (!spec) continue;
      const target = relative(src, resolve(dirname(file), spec))
        .split(sep)
        .join("/");
      if (!target.startsWith("core/") && !target.startsWith(".."))
        problems.push(`${relative(repo, file)}: core imports ${target} (value import)`);
    }
  }
}

for (const rule of modular) {
  const src = join(repo, rule.src);
  for (const name of readdirSync(src))
    if (!statSync(join(src, name)).isDirectory() && !rule.root.includes(name))
      problems.push(
        `${rule.src}/${name}: put it in a module folder (src/ root holds only the entry)`,
      );
}

// No package reaches into another package's source by relative path (2026-10-21: aggregator i18n
// imported "../../<contract>/src/..."). Cross-package use goes through the package entry.
for (const name of readdirSync(join(repo, "packages"))) {
  const src = join(repo, "packages", name, "src");
  try {
    if (!statSync(src).isDirectory()) continue;
  } catch {
    continue;
  }
  const root = join(repo, "packages", name);
  // Tests may compose packages (a kernel test registering capabilities); production code may not.
  for (const file of files(src).filter((path) => !/\.test\.tsx?$/.test(path))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(dirname(file), match[1] ?? "");
      if (!target.startsWith(root + sep))
        problems.push(`${relative(repo, file)}: relative import leaves the package (${match[1]})`);
    }
  }
}

// Capability packages and the kernel. The kernel never depends on a capability; a capability
// reaches the brain kernel only through its public kit and never through a deep or relative path.
const capabilities = [
  "remote",
  "computer-use",
  "browser",
  "workspaces",
  "teams",
  "routines",
  "plugins",
  "office",
  "import",
  "images",
  "videos",
  "external-agents",
  "credentials",
  "skills",
  "models",
  "memory",
  "orchestration",
];
const kernel = [
  "protocol-base",
  "secrets",
  "observability",
  "storage",
  "agent",
  "policy",
  "execution",
  "scheduler",
  "computer",
  "tools",
  "brain",
  "renderer-kit",
];
const protocolIndependentKernel = new Set([
  "storage",
  "agent",
  "policy",
  "scheduler",
  "tools",
  "brain",
]);
for (const name of kernel) {
  const manifest = JSON.parse(readFileSync(join(repo, "packages", name, "package.json"), "utf8"));
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
    if (name === "tools" && dep === "@pibot/brain")
      problems.push("packages/tools: L2 tools must not depend on @pibot/brain");
    else if (
      capabilities.some((cap) => dep === `@pibot/${cap}` || dep === `@pibot/${cap}-contract`)
    )
      problems.push(`packages/${name}: kernel package depends on capability ${dep}`);
    else if (protocolIndependentKernel.has(name) && dep === "@pibot/protocol")
      problems.push(`packages/${name}: kernel package depends on aggregate ${dep}`);
}
for (const cap of capabilities) {
  const root = join(repo, "packages", cap);
  for (const file of files(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm,
    )) {
      const spec = match[1] ?? match[2] ?? match[3] ?? "";
      const allowedBrainEntry =
        spec === "@pibot/brain/kit" ||
        (cap === "orchestration" && spec === "@pibot/brain/orchestration-kit");
      if (spec.startsWith("@pibot/brain") && !allowedBrainEntry)
        problems.push(`${relative(repo, file)}: use @pibot/brain/kit, not ${spec}`);
      if (spec.startsWith(".") && !resolve(dirname(file), spec).startsWith(root))
        problems.push(`${relative(repo, file)}: relative import leaves the package (${spec})`);
      // Entries run in different processes: /brain in the brain, /host in the desktop main process,
      // /store under the brain. Entries share only the contract package and /store.
      const entry = relative(join(root, "src"), file).split(sep)[0];
      if (spec.startsWith(".")) {
        const target = relative(join(root, "src"), resolve(dirname(file), spec)).split(sep)[0];
        if (
          target !== entry &&
          (target !== "store" || entry === "ui") &&
          !(cap === "orchestration" && entry === "index.ts")
        )
          problems.push(
            `${relative(repo, file)}: entry ${entry} imports entry ${target} (${spec})`,
          );
      }
      // Hard rule 3: packages never import Electron; the desktop app injects its objects.
      if (spec === "electron" || spec.startsWith("electron/"))
        problems.push(`${relative(repo, file)}: packages must not import Electron`);
      if (entry === "host" && /^@pibot\/(brain|agent|execution|policy)(\/|$)/.test(spec))
        problems.push(`${relative(repo, file)}: the host entry must not load brain code (${spec})`);
      // The renderer half only talks to the brain over RPC: no repositories, no brain packages.
      if (
        entry === "ui" &&
        /^@pibot\/(brain|storage|agent|execution|policy|scheduler|observability|secrets)(\/|$)/.test(
          spec,
        )
      )
        problems.push(`${relative(repo, file)}: the ui entry must not load brain code (${spec})`);
      if (
        entry !== "ui" &&
        (spec === "react" || spec.startsWith("react-dom") || spec === "@pibot/renderer-kit")
      )
        problems.push(
          `${relative(repo, file)}: only the ui entry may use React or the renderer kit`,
        );
    }
  }
}

// The plugin SDK and plugin packages are leaf definitions. Concrete plugins stay out of the
// kernel and capability packages; only the two composition roots know which plugins ship.
const pluginSdkRoot = join(repo, "sdk/plugin-sdk");
const pluginSdkManifest = JSON.parse(readFileSync(join(pluginSdkRoot, "package.json"), "utf8"));
const pluginSdkDependencies = new Set([
  "@modelcontextprotocol/server",
  "rollup",
  "rollup-plugin-dts",
  "@typescript/typescript6",
  "@pibot/protocol-base",
  "zod",
]);
for (const dep of Object.keys({
  ...pluginSdkManifest.dependencies,
  ...pluginSdkManifest.devDependencies,
}))
  if (!pluginSdkDependencies.has(dep)) problems.push(`sdk/plugin-sdk: forbidden dependency ${dep}`);

// The MCP server implementation is an SDK implementation detail. In particular, plugin packages and
// CLI entrypoints cannot grow a second server adapter; the client remains isolated in agent.
for (const parent of ["packages", "apps", "sdk"])
  for (const name of readdirSync(join(repo, parent))) {
    const src = join(repo, parent, name, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of files(src)) {
      if (file.startsWith(`${pluginSdkRoot}${sep}`)) continue;
      const source = readFileSync(file, "utf8");
      if (/from\s+["']@modelcontextprotocol\/server(?:\/[^"']*)?["']/.test(source))
        problems.push(`${relative(repo, file)}: MCP server SDK is only allowed in sdk/plugin-sdk`);
      if (
        /from\s+["']@modelcontextprotocol\/client(?:\/[^"']*)?["']/.test(source) &&
        !file.startsWith(`${join(repo, "packages/agent")}${sep}`)
      )
        problems.push(`${relative(repo, file)}: MCP client SDK is only allowed in packages/agent`);
    }
  }

const pluginsRoot = join(repo, "apps/plugins");
const concretePluginPackages = new Set<string>();
for (const name of readdirSync(pluginsRoot)) {
  const root = join(pluginsRoot, name);
  if (!statSync(root).isDirectory()) continue;
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  concretePluginPackages.add(manifest.name);
  const allowed = new Set(["@pibot/plugin-sdk", "zod"]);
  // The Gmail plugin's design explicitly permits these Gmail-only protocol clients; not a general plugin escape.
  const gmailClients = {
    imapflow: "2.12.1",
    nodemailer: "10.6.0",
    socks: "2.8.10",
    undici: "8.10.2",
  };
  if (name === "gmail")
    for (const [dep, version] of Object.entries(gmailClients)) {
      allowed.add(dep);
      if (manifest.dependencies?.[dep] !== version)
        problems.push(`apps/plugins/gmail: expected exact ${dep}@${version}`);
    }
  const allowedImports = new Set(allowed);
  if (name === "gmail") allowedImports.add("nodemailer/lib/mail-composer");
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
    if (!allowed.has(dep)) problems.push(`apps/plugins/${name}: forbidden dependency ${dep}`);
  // Code plugins keep their stdio server in server/; declarative ones may have no code at all.
  const sources = ["src", "server"].map((dir) => join(root, dir)).filter((dir) => existsSync(dir));
  for (const file of sources.flatMap((dir) => files(dir))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /from\s+["']([^"']+)["']|(?<![\w$.])import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm,
    )) {
      const spec = match[1] ?? match[2] ?? match[3] ?? "";
      if (spec.startsWith(".") && !resolve(dirname(file), spec).startsWith(`${root}${sep}`))
        problems.push(`${relative(repo, file)}: relative import leaves the plugin (${spec})`);
      if (!spec.startsWith(".") && !allowedImports.has(spec))
        problems.push(`${relative(repo, file)}: forbidden plugin import ${spec}`);
    }
  }
}

for (const [parent, names] of [
  ["packages", readdirSync(join(repo, "packages"))],
  ["apps", readdirSync(join(repo, "apps"))],
  ["sdk", readdirSync(join(repo, "sdk"))],
] as const)
  for (const name of names) {
    const root = join(repo, parent, name);
    if (!statSync(root).isDirectory()) continue;
    let manifest: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    } catch {
      // Grouping folders such as apps/plugins have no package.json; their children are scanned above.
      continue;
    }
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
      if (
        concretePluginPackages.has(dep) &&
        !(
          (parent === "packages" && name === "brain-app") ||
          (parent === "apps" && name === "desktop")
        )
      )
        problems.push(`${parent}/${name}: only composition roots may depend on ${dep}`);
  }

// Every workspace package declares its architectural layer. Dependencies normally point to
// the same or a lower numbered layer; cross-cutting packages may only use contracts/cross-cutting
// packages and L1. A few existing packages contain separate /brain and /ui adapters in one
// manifest, so an upward manifest edge is accepted only when every actual import occurs in the
// matching adapter entry. /store and /host never inherit a package-wide exception.
type Layer = "L1" | "L2" | "L3" | "L4" | "L5" | "cross";
interface LayerManifest {
  name: string;
  pibot?: { layer?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
function packageJsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) return [];
    if (name === "node_modules") return [];
    const manifest = join(path, "package.json");
    try {
      if (statSync(manifest).isFile()) return [manifest];
    } catch {
      // Grouping directories such as apps/plugins are traversed below.
    }
    return packageJsonFiles(path);
  });
}
const layerValues = new Set<Layer>(["L1", "L2", "L3", "L4", "L5", "cross"]);
const layerRank: Record<Exclude<Layer, "cross">, number> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
};
const layerPackages = new Map<string, { file: string; manifest: LayerManifest; layer: Layer }>();
for (const file of [
  ...packageJsonFiles(join(repo, "apps")),
  ...packageJsonFiles(join(repo, "packages")),
  ...packageJsonFiles(join(repo, "sdk")),
]) {
  const manifest = JSON.parse(readFileSync(file, "utf8")) as LayerManifest;
  if (!manifest.name?.startsWith("@pibot/")) continue;
  const layer = manifest.pibot?.layer as Layer | undefined;
  if (!layer || !layerValues.has(layer)) {
    problems.push(`${relative(repo, file)}: missing or invalid pibot.layer`);
    continue;
  }
  if (layerPackages.has(manifest.name))
    problems.push(`${relative(repo, file)}: duplicate package name`);
  layerPackages.set(manifest.name, { file, manifest, layer });
}
const importPattern =
  /from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm;
const packageName = (spec: string) => {
  if (!spec.startsWith("@pibot/")) return undefined;
  return spec.split("/").slice(0, 2).join("/");
};
const adapterImports = new Map<string, ReadonlySet<string>>([
  [
    "@pibot/brain-app:index.ts",
    new Set(["@pibot/protocol", "@pibot/remote", "@pibot/routines", "@pibot/teams"]),
  ],
  ["@pibot/browser:brain", new Set(["@pibot/brain"])],
  ["@pibot/browser:host", new Set(["@pibot/i18n"])],
  ["@pibot/browser:ui", new Set(["@pibot/i18n", "@pibot/renderer-kit", "@pibot/ui"])],
  ["@pibot/computer-use:brain", new Set(["@pibot/agent", "@pibot/brain"])],
  ["@pibot/computer-use:host", new Set(["@pibot/i18n", "@pibot/ui"])],
  [
    "@pibot/computer-use:ui",
    new Set(["@pibot/client-core", "@pibot/i18n", "@pibot/renderer-kit", "@pibot/ui"]),
  ],
  ["@pibot/credentials:brain", new Set(["@pibot/brain"])],
  [
    "@pibot/credentials:ui",
    new Set(["@pibot/client-core", "@pibot/i18n", "@pibot/renderer-kit", "@pibot/ui"]),
  ],
  ["@pibot/images:brain", new Set(["@pibot/agent", "@pibot/brain"])],
  ["@pibot/videos:brain", new Set(["@pibot/brain"])],
  ["@pibot/external-agents:brain", new Set(["@pibot/agent", "@pibot/brain"])],
  [
    "@pibot/external-agents:ui",
    new Set(["@pibot/client-core", "@pibot/i18n", "@pibot/renderer-kit", "@pibot/ui"]),
  ],
  ["@pibot/memory:brain", new Set(["@pibot/agent", "@pibot/brain"])],
  ["@pibot/models:brain", new Set(["@pibot/agent", "@pibot/brain"])],
  ["@pibot/models:ui", new Set(["@pibot/client-core", "@pibot/renderer-kit", "@pibot/ui"])],
  ["@pibot/import:brain", new Set(["@pibot/brain"])],
  ["@pibot/office:brain", new Set(["@pibot/brain"])],
  ["@pibot/office:ui", new Set(["@pibot/renderer-kit", "@pibot/ui"])],
  ["@pibot/plugins:brain", new Set(["@pibot/agent", "@pibot/brain"])],
  ["@pibot/plugins:ui", new Set(["@pibot/i18n", "@pibot/renderer-kit", "@pibot/ui"])],
  ["@pibot/skills:brain", new Set(["@pibot/agent", "@pibot/brain"])],
  ["@pibot/skills:ui", new Set(["@pibot/i18n", "@pibot/renderer-kit", "@pibot/ui"])],
  ["@pibot/workspaces:brain", new Set(["@pibot/agent", "@pibot/brain", "@pibot/scheduler"])],
  [
    "@pibot/workspaces:ui",
    new Set(["@pibot/client-core", "@pibot/i18n", "@pibot/renderer-kit", "@pibot/ui"]),
  ],
]);
const adapterImportAllowed = (source: string, target: string, sourceRoot: string, file: string) => {
  const entry = relative(join(sourceRoot, "src"), file).split(sep)[0];
  return adapterImports.get(`${source}:${entry}`)?.has(target) ?? false;
};
for (const [name, source] of layerPackages) {
  for (const dependency of Object.keys({
    ...source.manifest.dependencies,
    ...source.manifest.devDependencies,
  })) {
    const target = layerPackages.get(dependency);
    if (!target) continue;
    if (source.layer === "cross") {
      if (target.layer !== "cross" && target.layer !== "L1")
        problems.push(
          `${relative(repo, source.file)}: cross package depends on ${dependency} (${target.layer})`,
        );
      continue;
    }
    if (target.layer === "cross") continue;
    if (layerRank[target.layer] <= layerRank[source.layer]) continue;
    const sourceRoot = dirname(source.file);
    const importers = files(join(sourceRoot, "src")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(importPattern)].some(
        (match) => packageName(match[1] ?? match[2] ?? match[3] ?? "") === dependency,
      );
    });
    if (!importers.length) {
      problems.push(
        `${relative(repo, source.file)}: unused upward dependency ${dependency} (${target.layer})`,
      );
      continue;
    }
    for (const file of importers)
      if (!adapterImportAllowed(name, dependency, sourceRoot, file))
        problems.push(
          `${relative(repo, file)}: ${source.layer} entry imports upward ${dependency} (${target.layer})`,
        );
  }
}

// Runner deploys independently of desktop; its entire workspace closure must remain narrow.
const runnerPending = ["@pibot/runner-app"];
const runnerReachable = new Set(runnerPending);
while (runnerPending.length) {
  const current = layerPackages.get(runnerPending.shift() as string);
  if (!current) continue;
  for (const dependency of Object.keys(current.manifest.dependencies ?? {})) {
    if (!layerPackages.has(dependency) || runnerReachable.has(dependency)) continue;
    runnerReachable.add(dependency);
    runnerPending.push(dependency);
    if (!runnerAppDependencies.has(dependency))
      problems.push(`apps/runner: forbidden runtime workspace closure dependency ${dependency}`);
    else if (!Object.hasOwn(runnerAppManifest.dependencies ?? {}, dependency))
      problems.push(
        `apps/runner/package.json: runtime workspace closure dependency ${dependency} must be a direct dependency`,
      );
  }
}

// electron-vite bundles only the workspace packages named by desktop's direct dependencies.
// Keep the complete runtime closure explicit so a newly extracted package cannot survive checks
// yet become an external TypeScript import in the packaged brain process.
const desktopPackage = layerPackages.get("@pibot/desktop");
const brainAppPackage = layerPackages.get("@pibot/brain-app");
if (desktopPackage && brainAppPackage) {
  const desktopDependencies = new Set(Object.keys(desktopPackage.manifest.dependencies ?? {}));
  const pending = ["@pibot/desktop", "@pibot/brain-app"];
  const reachable = new Set(pending);
  while (pending.length) {
    const current = layerPackages.get(pending.shift() as string);
    if (!current) continue;
    for (const dependency of Object.keys(current.manifest.dependencies ?? {})) {
      if (!layerPackages.has(dependency) || reachable.has(dependency)) continue;
      reachable.add(dependency);
      pending.push(dependency);
    }
  }
  reachable.delete("@pibot/desktop");
  for (const dependency of [...reachable].sort())
    if (!desktopDependencies.has(dependency))
      problems.push(
        `apps/desktop/package.json: runtime workspace closure dependency ${dependency} must be a direct dependency`,
      );
  // Only imports retained in main/brain/workers need Node modules at runtime: manifest dependencies
  // may also belong exclusively to a renderer or to an unreferenced runner-only subpath.
  const thirdPartyOwners = new Map<string, string[]>();
  for (const name of [...reachable].sort()) {
    const current = layerPackages.get(name);
    if (!current) continue;
    for (const dependency of Object.keys(current.manifest.dependencies ?? {}).sort()) {
      if (!isThirdPartyRuntimeDependency(dependency) || layerPackages.has(dependency)) continue;
      const owners = thirdPartyOwners.get(dependency) ?? [];
      owners.push(name);
      thirdPartyOwners.set(dependency, owners);
    }
  }
  const external = [...new Set([...thirdPartyOwners.keys(), ...desktopDependencies])].filter(
    isThirdPartyRuntimeDependency,
  );
  // In-memory bundling resolves workspace exports and erases type-only imports without relying
  // on a possibly stale out/ directory. Bare third-party packages stay external as in Vite.
  const graph = buildSync({
    entryPoints: desktopMainInputs(dirname(desktopPackage.file)),
    outdir: join(repo, ".cache/desktop-runtime-lint"),
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    external: ["electron", ...external],
    define: { __PIBOT_DEV_BUILD__: "false" },
    tsconfig: join(repo, "apps/desktop/tsconfig.json"),
  });
  const required = new Set(
    Object.values(graph.metafile.outputs).flatMap((output) =>
      output.imports
        .filter((entry) => entry.external)
        .map((entry) =>
          entry.path.startsWith("@")
            ? entry.path.split("/").slice(0, 2).join("/")
            : (entry.path.split("/")[0] ?? ""),
        ),
    ),
  );
  for (const dependency of [...required].sort()) {
    const owners = thirdPartyOwners.get(dependency);
    if (owners && !desktopDependencies.has(dependency))
      problems.push(
        `apps/desktop/package.json: external runtime dependency ${dependency} required by ${owners.join(", ")} must be a direct dependency`,
      );
  }
}

for (const [name, source] of layerPackages) {
  const root = dirname(source.file);
  const sources = ["src", "server"].map((dir) => join(root, dir)).filter((dir) => existsSync(dir));
  for (const file of sources.flatMap((dir) => files(dir))) {
    const text = readFileSync(file, "utf8");
    if (text.includes("@pibot/brain/orchestration-kit") && name !== "@pibot/orchestration")
      problems.push(
        `${relative(repo, file)}: only @pibot/orchestration may import brain/orchestration-kit`,
      );
    if (source.layer === "L1" || source.layer === "L2")
      for (const match of text.matchAll(importPattern)) {
        const spec = match[1] ?? match[2] ?? match[3] ?? "";
        if (packageName(spec) === "@pibot/protocol")
          problems.push(
            `${relative(repo, file)}: ${source.layer} code must use protocol-base or a capability contract, not @pibot/protocol`,
          );
      }
  }
}

// Link crosses Node, Hermes and Workers. Its relay entry must not pull in a client or Node shim.
for (const name of ["link", "relay"]) {
  const root = join(repo, name === "link" ? "packages" : "apps", name);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const allowed =
    name === "link"
      ? ["@pibot/protocol-base", "@noble/curves", "@noble/ciphers", "@noble/hashes", "zod"]
      : ["@pibot/link"];
  for (const dep of Object.keys(manifest.dependencies ?? {}))
    if (!allowed.includes(dep))
      problems.push(`${relative(repo, root)}: unexpected runtime dependency ${dep}`);
  for (const file of files(join(root, "src"))) {
    const source = readFileSync(file, "utf8");
    if (name === "link" && /\b(?:Buffer|document|window)\s*[.(]/.test(source))
      problems.push(`${relative(repo, file)}: link cannot use Buffer or DOM globals`);
    for (const match of source.matchAll(
      /from\s+["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']/g,
    )) {
      const spec = match[1] ?? match[2] ?? match[3] ?? "";
      if (spec.startsWith("node:") || spec === "electron" || spec.startsWith("react"))
        problems.push(`${relative(repo, file)}: non-portable runtime import ${spec}`);
      if (name === "relay" && spec.startsWith("@pibot/") && spec !== "@pibot/link/room")
        problems.push(`${relative(repo, file)}: relay only imports @pibot/link/room`);
    }
  }
}

if (problems.length) {
  console.error(`Domain boundary violations:\n${problems.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
