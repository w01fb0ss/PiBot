import { type BotPanelTab, botPanelStyles as styles, useT } from "@pibot/renderer-kit";
import { CloseButton } from "@pibot/ui";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const tabs = ["details", "agent", "topics", "memory", "permissions"] as const;
export function PanelFrame({
  label,
  tab,
  changeTab,
  close,
  header,
  children,
  items,
  menu,
  tone,
  id = "bot-panel",
}: {
  label: string;
  /** The Bot's (or group's) avatar colour washes the panel top. */
  tone?: string;
  /** The panel's "⋯" menu, left of the close button. */
  menu?: ReactNode;
  tab: string;
  changeTab(tab: string): void;
  close(): void;
  header: ReactNode;
  children: ReactNode;
  items: readonly { value: string; label: string }[];
  id?: string;
}) {
  const t = useT();
  const root = useRef<HTMLElement>(null);
  const [overlay, setOverlay] = useState(() => window.matchMedia("(max-width: 1100px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const change = () => setOverlay(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    // Restoring from a panel must preserve pointer vs keyboard focus, not inherit its close button.
    const focusOptions: FocusOptions & { focusVisible: boolean } = {
      preventScroll: true,
      focusVisible: opener?.matches(":focus-visible") ?? false,
    };
    const element = root.current;
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (!element?.contains(document.activeElement) && document.activeElement !== document.body)
        return;
      if (opener?.isConnected) opener.focus(focusOptions);
      else
        document.querySelector<HTMLButtonElement>("[data-bot-panel-trigger]")?.focus(focusOptions);
    };
  }, []);
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest("dialog, [popover]"))
      )
        return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [close]);
  return (
    <aside
      ref={root}
      id={id}
      data-panel-focus-boundary="true"
      role={overlay ? "dialog" : "complementary"}
      aria-label={label}
      className={styles.panel}
      style={tone ? ({ "--panel-c": `var(--avatar-${tone})` } as CSSProperties) : undefined}
      onKeyDown={(event) => {
        if (
          !overlay ||
          event.key !== "Tab" ||
          (event.target instanceof Element && event.target.closest("dialog"))
        )
          return;
        const nodes = [
          ...(root.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) ?? []),
        ].filter((node) => node.getClientRects().length && node.tabIndex >= 0);
        const edge = event.shiftKey ? nodes[0] : nodes.at(-1);
        if (document.activeElement === edge) {
          event.preventDefault();
          if (event.shiftKey) {
            const lastTarget = nodes.at(-1);
            const regions = root.current?.querySelectorAll<HTMLElement>(
              "[data-virtual-focus-region]",
            );
            if (regions) {
              for (let index = regions.length - 1; index >= 0; index--) {
                const region = regions[index];
                if (!region || !region.getClientRects().length) continue;
                const coversLast =
                  !lastTarget ||
                  region.contains(lastTarget) ||
                  (lastTarget.compareDocumentPosition(region) &
                    Node.DOCUMENT_POSITION_FOLLOWING) !==
                    0;
                if (!coversLast) break;
                const focusEdge = new CustomEvent("pibot:focus-virtual-edge", {
                  cancelable: true,
                  detail: { edge: "last" },
                });
                if (!region.dispatchEvent(focusEdge)) return;
              }
            }
            lastTarget?.focus();
            return;
          }
          nodes[0]?.focus();
        }
      }}
    >
      <div className={styles.closeRow}>
        {menu}
        <CloseButton label={t("workspace.close")} onClick={close} />
      </div>
      <div className={styles.identity}>{header}</div>
      <div
        role="tablist"
        aria-label={label}
        className={styles.tabs}
        style={
          {
            "--tab-count": items.length,
            "--tab-index": Math.max(
              items.findIndex((item) => item.value === tab),
              0,
            ),
          } as CSSProperties
        }
      >
        {items.map(({ value, label }, index) => (
          <button
            type="button"
            key={value}
            id={`${id}-tab-${value}`}
            role="tab"
            aria-selected={value === tab}
            aria-controls={`${id}-content`}
            tabIndex={value === tab ? 0 : -1}
            className={styles.tab}
            onClick={() => changeTab(value)}
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : direction
                      ? (index + direction + items.length) % items.length
                      : undefined;
              if (next === undefined) return;
              event.preventDefault();
              const value = items[next]?.value;
              if (value) changeTab(value);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>("button")
                [next]?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-content`}
        aria-labelledby={`${id}-tab-${tab}`}
        className={styles.content}
      >
        {children}
      </div>
    </aside>
  );
}

export function BotPanelFrame(props: {
  label: string;
  menu?: ReactNode;
  tone?: string;
  tab: BotPanelTab;
  changeTab(tab: BotPanelTab): void;
  close(): void;
  header: ReactNode;
  children: ReactNode;
  /** An external agent keeps its own memory and skills, so that tab is not shown. */
  agent?: boolean;
}) {
  const t = useT();
  return (
    <PanelFrame
      {...props}
      items={tabs
        // An agent keeps its own memory and skills; only an agent Bot has the agent tab.
        .filter((value) => (props.agent ? value !== "memory" : value !== "agent"))
        .map((value) => ({
          value,
          label: t(`workspace.panel.${value}`),
        }))}
      changeTab={(value) => {
        const tab = tabs.find((tab) => tab === value);
        if (tab) props.changeTab(tab);
      }}
    />
  );
}
