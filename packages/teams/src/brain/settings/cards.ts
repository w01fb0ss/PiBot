import type { ToolCardDescriber } from "@pibot/brain/kit";
import { createTranslator, directRunPermissionStatusKey, type TranslationKey } from "@pibot/i18n";
import type { SettingsPlan, SettingsRow } from "./plan.ts";

type Translate = ReturnType<typeof createTranslator>;

function words(value: unknown, row: SettingsRow, t: Translate): string {
  if (row.key === "revokeGrant") {
    if (!value || typeof value !== "object") return t("piSettings.revoked");
    const { category, scope } = value as { category: string; scope: Record<string, unknown> };
    const target =
      scope.domain ??
      scope.path ??
      scope.root ??
      scope.target ??
      scope.tool ??
      (typeof scope.site === "object" && scope.site
        ? Object.values(scope.site).join(" · ")
        : undefined) ??
      (Array.isArray(scope.apps) ? scope.apps.join(" · ") : undefined) ??
      scope.model;
    return [
      t(`permissions.category.${category}` as TranslationKey),
      target,
      t("piSettings.granted"),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (value == null)
    return t(row.field.source === "permission" ? "permissions.followGlobal" : "piSettings.default");
  if (typeof value === "boolean") return t(value ? "piSettings.on" : "piSettings.off");
  if (Array.isArray(value))
    return value.map((item) => words(item, row, t)).join(" · ") || t("piSettings.empty");
  if (typeof value === "object") {
    const entry = value as Record<string, unknown>;
    if (typeof entry.tool === "string") {
      const label = entry.displayDescription || entry.tool;
      const status = entry.enabled
        ? entry.readOnly
          ? "piSettings.readOnly"
          : "piSettings.readWrite"
        : "piSettings.off";
      return `${label} · ${t(status)}`;
    }
    if (
      typeof entry.mode === "string" &&
      Array.isArray(entry.bots) &&
      Array.isArray(entry.groups)
    ) {
      const members = [...entry.bots, ...entry.groups].map((id) => row.names?.[id] ?? id);
      return [t(`piSettings.access.${entry.mode}` as TranslationKey), ...members].join(" · ");
    }
    if (typeof entry.pattern === "string") {
      const command = [entry.pattern, entry.folder].join(" · ");
      if (row.key !== "sandboxAutoOutsideCommands") return command;
      const source = entry.source === "user" ? "user" : "auto";
      const status = directRunPermissionStatusKey(source, row.strictIsolation);
      return `${t(status)} · ${command}`;
    }
    if (typeof entry.program === "string")
      return [entry.program, entry.path ?? entry.target ?? entry.service, entry.folder].join(" · ");
    if (typeof entry.provider === "string" && typeof entry.id === "string")
      return `${entry.provider} / ${entry.id}`;
    return Object.values(entry)
      .map((item) => words(item, row, t))
      .join(" · ");
  }
  if (row.key === "memoryMode")
    return t(value === "ask" ? "workspace.memoryAsk" : "workspace.memoryAuto");
  if (row.key === "browserExtensionPreference")
    return t(value === "user" ? "settings.browserPreferenceUser" : "settings.browserPreferenceBot");
  if (value === "[redacted]") return t("piSettings.redacted");
  if (value === "home" && row.field.source === "folder") return t("folders.home");
  if (typeof value === "string" && row.names?.[value]) return row.names[value];
  if (typeof value === "string" && row.field.values)
    return t(`${row.field.values}.${value}` as TranslationKey);
  return String(value) || t("piSettings.empty");
}

function risk(row: SettingsRow | undefined): TranslationKey {
  switch (row?.field.source) {
    case "remote":
      return "piSettings.risk.remote";
    case "browser":
      return "piSettings.risk.browser";
    case "yolo":
      return "piSettings.risk.yolo";
    case "app":
      return "piSettings.risk.sandbox";
    default:
      return "piSettings.risk.permission";
  }
}

export const settingsCard: ToolCardDescriber = (_context, _input, language, prepared) => {
  const plan = prepared as SettingsPlan | undefined;
  const t = createTranslator(language);
  const rows = plan?.operations.flatMap(({ rows }) => rows) ?? [];
  const [row] = rows;
  if (row?.key === "sandboxAutoOutsideCommands") {
    // The approval text is capped per fact. Give every permission its own row.
    const list = (value: unknown, label: TranslationKey) => {
      if (!Array.isArray(value) || value.length === 0)
        return [{ kind: "write" as const, label: t(label), value: t("piSettings.empty") }];
      return value.map((entry) => ({
        kind: "write" as const,
        label: t(label),
        value: words(entry, row, t),
      }));
    };
    return {
      title: t(row.field.label),
      lead: t("piSettings.directRunPermissionsNote"),
      facts: [...list(row.before, "piSettings.before"), ...list(row.after, "piSettings.after")],
    };
  }
  return {
    title: t(plan?.security ? "piSettings.securityTitle" : "piSettings.title"),
    lead: t(plan?.security ? risk(row) : "piSettings.apply"),
    facts: rows.map((row) => ({
      kind: "write",
      label: [row.target, row.label ?? t(row.field.label)].filter(Boolean).join(" · ").slice(0, 80),
      value: `${words(row.before, row, t)} → ${words(row.after, row, t)}`,
    })),
  };
};
