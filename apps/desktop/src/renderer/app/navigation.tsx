import {
  type BotPanelTab,
  type MessageFocus,
  NavigationContext,
  type NavigationValue,
  type SettingsOverlay,
  type SettingsSectionId,
  type SettingsTarget,
  type ShellDialog,
  type TeamOverlay,
  type View,
  type WorkspaceOverlay,
} from "@pibot/renderer-kit";
import { type ReactNode, useCallback, useRef, useState } from "react";

import { useStartupDisplay } from "./startup-display.tsx";

function returnTarget(view: View): View {
  const target = { ...view };
  delete target.focus;
  delete target.approvalFocus;
  delete target.groupPanel;
  return target;
}

export function NavigationProvider({ children }: { children: ReactNode }) {
  const cached = useStartupDisplay()?.snapshot?.conversation;
  const [view, setView] = useState<View>(() => ({
    name: "chat",
    botId: cached?.botId,
    groupId: cached?.groupId,
    topicId: cached?.topicId,
  }));
  const [settingsOverlay, setSettingsOverlay] = useState<SettingsOverlay>();
  const [dialog, setDialog] = useState<ShellDialog>();
  const [revisions, setRevisions] = useState<Readonly<Record<string, number>>>({});
  const [botPanel, setBotPanel] = useState<NavigationValue["botPanel"]>();
  const [teamOverlay, setTeamOverlay] = useState<TeamOverlay>();
  const closeTeamOverlay = useCallback(() => setTeamOverlay(undefined), []);
  const navigate = useCallback((next: View) => {
    setDialog(undefined);
    setSettingsOverlay(undefined);
    setTeamOverlay(undefined);
    setBotPanel((previous) =>
      next.name === "chat" && !next.groupId && previous?.botId === next.botId
        ? previous
        : undefined,
    );
    setView(next);
  }, []);
  const consumeChatFocus = useCallback((focus: MessageFocus) => {
    setView((current) => {
      if (current.name !== "chat" || current.focus !== focus) return current;
      return returnTarget(current);
    });
  }, []);
  const openBotPanel = useCallback(
    (botId: string, tab: BotPanelTab = "details", preserveChat = false, skillId?: string) => {
      if (!preserveChat && (view.name !== "chat" || view.groupId || view.botId !== botId))
        navigate({ name: "chat", botId });
      setTeamOverlay(undefined);
      setBotPanel({ botId, tab, ...(skillId ? { skillId } : {}) });
    },
    [view, navigate],
  );
  const openImportedTopic = useCallback(
    (botId: string, topicId: string, importId?: string) => {
      navigate({ name: "chat", botId, topicId });
      setBotPanel(
        importId
          ? { botId, tab: "topics", importedBatch: { id: importId, key: crypto.randomUUID() } }
          : undefined,
      );
    },
    [navigate],
  );
  const closeBotPanel = useCallback(() => setBotPanel(undefined), []);
  const inboxReturn = useRef<View>({ name: "chat" });
  const openWorkspace = useCallback(
    (overlay: WorkspaceOverlay) => {
      if (
        overlay.name === "team" ||
        overlay.name === "share" ||
        overlay.name === "template" ||
        overlay.name === "professions"
      ) {
        setTeamOverlay(overlay);
        return;
      }
      if (overlay.name === "inbox") {
        if (view.name !== "inbox") inboxReturn.current = returnTarget(view);
        navigate({ name: "inbox" });
        setBotPanel(undefined);
      } else openBotPanel(overlay.botId, overlay.target ?? "details");
    },
    [view, openBotPanel, navigate],
  );
  const closeWorkspace = useCallback(() => {
    if (view.name === "inbox") navigate(inboxReturn.current);
  }, [view.name, navigate]);
  const openSettings = useCallback(
    (section: SettingsSectionId | "passwords", target?: SettingsTarget) => {
      setDialog(undefined);
      setSettingsOverlay(
        section === "passwords"
          ? { section: "permissions", target: "passwords" }
          : { section, target },
      );
    },
    [],
  );
  const openBotPermissions = useCallback(
    (botId: string) => {
      setSettingsOverlay(undefined);
      openBotPanel(botId, "permissions");
    },
    [openBotPanel],
  );
  const closeSettings = useCallback(() => setSettingsOverlay(undefined), []);
  const pageReturns = useRef(new Map<View["name"], View>());
  const openPage = useCallback(
    (name: View["name"]) => {
      if (view.name !== name) pageReturns.current.set(name, returnTarget(view));
      navigate({ name });
    },
    [view, navigate],
  );
  const closePage = useCallback(
    (name: View["name"]) => navigate(pageReturns.current.get(name) ?? { name: "chat" }),
    [navigate],
  );
  const showDialog = useCallback(
    (update: (current: ShellDialog | undefined) => ShellDialog | undefined) => setDialog(update),
    [],
  );
  const closeDialog = useCallback((key: string) => {
    // An old dialog's delayed close cannot retire a newer request.
    setDialog((current) => (current?.key === key ? undefined : current));
  }, []);
  const bumpRevision = useCallback(
    (owner: string) =>
      setRevisions((current) => ({ ...current, [owner]: (current[owner] ?? 0) + 1 })),
    [],
  );
  const auditReturn = useRef<View>({ name: "chat" });
  const openAudit = useCallback(
    (botId?: string, groupId?: string) => {
      if (view.name !== "audit") auditReturn.current = returnTarget(view);
      setSettingsOverlay(undefined);
      navigate({ name: "audit", auditBotId: botId, auditGroupId: groupId });
    },
    [view, navigate],
  );
  const closeAudit = useCallback(() => navigate(auditReturn.current), [navigate]);
  return (
    <NavigationContext.Provider
      value={{
        view,
        botPanel,
        openBotPanel,
        openImportedTopic,
        closeBotPanel,
        openAudit,
        closeAudit,
        navigate,
        consumeChatFocus,
        settingsOverlay,
        openSettings,
        openPage,
        closePage,
        dialog,
        showDialog,
        closeDialog,
        revisions,
        bumpRevision,
        openBotPermissions,
        closeSettings,
        openWorkspace,
        closeWorkspace,
        teamOverlay,
        closeTeamOverlay,
      }}
    >
      {children}
    </NavigationContext.Provider>
  );
}
