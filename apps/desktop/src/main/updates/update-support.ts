import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import type { DesktopUpdateReason } from "@pibot/protocol";
import { installedFromDeb } from "../linux/package-type.ts";

/**
 * Why this build cannot replace itself, or undefined when it can. A blocked build still checks
 * (packaged builds only) and offers the download page instead of installing.
 */
export async function updateBlocker(options: {
  packaged: boolean;
  platform: NodeJS.Platform;
  execPath: string;
  /** Set by the AppImage runtime. */
  appImage: string | undefined;
}): Promise<DesktopUpdateReason | undefined> {
  if (!options.packaged) return "dev";
  if (options.platform === "linux") {
    if (options.appImage) return undefined;
    return (await installedFromDeb(options.execPath)) ? "linux_deb" : "linux_format";
  }
  if (options.platform !== "darwin") return undefined;
  const end = options.execPath.indexOf(".app/");
  if (end < 0) return "mac_location";
  const bundle = options.execPath.slice(0, end + 4);
  // A disk image is read-only, and a translocated copy is a throwaway path macOS chose.
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/"))
    return "mac_location";
  try {
    await access(dirname(bundle), constants.W_OK);
    await access(bundle, constants.W_OK);
  } catch {
    return "mac_location";
  }
  return (await stableSignature(bundle)) ? undefined : "mac_unsigned";
}

/**
 * Squirrel.Mac installs an update only when it satisfies the running app's designated
 * requirement. An ad-hoc signature's requirement is its own code hash, which no other build can
 * match, so only a certificate-backed signature (Developer ID, Apple Development or the local
 * "Pi Bot Dev") can update in place.
 */
function stableSignature(bundle: string) {
  return new Promise<boolean>((resolve) => {
    execFile(
      "/usr/bin/codesign",
      ["--display", "--verbose=2", bundle],
      {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
      (error, _stdout, stderr) => {
        // An unsigned bundle makes codesign exit non-zero; either way it cannot update in place.
        resolve(!error && /^Authority=/m.test(stderr) && !/^Signature=adhoc$/m.test(stderr));
      },
    );
  });
}
