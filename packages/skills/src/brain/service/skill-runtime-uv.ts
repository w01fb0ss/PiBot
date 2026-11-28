import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readScannedFile, zipEntries } from "@pibot/brain/kit";
import { SKILL_PYTHON_MIRROR, withPublicDownload } from "@pibot/execution";

// Astral uv 0.13.7: https://github.com/astral-sh/uv/releases/tag/0.13.7
// Digests are copied from each adjacent official release asset's .sha256 file.
export const UV_VERSION = "0.13.7";
const RELEASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
const ASSETS = {
  "aarch64-apple-darwin": [
    14347867,
    "81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731",
  ],
  "x86_64-apple-darwin": [
    17026382,
    "20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7",
  ],
  "x86_64-pc-windows-msvc": [
    15236317,
    "0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021",
  ],
  "aarch64-pc-windows-msvc": [
    15538425,
    "505d9e65e7692bac3ddf98c66754aa26c5050c409c184af30a881a0a72cc85e3",
  ],
  "x86_64-unknown-linux-gnu": [
    16671812,
    "c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83",
  ],
  "aarch64-unknown-linux-gnu": [
    15896996,
    "71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc",
  ],
} as const;
const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
type NetworkProxy = Parameters<typeof withPublicDownload>[0]["proxy"];
const MAX_BINARY = 64 * 1024 * 1024;

export class SkillUvError extends Error {
  constructor(
    readonly reason: "uv_download_failed" | "uv_checksum_mismatch" | "uv_network_failed",
  ) {
    super(reason);
  }
}

function asset(platform: NodeJS.Platform, arch: string) {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  const os = { darwin: "apple-darwin", win32: "pc-windows-msvc", linux: "unknown-linux-gnu" }[
    platform as "darwin" | "win32" | "linux"
  ];
  if (!cpu || !os) return undefined;
  const target = `${cpu}-${os}` as keyof typeof ASSETS;
  const [bytes, sha256] = ASSETS[target];
  const zip = platform === "win32";
  return { bytes, sha256, zip, target, url: `${RELEASE}/uv-${target}.${zip ? "zip" : "tar.gz"}` };
}

export async function ensurePrivateDir(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await lstat(path)).isDirectory()) throw new Error("invalid_runtime_directory");
}

/** Only the named regular entry is materialized; no archive path is ever used to write a file. */
async function executable(
  path: string,
  release: NonNullable<ReturnType<typeof asset>>,
  signal: AbortSignal,
) {
  if (release.zip) {
    const { files } = await zipEntries(path, signal);
    const entry = files.find(
      (file) => file.path === "uv.exe" || file.path === `uv-${release.target}/uv.exe`,
    );
    if (entry) return readScannedFile(entry, signal, MAX_BINARY);
  } else {
    const tar = gunzipSync(await readFile(path, { signal }), {
      maxOutputLength: 128 * 1024 * 1024,
    });
    for (let offset = 0; offset + 512 <= tar.length; ) {
      signal.throwIfAborted();
      const header = tar.subarray(offset, offset + 512);
      const field = (start: number, end: number) =>
        header.toString("ascii", start, end).split("\0")[0] ?? "";
      const name = field(0, 100);
      if (!name) break;
      const length = field(124, 136).trim();
      if (!/^[0-7]+$/.test(length)) break;
      const size = Number.parseInt(length, 8);
      const start = offset + 512;
      if (size > tar.length - start) break;
      if (
        !field(345, 500) &&
        name === `uv-${release.target}/uv` &&
        ["", "0"].includes(field(156, 157)) &&
        size > 0 &&
        size <= MAX_BINARY
      )
        return tar.subarray(start, start + size);
      offset = start + Math.ceil(size / 512) * 512;
    }
  }
  throw new SkillUvError("uv_download_failed");
}

interface Flight {
  controller: AbortController;
  done: Promise<void>;
  waiters: number;
}

export class SkillUv {
  private readonly flights = new Map<boolean, Flight>();
  readonly release: ReturnType<typeof asset>;
  private readonly root: string;
  readonly path: string;

  constructor(
    dataDir: string,
    platform: NodeJS.Platform,
    arch: string,
    private readonly proxy?: () => NetworkProxy | undefined,
  ) {
    this.release = asset(platform, arch);
    this.root = join(dataDir, "runtimes", "uv");
    this.path = join(this.root, UV_VERSION, platform === "win32" ? "uv.exe" : "uv");
  }

  async ensure(signal: AbortSignal, useMirror = false): Promise<void> {
    signal.throwIfAborted();
    // Serialize publication across download sources while keeping the caller's choice on retry.
    const other = this.flights.get(!useMirror);
    if (other) {
      try {
        await this.wait(other, signal);
        return;
      } catch {
        signal.throwIfAborted();
        // The other source failed. Try the one selected on this card.
      }
    }
    let flight = this.flights.get(useMirror);
    if (flight?.controller.signal.aborted) {
      await flight.done.catch(() => undefined);
      signal.throwIfAborted();
      return this.ensure(signal, useMirror);
    }
    if (!flight) {
      const controller = new AbortController();
      const done = this.install(
        AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
        useMirror,
      ).finally(() => {
        this.flights.delete(useMirror);
      });
      flight = { controller, waiters: 0, done };
      this.flights.set(useMirror, flight);
    }
    await this.wait(flight, signal);
  }

  private async wait(flight: Flight, signal: AbortSignal) {
    flight.waiters++;
    let detach: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        detach = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
        void flight.done.then(resolve, reject);
      });
      signal.throwIfAborted();
    } finally {
      detach?.();
      if (--flight.waiters === 0 && signal.aborted) {
        flight.controller.abort();
        await flight.done.catch(() => undefined);
      }
    }
  }

  private async install(signal: AbortSignal, useMirror: boolean) {
    const release = this.release;
    if (!release) throw new SkillUvError("uv_download_failed");
    const versionDir = join(this.root, UV_VERSION);
    await ensurePrivateDir(join(this.root, ".."));
    await ensurePrivateDir(this.root);
    const existing = await lstat(versionDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing) {
      if (!existing.isDirectory() || !(await lstat(this.path)).isFile())
        throw new SkillUvError("uv_download_failed");
      return;
    }
    const stage = await mkdtemp(join(this.root, ".download-"));
    try {
      const archive = join(stage, release.zip ? "release.zip" : "release.tar.gz");
      const hash = createHash("sha256");
      try {
        await withPublicDownload(
          {
            url: useMirror
              ? release.url.replace(
                  "https://github.com/astral-sh/",
                  `https://${SKILL_PYTHON_MIRROR}/github/`,
                )
              : release.url,
            hosts: useMirror ? new Set([...DOWNLOAD_HOSTS, SKILL_PYTHON_MIRROR]) : DOWNLOAD_HOSTS,
            method: "GET",
            signal,
            proxy: this.proxy?.(),
            uvRelease: true,
          },
          async (response) => {
            if ([407, 502, 503, 504].includes(response.status))
              throw new SkillUvError("uv_network_failed");
            if (!response.ok || !response.body) throw new SkillUvError("uv_download_failed");
            const file = await open(archive, "wx", 0o600);
            try {
              let bytes = 0;
              for await (const chunk of response.body) {
                signal.throwIfAborted();
                bytes += chunk.length;
                if (bytes > release.bytes) throw new SkillUvError("uv_checksum_mismatch");
                hash.update(chunk);
                await file.writeFile(chunk);
              }
              if (bytes !== release.bytes || hash.digest("hex") !== release.sha256)
                throw new SkillUvError("uv_checksum_mismatch");
            } finally {
              await file.close();
            }
          },
        );
      } catch (error) {
        if (error instanceof SkillUvError) throw error;
        throw new SkillUvError("uv_network_failed");
      }
      const binary = await executable(archive, release, signal);
      const publish = join(stage, UV_VERSION);
      await mkdir(publish, { mode: 0o700 });
      await writeFile(join(publish, release.zip ? "uv.exe" : "uv"), binary, {
        flag: "wx",
        mode: 0o700,
        signal,
      });
      signal.throwIfAborted();
      await rename(publish, versionDir);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
