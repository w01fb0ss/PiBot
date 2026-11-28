import { z } from "zod";

/** Only a small, re-encoded raster can cross IPC; paths, SVG and remote URLs never do. */
export const AvatarImageSchema = z
  .string()
  .max(200_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u)
  .refine((value) => {
    try {
      const head = atob(value.slice(22, 66));
      const byte = (i: number) => head.charCodeAt(i);
      const word = (i: number) =>
        byte(i) * 0x1000000 + byte(i + 1) * 0x10000 + byte(i + 2) * 0x100 + byte(i + 3);
      return (
        [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => byte(i) === v) &&
        head.slice(12, 16) === "IHDR" &&
        word(16) === 192 &&
        word(20) === 192
      );
    } catch {
      return false;
    }
  }, "Invalid normalized avatar");
export const ThirdPartyDependencySchema = z.strictObject({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  license: z.string().min(1).max(300),
});
export const AppDependenciesSchema = z.array(ThirdPartyDependencySchema).max(3000);
export const ReleaseVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/u)
  .max(60);
const download = z
  .url({ protocol: /^https$/u })
  .max(2000)
  .refine((v) => {
    const u = new URL(v);
    return !u.username && !u.password;
  });
export const AppReleaseSchema = z.strictObject({
  version: ReleaseVersionSchema,
  downloads: z.partialRecord(
    z.enum(["darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"]),
    download,
  ),
});
/**
 * The only facts an update check sends: the version and platform, so the update server can
 * count checks per day × version × platform. No identifier of any kind; a malformed version is
 * sent as "unknown" rather than anything the build happened to carry after it.
 */
export function updateUserAgent(version: string, platform: string, arch: string) {
  const parsed = ReleaseVersionSchema.safeParse(version.split(":")[0]);
  const safe = (value: string) => (/^[a-z0-9_]{1,16}$/u.test(value) ? value : "unknown");
  return `PiBot/${parsed.success ? parsed.data : "unknown"} (${safe(platform)}; ${safe(arch)})`;
}
/** electron-updater sends a persistent random ID on every check for staged rollouts; we send this. */
export const ANONYMOUS_STAGING_ID = "00000000-0000-0000-0000-000000000000";
export const AppUpdateResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    currentVersion: z.string(),
    version: ReleaseVersionSchema,
    url: download,
  }),
  z.strictObject({
    status: z.enum(["current", "not_ready", "unavailable", "no_download"]),
    currentVersion: z.string(),
    version: ReleaseVersionSchema.optional(),
  }),
]);
/**
 * How far the phone and desktop data contract has
 * moved. The desktop updates itself and the phone app is updated by hand, so a phone reads data
 * from newer desktops all the time; it reads leniently (unknown fields dropped, unknown list
 * items skipped). Bump this only for a change lenient reading cannot absorb: a removed or renamed
 * field, a field whose meaning changed, a new required phone request field, or a new value in a
 * single (non-list) enum field the phone reads. Adding optional fields needs no bump.
 */
export const PHONE_COMPAT_LEVEL = 1;
/** The official site, where both the desktop installers and the phone app are offered. */
export const PIBOT_WEBSITE_URL = "https://pibot.space";
export const AppAboutSchema = z.strictObject({
  version: z.string().min(1).max(60),
  phoneCompat: z.number().int().min(0).max(1_000_000),
  platform: z.enum(["darwin", "win32", "linux"]).optional(),
});
export const AppProfileMethods = {
  /** Version handshake and desktop OS for the phone's permission explanations. */
  "app.about": { params: z.undefined(), result: AppAboutSchema },
  "app.openFeedback": {
    params: z.strictObject({
      repository: z
        .string()
        .max(200)
        .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/u),
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(12000),
      confirmed: z.literal(true),
    }),
    result: z.null(),
  },
  "app.openLink": { params: z.strictObject({ url: download }), result: z.null() },
  "app.dependencies": { params: z.undefined(), result: AppDependenciesSchema },
  "app.checkUpdates": { params: z.undefined(), result: AppUpdateResultSchema },
} as const;
