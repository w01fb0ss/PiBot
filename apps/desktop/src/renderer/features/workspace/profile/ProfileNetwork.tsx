import { commandNetworkNoteKey } from "@pibot/i18n";
import { DomainSchema, type Permissions } from "@pibot/protocol";
import { PermissionRow, botPanelStyles as styles, useT } from "@pibot/renderer-kit";
import { Button, Icon, TextField } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import type { PermissionUpdate } from "../../settings/permissions/use-permissions.ts";

/**
 * Settings for this Bot's command network access, including the public website list.
 */
export function ProfileNetwork({
  network,
  inherited,
  disabled,
  save,
}: {
  network: Permissions["network"];
  inherited: boolean;
  disabled: boolean;
  save(patch: PermissionUpdate): Promise<boolean>;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<"invalid">();
  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);
  const saveDomains = (domains: string[]) =>
    save({ network: { allowAll: network.allowAll, domains } });
  const add = async () => {
    let normalized: string;
    try {
      const raw = domain.trim();
      if (!raw || /[:/\\?#@\s]/.test(raw)) throw new Error("Domain only");
      normalized = new URL(`https://${raw}`).hostname;
    } catch {
      setError("invalid");
      return;
    }
    const parsed = DomainSchema.safeParse(normalized);
    if (!parsed.success || network.domains.length >= 200) {
      setError("invalid");
      return;
    }
    if (await saveDomains([...new Set([...network.domains, parsed.data])])) {
      setDomain("");
      setAdding(false);
      setError(undefined);
    }
  };
  return (
    <>
      <PermissionRow<"list" | "all">
        icon={{ name: "network", tone: "green" }}
        label={t("permissions.allowNetwork")}
        note={`${t(network.allowAll ? "permissions.webNetworkOn" : "permissions.webNetworkOff")} ${t(commandNetworkNoteKey(window.pibot.platform, network.allowAll))}`}
        value={network.allowAll ? "all" : "list"}
        overridden={!inherited}
        disabled={disabled}
        options={[
          { value: "list", label: t("workspace.networkList") },
          { value: "all", label: t("workspace.networkAll") },
        ]}
        change={(value) =>
          void save({
            network: {
              allowAll: value === "all",
              domains: network.domains,
            },
          })
        }
        restore={() => void save({ network: null })}
      />
      <div className={`${styles.cardRow} ${styles.indentedRow}`}>
        <div className={styles.rowText}>
          <div className={styles.domains}>
            {network.domains.map((item) => (
              <span key={item} className={styles.domain}>
                {item}
                <Button
                  variant="circle"
                  className={styles.domainRemove}
                  disabled={disabled}
                  aria-label={t("permissions.removeDomain", { domain: item })}
                  onClick={() =>
                    void saveDomains(network.domains.filter((value) => value !== item))
                  }
                >
                  <Icon name="close" size={12} />
                </Button>
              </span>
            ))}
            <Button
              variant="pill"
              className={styles.addDomain}
              disabled={disabled || network.domains.length >= 200}
              onClick={() => setAdding(true)}
            >
              <Icon name="plus" size={12} />
              {t("permissions.addDomain")}
            </Button>
          </div>
          <details>
            <summary className={styles.note}>{t("permissions.networkDetails")}</summary>
            <small className={styles.note}>{t("permissions.networkExceptions")}</small>
          </details>
          {window.pibot.platform !== "win32" && (
            <small className={styles.note}>
              {t(
                network.allowAll
                  ? "permissions.commandDomainsNote"
                  : "permissions.commandDomainsNoteOff",
              )}
            </small>
          )}
          {!network.allowAll && !network.domains.length && (
            <small className={styles.note}>{t("permissions.noDomains")}</small>
          )}
          {adding && (
            <form
              className={styles.domainForm}
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              <TextField
                ref={input}
                label={t("permissions.domain")}
                value={domain}
                disabled={disabled}
                onChange={(event) => {
                  setDomain(event.currentTarget.value);
                  setError(undefined);
                }}
                error={error ? t("permissions.domainInvalid") : undefined}
              />
              <div className={styles.domainActions}>
                <Button variant="pill" type="submit" disabled={disabled || !domain.trim()}>
                  {t("permissions.addDomain")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    setAdding(false);
                    setError(undefined);
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
