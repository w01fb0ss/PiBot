import type { Logger } from "@pibot/observability";
import type { UiNavigation } from "@pibot/protocol";
import { app } from "electron";
import { z } from "zod";
import type { DesktopRegistrationSkipReason } from "./login-item-scope.ts";

/**
 * `pibot://` links only bring Pi Bot's window to the front, e.g. from the subscription
 * sign-in page once the browser is done. Any web page can open such a link, so it carries no
 * command or data: only the known actions count and nothing from the URL reaches the window or
 * brain.
 */
export const APP_URL_SCHEME = "pibot";
const ACTIONS = new Set(["open", "signed-in", "import"]);

const RoleImportQuery = z
  .object({
    kind: z.enum(["role", "group"]),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    version: z.coerce.number().int().min(1).max(100000),
  })
  .strict();

export function parseAppUrl(value: string): UiNavigation | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== `${APP_URL_SCHEME}:` || url.hostname !== "import") return undefined;
  const params = Object.fromEntries(url.searchParams.entries());
  const parsed = RoleImportQuery.safeParse(params);
  return parsed.success ? { view: "role-import", ...parsed.data } : undefined;
}

export function isAppUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === `${APP_URL_SCHEME}:` && ACTIONS.has(url.hostname);
}

/**
 * macOS gets the scheme from Info.plist and Linux packages from the desktop file (both written by
 * electron-builder `protocols`); the Windows installer writes nothing, so the app registers itself.
 * Account-wide registrations belong to the packaged app using the default data root.
 * The handler persists across quit so links can open Pi Bot when it is stopped.
 */
export function registerAppUrlScheme(
  reason: DesktopRegistrationSkipReason | undefined,
  logger: Logger,
): void {
  if (reason) {
    logger.info(JSON.stringify({ module: "app-url", event: "register_skipped", reason }));
    return;
  }
  if (process.platform === "darwin") return;
  // Not fatal: the sign-in page still says it can be closed; only its "back to Pi Bot" link fails.
  if (!app.setAsDefaultProtocolClient(APP_URL_SCHEME))
    logger.warn("pibot:// link registration unavailable");
}
