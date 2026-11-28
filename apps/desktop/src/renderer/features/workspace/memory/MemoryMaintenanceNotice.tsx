// Gives the existing memory surfaces the same warning and model-settings action.
import { type MemoryMaintenanceStatus, memoryFailureNeedsSettings } from "@pibot/protocol";
import { useNavigation, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import styles from "./memory-maintenance.module.css";
import { useOpenMemoryBudget } from "./use-open-memory.ts";

export function MemoryMaintenanceNotice({
  issue,
}: {
  issue: NonNullable<MemoryMaintenanceStatus["issue"]>;
}) {
  const t = useT();
  const { dialog, closeDialog, openSettings } = useNavigation();
  const openBudget = useOpenMemoryBudget();
  const budget = issue.reason === "budget_exhausted";
  return (
    <div className={styles.bannerWarn} role="status">
      <Icon name="warning" size={14} />
      <span>
        {budget
          ? t("memorySettings.maintenance.budget_exhausted")
          : t(`memorySettings.maintenance.${issue.task}`, {
              count: issue.count,
              reason: t(`memorySettings.maintenance.${issue.reason}`),
            })}
      </span>
      {budget ? (
        <Button variant="pill" onClick={openBudget}>
          {t("memorySettings.maintenance.raiseLimit")}
        </Button>
      ) : memoryFailureNeedsSettings(issue.reason) ? (
        <Button
          variant="pill"
          onClick={() => {
            if (dialog) closeDialog(dialog.key);
            openSettings("models");
          }}
        >
          {t("workspace.backgroundTaskModels")}
        </Button>
      ) : null}
    </div>
  );
}
