import type { MethodResults } from "@pibot/protocol";

/**
 * What the connected desktop said in the `app.about` handshake. `level` is absent when the
 * desktop predates the handshake (or did not answer): unknown, which never shows a notice.
 */
export interface DesktopAbout {
  computerId: string;
  version?: string;
  level?: number;
  platform?: MethodResults["app.about"]["platform"];
}
export type CompatNotice = "update_phone" | "update_desktop";

/**
 * Only the compatibility levels decide; different version numbers on the same level read each
 * other fine (new fields are dropped, unknown list items skipped), so they get no notice.
 */
export function compatNotice(phoneLevel: number, about?: DesktopAbout): CompatNotice | undefined {
  if (about?.level === undefined || about.level === phoneLevel) return undefined;
  return about.level > phoneLevel ? "update_phone" : "update_desktop";
}
