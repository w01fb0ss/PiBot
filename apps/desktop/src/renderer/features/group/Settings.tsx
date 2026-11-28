import type { ChatPeer } from "@pibot/client-core";
import type { Group, MethodParams } from "@pibot/protocol";
import {
  AppSelect,
  botPanelStyles as panelStyles,
  useAction,
  useNavigation,
  useT,
  useWorkspace,
  waitRpc,
} from "@pibot/renderer-kit";
import { BuiltinUpdate } from "@pibot/teams/ui";
import { Icon, IconTile, Switch } from "@pibot/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DeleteConversationDialog } from "../workspace/topics/DeleteConversationDialog.tsx";
import type { GroupSnapshot } from "./data.ts";
import { GroupLimits } from "./GroupLimits.tsx";
import styles from "./group.module.css";

type Patch = Omit<MethodParams["groups.update"], "groupId">;
const roundLimits = Array.from({ length: 10 }, (_, index) => index + 1);

/**
 * Group panel「群设置」: every field saves on its own (selects on change, text when the
 * field is left), so there is no save button. Pausing lives only at the top of the chat and the
 * folders only in the「文件」tab / chat header.
 */
export function GroupSettings({
  peer,
  data,
  refresh,
  children,
}: {
  peer: ChatPeer;
  data: GroupSnapshot & { group: Group };
  refresh(): Promise<void>;
  children?: ReactNode;
}) {
  const t = useT();
  const { navigate } = useNavigation();
  const workspace = useWorkspace();
  const [removing, setRemoving] = useState(false);
  const group = data.group;
  const action = useAction();
  const [name, setName] = useState(group.name);
  const [announcement, setAnnouncement] = useState(group.announcement);
  const editing = useRef<"name" | "announcement">(undefined);
  // Another window (or the coordinator) may change the group; untouched fields follow it.
  useEffect(() => {
    if (editing.current !== "name") setName(group.name);
    if (editing.current !== "announcement") setAnnouncement(group.announcement);
  }, [group.name, group.announcement]);
  const members = new Map(data.bots.map((bot) => [bot.id, bot]));
  const coordinators = group.members.filter(({ botId }) => {
    const bot = members.get(botId);
    return !!bot && bot.category !== "image" && bot.kind !== "agent";
  });
  const hasExternalAgent = group.members.some(({ botId }) => members.get(botId)?.kind === "agent");
  const locked = !data.identityReady || !data.membersReady || data.error;
  const save = async (patch: Patch) => {
    if (locked || action.busy) return false;
    const result = await action.run(
      (signal) =>
        waitRpc(
          () => peer.call("groups.update", { groupId: group.id, ...patch }),
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        ),
      () => "group.saveFailed",
    );
    if (result?.id !== group.id) return false;
    await refresh();
    return true;
  };
  const leaveName = async () => {
    editing.current = undefined;
    const next = name.trim();
    if (!next || next === group.name) {
      setName(group.name);
      return;
    }
    if (!(await save({ name: next }))) setName(group.name);
  };
  const leaveAnnouncement = async () => {
    editing.current = undefined;
    if (announcement === group.announcement) return;
    if (!(await save({ announcement }))) setAnnouncement(group.announcement);
  };
  return (
    <div className={styles.stack}>
      {/* Shown only for a group made from a template that has a newer version. */}
      <BuiltinUpdate target={{ groupId: group.id }} disabled={!!locked} />
      <section className={panelStyles.section}>
        <h2>{t("group.settings")}</h2>
        <div className={panelStyles.card}>
          <label className={panelStyles.cardRow}>
            <IconTile icon="users" tone="teal" size="lg" />
            <span className={panelStyles.rowText}>
              <strong>{t("group.name")}</strong>
            </span>
            <input
              className={styles.settingsInput}
              value={name}
              maxLength={200}
              required
              disabled={locked}
              onFocus={() => {
                editing.current = "name";
              }}
              onChange={(e) => setName(e.currentTarget.value)}
              onBlur={() => void leaveName()}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
          <div className={panelStyles.cardRow}>
            <IconTile icon="star" tone="amber" size="lg" />
            <span className={panelStyles.rowText}>
              <strong>{t("group.coordinator")}</strong>
              <small>{t("panel.coordinatorNote")}</small>
            </span>
            <AppSelect
              variant="pill"
              hideLabel
              label={t("group.coordinator")}
              value={group.coordinatorBotId}
              disabled={locked || action.busy}
              change={(coordinatorBotId) => {
                if (
                  coordinatorBotId !== group.coordinatorBotId &&
                  coordinators.some(({ botId }) => botId === coordinatorBotId)
                )
                  void save({ coordinatorBotId });
              }}
              options={coordinators.map(({ botId }) => ({
                value: botId,
                label: members.get(botId)?.name ?? botId,
              }))}
            />
          </div>
          {hasExternalAgent && (
            <div className={panelStyles.cardRow}>
              <IconTile icon="message" tone="violet" size="lg" />
              <span className={panelStyles.rowText}>
                <strong>{t("group.agentStepContext")}</strong>
                <small>{t("group.agentStepContextNote")}</small>
              </span>
              <Switch
                label={t("group.agentStepContext")}
                checked={group.externalAgentStepContext !== false}
                disabled={locked || action.busy}
                onCheckedChange={(checked) => void save({ externalAgentStepContext: checked })}
              />
            </div>
          )}
          <div className={panelStyles.cardRow}>
            <IconTile icon="refresh" tone="blue" size="lg" />
            <span className={panelStyles.rowText}>
              <strong>{t("group.roundLimit")}</strong>
              <small>{t("panel.roundLimitNote")}</small>
            </span>
            <AppSelect
              variant="pill"
              hideLabel
              label={t("group.roundLimit")}
              value={String(group.autoRoundLimit)}
              disabled={locked || action.busy}
              change={(value) => {
                const autoRoundLimit = Number(value);
                if (autoRoundLimit !== group.autoRoundLimit) void save({ autoRoundLimit });
              }}
              options={roundLimits.map((count) => ({
                value: String(count),
                label: t("panel.rounds", { count }),
              }))}
            />
          </div>
        </div>
      </section>
      <section className={panelStyles.section}>
        <h2>{t("group.announcement")}</h2>
        <label className={styles.announcementCard}>
          <textarea
            className={styles.announcementInput}
            rows={4}
            maxLength={8000}
            aria-label={t("group.announcement")}
            value={announcement}
            disabled={locked}
            onFocus={() => {
              editing.current = "announcement";
            }}
            onChange={(e) => setAnnouncement(e.currentTarget.value)}
            onBlur={() => void leaveAnnouncement()}
          />
          <span className={styles.fieldNote}>{t("panel.announcementNote")}</span>
        </label>
      </section>
      {children}
      <section className={panelStyles.section}>
        <h2>{t("execution.limitsTitle")}</h2>
        <GroupLimits peer={peer} group={group} />
      </section>
      <div className={panelStyles.card}>
        {/* Gentle here; the confirmation dialog carries the red. */}
        <button
          type="button"
          className={`${panelStyles.cardRow} ${panelStyles.rowButton}`}
          disabled={locked || action.busy}
          onClick={() => setRemoving(true)}
        >
          <IconTile icon="archive" tone="orange" size="lg" />
          <span className={panelStyles.rowText}>
            <strong>{t("group.archive")}</strong>
            <small>{t("group.archiveRowNote")}</small>
          </span>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      {removing && (
        <DeleteConversationDialog
          target={{ groupId: group.id }}
          close={() => setRemoving(false)}
          deleted={() => {
            navigate({ name: "chat" });
            void workspace.refresh();
          }}
        />
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </div>
  );
}
