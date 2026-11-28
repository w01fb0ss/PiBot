import { Icon, type IconName, IconTile, type Tone as TileTone } from "@pibot/ui";
import { type ReactNode, useId, useState } from "react";
import { useT } from "../settings/context.ts";
import styles from "./settings-layout.module.css";

/** Page → section → card → rows; see layout.module.css. */
export function SettingsPage({ lead, children }: { lead?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.page}>
      {lead && <p className={styles.lead}>{lead}</p>}
      {children}
    </div>
  );
}

export function SettingsSection({
  id: sectionId,
  title,
  action,
  children,
  bare = false,
}: {
  id?: string;
  title: string;
  /** Right side of the section title (a search box, an add button). */
  action?: ReactNode;
  children: ReactNode;
  /** Content that is not a card of rows (provider tiles, a fold). */
  bare?: boolean;
}) {
  const id = useId();
  return (
    <section id={sectionId} className={styles.section} aria-labelledby={id}>
      <div className={styles.title}>
        <h2 id={id}>{title}</h2>
        {action}
      </div>
      {bare ? children : <div className={styles.card}>{children}</div>}
    </section>
  );
}

export function SettingsRow({
  label,
  note,
  children,
  stacked = false,
  dot,
  icon,
  tone,
  info,
}: {
  label: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
  /** Control below the text instead of beside it (chip lists, text areas). */
  stacked?: boolean;
  /** A status dot before the label (service state). */
  dot?: Tone;
  /** A coloured icon tile before the label; tone defaults to the page colour's family. */
  icon?: IconName;
  tone?: TileTone;
  /** The long explanation behind an ⓘ after the label, so the note stays one line. */
  info?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const infoId = useId();
  return (
    <div className={styles.row} data-stacked={stacked || undefined}>
      {icon && <IconTile icon={icon} tone={tone ?? "blue"} size="lg" className={styles.rowIcon} />}
      {dot && <i className={styles.dot} data-tone={dot} aria-hidden="true" />}
      <div className={styles.text}>
        <strong>
          {label}
          {info && (
            <button
              type="button"
              className={styles.info}
              aria-expanded={open}
              aria-controls={infoId}
              aria-label={t("settings.moreInfo")}
              title={t("settings.moreInfo")}
              onClick={() => setOpen((value) => !value)}
            >
              i
            </button>
          )}
        </strong>
        {note && <small>{note}</small>}
        {info && (
          <div id={infoId} className={styles.infoBox} hidden={!open}>
            {info}
          </div>
        )}
      </div>
      {children !== undefined && children !== null && children !== false && (
        <div className={styles.control}>{children}</div>
      )}
    </div>
  );
}

/** A row that opens a second-level page (SSH hosts, saved accounts, a device). */
export function SettingsLinkRow({
  label,
  note,
  icon,
  tone,
  trailing,
  onClick,
  disabled,
}: {
  label: ReactNode;
  note?: ReactNode;
  icon?: IconName;
  tone?: TileTone;
  /** Chips before the chevron (status, warnings). */
  trailing?: ReactNode;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${styles.row} ${styles.linkRow}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && <IconTile icon={icon} tone={tone ?? "blue"} size="lg" className={styles.rowIcon} />}
      <span className={styles.text}>
        <strong>{label}</strong>
        {note && <small>{note}</small>}
      </span>
      {trailing}
      <Icon name="chevronRight" size={16} className={styles.chevron} />
    </button>
  );
}

/** «‹ 权限» above a second-level page. */
export function SettingsBack({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={styles.back} disabled={disabled} onClick={onClick}>
      <Icon name="back" size={14} />
      {label}
    </button>
  );
}

/**
 * The big card at the top of a page or detail (default model, this computer, a device): a
 * gradient mark, a small caption, the name, a note, and controls on the right.
 */
export function SettingsHero({
  icon,
  caption,
  title,
  note,
  children,
}: {
  icon: IconName;
  caption?: ReactNode;
  title: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`${styles.card} ${styles.hero}`}>
      <span className={styles.heroMark} aria-hidden="true">
        <Icon name={icon} size={24} />
      </span>
      <div className={styles.heroText}>
        {caption && <small>{caption}</small>}
        <strong>{title}</strong>
        {note && <small>{note}</small>}
      </div>
      {children && <div className={styles.control}>{children}</div>}
    </div>
  );
}

export type Tone = "ok" | "danger" | "warn";

/** A one-line status or hint inside a card, optionally led by a coloured dot. */
export function SettingsLine({
  children,
  tone,
  dot,
  action,
  role,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: Tone | "none";
  action?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className={styles.line} data-tone={tone} role={role}>
      {dot && dot !== "none" && <i className={styles.dot} data-tone={dot} aria-hidden="true" />}
      <span>{children}</span>
      {action}
    </div>
  );
}

export function SettingsEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <strong>{title}</strong>
      {body && <span>{body}</span>}
      {action}
    </div>
  );
}

/** A collapsed-by-default block («高级»): the summary names what is inside. */
export function SettingsFold({
  title,
  summary,
  children,
  icon,
  tone,
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
  /** The fold is a card whose head row leads with this tile. */
  icon?: IconName;
  tone?: TileTone;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const id = useId();
  return (
    <section className={`${styles.section} ${styles.foldCard}`} data-open={open || undefined}>
      <button
        type="button"
        className={styles.fold}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (controlledOpen === undefined) setLocalOpen(!open);
          onOpenChange?.(!open);
        }}
      >
        {icon && <IconTile icon={icon} tone={tone ?? "blue"} size="lg" />}
        <span className={styles.foldTitle}>{title}</span>
        {summary && <small>{summary}</small>}
        <Icon name="chevronRight" size={16} className={styles.foldChevron} />
      </button>
      <div id={id} hidden={!open} className={styles.card}>
        {children}
      </div>
    </section>
  );
}

export const layoutStyles = styles;
