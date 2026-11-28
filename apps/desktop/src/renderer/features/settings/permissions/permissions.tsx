// Arrange the global permissions and command environment settings.
import { isolationReasonText } from "@pibot/client-core";
import { PasswordSettings, useCredentialList } from "@pibot/credentials/ui";
import type { Category, Level } from "@pibot/protocol";
import {
  layoutStyles,
  SettingsBack,
  SettingsFold,
  SettingsLine,
  SettingsLinkRow,
  SettingsPage,
  SettingsSection,
  useT,
} from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { CommandProtectionCard } from "./CommandProtectionCard.tsx";
import { DockerPermissions } from "./docker-permissions.tsx";
import { AllowedDomains, CommandNetworkRows } from "./network-permissions.tsx";
import { PathPermissions } from "./path-permissions.tsx";
import { LevelRow } from "./permission-operations.tsx";
import { SandboxOutsideCommandsRow, StrictSandboxRow } from "./sandbox-escape.tsx";
import { SandboxRemembered } from "./sandbox-remembered.tsx";
import { SshHosts } from "./ssh-hosts.tsx";
import { UnisolatedYoloRow } from "./unisolated-yolo.tsx";
import { usePermissions } from "./use-permissions.ts";

const LOCAL: Category[] = ["run_command", "read_file", "list_dir", "write_file"];

type SubPage = "sandbox" | "ssh" | "domains" | "accounts" | "direct-runs";

/**
 * Settings · Permissions: the global defaults every Bot starts from. Per-Bot overrides,
 * grants and routine preauthorizations live in each Bot's profile panel only.
 * One-line notes with the long text behind ⓘ;
 * PATH, Docker and SSH form 「命令环境」; SSH hosts, the website allowlist and saved accounts
 * open as second-level pages, so each function shows in exactly one place.
 */
export function PermissionsSettings({ target }: { target?: "passwords" | "direct-runs" }) {
  const t = useT();
  const settings = usePermissions();
  const [sub, setSub] = useState<SubPage | undefined>(target === "passwords" ? "accounts" : target);
  const root = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each page switch starts at the top.
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>("[data-settings-scroll]");
    if (scroller) scroller.scrollTop = 0;
  }, [sub]);
  const data = settings.data;
  const disabled = !settings.connected || settings.busy || settings.refreshing || settings.error;
  const change = (category: Category, value: Level) =>
    void settings.save({ levels: { [category]: value } });
  const status = (
    <>
      {settings.error && (
        <p role="alert" className={layoutStyles.alert}>
          {t("permissions.error")}{" "}
          <Button
            variant="ghost"
            disabled={settings.busy || settings.refreshing}
            onClick={() => void settings.refresh()}
          >
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!data && !settings.error && <p role="status">{t("common.loading")}</p>}
    </>
  );
  const subPage = (title: string, body: ReactNode, lead?: ReactNode) => (
    <div ref={root} className={layoutStyles.page}>
      <SettingsBack label={t("settings.permissions")} onClick={() => setSub(undefined)} />
      <h2 className={layoutStyles.subTitle}>{title}</h2>
      {lead && <p className={layoutStyles.lead}>{lead}</p>}
      {body}
    </div>
  );
  if (sub === "sandbox")
    return subPage(t("permissions.sandboxRemembered"), <SandboxRemembered disabled={disabled} />);
  if (sub === "direct-runs")
    return subPage(
      t("permissions.sandboxOutsideCommands"),
      <SandboxOutsideCommandsRow disabled={disabled} initiallyOpen />,
    );
  if (sub === "accounts")
    return subPage(
      t("credentials.title"),
      <PasswordSettings focus={target === "passwords"} embedded />,
      t("credentials.intro"),
    );
  if (sub === "ssh")
    return subPage(
      t("ssh.title"),
      <>
        {status}
        {data && (
          <div className={layoutStyles.card}>
            <SshHosts data={data} disabled={disabled} save={settings.save} />
          </div>
        )}
      </>,
    );
  if (sub === "domains")
    return subPage(
      t("permissions.domains"),
      <>
        {status}
        {data && (
          <div className={layoutStyles.card}>
            <AllowedDomains
              data={{ ...data, network: data.overrides?.network ?? data.network }}
              disabled={disabled}
              save={settings.save}
            />
          </div>
        )}
      </>,
      t(
        window.pibot.platform === "win32"
          ? "permissions.domainsNoteWindows"
          : "permissions.domainsNote",
      ),
    );
  const enabledHosts = Object.values(data?.sshHosts ?? {}).filter((host) => host.enabled).length;
  const sandboxed = window.pibot.platform !== "win32";
  return (
    <div ref={root}>
      <SettingsPage lead={t("permissions.note")}>
        {status}
        {data && settings.global && (
          <>
            <SettingsSection title={t("permissions.operations")}>
              {window.pibot.platform === "linux" &&
                !data.isolation.available &&
                data.isolation.reason && (
                  <CommandProtectionCard
                    reason={data.isolation.reason}
                    refreshed={(status) => {
                      if (status.available) void settings.refresh();
                    }}
                  />
                )}
              {LOCAL.map((category) => (
                <LevelRow
                  key={category}
                  category={category}
                  levels={data.levels}
                  disabled={disabled}
                  info
                  note={
                    category === "run_command"
                      ? window.pibot.platform === "win32"
                        ? t("permissions.note.run_command.windows")
                        : data.isolation.available
                          ? t("permissions.isolationOn")
                          : isolationReasonText(data.isolation.reason, t)
                      : undefined
                  }
                  change={change}
                />
              ))}
            </SettingsSection>
            <SettingsSection title={t("permissions.commandEnv")}>
              {sandboxed ? (
                <SandboxRemembered disabled={disabled} open={() => setSub("sandbox")} />
              ) : (
                <UnisolatedYoloRow disabled={disabled} />
              )}
            </SettingsSection>
            <SettingsSection title={t("permissions.network")}>
              <LevelRow
                category="web"
                levels={data.levels}
                disabled={disabled}
                info
                change={change}
              />
              <CommandNetworkRows
                data={{ ...data, network: data.overrides?.network ?? data.network }}
                disabled={disabled}
                save={settings.save}
                openDomains={() => setSub("domains")}
              />
            </SettingsSection>
            <SettingsSection title={t("permissions.category.computer")}>
              <LevelRow
                category="computer"
                levels={data.levels}
                disabled={disabled}
                info
                change={change}
              />
            </SettingsSection>
            <SettingsSection title={t("permissions.connectionsAndSending")}>
              {(
                [
                  "connector",
                  "send_out",
                  "read_ai_config",
                  "read_messages",
                  "agent_delegation",
                ] as const
              ).map((category) => (
                <LevelRow
                  key={category}
                  category={category}
                  levels={data.levels}
                  disabled={disabled}
                  info
                  change={change}
                />
              ))}
              <SavedAccountsRow open={() => setSub("accounts")} />
            </SettingsSection>
            <SettingsFold
              icon="shield"
              tone="orange"
              title={t("permissions.advanced")}
              summary={t(sandboxed ? "permissions.advancedSandbox" : "permissions.advancedSummary")}
            >
              {sandboxed && (
                <>
                  <StrictSandboxRow disabled={disabled} />
                  <SandboxOutsideCommandsRow disabled={disabled} />
                </>
              )}
              <PathPermissions data={data} disabled={disabled} save={settings.save} />
              <DockerPermissions data={data} disabled={disabled} save={settings.save} />
              <SettingsLinkRow
                icon="server"
                tone="violet"
                label={t("ssh.title")}
                note={t("ssh.summary", { count: enabledHosts })}
                onClick={() => setSub("ssh")}
              />
            </SettingsFold>
          </>
        )}
      </SettingsPage>
    </div>
  );
}

/** One line for the saved accounts; the count is the first page the list already reads. */
function SavedAccountsRow({ open }: { open(): void }) {
  const t = useT();
  const list = useCredentialList();
  const count = list.error ? undefined : `${list.items.length}${list.hasMore ? "+" : ""}`;
  return (
    <>
      <SettingsLinkRow
        icon="user"
        tone="blue"
        label={
          count && !list.loading ? `${t("credentials.title")} · ${count}` : t("credentials.title")
        }
        note={t("credentials.summary")}
        onClick={open}
      />
      {list.error && <SettingsLine tone="danger">{t("credentials.loadError")}</SettingsLine>}
    </>
  );
}
