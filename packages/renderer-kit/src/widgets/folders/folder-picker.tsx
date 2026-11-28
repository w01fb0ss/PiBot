import { Icon, type IconName, IconTile, type Tone } from "@pibot/ui";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "../../settings/context.ts";
import { FolderPickerRow } from "./folder-picker-row.tsx";
import styles from "./folders.module.css";
import { RunnerFolderBrowser } from "./runner-browser.tsx";
import type { RunnerPickTarget } from "./runner-folders.ts";
import { type FolderEntry, type FolderModel, MAX_WRITABLE_FOLDERS } from "./selection.ts";

export function folderLabel(
  model: Pick<FolderModel, "primary" | "readonly" | "writable">,
  t: ReturnType<typeof useT>,
) {
  const count = model.readonly.length + (model.writable?.length ?? 0);
  return count ? t("folders.more", { name: model.primary.name, count }) : model.primary.name;
}

/**
 * The one folder picker of a conversation (DM topic or draft, group, routine). The trigger
 * shows the main folder (+N additional folders); the popover changes this conversation only.
 */
export function FolderPicker({
  model,
  variant = "subtitle",
  inherit,
  disabled,
  placement = "below",
  openRequest,
  footer,
  heading,
}: {
  model: FolderModel;
  /** `draft`: the new-topic line's four choices; `subtitle` / `field`: the full menu. */
  variant?: "subtitle" | "draft" | "field";
  inherit?: { name: string; active: boolean; select(): void };
  disabled?: boolean;
  placement?: "below" | "above";
  /** Changing this number opens the popover (a "folder unavailable" reply points here). */
  openRequest?: number;
  /** Extra section of the full menu. */
  footer?: ReactNode;
  /** Menu heading; defaults to the chat's folders (a routine passes its own). */
  heading?: string;
}) {
  const t = useT();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Browsing a runner replaces the menu until a folder is picked or the user goes back.
  const [browsing, setBrowsing] = useState<{ runner: string; target: RunnerPickTarget }>();
  // The header line clips its overflow, so the popover lives on <body> at the trigger's position.
  const [position, setPosition] = useState<CSSProperties>();
  const locked = model.busy || model.pending;
  const close = (focus = false) => {
    setOpen(false);
    setBrowsing(undefined);
    if (focus) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(360, window.innerWidth - 32);
      const left = Math.max(16, Math.min(box.left - 8, window.innerWidth - width - 16));
      setPosition(
        placement === "above"
          ? { left, width, bottom: window.innerHeight - box.top + 8 }
          : { left, width, top: box.bottom + 8 },
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, placement]);
  useLayoutEffect(() => {
    if (open && position)
      panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, position]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) setBrowsing(undefined);
  }, [open]);
  useEffect(() => {
    if (openRequest) setOpen(true);
  }, [openRequest]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);
  const act = (action: () => void) => () => {
    close(true);
    action();
  };
  const label = model.failed ? t("workplaces.unavailable") : folderLabel(model, t);
  const title = [model.primary, ...(model.writable ?? []), ...model.readonly]
    .map((f) => f.path ?? f.name)
    .join("\n");
  const item = (
    key: string,
    text: ReactNode,
    action: () => void,
    options: {
      icon?: readonly [IconName, Tone];
      checked?: boolean;
      disabled?: boolean;
      keepOpen?: boolean;
    } = {},
  ) => (
    <button
      key={key}
      type="button"
      className={styles.item}
      disabled={options.disabled ?? locked}
      aria-pressed={options.checked}
      onClick={options.keepOpen ? action : act(action)}
    >
      {options.icon ? (
        <IconTile icon={options.icon[0]} tone={options.icon[1]} size="sm" />
      ) : (
        <span className={styles.itemIcon} aria-hidden="true" />
      )}
      <span className={styles.itemText}>{text}</span>
      {options.checked && <Icon name="check" size={15} className={styles.check} />}
    </button>
  );
  const row = (folder: FolderEntry, role: "primary" | "readonly" | "writable") => (
    <FolderPickerRow
      key={`${role}:${folder.id}`}
      folder={folder}
      role={role}
      model={model}
      locked={locked}
      act={act}
    />
  );
  const homeName = t(model.homeLabel ?? "folders.home");
  // A workspace stays on one device, so a runner primary takes references from that runner.
  const primaryRunner =
    model.browseRunner && model.pickRunner && model.primary.location?.startsWith("runner:")
      ? model.primary.location
      : undefined;
  const runnerOnline = (id: string) => !!model.runners?.some((r) => r.id === id && r.online);
  // One entry next to "Choose another folder…"; the browser switches between runners.
  const onlineRunners = model.runners?.filter((r) => r.online) ?? [];
  const onlyRunner = model.runners?.length === 1 ? model.runners[0] : undefined;
  const runnerItem = (target: RunnerPickTarget) =>
    model.runners?.length && model.browseRunner && model.pickRunner
      ? item(
          "runner",
          !onlineRunners.length
            ? t("remote.runner.pickOffline")
            : onlyRunner
              ? t("remote.runner.pickOn", { name: onlyRunner.name })
              : t("remote.runner.pick"),
          () => {
            const runner =
              primaryRunner && runnerOnline(primaryRunner) ? primaryRunner : onlineRunners[0]?.id;
            if (runner) setBrowsing({ runner, target });
          },
          {
            icon: ["terminal", "violet"],
            disabled: locked || !onlineRunners.length,
            keepOpen: true,
          },
        )
      : null;
  return (
    <div ref={root} className={`${styles.anchor} ${styles[variant]}`}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-haspopup="dialog"
        data-folder-picker={variant}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={t("folders.trigger", { name: label })}
        title={title}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <Icon name={model.primary.id === "home" ? "home" : "folder"} size={13} />
        <span className={styles.triggerText}>{label}</span>
        <Icon name="chevron" size={13} className={styles.chevron} />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label={heading ?? t("folders.title")}
            className={`${styles.panel} ${styles[variant]}`}
            style={position}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }
            }}
          >
            {model.busy && (
              <p className={styles.notice} role="status">
                {t("folders.busy")}
              </p>
            )}
            {model.pending && !model.busy && (
              <p className={styles.notice} role="status">
                {t("folders.picking")}
              </p>
            )}
            {browsing && model.browseRunner && model.runners ? (
              <RunnerFolderBrowser
                runners={model.runners}
                runner={browsing.runner}
                fixed={browsing.target === "readonly"}
                browse={model.browseRunner}
                locked={locked}
                onBack={() => setBrowsing(undefined)}
                onPick={(location, path) =>
                  act(() => model.pickRunner?.(location, path, browsing.target))()
                }
              />
            ) : variant === "draft" ? (
              <>
                <div className={styles.group}>
                  {inherit &&
                    item("inherit", t("folders.inherit", { name: inherit.name }), inherit.select, {
                      icon: ["folder", "amber"],
                      checked: inherit.active,
                    })}
                  {item("pick", t("folders.pickOther"), () => model.pick("only"), {
                    icon: ["search", "blue"],
                  })}
                  {runnerItem("only")}
                  {item("create", t("folders.create"), () => model.pick("only", true), {
                    icon: ["plus", "green"],
                  })}
                  {item("home", t("folders.useHome"), () => model.setOnly("home"), {
                    icon: ["home", "amber"],
                    checked:
                      !inherit?.active &&
                      model.primary.id === "home" &&
                      !model.readonly.length &&
                      !model.writable?.length,
                  })}
                </div>
              </>
            ) : (
              <>
                <p className={styles.heading}>{heading ?? t("folders.title")}</p>
                {/* Sub-headings only tell two lists apart; one list needs none. */}
                {model.writable && model.readonly.length > 0 && (
                  <p className={styles.heading}>{t("folders.writableFolders")}</p>
                )}
                <ul className={styles.rows}>
                  {row(
                    {
                      ...model.primary,
                      name: model.primary.id === "home" ? homeName : model.primary.name,
                    },
                    "primary",
                  )}
                  {model.writable?.map((folder) => row(folder, "writable"))}
                </ul>
                {model.readonly.length > 0 && (
                  <>
                    {model.writable && (
                      <p className={styles.heading}>{t("folders.readonlyFolders")}</p>
                    )}
                    <ul className={styles.rows}>
                      {model.readonly.map((folder) => row(folder, "readonly"))}
                    </ul>
                  </>
                )}
                {model.recent.length > 0 && (
                  <>
                    <p className={styles.heading}>{t("folders.recent")}</p>
                    <ul className={styles.rows}>
                      {model.recent.map((folder) => (
                        <li key={folder.id} className={styles.row}>
                          <button
                            type="button"
                            className={styles.recent}
                            disabled={locked}
                            title={folder.path}
                            aria-label={t("folders.useRecent", { name: folder.name })}
                            onClick={act(() => model.setPrimary(folder.id))}
                          >
                            <IconTile icon="folder" tone="blue" />
                            <span className={styles.rowName}>
                              <span className={styles.name}>{folder.name}</span>
                              {folder.path && <span className={styles.path}>{folder.path}</span>}
                            </span>
                          </button>
                          <button
                            type="button"
                            className={styles.mini}
                            disabled={locked || model.readonly.length >= 32}
                            aria-label={t("folders.addRecentReadonly", { name: folder.name })}
                            onClick={act(() => model.setReadonly(folder.id))}
                          >
                            {t("folders.asReadonly")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className={styles.group}>
                  {item("pick", t("folders.pickOther"), () => model.pick("primary"), {
                    icon: ["search", "blue"],
                  })}
                  {runnerItem("primary")}
                  {item("create", t("folders.create"), () => model.pick("primary", true), {
                    icon: ["plus", "green"],
                  })}
                  {model.writable &&
                    item("writable", t("folders.addWritable"), () => model.pickWritable?.(), {
                      icon: ["plus", "orange"],
                      disabled:
                        locked ||
                        !model.pickWritable ||
                        model.writable.length >= MAX_WRITABLE_FOLDERS,
                    })}
                  {item(
                    "readonly",
                    t("folders.addReadonly"),
                    () =>
                      primaryRunner
                        ? setBrowsing({ runner: primaryRunner, target: "readonly" })
                        : model.pick("readonly"),
                    {
                      icon: ["link", "teal"],
                      disabled:
                        locked ||
                        model.readonly.length >= 32 ||
                        (!!primaryRunner && !runnerOnline(primaryRunner)),
                      keepOpen: !!primaryRunner,
                    },
                  )}
                  {model.primary.id !== "home" &&
                    item(
                      "home",
                      homeName === t("folders.home") ? t("folders.useHome") : homeName,
                      () => model.setPrimary("home"),
                      { icon: ["home", "amber"] },
                    )}
                </div>
                {model.writable && !model.pickWritable && (
                  <p className={styles.notice}>{t("folders.writableUnsupported")}</p>
                )}
                {model.writable && model.writable.length >= MAX_WRITABLE_FOLDERS && (
                  <p className={styles.notice}>{t("folders.writableFull")}</p>
                )}
                {footer}
                <p className={styles.foot}>
                  {t(model.writable ? "folders.writableBoundary" : "folders.boundary")}
                </p>
              </>
            )}
          </div>,
          // A modal <dialog> (the routine editor) is in the top layer; the popover must join it.
          trigger.current?.closest("dialog") ?? document.body,
        )}
      {model.error && !open && (
        <span className={styles.error} role="alert">
          {t(model.error)}
        </span>
      )}
    </div>
  );
}
