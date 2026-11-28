import { nextGroupRoundLimit, type PiHealthItem, type PiHealthReport } from "@pibot/protocol";
import { approvalStyles as styles, useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button, Icon, type IconName } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import own from "./health-card.module.css";
import lively from "./lively.module.css";

const KIND_ICONS: Record<PiHealthItem["kind"], IconName> = {
  approval: "hand",
  run: "play",
  topic: "message",
  plan: "plan",
  task: "check",
  connection: "plug",
  background: "terminal",
};

function since(at: string, language: "zh" | "en") {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  return hours < 48 ? format.format(-hours, "hour") : format.format(-Math.round(hours / 24), "day");
}

/** The default Pi's health checks in this reply: one compact list card each (live). */
export function HealthReports({ messageId }: { messageId: string }) {
  const { peer } = useRpc();
  const [reports, setReports] = useState<PiHealthReport[]>([]);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (!peer) return;
    try {
      setReports(await peer.call("teams.healthReports", { messageId }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [peer, messageId]);
  useEffect(() => {
    void load();
  }, [load]);
  useRpcEvent("teams.health.changed", (event) => {
    if (event.messageId === messageId) void load();
  });
  const { t } = useSettings();
  if (failed)
    return (
      <p role="alert">
        {t("workspace.failed")}{" "}
        <Button variant="pill" onClick={() => void load()}>
          {t("common.retry")}
        </Button>
      </p>
    );
  return reports.map((report) => <HealthReportCard key={report.id} report={report} />);
}

function HealthReportCard({ report }: { report: PiHealthReport }) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const [tapped, setTapped] = useState<string>();
  const [tapFailed, setTapFailed] = useState(false);
  const tap = async (item: string, action: PiHealthItem["actions"][number]) => {
    if (!peer || tapped) return;
    setTapped(`${item}|${action}`);
    setTapFailed(false);
    try {
      await peer.call("teams.healthRepair", { check: report.id, item, action });
    } catch {
      setTapFailed(true);
    } finally {
      setTapped(undefined);
    }
  };
  const outcomes = new Map(report.resolutions.map((value) => [value.itemId, value.outcome]));
  const total = report.items.length + report.more;
  const scope =
    report.scope.kind === "bot" && report.scope.name
      ? t("piHealth.scope.bot", { name: report.scope.name })
      : report.scope.kind === "group" && report.scope.name
        ? t("piHealth.scope.group", { name: report.scope.name })
        : undefined;
  return (
    <section
      className={`${styles.approval} ${lively.card} ${own.card}`}
      aria-label={t("piHealth.label")}
    >
      <header>
        <span aria-hidden="true">
          <Icon name="shield" />
        </span>
        <strong>
          {total ? t("piHealth.title.found", { count: total }) : t("piHealth.title.ok")}
        </strong>
        {scope && <small className={own.scope}>{scope}</small>}
      </header>
      {report.items.length > 0 && (
        <ul className={own.list}>
          {report.items.map((item) => {
            const outcome = outcomes.get(item.id);
            const raiseTo =
              item.roundLimit === undefined ? undefined : nextGroupRoundLimit(item.roundLimit);
            const where = [item.where.botName, item.where.groupName, item.where.title]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={item.id} className={own.row} data-outcome={outcome}>
                <span className={own.kind} aria-hidden="true">
                  <Icon name={KIND_ICONS[item.kind]} size={14} />
                </span>
                <div className={own.body}>
                  <div className={own.head}>
                    <strong>{where || t(`piHealth.kind.${item.kind}`)}</strong>
                    <small>
                      {t(`piHealth.kind.${item.kind}`)}
                      {item.since &&
                        ` · ${t("piHealth.since", { time: since(item.since, language) })}`}
                    </small>
                  </div>
                  <p className={own.reason}>{t(`piHealth.reason.${item.reason}`)}</p>
                  {outcome ? (
                    <p className={own.outcome} data-outcome={outcome}>
                      {outcome === "fixed" && <Icon name="check" size={12} />}
                      {t(`piHealth.outcome.${outcome}`)}
                    </p>
                  ) : item.actions.length ? (
                    // A tap asks Pi for exactly this fix (program-carried, never ids in text);
                    // Pi then shows its usual repair card.
                    <div className={own.fixes}>
                      <small>{t("piHealth.fixLabel")}</small>
                      {item.actions.slice(0, 3).map((action) => (
                        <Button
                          key={action}
                          variant="pill"
                          disabled={!!tapped || !peer}
                          loading={tapped === `${item.id}|${action}`}
                          onClick={() => void tap(item.id, action)}
                        >
                          {action === "rounds_raise" && raiseTo !== undefined
                            ? t("piHealth.roundsRaiseTo", { limit: raiseTo })
                            : t(`piHealth.action.${action}`)}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <p className={own.fix}>{t("piHealth.noFix")}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {tapFailed && (
        <p role="alert" className={own.more}>
          {t("piHealth.tapFailed")}
        </p>
      )}
      {report.more > 0 && <p className={own.more}>{t("piHealth.more", { count: report.more })}</p>}
    </section>
  );
}
