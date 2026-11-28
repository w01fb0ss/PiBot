import type { MemoryOwner } from "@pibot/protocol";
import { useNavigation } from "@pibot/renderer-kit";
import { projectMemoryDialog } from "./project/project-memory-dialog.ts";

export const ABOUT_YOU_DIALOG = "about-you";

export function useOpenMemoryBudget() {
  const { showDialog, closeSettings } = useNavigation();
  return () => {
    closeSettings();
    const state = { budgetFocus: crypto.randomUUID() };
    showDialog((current) =>
      current?.owner === ABOUT_YOU_DIALOG
        ? { ...current, state }
        : { owner: ABOUT_YOU_DIALOG, key: crypto.randomUUID(), state },
    );
  };
}

export function useOpenMemory() {
  const { showDialog, openBotPanel, navigate, closeSettings } = useNavigation();
  return (owner: MemoryOwner) => {
    closeSettings();
    if (owner.scope === "user") {
      showDialog((current) =>
        current?.owner === ABOUT_YOU_DIALOG
          ? current
          : { owner: ABOUT_YOU_DIALOG, key: crypto.randomUUID(), state: undefined },
      );
    } else if (owner.scope === "bot") {
      showDialog(() => undefined);
      openBotPanel(owner.ownerId, "memory");
    } else if (owner.scope === "project") {
      showDialog(() => projectMemoryDialog(owner.ownerId));
    } else {
      navigate({ name: "chat", groupId: owner.ownerId, groupPanel: "capabilities" });
    }
  };
}
