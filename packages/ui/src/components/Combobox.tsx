import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styles from "./Combobox.module.css";
import { ComboboxList } from "./ComboboxList.tsx";
import field from "./components.module.css";
import { Icon, type IconName } from "./Icon.tsx";
import { useComboboxPosition } from "./use-combobox-position.ts";

export interface ComboboxOption {
  value: string;
  label: string;
  secondary?: string;
  keywords?: readonly string[];
  group?: string;
  disabled?: boolean;
  /** De-emphasized but still selectable (for example, an empty activity category). */
  muted?: boolean;
  title?: string;
  /**
   * A face or badge that identifies the option at a glance (for example a Bot's avatar). The
   * picker stays text-only for search, so the node never has to be readable to find an option.
   */
  leading?: ReactNode;
}

export interface ComboboxProps {
  variant?: "field" | "pill" | "badge" | "subtitle";
  /**
   * The list's minimum width. A fixed-width field (settings model pickers) is narrower than its
   * options' names and context lines; matching the trigger cut every option to a few letters.
   */
  popupMinWidth?: number;
  hideLabel?: boolean;
  triggerIcon?: IconName;
  /** Display text for the trigger when it differs from the selected option's label. */
  triggerLabel?: string;
  label: string;
  options: readonly ComboboxOption[];
  value: string;
  onValueChange(value: string): void;
  placeholder: string;
  searchPlaceholder: string;
  noResultsText: string;
  moreResultsText(remaining: number): string;
  disabled?: boolean;
  id?: string;
}

function useMatches(options: readonly ComboboxOption[], query: string) {
  const indexed = useMemo(
    () =>
      options.map((option) => ({
        option,
        label: option.label.toLowerCase(),
        text: [option.label, ...(option.keywords ?? [])].join(" ").toLowerCase(),
      })),
    [options],
  );
  return useMemo(() => {
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const prefix: ComboboxOption[] = [];
    const other: ComboboxOption[] = [];
    for (const item of indexed) {
      if (!tokens.every((token) => item.text.includes(token))) continue;
      // Stable linear partition avoids sorting the entire catalog on each keystroke.
      (tokens[0] && !item.label.startsWith(tokens[0]) ? other : prefix).push(item.option);
    }
    const matches = [...prefix, ...other];
    return { visible: matches.slice(0, 200), remaining: Math.max(0, matches.length - 200) };
  }, [indexed, query]);
}

export function Combobox({
  label,
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  noResultsText,
  moreResultsText,
  disabled = false,
  id,
  variant = "field",
  popupMinWidth,
  hideLabel = false,
  triggerIcon,
  triggerLabel,
}: ComboboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const labelId = `${inputId}-label`;
  const listId = `${inputId}-list`;
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const open = expanded && !disabled;
  const subtitle = variant === "subtitle";
  const position = useComboboxPosition(
    open,
    trigger,
    popupMinWidth ?? (variant === "field" ? 0 : 360),
  );
  const { visible, remaining } = useMatches(options, query);
  const selected = useMemo(
    () => options.find((option) => option.value === value),
    [options, value],
  );
  const enabled = useMemo(() => visible.filter((option) => !option.disabled), [visible]);
  const active = enabled.find((option) => option.value === activeValue) ?? enabled[0];
  const activeId = active ? `${listId}-${encodeURIComponent(active.value)}` : undefined;
  const close = (restoreFocus = false) => {
    setExpanded(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = () => {
    setQuery("");
    setActiveValue(undefined);
    setExpanded(true);
  };
  const select = (option: ComboboxOption) => {
    if (option.disabled) return;
    close(true);
    onValueChange(option.value);
  };
  useEffect(() => {
    if (disabled) setExpanded(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (open) {
      composing.current = false;
      if (popup.current?.hasAttribute("popover")) popup.current.showPopover();
      search.current?.focus();
    }
  }, [open]);
  useLayoutEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [open, activeId]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !trigger.current?.contains(target) &&
        !popup.current?.contains(target)
      ) {
        setExpanded(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") {
      // Resume native tab order at the trigger, rather than at the end-of-body portal.
      close(true);
      return;
    }
    // Match chat's IME guard, including Chromium's keyCode 229 after compositionend.
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) select(active);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = active ? enabled.indexOf(active) : -1;
      const next = Math.max(
        0,
        Math.min(enabled.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
      );
      setActiveValue(enabled[next]?.value);
    }
  };
  return (
    <div className={variant === "field" ? field.field : styles.inlineField}>
      <label
        id={labelId}
        htmlFor={inputId}
        className={hideLabel ? styles.hiddenLabel : field.label}
      >
        {label}
      </label>
      <button
        ref={trigger}
        id={inputId}
        type="button"
        role={open ? undefined : "combobox"}
        aria-labelledby={labelId}
        title={subtitle || triggerIcon ? label : selected?.title}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        className={`${subtitle ? "" : field.input} ${styles.trigger} ${triggerIcon ? styles.iconOnly : ""} ${variant === "field" ? "" : styles[variant]}`}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }
        }}
      >
        {triggerIcon ? (
          <Icon name={triggerIcon} />
        ) : (
          <>
            {selected?.leading && <span className={styles.leading}>{selected.leading}</span>}
            <span className={`${styles.value} ${selected || subtitle ? "" : styles.placeholder}`}>
              {triggerLabel ?? selected?.label ?? placeholder}
            </span>
            <Icon
              name="chevron"
              size={subtitle ? 12 : undefined}
              className={subtitle ? styles.chevron : undefined}
            />
          </>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            popover={trigger.current?.closest("dialog") ? "manual" : undefined}
            className={styles.popup}
            style={position}
          >
            <input
              ref={search}
              role="combobox"
              aria-labelledby={labelId}
              aria-expanded={true}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={activeId}
              className={`${field.input} ${styles.search}`}
              placeholder={searchPlaceholder}
              value={query}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveValue(undefined);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={onKeyDown}
            />
            <ComboboxList
              id={listId}
              labelId={labelId}
              options={visible}
              value={value}
              active={active}
              onActiveChange={setActiveValue}
              onSelect={select}
            />
            <div role="status" aria-live="polite">
              {!visible.length && <p className={styles.message}>{noResultsText}</p>}
              {remaining > 0 && <p className={styles.message}>{moreResultsText(remaining)}</p>}
            </div>
          </div>,
          // Modal content must stay in the dialog's top layer and focus boundary.
          trigger.current?.closest("dialog, [data-panel-focus-boundary]") ?? document.body,
        )}
    </div>
  );
}
