import { useSettings } from "@pibot/renderer-kit";
import { Button, Icon, type IconName, IconTile, type Tone } from "@pibot/ui";
import { useEffect, useId, useRef, useState } from "react";
import styles from "./connections.module.css";

export type AddChoice =
  | "bringOver"
  | "mcp"
  | "plugin"
  | "link"
  | "skill"
  | "notion"
  | "obsidian"
  | "folder";
// Each way in keeps one coloured mark in the menu.
const MARKS: Record<AddChoice, { icon: IconName; tone: Tone }> = {
  bringOver: { icon: "arrow", tone: "pink" },
  mcp: { icon: "plug", tone: "teal" },
  plugin: { icon: "folder", tone: "amber" },
  link: { icon: "link", tone: "blue" },
  skill: { icon: "edit", tone: "violet" },
  notion: { icon: "file", tone: "neutral" },
  obsidian: { icon: "box", tone: "violet" },
  folder: { icon: "folder", tone: "amber" },
};

/**
 * Design ⑤: the page's one 「添加」 menu is grouped by how an item enters Pi Bot: bring-over,
 * app packages, custom capabilities, and read-only knowledge sources.
 */
export function AddMenu({
  choose,
  disabled,
  notionInstalled,
}: {
  choose(choice: AddChoice): void;
  disabled: boolean;
  /** The host found the Notion app, so the entry can say it is already here. */
  notionInstalled?: boolean;
}) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const item = (choice: AddChoice, label: string, hint?: string) => {
    const mark = MARKS[choice];
    return (
      <button
        type="button"
        role="menuitem"
        className={styles.menuItem}
        onClick={() => {
          setOpen(false);
          choose(choice);
        }}
      >
        <IconTile icon={mark.icon} tone={mark.tone} />
        <span className={styles.menuText}>
          {label}
          {hint && <small>{hint}</small>}
        </span>
      </button>
    );
  };
  return (
    <div className={styles.menuRoot} ref={root}>
      <Button
        className={styles.addButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Icon name="plus" size={14} />
        {t("connections.add")}
      </Button>
      {open && (
        <div id={id} role="menu" className={styles.menu} aria-label={t("connections.add")}>
          {item("bringOver", t("connections.add.bringOver"))}
          <hr />
          {item("plugin", t("connections.add.plugin"), t("connections.add.pluginHint"))}
          {/* Links download a package before opening the folder importer’s component/configuration review. */}
          {item("link", t("skills.link.title"), t("connections.add.linkHint"))}
          <hr />
          {item("mcp", t("connections.add.mcp"), t("connections.add.mcpHint"))}
          {item("skill", t("connections.add.skill"), t("connections.add.skillHint"))}
          <hr />
          {item(
            "notion",
            t("knowledge.add.notion"),
            notionInstalled
              ? `${t("knowledge.add.notionHint")} · ${t("knowledge.installed")}`
              : t("knowledge.add.notionHint"),
          )}
          {item("obsidian", t("knowledge.add.obsidian"), t("knowledge.add.obsidianHint"))}
          {item("folder", t("knowledge.add.folder"), t("knowledge.add.folderHint"))}
        </div>
      )}
    </div>
  );
}
