import { commandNetworkNoteKey } from "@pibot/i18n";
import { DomainSchema } from "@pibot/protocol";
import {
  layoutStyles,
  SettingsEmpty,
  SettingsLinkRow,
  SettingsRow,
  useT,
} from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import { useState } from "react";
import type { PermissionEditorProps } from "./permission-editor.ts";

/**
 * Whether commands a Bot runs may use the network, next to "visit websites" in one card.
 * The explicit domain list also applies to automatic commands, so keep its entry visible.
 */
export function CommandNetworkRows({
  data,
  disabled,
  save,
  openDomains,
}: PermissionEditorProps & { openDomains(): void }) {
  const t = useT();
  const domains = data.network.domains;
  return (
    <>
      <SettingsRow
        icon="network"
        tone="teal"
        label={t("permissions.allowNetwork")}
        note={`${t(data.network.allowAll ? "permissions.webNetworkOn" : "permissions.webNetworkOff")} ${t(commandNetworkNoteKey(window.pibot.platform, data.network.allowAll))}`}
        info={t("permissions.networkExceptions")}
      >
        <Switch
          label={t("permissions.allowNetwork")}
          checked={data.network.allowAll}
          disabled={disabled}
          onCheckedChange={(allowAll) => void save({ network: { allowAll } })}
        />
      </SettingsRow>
      <SettingsLinkRow
        icon="globe"
        tone="teal"
        label={t("permissions.domainsCount", { count: domains.length })}
        note={
          domains.length
            ? domains.slice(0, 3).join(t("tool.group.separator"))
            : window.pibot.platform === "win32"
              ? t("permissions.noExplicitDomains")
              : t(
                  data.network.allowAll
                    ? "permissions.commandDomainsNote"
                    : "permissions.commandDomainsNoteOff",
                )
        }
        onClick={openDomains}
      />
    </>
  );
}

/** The allowlist page: add a domain, remove one; the same save as before. */
export function AllowedDomains({ data, disabled, save }: PermissionEditorProps) {
  const t = useT();
  const [domain, setDomain] = useState("");
  const [invalidDomain, setInvalidDomain] = useState(false);
  const domains = data.network.domains;
  const saveDomains = (next: string[]) =>
    save({ network: { allowAll: data.network.allowAll, domains: next } });
  const addDomain = async () => {
    if (disabled) return;
    let normalized = "";
    try {
      const raw = domain.trim();
      if (!raw || /[:/\\?#@\s]/.test(raw)) throw new Error("Domain only");
      normalized = new URL(`https://${raw}`).hostname;
    } catch {
      setInvalidDomain(true);
      return;
    }
    const parsed = DomainSchema.safeParse(normalized);
    if (!parsed.success || domains.length >= 200) {
      setInvalidDomain(true);
      return;
    }
    setInvalidDomain(false);
    if (await saveDomains([...new Set([...domains, parsed.data])])) setDomain("");
  };
  return (
    <>
      <form
        className={layoutStyles.inset}
        onSubmit={(event) => {
          event.preventDefault();
          void addDomain();
        }}
      >
        <div className={layoutStyles.labelled}>
          <input
            className={layoutStyles.input}
            aria-label={t("permissions.domain")}
            aria-invalid={invalidDomain || undefined}
            placeholder={t("permissions.domain")}
            value={domain}
            disabled={disabled}
            onChange={(event) => {
              setDomain(event.currentTarget.value);
              setInvalidDomain(false);
            }}
          />
          <Button type="submit" disabled={disabled || !domain.trim()}>
            {t("permissions.addDomain")}
          </Button>
        </div>
        {invalidDomain && (
          <p role="alert" className={layoutStyles.alert}>
            {t("permissions.domainInvalid")}
          </p>
        )}
      </form>
      {domains.map((item) => (
        <div className={layoutStyles.row} key={item}>
          <span className={`${layoutStyles.grow} ${layoutStyles.mono}`}>{item}</span>
          <Button
            variant="ghost"
            className={layoutStyles.small}
            disabled={disabled}
            aria-label={t("permissions.removeDomain", { domain: item })}
            onClick={() => void saveDomains(domains.filter((value) => value !== item))}
          >
            {t("workplaces.remove")}
          </Button>
        </div>
      ))}
      {!domains.length && (
        <SettingsEmpty
          icon="globe"
          title={t(
            data.network.allowAll ? "permissions.noExplicitDomains" : "permissions.noDomains",
          )}
        />
      )}
    </>
  );
}
