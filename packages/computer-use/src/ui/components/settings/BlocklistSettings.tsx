import {
  type ComputerApp,
  type ComputerBlocklistEntry,
  sameAppId,
} from "@pibot/computer-use-contract/full";
import {
  hostPlatform,
  type Peer,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useRpc,
  useT,
} from "@pibot/renderer-kit";
import { Button, Icon, IconTile, SegmentedControl } from "@pibot/ui";
import {
  type KeyboardEvent,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "../computer.module.css";
import {
  computerErrorKey,
  installedAppsUnavailableText,
  isInstalledAppsRetryable,
} from "../presentation.ts";
import { RemoveIcon } from "./AppListEditor.tsx";
import { isBlocking, useBlocklist, useInstalledApps } from "./use-apps.ts";

/**
 * The blocklist stores one entry per platform app id, so a suggestion such as Slack has a macOS
 * bundle id and a Windows exe. People think in app names: show each name once and act on all of
 * its ids together.
 */
function byName(entries: ComputerBlocklistEntry[]) {
  const names = new Map<string, { name: string; ids: string[] }>();
  for (const entry of entries) {
    const key = entry.name.toLocaleLowerCase();
    const known = names.get(key);
    if (known) known.ids.push(entry.appId);
    else names.set(key, { name: entry.name, ids: [entry.appId] });
  }
  return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

const MATCH_LIMIT = 50;

/** Search this computer's apps and pick one, instead of a checklist of every app. */
function AddAppPopover({
  blocked,
  disabled,
  add,
}: {
  blocked(appId: string): boolean;
  disabled: boolean;
  add(app: ComputerApp): void;
}) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The installed-app scan takes seconds on macOS, so it only runs once the popover opens.
  const installed = useInstalledApps(open);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const matches = useMemo(() => {
    if (installed.data?.supported !== true) return [];
    const needle = deferred.trim().toLocaleLowerCase();
    return installed.data.apps
      .filter(
        (app) =>
          !blocked(app.id) &&
          (!needle ||
            app.name.toLocaleLowerCase().includes(needle) ||
            app.id.toLocaleLowerCase().includes(needle)),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MATCH_LIMIT);
  }, [installed.data, deferred, blocked]);
  const keyDown = (event: KeyboardEvent) => {
    // Escape closes only the popover, not the whole settings dialog around it.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <div ref={root} className={styles.addApp}>
      <Button
        variant="pill"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="plus" size={14} />
        {t("computerUse.blocklist.add")}
      </Button>
      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape handling for the popover's own controls.
        <div id={id} className={styles.addPopover} onKeyDown={keyDown}>
          <label className={styles.search}>
            <Icon name="search" size={14} />
            <input
              ref={input}
              type="search"
              value={query}
              aria-label={t("computerUse.picker.search")}
              placeholder={t("computerUse.picker.search")}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div className={styles.addList}>
            {matches.map((app) => (
              <button
                key={app.id}
                type="button"
                className={styles.addItem}
                disabled={disabled}
                onClick={() => {
                  add({ id: app.id, name: app.name });
                  setQuery("");
                }}
              >
                {/* Menu items lead with a tile; adding here blocks the app. */}
                <IconTile icon="shield" tone="orange" size="sm" />
                <span className={styles.appName}>{app.name}</span>
                {app.category && (
                  <span className={styles.hint}>{t("computerUse.card.suggested")}</span>
                )}
              </button>
            ))}
            {installed.data?.supported === true && !matches.length && (
              <p className={styles.listNote}>{t("computerUse.picker.noMatch")}</p>
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
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Apps Bots can never operate": the fixed floor and the user's own list, each name
 * once; adding goes through a search popover so the page never lists every installed app.
 */
export function BlocklistSettings() {
  const t = useT();
  const { peer } = useRpc();
  const list = useBlocklist();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof computerErrorKey>>();
  const locked = useRef(false);
  const platform = hostPlatform();
  const entries = (list.data ?? []).filter((entry) => {
    // Defaults are stored for every platform; this is display filtering only.
    if (entry.source !== "default") return true;
    const id = entry.appId.toLowerCase();
    if (id.endsWith(".exe")) return platform === "win32";
    if (
      id.endsWith(".desktop") ||
      /^(?:org\.(?:gnome|kde)\.|pi-bot$|xterm$|1password$|bitwarden$)/u.test(id)
    )
      return platform === "linux";
    if (id === "org.keepassxc.keepassxc") return platform === "darwin" || platform === "linux";
    return platform === "darwin";
  });
  const fixed = byName(entries.filter((entry) => !entry.removable));
  const fixedNames = new Set(fixed.map((item) => item.name.toLocaleLowerCase()));
  const mine = byName(
    entries.filter(
      (entry) =>
        entry.removable && isBlocking(entry) && !fixedNames.has(entry.name.toLocaleLowerCase()),
    ),
  );
  const blocked = (appId: string) =>
    entries.some((entry) => isBlocking(entry) && sameAppId(entry.appId, appId));
  const run = async (action: (rpc: Peer) => Promise<void>) => {
    if (!peer || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action(peer);
    } catch (e) {
      setError(computerErrorKey(e));
      list.reload();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const add = (app: ComputerApp) =>
    void run(async (rpc) => {
      const entry = await rpc.call("computer.blocklist.add", { app });
      list.setData((old) => [
        ...(old ?? []).filter((item) => !sameAppId(item.appId, entry.appId)),
        entry,
      ]);
    });
  const remove = (ids: string[]) =>
    void run(async (rpc) => {
      for (const appId of ids) await rpc.call("computer.blocklist.remove", { appId });
      const gone = (appId: string) => ids.some((id) => sameAppId(id, appId));
      list.setData((old) =>
        (old ?? []).flatMap((item): ComputerBlocklistEntry[] =>
          !gone(item.appId)
            ? [item]
            : item.source === "default"
              ? [{ ...item, removed: true }]
              : [],
        ),
      );
    });
  return (
    <SettingsSection title={t("computerUse.blocklist.title")}>
      <SettingsRow
        icon="hide"
        tone="red"
        stacked
        label={t("computerUse.blocklist.always")}
        note={t("computerUse.blocklist.alwaysNote")}
      >
        <div className={styles.chips} data-flush>
          {fixed.map((item) => (
            <span key={item.name} className={styles.chip} data-locked>
              <LockIcon /> {item.name}
            </span>
          ))}
          {list.loading && !list.data && <span role="status">{t("common.loading")}</span>}
        </div>
      </SettingsRow>
      <SettingsRow
        icon="hide"
        tone="red"
        stacked
        label={t("computerUse.blocklist.mine")}
        note={t("computerUse.blocklist.mineNote")}
      >
        {mine.length > 0 && (
          <div className={styles.chips} data-flush>
            {mine.map((item) => (
              <span key={item.name} className={styles.chip}>
                {item.name}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("computerUse.blocklist.remove", { name: item.name })}
                  onClick={() => remove(item.ids)}
                >
                  <RemoveIcon />
                </button>
              </span>
            ))}
          </div>
        )}
        {list.data && <AddAppPopover blocked={blocked} disabled={busy || !peer} add={add} />}
      </SettingsRow>
      {list.error && (
        <SettingsLine
          role="alert"
          tone="danger"
          action={
            <Button variant="ghost" onClick={list.reload}>
              {t("common.retry")}
            </Button>
          }
        >
          {t(list.error)}
        </SettingsLine>
      )}
      {error && (
        <SettingsLine role="alert" tone="danger">
          {t(error)}
        </SettingsLine>
      )}
    </SettingsSection>
  );
}

const RETENTION = [3, 7, 30] as const;
export function ScreenshotRetention() {
  const t = useT();
  const { peer } = useRpc();
  const [days, setDays] = useState<number>();
  const [error, setError] = useState<ReturnType<typeof computerErrorKey>>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit retry trigger
  useEffect(() => {
    if (!peer) return;
    let active = true;
    setError(undefined);
    peer
      .call("computer.settings.get", undefined)
      .then((result) => {
        if (active) setDays(result.screenshotRetentionDays);
      })
      .catch((e: unknown) => {
        if (active) setError(computerErrorKey(e));
      });
    return () => {
      active = false;
    };
  }, [peer, revision]);
  const save = async (value: number) => {
    if (!peer || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await peer.call("computer.settings.set", { screenshotRetentionDays: value });
      setDays(result.screenshotRetentionDays);
    } catch (e) {
      setError(computerErrorKey(e));
    } finally {
      setBusy(false);
    }
  };
  // A value set elsewhere (1–30) stays visible even when it is not one of the presets.
  const options = [...new Set([...RETENTION, ...(days ? [days] : [])])].sort((a, b) => a - b);
  return (
    <SettingsSection title={t("computerUse.retention.title")}>
      <SettingsRow
        icon="camera"
        tone="violet"
        label={t("computerUse.retention.label")}
        note={t("computerUse.retention.note")}
      >
        {days !== undefined && (
          <SegmentedControl<string>
            label={t("computerUse.retention.label")}
            value={String(days)}
            disabled={busy || !peer}
            options={options.map((value) => ({
              value: String(value),
              label: t("computerUse.retention.days", { count: value }),
            }))}
            onValueChange={(value) => void save(Number(value))}
          />
        )}
        {days === undefined && !error && <span role="status">{t("common.loading")}</span>}
      </SettingsRow>
      {error && (
        <SettingsLine
          role="alert"
          tone="danger"
          action={
            <Button variant="ghost" onClick={() => setRevision((n) => n + 1)}>
              {t("common.retry")}
            </Button>
          }
        >
          {t(error)}
        </SettingsLine>
      )}
    </SettingsSection>
  );
}
