import type { TranslationKey } from "@pibot/i18n";

type Source =
  | "app"
  | "routine"
  | "bot"
  | "group"
  | "plugin"
  | "connection"
  | "remote"
  | "browser"
  | "yolo"
  | "permission"
  | "grant"
  | "folder";
type Field = {
  source: Source;
  label: TranslationKey;
  description?: TranslationKey;
  path?: string;
  values?: string;
  fallback?: unknown;
  removeOnly?: boolean;
};

export const ordinaryFields = {
  app: {
    // Language selected in General.
    language: { source: "app", label: "language.label", values: "language" },
    // Appearance selected in General.
    theme: { source: "app", label: "theme.label", values: "theme" },
    // Reading size of chat text.
    chatFontSize: {
      source: "app",
      label: "chatFont.label",
      values: "chatFont",
      fallback: "medium",
    },
    // Show the live island when the app is in the background.
    liveIsland: { source: "app", label: "liveIsland.show", fallback: true },
    // Choose compact or detailed live island content.
    liveIslandContent: {
      source: "app",
      label: "liveIsland.content",
      values: "liveIsland.content",
      fallback: "full",
    },
    // Select the kinds of work shown on the island.
    liveIslandKinds: {
      source: "app",
      label: "liveIsland.kinds",
      values: "liveIsland.kind",
      fallback: ["chat", "group", "routine", "waiting"],
    },
    // Schedule idle Dream maintenance.
    memoryDreamEnabled: { source: "app", label: "memorySettings.dream.automatic", fallback: false },
    // Run Dream only with a local model.
    // Limit the cost of one Dream run.
    memoryDreamCostUsd: { source: "app", label: "memorySettings.dream.budget", fallback: 0.05 },
    // Limit the daily spend on memory extraction.
    memoryExtractionDailyCostUsd: {
      source: "app",
      label: "piSettings.extractionCost",
      fallback: 0.5,
    },
    // Limit daily memory extraction on models without pricing.
    memoryExtractionDailyBudget: {
      source: "app",
      path: "memoryExtractionDailyTokens",
      label: "piSettings.extractionBudget",
      fallback: 2_000_000,
    },
    // Policy for missed scheduled runs after sleep.
    "routines.missedPolicy": {
      source: "routine",
      path: "missedPolicy",
      label: "routines.missed",
      values: "routines.missed",
    },
    // Keep the computer awake near routines.
    "routines.keepAwake": {
      source: "routine",
      path: "keepAwake",
      label: "routines.keepAwake",
      values: "routines.keepAwake",
    },
    // Pause routines after the person has been away.
    "routines.pauseWhenAway": {
      source: "routine",
      path: "pauseWhenAway",
      label: "piSettings.pauseWhenAway",
    },
    // Show an icon in the tray or menu bar.
    showTrayIcon: { source: "app", label: "settings.showTrayIcon" },
  },
  bot: {
    // The profile's paired provider and model, including media Bots.
    model: { source: "bot", label: "workspace.model" },
    videoModel: { source: "bot", label: "video.model", path: "defaultVideoModel" },
    imageModel: { source: "bot", label: "piSettings.imageModel" },
    // Image generation or editing.
    imageMode: { source: "bot", label: "piSettings.imageMode", values: "piSettings.imageMode" },
    // Explicit thinking preference, or follow the model default.
    thinkingPreference: {
      source: "bot",
      label: "workspace.thinking",
      values: "models.thinking",
    },
    // Remember automatically or ask before remembering.
    memoryMode: {
      source: "bot",
      label: "workspace.memoryMode",
      values: "workspace.memory",
      fallback: "auto",
    },
    // Extract memories when a conversation has finished.
    memoryExtraction: { source: "bot", label: "workspace.memoryExtraction", fallback: true },
    // Pick an already registered workspace from the existing folder list.
    folder: { source: "folder", label: "piSettings.folder" },
  },
  connection: {
    // Plain fields declared editable by the installed package's Settings form.
    config: { source: "plugin", label: "piSettings.connectionConfig" },
  },
  group: {
    autoRoundLimit: { source: "group", label: "group.roundLimit" },
  },
  permissions: {},
} as const satisfies Record<string, Record<string, Field>>;

export const securityFields = {
  group: {},
  app: {
    // Turning it off lets memory text go to cloud models: a privacy boundary.
    memoryDreamLocalOnly: {
      source: "app",
      label: "memorySettings.dream.localOnly",
      fallback: false,
    },
    // Prevent commands from leaving the sandbox.
    strictSandbox: { source: "app", label: "permissions.strictSandbox", fallback: false },
    // Commands the person explicitly runs outside the sandbox.
    sandboxOutsideCommands: {
      source: "app",
      label: "permissions.sandboxOutsideCommands",
      fallback: [],
    },
    // This list includes both explicit permissions and inactive legacy entries.
    sandboxAutoOutsideCommands: {
      source: "app",
      label: "piSettings.savedDirectRunPermissions",
      fallback: [],
      removeOnly: true,
    },
    // Settings can remove previously remembered writes outside the sandbox.
    sandboxAutoWritePaths: {
      source: "app",
      label: "permissions.sandboxWrites",
      fallback: [],
      removeOnly: true,
    },
    // Settings can remove previously remembered local service access.
    sandboxAutoLocalServices: {
      source: "app",
      label: "permissions.sandboxLocal",
      fallback: [],
      removeOnly: true,
    },
    // Settings can remove previously remembered system service access.
    sandboxAutoSystemServices: {
      source: "app",
      label: "permissions.sandboxSystem",
      fallback: [],
      removeOnly: true,
    },
    // Switch YOLO in the current Pi conversation.
    yolo: {
      source: "yolo",
      path: "enabled",
      label: "piSettings.yolo",
      description: "piSettings.yoloDescription",
    },
    // Withdraw Windows consent through the Settings UI's separate withdrawal flow.
    yoloUnisolatedCommands: {
      source: "app",
      label: "piSettings.windowsYolo",
      fallback: false,
      removeOnly: true,
    },
    // Turn the phone link on or off.
    "remote.enabled": { source: "remote", path: "enabled", label: "remote.enabled" },
    // Choose the signaling relay.
    "remote.relay": { source: "remote", path: "relay", label: "remote.relay", values: "remote" },
    // Set the address of a self-hosted relay.
    "remote.relayUrl": { source: "remote", path: "relayUrl", label: "remote.address" },
    // Select LAN-only or NAT traversal for direct connections.
    "remote.direct.mode": {
      source: "remote",
      path: "direct.mode",
      label: "remote.direct.mode",
      values: "remote.direct",
    },
    // Set the STUN service contacted to discover public addresses.
    "remote.direct.stunUrl": {
      source: "remote",
      path: "direct.stunUrl",
      label: "remote.stun.address",
    },
    // Advertise the desktop for discovery on the local network.
    "remote.lanDiscovery": {
      source: "remote",
      path: "lanDiscovery",
      label: "remote.lanDiscovery",
    },
    // Use the signed-in browser instead of the Bot browser.
    browserExtensionPreference: {
      source: "browser",
      path: "preference",
      label: "settings.browserPreference",
      values: "piSettings.browser",
    },
    // Move the browser extension's active connection to this copy.
    browserExtensionTakeOver: {
      source: "browser",
      path: "registration",
      label: "piSettings.browserTakeover",
      values: "piSettings.browserRegistration",
    },
  },
  bot: {
    // Require a fresh confirmation for everything this Bot sends outward.
    confirmEverySend: { source: "bot", label: "permissions.confirmEverySend", fallback: false },
  },
  connection: {
    // Select which Bots and groups can use this connection.
    access: { source: "connection", label: "piSettings.connectionAccess" },
    // Control confirmations for connector actions.
    confirmationMode: {
      source: "connection",
      label: "piSettings.connectionConfirmation",
      values: "piSettings.connectionConfirmation",
    },
    // Allow the connector to reach additional domains.
    networkDomains: { source: "connection", label: "permissions.domains", fallback: [] },
    // Enable tools or mark them read-only.
    tools: { source: "connection", label: "piSettings.connectionTools" },
  },
  permissions: {
    // Shell command execution.
    "levels.run_command": {
      source: "permission",
      label: "permissions.category.run_command",
      values: "permissions.level",
    },
    // Connected app calls.
    "levels.connector": {
      source: "permission",
      label: "permissions.category.connector",
      values: "permissions.level",
    },
    // Computer use.
    "levels.computer": {
      source: "permission",
      label: "permissions.category.computer",
      values: "permissions.level",
    },
    // Read files.
    "levels.read_file": {
      source: "permission",
      label: "permissions.category.read_file",
      values: "permissions.level",
    },
    // List folders.
    "levels.list_dir": {
      source: "permission",
      label: "permissions.category.list_dir",
      values: "permissions.level",
    },
    // Modify files.
    "levels.write_file": {
      source: "permission",
      label: "permissions.category.write_file",
      values: "permissions.level",
    },
    // Read other agents' configuration.
    "levels.read_ai_config": {
      source: "permission",
      label: "permissions.category.read_ai_config",
      values: "permissions.level",
    },
    // Read conversation messages.
    "levels.read_messages": {
      source: "permission",
      label: "permissions.category.read_messages",
      values: "permissions.level",
    },
    // Send externally.
    "levels.send_out": {
      source: "permission",
      label: "permissions.category.send_out",
      values: "permissions.level",
    },
    // Browse and fetch web pages.
    "levels.web": {
      source: "permission",
      label: "permissions.category.web",
      values: "permissions.level",
    },
    // Delegate work to another agent.
    "levels.agent_delegation": {
      source: "permission",
      label: "permissions.category.agent_delegation",
      values: "permissions.level",
    },
    // Default Pi's Bot and group management level.
    "levels.bot_management": {
      source: "permission",
      label: "permissions.category.bot_management",
      values: "permissions.level",
    },
    // Default Pi's dispatch level.
    "levels.work_dispatch": {
      source: "permission",
      label: "permissions.category.work_dispatch",
      values: "permissions.level",
    },
    // Default Pi's repair level.
    "levels.pi_repair": {
      source: "permission",
      label: "permissions.category.pi_repair",
      values: "permissions.level",
    },
    // Default Pi's ordinary Settings change level.
    "levels.settings_change": {
      source: "permission",
      label: "permissions.category.settings_change",
      values: "permissions.level",
    },
    // Permit unrestricted network access for commands.
    "network.allowAll": { source: "permission", label: "permissions.allowNetwork" },
    // List the permitted domains.
    "network.domains": { source: "permission", label: "permissions.domains" },
    // Revoke a previously granted permission through the Grants UI's path.
    revokeGrant: { source: "grant", label: "piSettings.revokeGrant" },
  },
} as const satisfies Record<string, Record<string, Field>>;

export type ScopeKind = keyof typeof ordinaryFields;
export type SettingsField = Field & { security: boolean };
export function fieldsFor(kind: ScopeKind): Record<string, SettingsField> {
  const entries = (fields: Record<string, Field>, security: boolean) =>
    Object.entries(fields).map(([key, field]) => [key, { ...field, security }]);
  return Object.fromEntries([
    ...entries(ordinaryFields[kind], false),
    ...entries(securityFields[kind], true),
  ]);
}
