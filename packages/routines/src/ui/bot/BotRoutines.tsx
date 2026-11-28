import type { Language, TranslationKey, TranslationVars } from "@pibot/i18n";
import { isIndefinitePause, type Routine } from "@pibot/protocol";
import { type Peer, botPanelStyles as panelStyles, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, IconTile, Switch } from "@pibot/ui";
import { useCallback } from "react";
import { type RoutineBot, useRoutineBots } from "../editor/use-routine-bot.ts";
import { usePages } from "../page/paging.ts";
import { type RoutineRowState, useRoutineRows } from "../page/rows.ts";
import { useRoutineNavigation } from "../shell/navigation.ts";
import { useRoutineAction, useRoutineRefresh } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { runFailureKey } from "../timeline/RunHistory.tsx";
import { appTriggerText, hasRetiredTrigger, watchesEvents } from "../triggers/app-trigger-text.ts";
import { cronText, systemTimezone } from "../triggers/cron.ts";

/** Bot panel「话题」: this Bot's scheduled tasks, one row each. */
export function BotRoutines({ botId }: { botId: string }) {
  const { t } = useSettings();
  const { openRoutines } = useRoutineNavigation();
  const load = useCallback(
    async (peer: Peer, before?: string) => {
      const rows = await peer.call("routines.list", { botId, before, limit: 50 });
      if (rows.some((r) => r.botId !== botId)) throw new Error("Routine owner mismatch");
      return rows;
    },
    [botId],
  );
  const page = usePages(load);
  const states = useRoutineRows(page.rows, botId);
  const bots = useRoutineBots(page.rows.length ? [botId] : []);
  useRoutineRefresh(page.refresh, botId);
  return (
    <section className={panelStyles.section}>
      <div className={panelStyles.sectionHead}>
        <h2>{t("routines.title")}</h2>
        <Button
          variant="pill"
          className={panelStyles.menuTrigger}
          onClick={() => openRoutines("new", botId)}
        >
          {t("routines.new")}
        </Button>
      </div>
      {!!page.rows.length && (
        <div className={panelStyles.card}>
          {page.rows.map((r) => (
            <RoutineRow
              key={r.id}
              routine={r}
              bot={bots.get(botId)}
              state={states.value?.rows.get(r.id)}
              pausedUntil={states.value?.pausedUntil}
              asOf={states.value?.at}
              open={() => openRoutines(r.id, botId)}
            />
          ))}
        </div>
      )}
      {states.error && (
        <p role="alert" className={panelStyles.error}>
          {t(states.error)}{" "}
          <Button variant="pill" onClick={states.refresh}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {page.loading && (
        <p role="status" className={panelStyles.note}>
          {t("common.loading")}
        </p>
      )}
      {page.error && (
        <p role="alert" className={panelStyles.error}>
          {t(page.error)}{" "}
          <Button variant="pill" onClick={page.refresh}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!page.loading && !page.error && !page.rows.length && (
        <p className={panelStyles.note}>{t("panel.noRoutines")}</p>
      )}
      {page.more && (
        <Button
          variant="pill"
          className={panelStyles.more}
          disabled={page.loading}
          onClick={() => void page.next()}
        >
          {t("routines.more")}
        </Button>
      )}
    </section>
  );
}

/**
 * "今天 17:00" / "明天 17:00" / "周五 17:00" / "10月20日 17:00", in this computer's time zone
 * (the routine's own zone only decides when it fires; the user reads local time).
 */
export function humanTime(
  iso: string,
  language: Language,
  t: (key: TranslationKey, vars?: TranslationVars) => string,
  now = new Date(),
): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round((day(date).getTime() - day(now).getTime()) / 86_400_000);
  if (days === 0) return t("panel.today", { time });
  if (days === 1) return t("panel.tomorrow", { time });
  if (days > 1 && days < 7)
    return `${date.toLocaleDateString(language, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(language, { month: "short", day: "numeric" })} ${time}`;
}

function cadence(routine: Routine, language: Language, t: ReturnType<typeof useSettings>["t"]) {
  const local = systemTimezone();
  return routine.triggers
    .map((trigger) => {
      const config = trigger.config;
      if (config.kind === "cron") {
        const text = cronText(config.expr, config.timezone, language);
        // The zone is only worth showing when it is not this computer's.
        const suffix = ` · ${config.timezone}`;
        return config.timezone === local && text.endsWith(suffix)
          ? text.slice(0, -suffix.length)
          : text;
      }
      if (config.kind === "once") return t("panel.once");
      if (config.kind === "folder") return t("routines.onChange");
      return appTriggerText(config, t) ?? "";
    })
    .join(" / ");
}

function RoutineRow({
  routine,
  bot,
  state,
  pausedUntil,
  asOf,
  open,
}: {
  routine: Routine;
  bot: RoutineBot | undefined;
  state?: RoutineRowState;
  pausedUntil?: string | null;
  asOf?: string;
  open(): void;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const action = useRoutineAction();
  const referencesUnsupported = bot?.category === "image" && !bot.imageScheduleAvailable;
  const enablingBlocked = !bot || referencesUnsupported;
  const recent = state?.lastResult ?? state?.onceOutcome;
  const paused = pausedUntil && new Date(pausedUntil) > new Date(asOf ?? Date.now());
  const consumed =
    routine.triggers.length === 1 &&
    routine.triggers[0]?.config.kind === "once" &&
    !!routine.triggers[0].state.consumedAt;
  const next = !state
    ? t("routines.nextUnknown")
    : !routine.enabled
      ? t("routines.disabled")
      : routine.pausedReason
        ? t(`routines.paused.${routine.pausedReason}`)
        : paused
          ? isIndefinitePause(pausedUntil)
            ? t("routines.pausedIndefinitely")
            : t("routines.pausedUntil", { time: humanTime(pausedUntil, language, t) })
          : consumed
            ? t("routines.once.consumed")
            : state.nextAt
              ? t("panel.next", { time: humanTime(state.nextAt, language, t) })
              : routine.triggers.some((trigger) => watchesEvents(trigger.config))
                ? ""
                : t("routines.noPlan");
  // Only what needs the user's attention gets a second line; the rest is in the task dialog.
  const warning = referencesUnsupported
    ? t("media.routineReferencesUnsupported")
    : hasRetiredTrigger(routine.triggers.map((trigger) => trigger.config))
      ? t("routines.githubRetired")
      : state?.attentionCount
        ? t("routines.attention", { count: state.attentionCount })
        : recent?.errorCode
          ? t(runFailureKey(recent.errorCode))
          : undefined;
  return (
    <div className={panelStyles.cardRow}>
      <IconTile icon="clock" tone={routine.enabled ? "orange" : "neutral"} size="lg" />
      <button type="button" className={styles.panelOpen} onClick={open}>
        <strong>{routine.name}</strong>
        <small>{[cadence(routine, language, t), next].filter(Boolean).join(" · ")}</small>
        {warning && <small className={styles.panelWarn}>{warning}</small>}
        {action.error && (
          <small role="alert" className={styles.panelWarn}>
            {t(action.error)}
          </small>
        )}
      </button>
      <Switch
        label={`${t("routines.enabled")} · ${routine.name}`}
        checked={routine.enabled}
        disabled={
          action.disabled ||
          !!routine.deletedAt ||
          (!routine.enabled && (enablingBlocked || !!consumed))
        }
        onCheckedChange={(enabled) => {
          if (peer && (!enabled || !enablingBlocked))
            void action.run(() => peer.call("routines.setEnabled", { id: routine.id, enabled }));
        }}
      />
    </div>
  );
}

export { RoutineTopicLabel, RoutineTopicLabelProvider } from "./routine-topic-labels.tsx";
