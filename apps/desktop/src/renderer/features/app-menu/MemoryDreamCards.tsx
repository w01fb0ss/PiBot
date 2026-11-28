import {
  type MemoryDreamSummary,
  type MemoryMaintenanceStatus,
  type MethodResults,
  memoryFailureNeedsSettings,
} from "@pibot/protocol";
import {
  layoutStyles,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useRpc,
  useRpcEvent,
  useSettings,
} from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { MemoryFallbackNotice } from "../workspace/memory/MemoryFallbackNotice.tsx";
import menu from "./app-menu.module.css";
import { MemoryDreamSettings } from "./MemoryDreamSettings.tsx";

type Changes = MethodResults["memory.dream.changes"];

export function MemoryDreamCards({
  dailyUsage,
  budgetFocus,
}: {
  dailyUsage?: MemoryMaintenanceStatus["dailyUsage"];
  budgetFocus?: string;
}) {
  const { peer } = useRpc();
  const { t, settings } = useSettings();
  const [snapshot, setSnapshot] = useState<{
    peer: typeof peer;
    revision: number;
    summary: MemoryDreamSummary | null;
  }>();
  const summary = snapshot?.peer === peer ? (snapshot?.summary ?? null) : null;
  const [changes, setChanges] = useState<Changes>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"empty" | "busy" | "failed">();
  const [revision, setRevision] = useState(0);
  const live = useRef<AbortController | null>(null);
  useRpcEvent("memory.dream.finished", () => setRevision((value) => value + 1));
  useEffect(() => {
    setChanges(undefined);
    if (!peer) return;
    const controller = new AbortController();
    void peer
      .call("memory.dream.last", {}, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSnapshot({ peer, revision, summary: value });
      })
      .catch(() => {
        /* An older or disconnected brain cannot provide a summary. */
      });
    return () => controller.abort();
  }, [peer, revision]);
  useEffect(() => {
    if (!peer) return;
    return () => {
      live.current?.abort();
      live.current = null;
    };
  }, [peer]);
  const action = async (name: "run" | "undo" | "changes") => {
    if (!peer || live.current) return;
    const controller = new AbortController();
    live.current = controller;
    setPending(true);
    setStatus(undefined);
    try {
      if (name === "run") {
        const next = await peer.call(
          "memory.dream.run",
          { ownerInitiated: true },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setSnapshot({ peer, revision, summary: next });
        if (next.status === "done" && !next.merged && !next.retired && !next.proposed)
          setStatus("empty");
      } else if (summary && name === "undo") {
        await peer.call("memory.dream.undo", { id: summary.id }, { signal: controller.signal });
      } else if (summary) {
        if (changes) setChanges(undefined);
        else {
          const rows = await peer.call(
            "memory.dream.changes",
            { id: summary.id },
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) setChanges(rows);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setStatus(
          error instanceof Error && error.message === "memory_dream_busy" ? "busy" : "failed",
        );
    } finally {
      if (live.current === controller) {
        live.current = null;
        setPending(false);
      }
    }
  };
  const changed = summary && (summary.merged || summary.retired || summary.proposed);
  return (
    <div className={menu.dreamSettings}>
      <SettingsSection title={t("memorySettings.dream.heading")} bare>
        <div className={layoutStyles.card} aria-busy={pending}>
          <SettingsRow
            icon="refresh"
            tone="violet"
            label={t("memorySettings.dream.lead")}
            note={t("memorySettings.dream.sharedNote")}
          >
            <Button variant="pill" disabled={!peer || pending} onClick={() => void action("run")}>
              {t("memorySettings.dream.run")}
            </Button>
          </SettingsRow>
          {status && (
            <SettingsLine
              role={status === "failed" ? "alert" : "status"}
              tone={status === "failed" ? "danger" : status === "busy" ? "warn" : undefined}
            >
              {t(`memorySettings.dream.${status}`)}
            </SettingsLine>
          )}
          {summary?.status === "failed" && (
            <SettingsLine role="status" tone="warn" dot="warn">
              {summary.failureReason === "local_only_no_model"
                ? t("memorySettings.dream.localOnlyNoModel")
                : summary.failureReason === "no_model"
                  ? t("memorySettings.dream.noModel")
                  : summary.failureReason && memoryFailureNeedsSettings(summary.failureReason)
                    ? t("memorySettings.dream.runFailed")
                    : t("memorySettings.dream.runStopped", {
                        reason: t(
                          `memorySettings.maintenance.${summary.failureReason ?? "failed"}`,
                        ),
                      })}
            </SettingsLine>
          )}
          {summary?.budgetUpdated && (
            <SettingsLine role="status">{t("memorySettings.dream.budgetUpdated")}</SettingsLine>
          )}
          {!summary?.budgetUpdated &&
            (summary?.status === "limited" || summary?.status === "interrupted") && (
              <SettingsLine role="status" tone="warn" dot="warn">
                {t(
                  summary.status === "limited" && summary.failureReason === "budget_exhausted"
                    ? "memorySettings.dream.dailyLimited"
                    : `memorySettings.dream.${summary.status}`,
                )}
              </SettingsLine>
            )}
          {summary?.fallback && (
            <MemoryFallbackNotice
              fallback={summary.fallback}
              partial={summary.status !== "done"}
              settingsLine
            />
          )}
          {!!changed && summary && (
            <SettingsRow
              icon="moon"
              tone="violet"
              label={t("memorySettings.dream.title")}
              note={t("memorySettings.dream.summary", {
                merged: summary.merged,
                retired: summary.retired,
                proposed: summary.proposed,
              })}
            >
              <div className={menu.dreamActions}>
                {summary.undoable && (
                  <Button variant="pill" disabled={pending} onClick={() => void action("undo")}>
                    {t("memorySettings.dream.undo")}
                  </Button>
                )}
                <Button
                  variant="pill"
                  disabled={pending}
                  aria-expanded={!!changes}
                  onClick={() => void action("changes")}
                >
                  {t("memorySettings.dream.changes")}
                </Button>
              </div>
            </SettingsRow>
          )}
          {changes && summary && (
            <ul aria-label={t("memorySettings.dream.changes")} className={menu.dreamChanges}>
              {changes.map((item) => (
                <li key={item.proposalId}>
                  <strong>{item.botName}</strong> · {item.text}
                </li>
              ))}
              {summary.proposed > 0 && <li>{t("memorySettings.dream.waiting")}</li>}
            </ul>
          )}
        </div>
        <MemoryDreamSettings
          dailyUsage={dailyUsage}
          budgetFocus={budgetFocus}
          disabled={!peer || !settings || pending}
          onBudgetSaved={() => setRevision((value) => value + 1)}
        />
      </SettingsSection>
    </div>
  );
}
