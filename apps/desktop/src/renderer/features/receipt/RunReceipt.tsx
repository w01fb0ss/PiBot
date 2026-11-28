import { receiptBudgetRaise, receiptSections, receiptSummaryChips } from "@pibot/client-core";
import type { AgentTurnFacts } from "@pibot/external-agents-contract";
import type { RunReceipt as Receipt } from "@pibot/protocol";
import { PopupMenu, RevealFileButton, useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, type ChipProps, Icon, IconTile } from "@pibot/ui";
import { memo, useEffect, useId, useRef, useState } from "react";
import { useBackgroundRun } from "../chat/status/use-background-run.ts";
import { agentReceiptChips, agentReceiptSection } from "./agent-receipt.ts";
import { GroupExecutionFact } from "./GroupExecutionFact.tsx";
import styles from "./receipt.module.css";
import { useRunReceipt } from "./receipt-store.ts";

/** Each summary chip and details section keeps one colour, so a receipt reads at a glance. */
function chipTone(chip: {
  id: string;
  tone: "muted" | "ok" | "warn" | "danger";
}): ChipProps["tone"] {
  if (chip.tone === "danger") return "danger";
  if (chip.tone === "warn") return "warn";
  if (chip.tone === "ok") return "ok";
  return chip.id === "cost" ? "green" : "blue";
}
const sectionTone: Record<string, string> = {
  outcome: "red",
  delivery: "green",
  uncertain: "amber",
  inputs: "blue",
  outputs: "green",
  approvals: "amber",
  actions: "orange",
  cost: "teal",
  unverified: "amber",
};

/**
 * Attention stays in the summary; its evidence and recovery actions live in the details.
 * `embedded` renders it as the footer of another card (the turn's
 * changed-files card) so a reply never gets two cards; `files: false` then skips the file list.
 */
export const RunReceipt = memo(function RunReceipt({
  runId,
  messageId,
  embedded = false,
  files = true,
  agent,
  onStoppedChange,
}: {
  /** An external agent's turn; its own figures replace Pi Bot's cost and approval count. */
  agent?: AgentTurnFacts;
  runId: string;
  /** Under a reply: shown only when this message is the run's own reply. */
  messageId?: string;
  embedded?: boolean;
  files?: boolean;
  /** Lets the reply omit its duplicate status only while this receipt actually shows it. */
  onStoppedChange?(stopped: boolean): void;
}) {
  const { peer } = useRpc();
  const { openAudit } = useNavigation();
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const { data, error, retry } = useRunReceipt(peer, runId);
  const background = useBackgroundRun(data?.botId, runId);
  const stopped = data?.outcome === "stopped" && (!messageId || data.messageId === messageId);
  useEffect(() => {
    onStoppedChange?.(stopped);
    return () => onStoppedChange?.(false);
  }, [onStoppedChange, stopped]);
  const frame = embedded ? styles.footer : styles.card;
  if (!data)
    return error ? (
      <div className={`${frame} ${styles.failed}`} role="status">
        <span>{t("receipt.error")}</span>
        <button type="button" className={styles.link} onClick={retry}>
          {t("common.retry")}
        </button>
      </div>
    ) : null;
  if (data.outcome === "running" || (messageId && data.messageId !== messageId)) return null;
  // Inside the changed-files card the file count is already its title.
  const ownChips = receiptSummaryChips(data, t).filter((chip) => files || chip.id !== "files");
  const summaryChips = agent
    ? [
        ...ownChips.filter((chip) => chip.id !== "cost" && chip.id !== "approvals"),
        ...agentReceiptChips(agent, t),
      ]
    : ownChips;
  const ownSections = receiptSections(data, t, { files });
  const quiet = t("receipt.quiet");
  const sections = agent
    ? [
        ...ownSections
          .filter((section) => section.id !== "cost")
          // Pi Bot's records do not see the agent's own steps: "only replied" would be false.
          .map((section) =>
            agent.steps
              ? { ...section, rows: section.rows.filter((row) => row.value !== quiet) }
              : section,
          ),
        agentReceiptSection(agent, t),
      ]
    : ownSections;
  const chips = background.pending
    ? [
        {
          id: "outcome",
          text: t(background.waiting ? "background.receiptWaiting" : "background.continued"),
          tone: "muted" as const,
        },
        ...summaryChips.filter((chip) => chip.id !== "outcome"),
      ]
    : summaryChips;
  const summary = chips.map((chip) => chip.text).join(" · ");
  return (
    <section className={frame} aria-label={t("receipt.title")}>
      <div className={styles.top}>
        <IconTile icon="audit" tone="teal" size="sm" className={styles.icon} />
        <b className={styles.title}>{t("receipt.title")}</b>
        <ul className={styles.chips} title={summary}>
          {chips.map((chip) => (
            <li key={chip.id}>
              <Chip tone={chipTone(chip)}>{chip.text}</Chip>
            </li>
          ))}
        </ul>
        {/* Maintainers 2026-11-13: 加预算继续 sits in the summary, not only inside 明细. */}
        {data.budgetRaise && <BudgetRaise receipt={data} reload={retry} compact />}
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {t(open ? "receipt.hide" : "receipt.details")}
          <Icon name="chevron" size={13} className={open ? styles.up : undefined} />
        </button>
      </div>
      {data.groupExecution && <GroupExecutionFact fact={data.groupExecution} />}
      <div id={id} hidden={!open}>
        {data.trigger && (
          <p>{t("background.receiptTrigger", { id: data.backgroundCommandId ?? "" })}</p>
        )}
        {open && (
          <div className={styles.sections}>
            {sections.map((section) => (
              <div
                key={section.id}
                className={styles.section}
                data-tone={sectionTone[section.id] ?? "blue"}
              >
                <h4>{section.title}</h4>
                {section.rows.length ? (
                  <dl>
                    {section.rows.map((row) => (
                      <div key={row.key} className={row.tone && styles[row.tone]}>
                        {/* An unlabeled row is a sentence across the whole width. */}
                        {row.label && <dt>{row.label}</dt>}
                        <dd className={row.code ? styles.code : undefined}>
                          {row.value}
                          {row.filePath && (
                            <PopupMenu label={t("messages.actions")} icon="more">
                              <RevealFileButton source={{ runId, path: row.filePath }} />
                            </PopupMenu>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className={styles.empty}>{section.empty}</p>
                )}
              </div>
            ))}
            {data.outcome === "failed" && (
              <Button
                variant="ghost"
                onClick={() => openAudit(data.botId, data.groupId ?? undefined)}
              >
                {t("receipt.viewActivity")}
              </Button>
            )}
            <p className={styles.footnote}>{t("receipt.footnote")}</p>
          </div>
        )}
      </div>
    </section>
  );
});

/**
 * 「预算用完 · 加预算继续」 under a workflow run stopped at its cost cap. One click resumes the
 * same run on the same ledger with the cap raised; the brain re-checks everything it shows here.
 */
export function BudgetRaise({
  receipt,
  reload,
  compact = false,
}: {
  receipt: Receipt;
  reload(): void;
  /** In a summary row whose chip already says 预算用完 · 上限: only the action (or why not). */
  compact?: boolean;
}) {
  const { peer } = useRpc();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  const line = receiptBudgetRaise(receipt, t);
  if (!line) return null;
  const raise = async () => {
    if (!peer || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFailed(false);
    try {
      await peer.call(
        "runs.resume",
        {
          botId: receipt.botId,
          conversationId: receipt.conversationId,
          runId: receipt.runId,
          raiseBudget: true,
          origin: "user",
        },
        { signal: controller.signal, timeoutMs: 30_000 },
      );
      if (!controller.signal.aborted) reload();
    } catch {
      // The brain names the reason in its error code; the card only offers another try.
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className={compact ? styles.budgetInline : styles.budget}>
      {!compact && <span className={styles.warn}>{line.text}</span>}
      {line.action ? (
        <Button
          type="button"
          variant={compact ? "primary" : "secondary"}
          className={compact ? styles.budgetAction : undefined}
          loading={busy}
          onClick={() => void raise()}
        >
          {line.action}
        </Button>
      ) : (
        <span className={styles.muted}>{line.note}</span>
      )}
      {failed && (
        <span role="alert" className={styles.danger}>
          {t("receipt.budgetRaise.error")}
        </span>
      )}
    </div>
  );
}
