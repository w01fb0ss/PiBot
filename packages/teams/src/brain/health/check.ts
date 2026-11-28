// pi_health_check: read-only. It lists what is stuck, saves the list for the card under Pi's
// step and for pi_repair's stale check, and writes one audit entry with counts only.
import { randomUUID } from "node:crypto";
import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { CapabilityContext, ToolRunContext } from "@pibot/brain/kit";
import { nextGroupRoundLimit } from "@pibot/protocol";
import type { PiHealthItem } from "@pibot/teams-contract";
import { piHealthTools } from "@pibot/teams-contract";
import { PiHealthReportsRepo } from "../../store/pi-health.ts";
import { findBot, findGroup, type Language, say } from "../manager/lookup.ts";
import { type HealthScope, healthPage } from "./detect.ts";
import { reasonText } from "./texts.ts";

function scopeOf(
  ctx: CapabilityContext,
  args: { bot?: string; group?: string },
): HealthScope | { invalid: string } {
  if (args.bot && args.group) return { invalid: "scope_one_only" };
  if (args.group) {
    const group = findGroup(ctx.db, args.group);
    return group
      ? { kind: "group", groupId: group.id, name: group.name }
      : { invalid: "group_unknown" };
  }
  if (args.bot) {
    const bot = findBot(ctx.db, args.bot);
    return bot ? { kind: "bot", botId: bot.id, name: bot.name } : { invalid: "bot_unknown" };
  }
  return { kind: "all" };
}

/** What the model reads: ids to repair with, names, times, the reason in plain words. */
function modelItem(item: PiHealthItem, language: Language) {
  return {
    id: item.id,
    kind: item.kind,
    reason: item.reason,
    why: reasonText(item.reason, language),
    ...(item.detail ? { detail: item.detail } : {}),
    where: Object.fromEntries(
      Object.entries(item.where).filter(([key]) => !key.endsWith("Id") || key === "conversationId"),
    ),
    since: item.since,
    fixes: item.actions,
    ...(item.roundLimit !== undefined
      ? { roundLimit: item.roundLimit, raiseTo: nextGroupRoundLimit(item.roundLimit) }
      : {}),
    ...(item.liveWorker ? { liveWorker: true } : {}),
  };
}

export function piHealthCheck(
  ctx: CapabilityContext,
  context: ToolRunContext,
  call: LocalToolCall,
): LocalToolResult {
  const language = context.language;
  const args = piHealthTools.pi_health_check.schema.parse(call.input);
  const scope = scopeOf(ctx, args);
  if ("invalid" in scope)
    return {
      text: say(
        language,
        `没有体检 [${scope.invalid}]：${scope.invalid === "scope_one_only" ? "请省略 bot 或 group，只保留一项。要体检全部，请省略这两个字段。" : "找不到这个 Bot 或群"}`,
        `Not checked [${scope.invalid}]: ${scope.invalid === "scope_one_only" ? "Omit either bot or group. To check everything, omit both fields." : "no such Bot or group"}`,
      ),
      isError: true,
    };
  const repo = new PiHealthReportsRepo(ctx.db);
  const reportScope =
    scope.kind === "all"
      ? { kind: scope.kind }
      : { kind: scope.kind, name: ctx.redactor.redact(scope.name).slice(0, 200) };
  const targetId =
    scope.kind === "all" ? undefined : scope.kind === "bot" ? scope.botId : scope.groupId;
  const after =
    args.after &&
    repo.hasPageItem(context.botId, context.messageId, reportScope, targetId, args.after)
      ? args.after
      : undefined;
  const page = healthPage(ctx, scope, after);
  const report = repo.create({
    id: randomUUID(),
    piBotId: context.botId,
    piRunId: context.runId,
    scopeTargetId: targetId,
    report: {
      toolCallId: call.id,
      messageId: context.messageId,
      scope: reportScope,
      items: page.items,
      more: page.more,
    },
  });
  try {
    ctx.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "pi.health_checked",
      summary: `Pi health check: ${page.total} stuck / Pi 体检卡住的状态`,
      detail: {
        actor: "user",
        reasonCode: "pi_health_check",
        piHealth: { scope: scope.kind, total: page.total, kinds: page.counts },
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(scope.kind === "group" ? { groupId: scope.groupId } : {}),
        ...(scope.kind === "bot" ? { targetBotId: scope.botId } : {}),
      },
    });
  } catch (error) {
    // The check changed nothing; a failed audit write must not hide its result from the person.
    ctx.logger.warn(
      JSON.stringify({
        module: "pi_health",
        event: "audit_failed",
        reason: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
  ctx.peer.emit("teams.health.changed", { messageId: context.messageId });
  return {
    text: JSON.stringify({
      checkId: report.id,
      total: page.total,
      ...(page.more ? { more: page.more, next: page.items.at(-1)?.id } : {}),
      items: page.items.map((item) => modelItem(item, language)),
      note: say(
        language,
        "只是读出来的状态，什么都没改。修哪一项要用户同意，再用 pi_repair（check=checkId, item=id, action 从 fixes 里选）。fixes 为空的项需要用户自己在那里处理。",
        "Read-only; nothing changed. Repair an item only once the person agrees, with pi_repair (check=checkId, item=id, action from fixes). Items with no fixes need the person there.",
      ),
    }),
    summary: page.total
      ? say(language, `体检：${page.total} 项卡住`, `Check: ${page.total} stuck`)
      : say(language, "体检：一切正常", "Check: nothing stuck"),
  };
}
