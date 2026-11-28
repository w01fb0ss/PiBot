import { z } from "zod";
import { ReleaseVersionSchema } from "../bots/app-profile.ts";

/**
 * In-app updates (maintainers 2026-10-22): renderer <-> desktop main bridge, separate from brain RPC
 * because installing restarts the whole app, brain included.
 */
export const DesktopUpdateReasonSchema = z.enum([
  // Development run: nothing is installed, so there is nothing to replace.
  "dev",
  // Squirrel.Mac only accepts an update signed like the running app; an ad-hoc signature has no
  // stable identity to compare.
  "mac_unsigned",
  // Running from the disk image or a folder the user cannot write to.
  "mac_location",
  // The .deb is managed by the package manager.
  "linux_deb",
  // Only the AppImage can replace itself; tar.gz installs are updated by hand.
  "linux_format",
]);
export type DesktopUpdateReason = z.infer<typeof DesktopUpdateReasonSchema>;

/**
 * Maintainers 2026-11-13: the update page shows what a version changes. Written per version in
 * apps/desktop/release-notes/<version>.json and carried in the feed's releaseNotes as JSON; plain
 * text lines only (rendered as text, never HTML).
 */
const noteLine = z.string().trim().min(1).max(300);
export const ReleaseNotesSchema = z.strictObject({
  zh: z.array(noteLine).min(1).max(20),
  en: z.array(noteLine).min(1).max(20),
});
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;

export const DesktopUpdateStateSchema = z.strictObject({
  phase: z.enum([
    "idle",
    "checking",
    "current",
    "available",
    "downloading",
    "downloaded",
    "installing",
    "error",
  ]),
  currentVersion: z.string().min(1).max(100),
  /** The newer version once one has been found. */
  version: ReleaseVersionSchema.optional(),
  /** False: this build cannot replace itself; the UI offers the download page instead. */
  installable: z.boolean(),
  reason: DesktopUpdateReasonSchema.optional(),
  /** Whole percent while downloading. */
  percent: z.number().int().min(0).max(100).optional(),
  error: z.enum(["network", "download", "install"]).optional(),
  /** What the newer version changes, when its feed carries notes. */
  notes: ReleaseNotesSchema.optional(),
  /**
   * Whether the renderer shows the non-blocking corner prompt for this state. Opened by an
   * automatic check that found a version not put off with 「稍后」 this launch, and when a
   * download is ready; closed by 「稍后」.
   */
  notice: z.boolean(),
});
export type DesktopUpdateState = z.infer<typeof DesktopUpdateStateSchema>;

export const DesktopUpdateActionSchema = z.strictObject({
  action: z.enum(["state", "check", "download", "cancel", "install", "dismiss"]),
});
export type DesktopUpdateAction = z.infer<typeof DesktopUpdateActionSchema>["action"];

/** Main -> renderer push channel and renderer -> main request channel. */
export const DESKTOP_UPDATES_CHANNEL = "pibot:updates";
export const DESKTOP_UPDATES_STATE_CHANNEL = "pibot:updates-state";

/** Explicit application restart; separate from brain restart and update installation. */
export const DESKTOP_RESTART_CHANNEL = "pibot:restart-app";
export const DesktopRestartRequestSchema = z.strictObject({ action: z.literal("restart") });
export const DesktopRestartResultSchema = z.strictObject({ status: z.literal("requested") });
