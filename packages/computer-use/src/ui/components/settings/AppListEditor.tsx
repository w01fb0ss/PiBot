import { type ComputerApp, sameAppId } from "@pibot/computer-use-contract/full";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import styles from "../computer.module.css";
import {
  installedAppsUnavailableText,
  isDesktopApp,
  isInstalledAppsRetryable,
} from "../presentation.ts";
import { AppPicker, type PickerApp } from "./AppPicker.tsx";
import { isBlocking, useBlocklist, useInstalledApps } from "./use-apps.ts";

export function RemoveIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24">
      <path d="M6 6l12 12M6 18L18 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Chips + "add app" picker over this computer's installed apps, for the always-list and
 * routine preauthorization. Blocklisted apps are shown locked (they can never be added) and the
 * Bot browser is left out (it is governed by website permissions).
 */
export function AppListEditor({
  apps,
  onChange,
  disabled = false,
}: {
  apps: ComputerApp[];
  onChange(apps: ComputerApp[]): void;
  disabled?: boolean;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const blocklist = useBlocklist();
  // The installed-app scan takes seconds on macOS, so it only runs once the picker opens.
  const installed = useInstalledApps(adding);
  const blocked = (appId: string) =>
    (blocklist.data ?? []).some((entry) => isBlocking(entry) && sameAppId(entry.appId, appId));
  const remove = (appId: string) => onChange(apps.filter((app) => !sameAppId(app.id, appId)));
  const pickerApps: PickerApp[] =
    installed.data?.supported === true
      ? installed.data.apps
          .filter((app) => isDesktopApp(app.id))
          .map((app) => ({
            id: app.id,
            name: app.name,
            locked: blocked(app.id) ? t("computerUse.card.blocked") : undefined,
          }))
      : [];
  return (
    <>
      <div className={styles.chips} data-flush>
        {apps.map((app) => (
          <span key={app.id} className={styles.chip}>
            {app.name}
            {blocked(app.id) && (
              <span className={styles.hint} data-tone="danger">
                {t("computerUse.card.blocked")}
              </span>
            )}
            <button
              type="button"
              disabled={disabled}
              aria-label={t("computerUse.profile.remove", { name: app.name })}
              onClick={() => remove(app.id)}
            >
              <RemoveIcon />
            </button>
          </span>
        ))}
        {!adding && (
          <Button variant="pill" disabled={disabled} onClick={() => setAdding(true)}>
            {t("computerUse.profile.add")}
          </Button>
        )}
      </div>
      {adding && (
        <div className={styles.picker}>
          {installed.data?.supported === true && (
            <AppPicker
              apps={pickerApps}
              label={t("computerUse.profile.add")}
              disabled={disabled}
              checked={(appId) => apps.some((app) => sameAppId(app.id, appId))}
              toggle={(app, on) => (on ? onChange([...apps, app]) : remove(app.id))}
            />
          )}
          {installed.data?.supported === true && installed.data.truncated && (
            <p className={styles.listNote}>{t("computerUse.picker.truncated")}</p>
          )}
          {installed.loading && (
            <p className={styles.listNote}>{t("computerUse.picker.loading")}</p>
          )}
          {installed.data?.supported === false && (
            <p className={styles.listNote}>
              {installedAppsUnavailableText(installed.data.reason, t)}
              {isInstalledAppsRetryable(installed.data.reason) && (
                <>
                  {" "}
                  <Button variant="ghost" onClick={installed.reload}>
                    {t("common.retry")}
                  </Button>
                </>
              )}
            </p>
          )}
          {installed.error && (
            <p role="alert" className={styles.listError}>
              {t(installed.error)}{" "}
              <Button variant="ghost" onClick={installed.reload}>
                {t("common.retry")}
              </Button>
            </p>
          )}
          <div className={styles.pickerActions}>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              {t("computerUse.picker.done")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
