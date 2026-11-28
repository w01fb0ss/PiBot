import { SKILL_NODE_DOMAINS } from "@pibot/execution";
import { z } from "zod";

const packageName = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9_~-][a-z0-9._~-]*\/)?[a-z0-9_~-][a-z0-9._~-]*$/i);
const dependencyMap = z.record(
  packageName,
  z
    .string()
    .min(1)
    .max(500)
    .regex(/^[a-z0-9*.^~<>=|+ -]+$/i),
);
const declarations = z.object({
  dependencies: dependencyMap.optional(),
  devDependencies: dependencyMap.optional(),
  optionalDependencies: dependencyMap.optional(),
  peerDependencies: dependencyMap.optional(),
  peerDependenciesMeta: z
    .record(packageName, z.object({ optional: z.boolean().optional() }))
    .optional(),
});
const manifestSchema = declarations.extend({
  name: z.string().optional(),
  version: z.string().optional(),
  overrides: z.never().optional(),
  workspaces: z.never().optional(),
  bundleDependencies: z.never().optional(),
  bundledDependencies: z.never().optional(),
});
const registryEntry = declarations.extend({
  name: packageName.optional(),
  version: z
    .string()
    .max(128)
    .regex(/^\d+\.\d+\.\d+(?:[-+][a-z0-9.+-]+)?$/i),
  resolved: z.string(),
  integrity: z.string().regex(/^sha(?:512|384|256|1)-[A-Za-z0-9+/]+={0,2}$/),
  // Reject linked or bundled packages. Their contents cannot be reviewed individually.
  link: z.literal(false).optional(),
  inBundle: z.literal(false).optional(),
  dev: z.boolean().optional(),
  devOptional: z.boolean().optional(),
  optional: z.boolean().optional(),
  peer: z.boolean().optional(),
  hasInstallScript: z.boolean().optional(),
  engines: z.record(z.string(), z.string()).optional(),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  libc: z.array(z.string()).optional(),
});
const lockSchema = z.object({
  lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(z.string(), z.unknown()),
});

function canonicalDeclarations(value: z.infer<typeof declarations>) {
  return JSON.stringify(
    Object.entries(value).map(([key, entries]) => [
      key,
      Object.entries(entries ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
}

/** Windows installs only a pinned, reviewable registry graph into a fresh environment. */
export function reviewNodeInputs(manifest: string, lock: string | undefined, arch: string) {
  if (!lock) return undefined;
  try {
    const root = manifestSchema.parse(JSON.parse(manifest));
    const { packages } = lockSchema.parse(JSON.parse(lock));
    const lockedRoot = declarations.parse(packages[""]);
    if (canonicalDeclarations(declarations.parse(root)) !== canonicalDeclarations(lockedRoot))
      return undefined;

    const entries = Object.entries(packages);
    if (entries.length > 1001) return undefined;
    const reviewed: Record<string, unknown> = { "": root };
    const candidates = new Map<string, string>();
    const skipped = new Set<string>();
    const permits = (list: string[] | undefined, value: string) =>
      !list?.includes("!" + value) &&
      (!list?.some((item) => !item.startsWith("!")) || list.includes(value));
    for (const [path, value] of entries) {
      if (path === "") continue;
      const segments = path.split(/(?:^|\/)node_modules\//).slice(1);
      const name = segments.at(-1);
      if (
        !path.startsWith("node_modules/") ||
        !name ||
        !segments.every((part) => packageName.safeParse(part).success)
      )
        return undefined;
      const entry = registryEntry.parse(value);
      const leaf = name.split("/").at(-1);
      if (
        (entry.name !== undefined && entry.name !== name) ||
        entry.resolved !== `https://${SKILL_NODE_DOMAINS[0]}/${name}/-/${leaf}-${entry.version}.tgz`
      )
        return undefined;
      reviewed[path] = entry;
      if (
        entry.dev ||
        (entry.optional && (!permits(entry.os, "win32") || !permits(entry.cpu, arch)))
      )
        skipped.add(path);
      else candidates.set(path, `${name}@${entry.version}`);
    }

    // Missing required direct dependencies must not send npm to the registry to fill the lock.
    const required = new Set([
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.peerDependencies ?? {}).filter(
        (name) => root.peerDependenciesMeta?.[name]?.optional !== true,
      ),
    ]);
    for (const name of required)
      if (
        !Object.hasOwn(root.optionalDependencies ?? {}, name) &&
        !Object.hasOwn(reviewed, `node_modules/${name}`)
      )
        return undefined;

    // Feed npm only the validated package records. Version 2's legacy tree and any
    // additional fields in the original inputs can otherwise change how npm resolves sources.
    return {
      manifest: JSON.stringify(root),
      lock: JSON.stringify({
        name: root.name,
        version: root.version,
        lockfileVersion: 3,
        packages: reviewed,
      }),
      packages: [
        ...new Set(
          [...candidates].flatMap(([path, spec]) => {
            let at = path.lastIndexOf("/node_modules/");
            while (at >= 0) {
              if (skipped.has(path.slice(0, at))) return [];
              at = path.lastIndexOf("/node_modules/", at - 1);
            }
            return [spec];
          }),
        ),
      ].sort(),
    };
  } catch {
    // Malformed or unsupported inputs cannot produce an unisolated install plan.
    return undefined;
  }
}
