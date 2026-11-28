import { ChatFontSizeSchema, type Settings } from "@pibot/protocol";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  TaskStatus,
  useRpc,
  useSettings,
  useTask,
} from "@pibot/renderer-kit";
import { SegmentedControl, Switch } from "@pibot/ui";
import { LoginStartRow } from "../background/LoginStartRow.tsx";
import { BackgroundLimit } from "./BackgroundLimit.tsx";
import { DataStorageSection } from "./DataStorageSection.tsx";
import { LiveIslandSettings } from "./LiveIslandSettings.tsx";
import { NetworkProxySettings } from "./network-proxy.tsx";
import { requirePeer } from "./operations.ts";

// Same order as the language choices, so "follow system" always comes first.
const THEMES = ["system", "light", "dark"] as const;

export function GeneralSettings({ showNetworkProxy = false }: { showNetworkProxy?: boolean } = {}) {
  const { peer } = useRpc();
  const { t, settings, update } = useSettings();
  const task = useTask();
  const disabled = task.busy || !peer;
  const change = (patch: Partial<Settings>) =>
    void task.run(async () => {
      requirePeer(peer);
      await update(patch);
    });
  return (
    <SettingsPage>
      <TaskStatus task={task} />
      <LiveIslandSettings disabled={disabled} change={change} />
      <SettingsSection title={t("settings.languageTheme")}>
        <SettingsRow icon="globe" tone="blue" label={t("language.label")} note={t("language.note")}>
          <SegmentedControl
            label={t("language.label")}
            disabled={disabled}
            value={settings?.language ?? "system"}
            options={(["system", "zh", "en"] as const).map((value) => ({
              value,
              label: t(`language.${value}`),
            }))}
            onValueChange={(language) => change({ language })}
          />
        </SettingsRow>
        <SettingsRow
          icon="moon"
          tone="violet"
          label={t("theme.label")}
          note={t("settings.themeNote")}
        >
          <SegmentedControl
            label={t("theme.label")}
            disabled={disabled}
            value={settings?.theme ?? "system"}
            options={THEMES.map((value) => ({ value, label: t(`theme.${value}`) }))}
            onValueChange={(theme) => change({ theme })}
          />
        </SettingsRow>
        <SettingsRow
          icon="message"
          tone="teal"
          label={t("chatFont.label")}
          note={t("settings.chatFontNote")}
        >
          <SegmentedControl
            label={t("chatFont.label")}
            disabled={disabled}
            value={settings?.chatFontSize ?? "medium"}
            options={ChatFontSizeSchema.options.map((value) => ({
              value,
              label: t(`chatFont.${value}`),
            }))}
            onValueChange={(chatFontSize) => change({ chatFontSize })}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings.startup")}>
        <LoginStartRow disabled={disabled} />
        <SettingsRow
          icon="pin"
          tone="teal"
          label={t("settings.showTrayIcon")}
          note={t("settings.showTrayIconNote")}
        >
          <Switch
            label={t("settings.showTrayIcon")}
            checked={settings?.showTrayIcon ?? false}
            disabled={disabled}
            onCheckedChange={(showTrayIcon) => change({ showTrayIcon })}
          />
        </SettingsRow>
      </SettingsSection>
      <NetworkProxySettings focus={showNetworkProxy} />
      <BackgroundLimit />
      <DataStorageSection disabled={disabled} />
    </SettingsPage>
  );
}
