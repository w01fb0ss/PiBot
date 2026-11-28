import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** electron-builder marks the .deb's resources. The AppImage and tarball have no marker. */
export async function installedFromDeb(executable: string): Promise<boolean> {
  const marker = join(dirname(executable), "resources", "package-type");
  const type = await readFile(marker, "utf8").catch(() => "");
  return type.trim() === "deb";
}
