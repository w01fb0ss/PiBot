import type { ExternalAgentMethodResults } from "@pibot/external-agents-contract";
import { hostPlatform, SettingsRow, SettingsSection, useT } from "@pibot/renderer-kit";
import { Button, Chip, Switch } from "@pibot/ui";
import styles from "../agents/agents.module.css";
import { readOnlyLabel } from "../agents/shared.tsx";

type Info = ExternalAgentMethodResults["externalAgents.bot"];

/** The marker every unisolated agent carries (Windows): the panel, the profile, the chat header. */
export function UnisolatedBadge() {
  const t = useT();
  if (hostPlatform() !== "win32") return null;
  return (
    <Chip
      tone="warn"
      className={styles.unisolatedBadge}
      title={t("externalAgents.unisolated.hint")}
    >
      {t("externalAgents.unisolated.badge")}
    </Chip>
  );
}

/**
 * How the agent runs. macOS / Linux: Pi Bot's sandbox, what it may write and reach and the paths
 * opened for it. Windows has no command sandbox (W3): none of that holds there, so the section
 * says it runs directly on this computer and carries the confirmation and its revoke instead.
 */
export function AgentIsolation({
  info,
  busy,
  revoke,
  confirm,
  shareMemory,
}: {
  info: Info;
  busy?: string;
  revoke(): void;
  confirm(): void;
  shareMemory(enabled: boolean): void;
}) {
  const t = useT();
  const { allowances } = info;
  const memory = (
    <SettingsRow
      icon="user"
      tone="violet"
      label={t("externalAgents.memory.share")}
      note={t("externalAgents.memory.note")}
    >
      <Switch
        label={t("externalAgents.memory.share")}
        checked={info.bot.shareUserMemory === true}
        disabled={!!busy}
        onCheckedChange={shareMemory}
      />
    </SettingsRow>
  );
  if (hostPlatform() === "win32")
    return (
      <SettingsSection title={t("externalAgents.create.run")}>
        {memory}
        <SettingsRow
          icon="warning"
          tone="amber"
          label={t("externalAgents.unisolated.badge")}
          note={t("externalAgents.unisolated.note")}
        >
          {info.isolation === "unisolated" ? (
            <>
              <Chip tone="warn">{t("externalAgents.settings.unisolated")}</Chip>
              <Button variant="pill" loading={busy === "revoke"} disabled={!!busy} onClick={revoke}>
                {t("externalAgents.settings.revoke")}
              </Button>
            </>
          ) : (
            <Button variant="pill" disabled={!!busy} onClick={confirm}>
              {t("externalAgents.settings.confirm")}
            </Button>
          )}
        </SettingsRow>
      </SettingsSection>
    );
  return (
    <SettingsSection title={t("externalAgents.profile.sandbox")}>
      {memory}
      <SettingsRow
        icon="folder"
        tone="amber"
        label={t("externalAgents.profile.canWrite")}
        note={t("externalAgents.create.writeValue")}
      />
      <SettingsRow
        icon="globe"
        tone="blue"
        label={t("externalAgents.profile.canReach")}
        note={
          allowances.network.length
            ? allowances.network.join(" · ")
            : t("externalAgents.create.networkNone")
        }
      />
      <SettingsRow
        icon="key"
        tone="violet"
        label={t("externalAgents.profile.allowed")}
        note={
          // The brain already writes these home-relative paths as `~/…`.
          [
            ...allowances.readWrite,
            ...allowances.readOnly.map((path) => readOnlyLabel(path, t)),
          ].join(" · ") || t("externalAgents.create.allowNone")
        }
      >
        {info.isolation === "sandbox" && (
          <Chip tone="ok">{t("externalAgents.settings.sandboxed")}</Chip>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
