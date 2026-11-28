import {
  type AuditT,
  auditFactRows,
  auditGroup,
  auditResult,
  auditSummary,
  isSystemAudit,
  isUserAudit,
  routineRunName,
  routineRunStatus,
  runErrorText,
  safeAuditText,
} from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import type { BackgroundCommandRecord, Bot } from "@pibot/protocol";
import type { useStatusText, useText } from "../../runtime/context.tsx";
import type { AvatarLook } from "../../ui/avatar.tsx";
import type { useTimeText } from "../../ui/time.ts";
import { botLook } from "../conversations/model.ts";
import { isRunning, type RecordRow } from "./model.ts";

const INPUT_READS = new Set<string>(["file.read", "web.fetched"]);

export type Tone = "ok" | "warn" | "danger" | "muted" | "running";
export interface RecordView {
  /** What happened, one line (the desktop row's sentence). */
  what: string;
  who: string;
  look?: AvatarLook;
  /** The category badge (desktop row badge). */
  badge: string;
  outcome: { text: string; tone: Tone };
  /** Same kind + sentence + Bot + outcome (maintainers 2026-10-22); none while still running. */
  repeatKey?: string;
}
export interface PresentContext {
  t: ReturnType<typeof useText>;
  shared: AuditT;
  status: ReturnType<typeof useStatusText>;
  bots: Map<string, Bot>;
  groupName(id: string): string | undefined;
}

function commandOutcome(row: BackgroundCommandRecord, shared: AuditT): RecordView["outcome"] {
  if (row.status === "running") return { text: shared("backgroundLog.running"), tone: "running" };
  if (row.status === "exited")
    return {
      text: shared("backgroundLog.reason.exited", { code: row.exitCode ?? "?" }),
      tone: row.exitCode ? "danger" : "muted",
    };
  if (row.status === "failed")
    return { text: shared("backgroundLog.reason.failed"), tone: "danger" };
  return {
    text: shared(`backgroundLog.reason.${row.stopReason ?? "user"}` as TranslationKey),
    tone: row.stopReason === "exposed" ? "warn" : "muted",
  };
}
const chatTone = (status: string): Tone =>
  status === "done"
    ? "ok"
    : status === "error"
      ? "danger"
      : status === "aborted"
        ? "warn"
        : status === "waiting"
          ? "warn"
          : "running";

/** One row as the desktop records page phrases it, with the shared catalog where it exists. */
export function presentRecord(row: RecordRow, c: PresentContext): RecordView {
  const bot = c.bots.get(row.botId);
  const name = bot?.name;
  const look = bot ? botLook(bot) : undefined;
  let view: RecordView;
  switch (row.type) {
    case "audit": {
      const system = isSystemAudit(row.entry);
      const user = isUserAudit(row.entry);
      const who = system
        ? c.shared("audit.actor.system")
        : user
          ? c.shared("audit.actor.user")
          : (name ?? c.shared("audit.actor.bot"));
      const group = auditGroup(row.entry);
      const result = auditResult(row.entry, c.shared);
      view = {
        what: auditSummary(row.entry, c.shared, { botName: who }),
        who,
        look: system || user ? undefined : look,
        badge: c.shared(
          group === "identity" ? "audit.kind.oauth.changed" : `activity.kind.${group}`,
        ),
        outcome: { text: result.text, tone: result.tone },
      };
      break;
    }
    case "routine": {
      const result = routineRunStatus(row.run, c.shared);
      const routineBot = row.run.bot;
      view = {
        what: routineRunName(row.run, c.shared),
        who: safeAuditText(routineBot?.name ?? "", 200) || c.shared("activity.routineBotMissing"),
        look: routineBot
          ? {
              name: routineBot.name,
              shape: routineBot.avatarShape,
              color: routineBot.avatarColor,
              eyes: routineBot.avatarEyes,
            }
          : look,
        badge: c.shared("activity.kind.scheduling"),
        outcome: {
          text: result.text,
          tone: result.tone === "warn" && isRunning(row) ? "running" : result.tone,
        },
      };
      break;
    }
    case "chat": {
      const run = row.run;
      const kind = c.t(
        run.kind === "group_task"
          ? "recordGroupTask"
          : run.kind === "wake"
            ? "recordWake"
            : "recordChatRun",
      );
      const group = run.groupId ? c.groupName(run.groupId) : undefined;
      view = {
        what: group ? `${group} · ${kind}` : kind,
        who: name ?? c.shared("audit.actor.bot"),
        look,
        badge: c.t("recordKindChat"),
        outcome: { text: c.status(run.status), tone: chatTone(run.status) },
      };
      break;
    }
    case "command":
      view = {
        what: safeAuditText(row.command.command, 200),
        who: name ?? c.shared("audit.actor.bot"),
        look,
        badge: c.shared("activity.kind.background"),
        outcome: commandOutcome(row.command, c.shared),
      };
      break;
  }
  // A run reads many different files / pages in a row (the input audit); those fold by kind,
  // like the desktop log, instead of flooding the list one path at a time.
  const foldByKind =
    row.type === "audit" &&
    (INPUT_READS.has(row.entry.kind) || row.entry.kind === "tool.journal.replay_blocked");
  if (!isRunning(row))
    view.repeatKey = JSON.stringify([
      row.type,
      row.type === "audit" ? row.entry.kind : "",
      foldByKind ? "" : view.what,
      row.botId,
      view.outcome.text,
      row.type === "audit" && row.entry.kind === "tool.journal.replay_blocked"
        ? row.entry.detail.reasonCode
        : "",
    ]);
  return view;
}

/** The detail page's label / value lines. */
export function recordFacts(
  row: RecordRow,
  view: RecordView,
  c: PresentContext,
  time: ReturnType<typeof useTimeText>,
): { label: string; value: string }[] {
  const between = (from: string | null, to: string | null) =>
    from && to ? time.duration(Date.parse(to) - Date.parse(from)) : undefined;
  const lines: { label: string; value: string | undefined }[] = [];
  switch (row.type) {
    case "audit":
      return auditFactRows(row.entry, c.shared, view.who);
    case "routine": {
      const run = row.run;
      lines.push(
        { label: c.shared("activity.routineTask"), value: view.what },
        { label: c.shared("audit.bot"), value: view.who },
        {
          label: c.shared("activity.routineReason"),
          value: c.shared(`routines.reason.${run.reason}`),
        },
        { label: c.shared("activity.routineCreated"), value: time.stamp(run.createdAt) },
        {
          label: c.shared("activity.routineStarted"),
          value: run.startedAt ? time.stamp(run.startedAt) : c.shared("activity.routineNotStarted"),
        },
        { label: c.shared("activity.routineActive"), value: time.duration(run.activeMs) },
        { label: c.shared("activity.routineWaiting"), value: time.duration(run.waitingMs) },
        {
          label: c.shared("activity.routineFinished"),
          value: run.finishedAt ? time.stamp(run.finishedAt) : undefined,
        },
        {
          label: c.t("recordError"),
          value:
            runErrorText(run.errorCode, c.shared, { ambiguousPermissionDenied: true }) ??
            (run.status === "failed" || run.status === "timeout"
              ? c.shared("errors.genericFailure")
              : undefined),
        },
      );
      break;
    }
    case "chat": {
      const run = row.run;
      lines.push(
        { label: c.t("recordKind"), value: view.what },
        { label: c.shared("audit.bot"), value: view.who },
        { label: c.t("recordStarted"), value: time.stamp(run.startedAt ?? run.createdAt) },
        {
          label: c.t("recordFinished"),
          value: run.finishedAt ? time.stamp(run.finishedAt) : undefined,
        },
        { label: c.t("recordDuration"), value: between(run.startedAt, run.finishedAt) },
        {
          label: c.t("recordError"),
          value:
            runErrorText(run.errorCode, c.shared, { ambiguousPermissionDenied: true }) ??
            (run.status === "error" ? c.shared("errors.genericFailure") : undefined),
        },
      );
      break;
    }
    case "command": {
      const command = row.command;
      const place = command.place;
      const title = place
        ? safeAuditText(place.title, 200) || c.shared("backgroundLog.place.untitled")
        : undefined;
      lines.push(
        { label: c.shared("audit.bot"), value: view.who },
        {
          label: c.t("recordPlace"),
          value: !place
            ? c.shared("backgroundLog.place.gone")
            : place.kind === "thread"
              ? c.shared("backgroundLog.place.thread", {
                  group:
                    safeAuditText(place.groupName ?? "", 200) ||
                    c.shared("backgroundLog.place.untitled"),
                  title: title ?? "",
                })
              : c.shared(
                  place.kind === "group"
                    ? "backgroundLog.place.group"
                    : "backgroundLog.place.topic",
                  {
                    title: title ?? "",
                  },
                ),
        },
        { label: c.t("recordStarted"), value: time.stamp(command.startedAt) },
        {
          label: c.t("recordFinished"),
          value: command.endedAt ? time.stamp(command.endedAt) : undefined,
        },
        {
          label: c.t("recordDuration"),
          value: between(command.startedAt, command.endedAt ?? new Date().toISOString()),
        },
        { label: c.t("recordCommand"), value: command.command },
      );
      break;
    }
  }
  return lines.flatMap((line) => (line.value ? [{ label: line.label, value: line.value }] : []));
}
