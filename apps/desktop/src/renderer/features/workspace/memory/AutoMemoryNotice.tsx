import type { MemoryProposal } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "../workspace.module.css";
import { MemoryScopeLabel } from "./MemoryScopeLabel.tsx";
import { AUTO_NOTICE_MS, type MemoryNoticesController } from "./memory-notices.ts";
import { useOpenMemory } from "./use-open-memory.ts";

export function AutoMemoryNotice({
  proposal,
  controller,
  busy,
  receipt,
}: {
  proposal: MemoryProposal;
  controller: MemoryNoticesController;
  busy: boolean;
  receipt: boolean;
}) {
  const t = useT();
  const openMemory = useOpenMemory();
  // Pre-scope notices belonged to their Bot; an explicit group must retain its own identity.
  const scope = proposal.scope ?? "bot";
  const ownerId =
    proposal.ownerId ?? (scope === "user" ? "user" : scope === "bot" ? proposal.botId : undefined);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (receipt) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dismiss = () => controller.dismissNotice(proposal.id);
    const reduced = () => {
      if (motion.matches && fading) dismiss();
    };
    motion.addEventListener("change", reduced);
    if (hovered || focused || busy) setFading(false);
    else if (fading) timer = setTimeout(dismiss, motion.matches ? 0 : 180);
    else
      timer = setTimeout(() => {
        if (motion.matches) dismiss();
        else setFading(true);
      }, AUTO_NOTICE_MS);
    return () => {
      clearTimeout(timer);
      motion.removeEventListener("change", reduced);
    };
  }, [controller, proposal.id, hovered, focused, busy, fading, receipt]);
  return (
    <fieldset
      aria-label={t("workspace.memory")}
      className={`${styles.item} ${styles.autoNotice}`}
      data-fading={(!receipt && fading) || undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div className={styles.noticeHead}>
        <IconTile icon="star" tone="violet" size="sm" className={styles.noticeMark} />
        <strong>
          {t(
            receipt ? "workspace.memoryApplied.add" : `workspace.memoryApplied.${proposal.action}`,
          )}{" "}
          · {t(`workspace.category.${proposal.category ?? "other"}`)}
        </strong>
        <MemoryScopeLabel scope={proposal.scope} />
      </div>
      <div className={styles.noticeBody}>
        <p>{proposal.text}</p>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void controller.undo(proposal.id)}
        >
          {t("workspace.undo")}
        </Button>
        <Button
          variant="ghost"
          className={styles.noticeLink}
          disabled={!ownerId}
          onClick={() => ownerId && openMemory({ scope, ownerId })}
        >
          {t("workspace.viewMemory")}
        </Button>
      </div>
    </fieldset>
  );
}
