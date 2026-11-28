import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join } from "node:path";

/** Main bundles workspace sources; bare third-party imports resolve from desktop at runtime. */
export function isThirdPartyRuntimeDependency(name: string) {
  return (
    !name.startsWith("@pibot/") &&
    !name.startsWith(".") &&
    !name.startsWith("/") &&
    !isBuiltin(name) &&
    name !== "electron"
  );
}

/** The lint graph and production build must start from the same independently loaded entries. */
export function desktopMainInputs(root: string, includeLocalGmail = false) {
  const inputs = {
    index: join(root, "src/main/index.ts"),
    "sandbox-doctor": join(root, "src/main/sandbox-doctor-cli.ts"),
    "linux-sandbox-check": join(root, "src/main/linux/sandbox-check.ts"),
    brain: join(root, "src/brain/index.ts"),
    "attachment-worker": join(
      root,
      "../../packages/brain/src/conversations/attachments/attachment-worker.ts",
    ),
    "import-cleanup-worker": join(root, "../../packages/import/src/store/import-cleanup-worker.ts"),
    "office-worker": join(root, "../../packages/office/src/brain/worker-entry.ts"),
    "semantic-worker": join(root, "../../packages/execution/src/semantic/worker.ts"),
    "codemap-worker": join(root, "../../packages/execution/src/codemap/worker.ts"),
    "html-text-worker": join(root, "../../packages/execution/src/web/html-text-worker.ts"),
    "sandbox-host": join(root, "../../packages/execution/src/sandbox/sandbox-host.ts"),
    "violation-log": join(root, "../../packages/execution/src/sandbox/violation-log.ts"),
    "plugin-calendar-server": join(root, "../plugins/calendar/server/index.ts"),
    "plugin-contacts-server": join(root, "../plugins/contacts/server/index.ts"),
    "plugin-image-inspiration-server": join(root, "../plugins/image-inspiration/server/index.ts"),
    // The relay an external agent starts as its `pibot` MCP server (helper Node, sandboxed).
    "pibot-mcp-bridge": join(root, "../../packages/external-agents/src/bridge/pibot-mcp-bridge.ts"),
  } as Record<string, string>;
  if (includeLocalGmail)
    inputs["plugin-gmail-server"] = join(root, "../plugins/gmail/server/index.ts");
  return inputs;
}

/** Resolve the installed production graph at build time; never install or contact a registry. */
export function thirdPartyDependencies(manifest: string) {
  const queue = [manifest],
    seen = new Set<string>();
  const result = new Map<string, { name: string; version: string; license: string }>();
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    if (!file || seen.has(file)) continue;
    seen.add(file);
    if (seen.size > 5000) throw new Error("dependency_manifest_limit");
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (isThirdPartyRuntimeDependency(pkg.name) && file !== manifest)
      result.set(`${pkg.name}@${pkg.version}`, {
        name: pkg.name,
        version: pkg.version,
        license:
          typeof pkg.license === "string"
            ? pkg.license
            : typeof pkg.license?.type === "string"
              ? pkg.license.type
              : "SEE LICENSE IN PACKAGE",
      });
    const require = createRequire(file);
    // Renderer-only libraries are devDependencies (Vite bundles them, so the package does not ship
    // their node_modules copy), but their code ships in out/renderer and keeps its notice.
    const bundled = [
      ...(file === manifest && Array.isArray(pkg.rendererBundled) ? pkg.rendererBundled : []),
      // Build-time devDependencies whose files are copied into the app (code map grammars:
      // only their .wasm and tags queries ship, via prepare-resources) keep their notice too.
      ...(Array.isArray(pkg.pibot?.shippedAssets) ? pkg.pibot.shippedAssets : []),
    ];
    for (const name of [
      ...Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }),
      ...bundled,
    ]) {
      const target = require.resolve
        .paths(`${name}/`)
        ?.map((path) => join(path, name, "package.json"))
        .find(existsSync);
      if (target) queue.push(realpathSync(target));
      else if (!Object.hasOwn(pkg.optionalDependencies ?? {}, name))
        throw new Error(`dependency_manifest_missing:${pkg.name}:${name}`);
    }
  }
  const rootRequire = createRequire(manifest);
  const electronFile = rootRequire.resolve
    .paths("electron/")
    ?.map((path) => join(path, "electron", "package.json"))
    .find(existsSync);
  if (electronFile) {
    const electron = JSON.parse(readFileSync(electronFile, "utf8"));
    result.set(`electron@${electron.version}`, {
      name: "electron",
      version: electron.version,
      license: electron.license,
    });
  }
  return [...result.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}
