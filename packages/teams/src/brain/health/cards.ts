// The repair card: exactly what will change and what cannot be undone,
// and which repairs must show it even under Pi's "always" level or YOLO.
import type { CapabilityContext, ToolCardDescriber, ToolMustAsk } from "@pibot/brain/kit";
import type { ApprovalFact } from "@pibot/protocol";
import { BotsRepo } from "@pibot/storage";
import type { PiHealthItem } from "@pibot/teams-contract";
import { type Language, say } from "../manager/lookup.ts";
import { parseItemId } from "./repair.ts";
import { listedReportItem, repairRequest, requestErrorText } from "./request.ts";
import { actionText, effects, reasonText } from "./texts.ts";

function place(item: PiHealthItem, language: Language) {
  const quote = (value: string) => (language === "zh" ? `『${value}』` : `“${value}”`);
  const area = [item.where.groupName, item.where.title].filter(Boolean).join(" · ");
  if (item.where.botName && area)
    return say(
      language,
      `${quote(item.where.botName)}在${quote(area)}里`,
      `${quote(item.where.botName)} in ${quote(area)}`,
    );
  return quote(item.where.botName || area || "—");
}

export function repairCard(ctx: CapabilityContext): ToolCardDescriber {
  return (context, input, language) => {
    const pi = new BotsRepo(ctx.db).getMain()?.name ?? "Pi";
    const fallbackTitle = say(
      language,
      `${pi} 想修复一项卡住的状态`,
      `${pi} wants to repair something stuck`,
    );
    const args = repairRequest(ctx, context, input);
    if ("error" in args)
      return {
        title: fallbackTitle,
        facts: [],
        invalid: { code: args.error, text: requestErrorText(language, args.error) },
      };
    const found = listedReportItem(ctx, context, args.check, args.item, args.action);
    if (!found)
      return {
        title: fallbackTitle,
        facts: [],
        invalid: {
          code: "health_item_unknown",
          text: say(
            language,
            "没有修 [health_item_unknown]：这一项不在体检结果里，或者没有这种修法。先重新体检。",
            "Not done [health_item_unknown]: that item is not in the check or has no such fix. Run the check again first.",
          ),
        },
      };
    const { item } = found;
    const action = args.action;
    const actionLabel = actionText(action, language, item.roundLimit);
    const effect = effects[action];
    const where = place(item, language);
    const label = (zh: string, en: string) => say(language, zh, en);
    const live = action === "stop_run" && ctx.chat.queue.owns(parseItemId(item.id).first);
    const facts: ApprovalFact[] = [
      { kind: "write", label: label("在哪", "Where"), value: where },
      { kind: "write", label: label("现在", "Now"), value: reasonText(item.reason, language) },
      { kind: "write", label: label("会做什么", "What happens"), value: effect[language] },
      ...(live
        ? [
            {
              kind: "warning" as const,
              value: label(
                "它还有进程在跑，停止会打断正在做的事",
                "It still has a live process; stopping interrupts what it is doing",
              ),
            },
          ]
        : []),
      { kind: "warning", label: label("不能撤销", "Cannot undo"), value: effect.undo[language] },
    ];
    return {
      title: say(
        language,
        `${pi} 想${actionLabel}`,
        `${pi} wants to: ${actionLabel.toLowerCase()}`,
      ),
      lead: say(
        language,
        `${actionLabel}：${where}。${reasonText(item.reason, language)}。`,
        `${actionLabel}: ${where}. ${reasonText(item.reason, language)}.`,
      ),
      facts,
    };
  };
}

/**
 * Owner decision 2026-11-25: stopping a run that still has a live worker, ending a plan and
 * closing a task always show the card. Read now, not from the report: a run that gained a worker
 * since the check must ask (its repair is then refused as changed anyway).
 */
export function repairMustAsk(ctx: CapabilityContext): ToolMustAsk {
  return (context, input) => {
    const args = repairRequest(ctx, context, input);
    if ("error" in args) return true;
    const { action, item } = args;
    if (
      action === "plan_stop" ||
      action === "task_close" ||
      action === "rounds_reset" ||
      action === "rounds_raise"
    )
      return true;
    if (action !== "stop_run") return false;
    const { type, first } = parseItemId(item);
    return type !== "run" || ctx.chat.queue.owns(first);
  };
}
