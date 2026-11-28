// Option a (maintainers 2026-11-14): the separately signed Node every child workload runs on
// (sandbox hosts, the violation-log supervisor, checkpoint scripts, built-in stdio plugin servers,
// external-agent adapters). Pi Bot's own executable ships with the RunAsNode fuse off.
//
// Official nodejs.org build, exact version, SHA-256 pinned here (copied from that release's
// SHASUMS256.txt) and checked before anything is unpacked. Keep NODE_HELPER_VERSION equal to
// CHILD_NODE_VERSION in packages/execution/src/runtime/child-node.ts.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const NODE_HELPER_VERSION = "26.11.1";
const DIGESTS = {
  "darwin-arm64.tar.gz": "d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac",
  "darwin-x64.tar.gz": "9a8129bd9ab08039793dd1143a7aedee6b5d60ac06592ad938d8bddf36142f3a",
  "linux-arm64.tar.gz": "170454fb022f5e9b5f6cc76c25fa32ef5100895be44eb04e92f9780591491bbf",
  "linux-x64.tar.gz": "15fc043a51a5783f2f4b634561091658f5a7f0e3db03f997dca3a8033a33e45b",
  "win-arm64.zip": "8dd03add3ed431eb436306f9abe946434bce928d2bf967b04117dc3755051208",
  "win-x64.zip": "97f36a8a9684ff0d3e35758b4610fef5b628a5880e96f2ccc11240e5daf9934e",
};
const MAX_ARCHIVE = 200 * 1024 * 1024;
const run = promisify(execFile);

/**
 * Downloads (or reuses from .cache) and verifies the archive for one target, then writes the
 * binary and its licence into `binDirectory` as `node` / `node.exe` and `node-LICENSE`.
 */
export async function prepareNodeHelper(desktop, platform, arch, binDirectory) {
  const official = platform === "win32" ? "win" : platform;
  const suffix = platform === "win32" ? "zip" : "tar.gz";
  const key = `${official}-${arch}.${suffix}`;
  const expected = DIGESTS[key];
  if (!expected) throw new Error(`No pinned Node helper for ${key}`);
  const name = `node-v${NODE_HELPER_VERSION}-${official}-${arch}`;
  const cache = join(desktop, "../../.cache/pibot-node", NODE_HELPER_VERSION);
  await mkdir(cache, { recursive: true });
  const archive = join(cache, `${name}.${suffix}`);
  let bytes;
  let downloaded = false;
  try {
    bytes = await readFile(archive);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
    const response = await fetch(
      `https://nodejs.org/dist/v${NODE_HELPER_VERSION}/${name}.${suffix}`,
      {
        signal: AbortSignal.timeout(300_000),
      },
    );
    if (!response.ok) throw new Error(`Node helper download failed (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_ARCHIVE) throw new Error("Node helper archive exceeds limit");
    bytes = buffer;
    downloaded = true;
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    await rm(archive, { force: true });
    throw new Error(`Node helper checksum mismatch for ${key}`);
  }
  if (downloaded) await writeFile(archive, bytes, { mode: 0o600 });
  const temporary = await mkdtemp(join(tmpdir(), "pibot-node-helper-"));
  try {
    if (suffix === "zip") await run("unzip", ["-q", archive, "-d", temporary]);
    else await run("tar", ["-xzf", archive, "-C", temporary]);
    const root = join(temporary, name);
    const executable = platform === "win32" ? "node.exe" : "node";
    await mkdir(binDirectory, { recursive: true });
    const target = join(binDirectory, executable);
    await copyFile(join(root, platform === "win32" ? executable : join("bin", executable)), target);
    // npm comes from the same verified archive as Node. Use its JS entry on every platform.
    await cp(
      join(root, ...(platform === "win32" ? [] : ["lib"]), "node_modules", "npm"),
      join(binDirectory, "npm"),
      { recursive: true },
    );
    await copyFile(join(root, "LICENSE"), join(binDirectory, "node-LICENSE"));
    if (platform !== "win32") await chmod(target, 0o755);
    const before = (await stat(target)).size;
    // Local symbols only; the exported N-API surface stays. macOS re-signs it afterwards anyway.
    if (platform === "darwin" && process.platform === "darwin")
      await run("/usr/bin/strip", ["-x", target]);
    if (platform === "linux" && process.platform === "linux")
      await run("/usr/bin/strip", ["--strip-unneeded", target]);
    console.info(
      JSON.stringify({
        event: "package.node_helper",
        version: NODE_HELPER_VERSION,
        target: key,
        sha256: actual,
        bytes: { before, after: (await stat(target)).size },
      }),
    );
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
