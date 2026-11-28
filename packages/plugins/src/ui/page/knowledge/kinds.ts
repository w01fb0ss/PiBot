import type { KnowledgeKind } from "@pibot/plugins-contract/full";
import type { IconName, Tone } from "@pibot/ui";

/** One tile per source kind, shared by the tab's rows and the detail panel. */
export const KIND_ICON: Record<KnowledgeKind, IconName> = {
  obsidian: "box",
  folder: "folder",
  notion: "file",
};
export const KIND_TONE: Record<KnowledgeKind, Tone> = {
  obsidian: "violet",
  folder: "amber",
  notion: "teal",
};
