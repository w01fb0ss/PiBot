import { directRunPermissionStatusKey } from "@pibot/i18n";
import { OutsideCommandPatternSchema } from "@pibot/protocol";
import { layoutStyles, SettingsRow, useSettings } from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import { useEffect, useId, useState } from "react";

/** Covers the macOS / Linux sandbox; Windows commands are unisolated already. */
const sandboxed = () => window.pibot.platform !== "win32";

/** Strict sandbox: a blocked command is never offered a run outside it, and the list is ignored. */
export function StrictSandboxRow({ disabled }: { disabled: boolean }) {
  const { t, settings, update } = useSettings();
  if (!sandboxed() || !settings) return null;
  return (
    <SettingsRow
      icon="shield"
      tone="orange"
      label={t("permissions.strictSandbox")}
      note={t("permissions.short.strictSandbox")}
      info={t("permissions.strictSandboxNote")}
    >
      <Switch
        label={t("permissions.strictSandbox")}
        checked={settings.strictSandbox === true}
        disabled={disabled}
        onCheckedChange={(next) => void update({ strictSandbox: next })}
      />
    </SettingsRow>
  );
}

function parseCommands(text: string) {
  return [
    ...new Set(
      text
        .split("\n")
        .map((value) => value.trim().replace(/\s+/g, " "))
        .filter(Boolean),
    ),
  ];
}

/** One shape per line, saved on blur like the PATH list; each run is still confirmed. */
export function SandboxOutsideCommandsRow({
  disabled,
  initiallyOpen = false,
}: {
  disabled: boolean;
  initiallyOpen?: boolean;
}) {
  const { t, language, settings, update } = useSettings();
  const key = settings?.sandboxOutsideCommands?.join("\n") ?? "";
  const [text, setText] = useState(key);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(initiallyOpen);
  const editorId = useId();
  useEffect(() => setText(key), [key]);
  if (!sandboxed() || !settings) return null;
  const count =
    (settings.sandboxOutsideCommands?.length ?? 0) +
    (settings.sandboxAutoOutsideCommands?.length ?? 0);
  const commit = () => {
    const entries = parseCommands(text);
    if (entries.join("\n") === key) return;
    if (
      entries.length > 32 ||
      !entries.every((entry) => OutsideCommandPatternSchema.safeParse(entry).success)
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void update({ sandboxOutsideCommands: entries });
  };
  // One row with the count; 编辑 opens the list under it.
  const preview = [
    ...(settings.sandboxOutsideCommands ?? []),
    ...(settings.sandboxAutoOutsideCommands?.map((entry) => entry.pattern) ?? []),
  ]
    .slice(0, 2)
    .join(" · ");
  const summary = count
    ? preview
      ? t("permissions.sandboxOutsideCount", { list: preview, count })
      : t("permissions.sandboxOutsideCountOnly", { count })
    : t("permissions.sandboxOutsideNone");
  const locale = language === "zh" ? "zh-CN" : "en";
  return (
    <>
      <SettingsRow
        icon="terminal"
        tone="teal"
        label={t("permissions.sandboxOutsideCommands")}
        note={
          settings.strictSandbox
            ? `${summary} · ${t("permissions.sandboxOutsideCommandsStrict")}`
            : summary
        }
        info={t("permissions.sandboxOutsideCommandsNote")}
      >
        <Button
          variant={open ? "secondary" : "ghost"}
          className={layoutStyles.small}
          aria-expanded={open}
          aria-controls={editorId}
          onClick={() => setOpen((value) => !value)}
        >
          {t(open ? "permissions.collapse" : "permissions.edit")}
        </Button>
      </SettingsRow>
      {open && (
        <div id={editorId} className={layoutStyles.editor}>
          <textarea
            className={layoutStyles.textarea}
            aria-label={t("permissions.sandboxOutsideCommands")}
            placeholder={t("permissions.sandboxOutsidePlaceholder")}
            value={text}
            disabled={disabled}
            rows={3}
            onChange={(event) => setText(event.currentTarget.value)}
            onBlur={commit}
          />
          {settings.sandboxAutoOutsideCommands?.map((entry) => (
            <SettingsRow
              key={`${entry.folder}\0${entry.pattern}`}
              icon="terminal"
              label={entry.pattern}
              note={`${t(directRunPermissionStatusKey(entry.source, settings.strictSandbox))} · ${entry.folder} · ${new Date(entry.createdAt).toLocaleString(locale)}`}
            >
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  void update({
                    sandboxAutoOutsideCommands: settings.sandboxAutoOutsideCommands?.filter(
                      (value) => value !== entry,
                    ),
                  })
                }
              >
                {t("permissions.sandboxAutoDelete")}
              </Button>
            </SettingsRow>
          ))}
          {invalid && (
            <p role="alert" className={layoutStyles.alert}>
              {t("permissions.sandboxOutsideCommandsInvalid")}
            </p>
          )}
        </div>
      )}
    </>
  );
}
