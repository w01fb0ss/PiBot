import type { BuiltinPlan } from "@pibot/protocol";
import { Overlay, useAction, useNavigation, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "./builtin.module.css";
import { builtinError, permissionLines, RoleAvatar, useBuiltinCatalog } from "./shared.tsx";

/**
 * Preview one built-in group template (members, coordinator, announcement, each
 * member's tightened permissions and skills), then create the group and its Bots in one step.
 */
export function TemplatePreview({ id, close }: { id: string; close(): void }) {
  const t = useT();
  const { peer } = useRpc();
  const { navigate } = useNavigation();
  const workspace = useWorkspace();
  const { catalog } = useBuiltinCatalog();
  const task = useAction();
  const [plan, setPlan] = useState<BuiltinPlan>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!peer) return;
    let active = true;
    peer
      // Maintainers 2026-11-20: a group template uses the Bots already made from its roles and only
      // creates the missing ones (it used to add 小审 2, 小栈 2 next to the existing ones).
      .call("builtin.plan", { groups: [id], reuseExisting: true })
      .then((value) => {
        if (active) setPlan(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [peer, id]);
  const template = catalog?.groups.find((group) => group.id === id);
  const roles = new Map(catalog?.roles.map((role) => [role.id, role]));
  const bots = new Map(plan?.bots.map((bot) => [bot.roleId, bot]));
  const planned = plan?.groups[0];
  const create = () => {
    if (!peer || !planned?.available) return;
    void task
      .run(
        () =>
          peer.call(
            "builtin.create",
            { groups: [id], reuseExisting: true, source: "template" },
            { timeoutMs: 120_000 },
          ),
        builtinError,
      )
      .then((result) => {
        const groupId = result?.groupIds[0];
        if (!groupId) return;
        close();
        navigate({ name: "chat", groupId });
        void workspace.refresh();
      });
  };
  return (
    <Overlay
      icon="users"
      tone="teal"
      title={template?.name ?? t("builtin.template.title")}
      close={close}
      busy={task.busy}
    >
      <div className={styles.stack}>
        {template && <p className={styles.note}>{template.summary}</p>}
        <p className={styles.note}>{t("builtin.template.note")}</p>
        {failed && (
          <p role="alert" className={styles.error}>
            {t("builtin.role.loadFailed")}
          </p>
        )}
        {(!plan || !catalog) && !failed && <p role="status">{t("common.loading")}</p>}
        {planned?.members.map((roleId) => {
          const role = roles.get(roleId);
          const bot = bots.get(roleId);
          const permissions = role ? permissionLines(role, t) : [];
          return (
            <section key={roleId} className={styles.card}>
              <div className={styles.row}>
                <RoleAvatar role={role} size={32} />
                <div className={styles.rowText}>
                  <strong>{bot?.name ?? role?.defaultBotName ?? roleId}</strong>
                  <div className={styles.note}>{role?.name}</div>
                </div>
                {roleId === planned.coordinator && (
                  <span className={styles.badge}>{t("builtin.template.coordinator")}</span>
                )}
              </div>
              {bot?.existingBotId ? (
                <p className={styles.note}>{t("builtin.template.reusedPermissions")}</p>
              ) : permissions.length ? (
                <div className={styles.chips}>
                  {permissions.map((line) => (
                    <span key={line} className={styles.chip}>
                      {line}
                    </span>
                  ))}
                </div>
              ) : (
                <p className={styles.note}>{t("builtin.role.noPermissions")}</p>
              )}
              {role && <p className={styles.note}>{role.summary}</p>}
            </section>
          );
        })}
        {!!planned?.skipped.length && (
          <p className={styles.warn}>
            {t("builtin.template.skipped", {
              names: planned.skipped
                .map((s) => roles.get(s.roleId)?.name ?? s.roleId)
                .join(t("skills.message.paramSeparator")),
            })}
          </p>
        )}
        {planned && !planned.available && (
          <p className={styles.warn}>{t("builtin.template.unavailable")}</p>
        )}
        {planned && (
          <>
            <h2 className={styles.subheading}>{t("builtin.template.announcement")}</h2>
            <div className={styles.pre}>{planned.announcement}</div>
          </>
        )}
        {task.error && (
          <p role="alert" className={styles.error}>
            {t(task.error)}
          </p>
        )}
        <div className={styles.actions}>
          <Button
            loading={task.busy}
            disabled={!peer || !planned?.available || task.error === "workspace.createUncertain"}
            onClick={create}
          >
            {t("builtin.template.create")}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
