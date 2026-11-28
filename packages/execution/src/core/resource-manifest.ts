import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const ResourceManifest = z.object({
  version: z.literal(2),
  resources: z
    .array(
      z
        .object({
          path: z
            .string()
            .max(4096)
            .refine(
              (path) =>
                !isAbsolute(path) &&
                path.startsWith("resources/") &&
                path
                  .split("/")
                  .every((part) => part && part !== "." && part !== ".." && !/[\\\0:]/.test(part)),
            ),
          bytes: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    )
    .max(10_000),
});

export class ResourceVerificationTimeout extends Error {
  constructor() {
    super("runner_resources_timeout");
  }
}

/** Integrity only; pairing and policy remain the authority to execute anything. */
export async function verifyResourceManifest(root: string, expectedDigest: string) {
  const manifestPath = join(root, "manifest.json");
  if ((await lstat(manifestPath)).size > 2 * 1024 * 1024)
    throw new Error("runner_manifest_invalid");
  const manifest = ResourceManifest.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (
    createHash("sha256").update(JSON.stringify(manifest.resources)).digest("hex") !== expectedDigest
  )
    throw new Error("runner_manifest_invalid");
  // First start on a busy host can be much slower while its antivirus scans the resources.
  const signal = AbortSignal.timeout(120_000);
  try {
    for (const item of manifest.resources) {
      const path = join(root, ...item.path.split("/"));
      const info = await lstat(path);
      signal.throwIfAborted();
      if (!info.isFile() || info.isSymbolicLink() || info.size !== item.bytes)
        throw new Error("runner_resource_invalid");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
      signal.throwIfAborted();
      if (hash.digest("hex") !== item.sha256) throw new Error("runner_resource_invalid");
    }
  } catch (error) {
    if (signal.aborted) throw new ResourceVerificationTimeout();
    throw error;
  }
}
