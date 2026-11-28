import { hostPlatform, useAction, useRpc, useT } from "@pibot/renderer-kit";
import type { MethodResults } from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { skillError } from "./presentation.ts";
import styles from "./skills.module.css";

export function SkillSecretBindings({ skillId, groupId }: { skillId: string; groupId?: string }) {
  const t = useT();
  const { peer } = useRpc();
  const windows = hostPlatform() === "win32";
  const action = useAction();
  const [data, setData] = useState<MethodResults["skills.secretBindings"]>();
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [saved, setSaved] = useState(false);
  const load = async () => {
    if (!peer) return;
    const result = await action.run(
      (signal) => peer.call("skills.secretBindings", { skillId, groupId }, { signal }),
      skillError,
    );
    if (result) setData(result);
  };
  const save = async () => {
    if (!peer) return;
    const result = await action.run(
      (signal) =>
        peer.call(
          "skills.setSecretBindings",
          {
            skillId,
            groupId,
            bindings: Object.entries(draft).map(([variable, secretName]) => ({
              variable,
              secretName,
            })),
          },
          { signal },
        ),
      skillError,
    );
    if (!result) return;
    setData(
      (current) =>
        current && {
          ...current,
          bindings: current.bindings.map((field) =>
            Object.hasOwn(draft, field.variable)
              ? { ...field, secretName: draft[field.variable] ?? null }
              : field,
          ),
        },
    );
    setDraft({});
    setSaved(true);
  };
  return (
    <details
      className={styles.card}
      onToggle={(event) => {
        if (event.currentTarget.open && !data && !action.busy) void load();
      }}
    >
      <summary>{t("skills.secrets.title")}</summary>
      {data && (
        <>
          <p className={styles.note}>
            {t(data.bindings.length ? "skills.secrets.info" : "skills.secrets.none")}
          </p>
          {windows && <p className={styles.note}>{t("skills.secrets.windows")}</p>}
          {data.bindings
            .filter(({ secretName }) => !windows || secretName)
            .map(({ variable, secretName }) => {
              const value = Object.hasOwn(draft, variable) ? draft[variable] : secretName;
              return (
                <label key={variable} className={styles.field}>
                  {variable}
                  <select
                    value={value ?? ""}
                    disabled={action.busy}
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      setDraft((current) => ({ ...current, [variable]: name || null }));
                      setSaved(false);
                    }}
                  >
                    <option value="">{t("skills.secrets.unbound")}</option>
                    {value && (windows || !data.available.includes(value)) && (
                      <option value={value}>{value}</option>
                    )}
                    {!windows &&
                      data.available.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                  </select>
                </label>
              );
            })}
          {data.bindings.some(({ secretName }) => !windows || secretName) && (
            <Button
              variant="secondary"
              disabled={action.busy || !Object.keys(draft).length}
              onClick={() => void save()}
            >
              {t("common.save")}
            </Button>
          )}
        </>
      )}
      {action.busy && !data && <p role="status">{t("common.loading")}</p>}
      {saved && <p role="status">{t("skills.secrets.saved")}</p>}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}{" "}
          <Button variant="pill" onClick={() => void (data ? save() : load())}>
            {t("common.retry")}
          </Button>
        </p>
      )}
    </details>
  );
}
