import type { TranslationKey } from "@pibot/i18n";
import { useAction, useNavigation, useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { skillLabels } from "@pibot/skills-contract/full";
import { Button, Icon } from "@pibot/ui";
import { useCallback, useState } from "react";
import { useSkillRoutineNavigation } from "../shell/ports.tsx";
import {
  skillError,
  skillRoutineInitial,
  skillTrialMessage,
  sourceKey,
  usedText,
} from "./presentation.ts";
import { SkillDetailExtras } from "./SkillDetailExtras.tsx";
import { SkillEditor } from "./SkillEditor.tsx";
import { SkillFileList } from "./SkillFileList.tsx";
import styles from "./skills.module.css";
import { useSkillDetailRead, useSkillResources } from "./use-skill-detail-read.ts";
import { useSkillUpdate } from "./use-skill-update.ts";

export function SkillDetail({
  skillId,
  groupId,
  botId,
  botName,
  send,
  back,
}: {
  skillId: string;
  groupId?: string;
  botId: string;
  botName: string;
  /** Sends an ordinary message to this Bot's open chat; absent where no chat is open. */
  send?(text: string): Promise<boolean>;
  back(): void;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const { openRoutines } = useSkillRoutineNavigation();
  const task = useAction();
  const update = useSkillUpdate(task, skillId, groupId);
  const navigation = useNavigation();
  const [revision, setRevision] = useState(0);
  const { data, error: loadError } = useSkillDetailRead(
    skillId,
    groupId,
    botId,
    revision,
    "summary",
  );
  const resources = useSkillResources(skillId, groupId, botId, revision);
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [notice, setNotice] = useState<TranslationKey>();
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  useRpcEvent("skills.changed", (event) => {
    if (event.groupId === groupId && event.botId === botId && event.skillId === skillId) {
      if (event.reason === "removed") back();
      else reload();
    }
  });
  const disabled = task.busy || !peer;
  const skill = data?.skill;
  const document = data?.document;
  // A built-in skill reads in the interface language; its copy and prompt entry stay as
  // installed, so only the strings shown here come from the other shipped language.
  const label = skillLabels(skill ?? { name: "", description: "" }, language);
  return (
    <div className={styles.detail}>
      <Button variant="ghost" className={`${styles.mini} ${styles.back}`} onClick={back}>
        <Icon name="back" size={14} /> {t("skills.back")}
      </Button>
      {loadError && (
        <p role="alert" className={styles.error}>
          {t(loadError)}{" "}
          <Button variant="pill" onClick={reload}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!data && !loadError && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {mode === "edit" && (!resources.data || resources.error) && (
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => setMode("view")}>
            {t("common.cancel")}
          </Button>
          {resources.error ? (
            <>
              <p role="alert" className={styles.error}>
                {t(resources.error)}
              </p>
              <Button variant="pill" onClick={resources.load}>
                {t("common.retry")}
              </Button>
            </>
          ) : (
            <p role="status" className={styles.note}>
              {t("common.loading")}
            </p>
          )}
        </div>
      )}
      {skill && !skill.builtinKey && resources.data && !resources.error && mode === "edit" && (
        <SkillEditor
          initial={resources.data.document}
          files={resources.data.files}
          scope={{ botId, groupId, skillId }}
          botName={botName}
          busy={task.busy || resources.loading}
          onCancel={() => setMode("view")}
          onSubmit={async (next, files) => {
            if (await update(next, files)) {
              setMode("view");
              reload();
            }
          }}
        />
      )}
      {skill && document && mode !== "edit" && (
        <>
          <div className={styles.titleRow}>
            <strong>{label.name}</strong>
            <span className={styles.tag}>
              {t(skill.builtinKey ? "skills.pick.builtin" : sourceKey(skill.source))}
            </span>
          </div>
          <p className={styles.description}>{label.description}</p>
          <p className={styles.kv}>
            <span>{t("skills.detail.params")}</span>
            <span>
              {document.params.length
                ? document.params
                    .map((p) =>
                      p.default
                        ? `${p.name} (${t("skills.detail.default", { value: p.default })})`
                        : p.name,
                    )
                    .join(" · ")
                : t("skills.detail.noParams")}
            </span>
          </p>
          <p className={styles.kv}>
            <span>{t("skills.detail.lastUsed")}</span>
            <span>{usedText(t, skill.lastUsedAt, language)}</span>
          </p>
          <pre className={styles.body}>{document.body}</pre>
          {resources.data && !resources.error ? (
            <>
              <h3 className={styles.subhead}>
                {t("skills.detail.files", { count: resources.data.files.length })}
              </h3>
              {resources.data.files.length > 0 && (
                <>
                  <SkillFileList
                    files={resources.data.files}
                    label={t("skills.detail.files", { count: resources.data.files.length })}
                  />
                  <p className={styles.note}>{t("skills.detail.filesNote", { bot: botName })}</p>
                </>
              )}
            </>
          ) : (
            <div className={styles.actions}>
              <Button
                variant="secondary"
                className={styles.mini}
                disabled={!peer || resources.loading}
                loading={resources.loading}
                onClick={resources.load}
              >
                {t(
                  resources.loading
                    ? "common.loading"
                    : resources.error
                      ? "common.retry"
                      : "skills.detail.loadFiles",
                )}
              </Button>
            </div>
          )}
          {/* The Bot panel shows source, runtime and compatibility read-only; updating and
              preparing happen on the connections page, which owns those actions. */}
          <SkillDetailExtras
            key={skillId}
            skillId={skillId}
            groupId={groupId}
            botId={botId}
            name={label.name}
            readOnly
            detail={data}
            resources={resources}
            retryDestination={{
              botName,
              open: (runtime) => {
                navigation.openPage("connectors");
                navigation.navigate({
                  name: "connectors",
                  skillConnection: { skillId, botId, groupId, name: label.name, runtime },
                });
              },
            }}
          />
          {/* Assigned built-in methods stay read-only, just as on the connections page. */}
          {skill.builtinKey ? null : mode === "delete" ? (
            <div className={styles.confirm}>
              <p>
                {t("skills.deleteConfirm", {
                  name: label.name,
                  bot: botName,
                })}
              </p>
              <div className={styles.actions}>
                <Button
                  variant="primary"
                  className={styles.deleteButton}
                  loading={task.busy}
                  disabled={!peer}
                  onClick={async () => {
                    if (!peer) return;
                    const result = await task.run(
                      () => peer.call("skills.delete", { groupId, skillId, confirmed: true }),
                      skillError,
                    );
                    if (result) back();
                  }}
                >
                  {t("skills.delete")}
                </Button>
                <Button variant="ghost" disabled={task.busy} onClick={() => setMode("view")}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              <Button
                variant="secondary"
                className={styles.mini}
                disabled={disabled || !skill.enabled || !!groupId}
                onClick={async () => {
                  setNotice(undefined);
                  if (!send) {
                    setNotice("skills.trialUnavailable");
                    return;
                  }
                  const sent = await send(skillTrialMessage(t, label.name, document.params));
                  setNotice(sent ? "skills.trialSent" : "skills.trialBlocked");
                }}
              >
                <Icon name="play" size={14} /> {t("skills.trial")}
              </Button>
              <Button
                variant="secondary"
                className={styles.mini}
                disabled={disabled || !!groupId}
                onClick={() =>
                  openRoutines("new", botId, skillRoutineInitial(t, label.name, document.params))
                }
              >
                {t("skills.routine")}
              </Button>
              <Button
                variant="secondary"
                className={styles.mini}
                disabled={disabled}
                onClick={() => {
                  if ((!resources.data || resources.error) && !resources.loading) resources.load();
                  setMode("edit");
                }}
              >
                {t("skills.edit")}
              </Button>
              <span className={styles.grow} />
              <Button
                variant="ghost"
                className={`${styles.mini} ${styles.danger}`}
                disabled={disabled}
                onClick={() => setMode("delete")}
              >
                {t("skills.delete")}
              </Button>
            </div>
          )}
          {notice && (
            <p
              role={notice === "skills.trialSent" ? "status" : "alert"}
              className={notice === "skills.trialSent" ? styles.status : styles.error}
            >
              {t(notice, { bot: botName })}
            </p>
          )}
        </>
      )}
      {task.error && (
        <p role="alert" className={styles.error}>
          {t(task.error)}
        </p>
      )}
    </div>
  );
}
