import type { MethodParams } from "@pibot/protocol";
import { createContext, useContext } from "react";
import type { SettingsSectionId } from "./settings-sections.ts";

export type { SettingsSectionId } from "./settings-sections.ts";
/** Where to scroll inside a page: the default-model card, or the saved-passwords section. */
export type SettingsTarget = "pi-model" | "passwords" | "network-proxy" | "direct-runs";
/** `agent`: an external agent Bot's settings, program and sandbox; not in navigation events. */
export type BotPanelTab = "details" | "agent" | "topics" | "memory" | "permissions";
export interface MessageFocus {
  messageId: string;
  toolCallId?: string;
}
export type View = {
  /** "teach": the "teach it once" page for `botId`. */
  name: "chat" | "inbox" | "audit" | "routines" | "teach" | "connectors";
  connection?: {
    id: string;
    connectorId?: string;
    section?: "access" | "advanced";
    target?: { kind: "bot" | "group"; id: string };
  };
  /** Open the exact Bot/group copy in Connections › Skills, independent of catalog grouping. */
  skillConnection?: {
    skillId: string;
    botId: string;
    groupId?: string;
    name: string;
    prepareRuntime?: boolean;
    runtime?: "python" | "node";
  };
  /** Open the Knowledge tab focused on this knowledge source's Details panel. */
  knowledgeSourceId?: string;
  /** Opens the Connections page's Access tokens dialog, optionally focused on one shared token. */
  tokens?: { secretName?: string };
  auditBotId?: string;
  auditGroupId?: string;
  botId?: string;
  topicId?: string;
  /** Display hint for a linked group topic outside the current workspace. */
  topicTitle?: string;
  draftId?: string;
  groupId?: string;
  /** Opens the group's skills and shared-memory tab from a scoped memory notice. */
  groupPanel?: "capabilities";
  threadId?: string;
  focus?: MessageFocus;
  approvalFocus?: { id: string };
};
export type TeamOverlay =
  | { name: "team" }
  | { name: "share"; target: MethodParams["teams.export"] }
  // Preview and create a built-in group template.
  | { name: "template"; id: string }
  // "add Bots and groups by profession", moved here from Settings · General.
  | { name: "professions" };
/** "New Bot" / "New group chat" are shell dialogs the desktop owns (sidebar ＋ menu). */
export type WorkspaceOverlay =
  | TeamOverlay
  | { name: "profile"; botId: string; target?: BotPanelTab }
  | { name: "inbox" };
export interface SettingsOverlay {
  section: SettingsSectionId;
  target?: SettingsTarget;
}
/**
 * A capability's modal over the current page (routines: the task editor). The shell keeps at most
 * one, closes it on navigation and when Settings open, and never looks inside `state`.
 */
export interface ShellDialog {
  owner: string;
  /** Fresh per request, so an old dialog's delayed close cannot retire a newer one. */
  key: string;
  state: unknown;
}

export interface NavigationValue {
  /** `skillId`: the skills tab opens with this skill's detail expanded (teach "view this skill"). */
  botPanel:
    | {
        botId: string;
        tab: BotPanelTab;
        skillId?: string;
        importedBatch?: { id: string; key: string };
      }
    | undefined;
  openBotPanel(botId: string, tab?: BotPanelTab, preserveChat?: boolean, skillId?: string): void;
  openImportedTopic(botId: string, topicId: string, importId?: string): void;
  closeBotPanel(): void;
  openAudit(botId?: string, groupId?: string): void;
  closeAudit(): void;
  view: View;
  navigate(view: View): void;
  /** Opens a page that `closePage` leaves again, back to the view it was opened from. */
  openPage(name: View["name"]): void;
  closePage(name: View["name"]): void;
  consumeChatFocus(focus: MessageFocus): void;
  settingsOverlay: SettingsOverlay | undefined;
  /** "passwords" is the older page name, kept so older links land on the merged section. */
  openSettings(section: SettingsSectionId | "passwords", target?: SettingsTarget): void;
  dialog: ShellDialog | undefined;
  /** `update` sees the open dialog, so a repeated request can keep its draft. */
  showDialog(update: (current: ShellDialog | undefined) => ShellDialog | undefined): void;
  closeDialog(key: string): void;
  /** Per-owner counters a capability bumps after a change its pages should refetch. */
  revisions: Readonly<Record<string, number>>;
  bumpRevision(owner: string): void;
  openBotPermissions(botId: string): void;
  closeSettings(): void;
  openWorkspace(overlay: WorkspaceOverlay): void;
  closeWorkspace(): void;
  teamOverlay: TeamOverlay | undefined;
  closeTeamOverlay(): void;
}

/** Filled by the desktop `NavigationProvider`. */
export const NavigationContext = createContext<NavigationValue | undefined>(undefined);

export function useNavigation(): NavigationValue {
  const value = useContext(NavigationContext);
  if (!value) throw new Error("useNavigation must be used inside NavigationProvider");
  return value;
}
