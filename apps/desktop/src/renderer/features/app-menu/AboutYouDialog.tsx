import { useNavigation, useT } from "@pibot/renderer-kit";
import { MemoryScopeView } from "../workspace/memory/settings/MemoryScopeView.tsx";
import { useMemoryMaintenance } from "../workspace/memory/use-memory-maintenance.ts";
import { ABOUT_YOU_DIALOG } from "../workspace/memory/use-open-memory.ts";
import { AppDialog } from "./AppDialog.tsx";
import { MemoryDreamCards } from "./MemoryDreamCards.tsx";
import { MemorySortIntoPlace } from "./MemorySortIntoPlace.tsx";

export function AboutYouDialog() {
  const { dialog, closeDialog } = useNavigation();
  const t = useT();
  const maintenance = useMemoryMaintenance(undefined, dialog?.owner === ABOUT_YOU_DIALOG);
  if (dialog?.owner !== ABOUT_YOU_DIALOG) return null;
  const focus = (dialog.state as { budgetFocus?: string } | undefined)?.budgetFocus;
  return (
    <AppDialog
      key={dialog.key}
      kind="about-you"
      mark={{ icon: "user", tone: "pink" }}
      title={t("appMenu.aboutYou")}
      close={() => closeDialog(dialog.key)}
    >
      <MemoryDreamCards dailyUsage={maintenance?.dailyUsage} budgetFocus={focus} />
      <MemorySortIntoPlace />
      <MemoryScopeView owner={{ scope: "user", ownerId: "user" }} maintenance={maintenance} />
    </AppDialog>
  );
}
