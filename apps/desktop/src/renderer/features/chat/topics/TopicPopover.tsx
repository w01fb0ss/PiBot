import { displayTopicTitle } from "@pibot/client-core";
import { useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styles from "./topic-menu.module.css";

/** Shared header topic selector frame for DM and group lists. */
export function TopicPopover({
  title,
  error,
  retry,
  children,
}: {
  title: string;
  error?: boolean;
  retry?(): void;
  children: ReactNode;
}) {
  const t = useT();
  title = displayTopicTitle(title, t("messages.forwardedTitle"));
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(380, window.innerWidth - 32);
      setPosition({
        top: box.bottom + 8,
        left: Math.max(16, Math.min(box.left, window.innerWidth - width - 16)),
        width,
        maxHeight: Math.max(120, window.innerHeight - box.bottom - 24),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useLayoutEffect(() => {
    if (open && position) panel.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [open, position]);
  useEffect(() => {
    if (!open) return;
    const close = (focus: boolean) => {
      setOpen(false);
      if (focus) trigger.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !panel.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        data-header-topic
        className={styles.trigger}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{title}</span>
        <Icon name="chevron" size={12} className={styles.chevron} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className={styles.panel}
            role="dialog"
            aria-label={t("workspace.topics")}
            style={position}
          >
            {error && (
              <p role="alert">
                {t("workspace.failed")} <Button onClick={retry}>{t("common.retry")}</Button>
              </p>
            )}
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
