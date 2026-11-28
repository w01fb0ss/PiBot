import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code;
}

async function directory(path: string, uid: number) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    // A concurrent trash operation or file manager may already have created it.
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  // Renamed payloads retain their permissions, so only the owner may access this tree.
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new Error("Invalid Trash directory");
}

function mountRoot(path: string, mounts: string) {
  // Device IDs alone miss bind mounts. mountinfo gives the paths in this process's namespace.
  let root = "/";
  for (const line of mounts.split("\n")) {
    const point = line
      .split(" ", 6)[4]
      ?.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      );
    if (point && point.length > root.length && (path === point || path.startsWith(`${point}/`)))
      root = point;
  }
  return root;
}

function trashInfo(path: string, now: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("-");
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(pad).join(":");
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `[Trash Info]\nPath=${encoded}\nDeletionDate=${date}T${time}\n`;
}

async function move(
  source: string,
  root: string,
  originalPath: string,
  uid: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const files = join(root, "files");
  const info = join(root, "info");
  await directory(root, uid);
  await directory(files, uid);
  await directory(info, uid);

  // A UUID fits NAME_MAX even when the original name does not fit with ".trashinfo" appended.
  // The exclusive metadata file reserves the pair across processes.
  for (;;) {
    signal.throwIfAborted();
    const name = randomUUID();
    const metadata = join(info, `${name}.trashinfo`);
    const destination = join(files, name);
    const entry = await open(metadata, "wx", 0o600).catch((error: unknown) => {
      if (errorCode(error) === "EEXIST") return undefined;
      throw error;
    });
    if (!entry) continue;
    let moved = false;
    try {
      try {
        const exists = await lstat(destination).catch((error: unknown) => {
          if (errorCode(error) === "ENOENT") return undefined;
          throw error;
        });
        if (exists) continue; // Preserve orphaned entries too.
        await entry.writeFile(trashInfo(originalPath, new Date()));
      } finally {
        await entry.close();
      }
      signal.throwIfAborted();
      await rename(source, destination);
      moved = true;
      return;
    } finally {
      if (!moved) await unlink(metadata);
    }
  }
}

/** The freedesktop.org Trash fallback for an approved, canonical knowledge-note path. */
export async function trashOnLinux(
  source: string,
  home: string,
  xdgDataHome: string | undefined,
  signal: AbortSignal,
) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Trash requires a user ID");
  const data = xdgDataHome && isAbsolute(xdgDataHome) ? xdgDataHome : join(home, ".local", "share");
  signal.throwIfAborted();
  let top: string;
  try {
    await mkdir(data, { recursive: true, mode: 0o700 });
    await move(source, join(data, "Trash"), source, uid, signal);
    return;
  } catch (error) {
    signal.throwIfAborted();
    // A read-only or missing home Trash says nothing about a separate source mount.
    const mounts = await readFile("/proc/self/mountinfo", "utf8");
    top = mountRoot(source, mounts);
    const homePath = await realpath(data).catch(() => data);
    if (top === source || (errorCode(error) !== "EXDEV" && top === mountRoot(homePath, mounts)))
      throw error;
  }

  const path = relative(top, source);
  const shared = join(top, ".Trash");
  try {
    const info = await lstat(shared);
    if (info.isDirectory() && (info.mode & 0o1000) !== 0) {
      await move(source, join(shared, String(uid)), path, uid, signal);
      return;
    }
  } catch {
    // An absent or unusable shared Trash falls back to the private per-volume Trash.
    signal.throwIfAborted();
  }
  await move(source, join(top, `.Trash-${uid}`), path, uid, signal);
}
