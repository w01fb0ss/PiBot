import { systemServiceLabel } from "@pibot/client-core";
import { SettingsLinkRow, SettingsRow, SettingsSection, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";

export function SandboxRemembered({
  disabled,
  folders,
  open,
}: {
  disabled: boolean;
  folders?: string[];
  open?: () => void;
}) {
  const { t, language, settings, update } = useSettings();
  if (!settings) return null;
  const groups = [
    {
      key: "sandboxAutoWritePaths" as const,
      title: "permissions.sandboxWrites" as const,
      entries: (settings.sandboxAutoWritePaths ?? []).map((e) => ({
        ...e,
        value: e.path,
        display: e.path,
      })),
    },
    {
      key: "sandboxAutoLocalServices" as const,
      title: "permissions.sandboxLocal" as const,
      entries: (settings.sandboxAutoLocalServices ?? []).map((e) => ({
        ...e,
        value: e.target,
        display: e.target,
      })),
    },
    {
      key: "sandboxAutoSystemServices" as const,
      title: "permissions.sandboxSystem" as const,
      entries: (settings.sandboxAutoSystemServices ?? []).map((e) => ({
        ...e,
        value: e.service,
        display: systemServiceLabel(e.service, t),
      })),
    },
  ].map((g) => ({
    ...g,
    entries: g.entries.filter((e) => !folders || folders.includes(e.folder)),
  }));
  const count = groups.reduce((sum, g) => sum + g.entries.length, 0);
  const note = count
    ? t("permissions.sandboxRememberedSummary", {
        count,
        writes: groups[0]?.entries.length ?? 0,
        local: groups[1]?.entries.length ?? 0,
        system: groups[2]?.entries.length ?? 0,
      })
    : t("permissions.sandboxOutsideNone");
  if (open)
    return (
      <SettingsLinkRow
        icon="shield"
        tone="orange"
        label={t("permissions.sandboxRemembered")}
        note={note}
        onClick={open}
      />
    );
  // Embedded in Bot › Permissions: omit when empty so no orphaned "None yet" appears.
  if (folders && !count) return null;
  const locale = language === "zh" ? "zh-CN" : "en";
  return (
    <>
      {!count && <p>{note}</p>}
      {groups
        .filter((g) => g.entries.length)
        .map((g) => (
          <SettingsSection key={g.key} title={t(g.title)}>
            {g.entries.map((e) => (
              <SettingsRow
                key={`${e.folder}\0${e.program}\0${e.value}`}
                icon="shield"
                label={`${e.display} · ${e.program}`}
                note={`${e.folder.split(/[/\\]/).filter(Boolean).at(-1) ?? e.folder} · ${new Date(e.createdAt).toLocaleString(locale)}`}
                info={g.key === "sandboxAutoSystemServices" ? <code>{e.value}</code> : undefined}
              >
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    void update({
                      [g.key]: settings[g.key]?.filter(
                        (entry) =>
                          !(
                            entry.folder === e.folder &&
                            entry.program === e.program &&
                            entry.createdAt === e.createdAt &&
                            ("path" in entry
                              ? entry.path
                              : "target" in entry
                                ? entry.target
                                : entry.service) === e.value
                          ),
                      ),
                    })
                  }
                >
                  {t("permissions.sandboxAutoDelete")}
                </Button>
              </SettingsRow>
            ))}
          </SettingsSection>
        ))}
    </>
  );
}
