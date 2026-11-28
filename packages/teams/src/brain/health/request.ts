// Which repair a pi_repair call means. A fix the person tapped on the check card travels with the
// message it sent (program-set usage, never text), so the call carries no ids and words typed to
// look like a tap change nothing. Otherwise the model names check, item and action itself.
import type { CapabilityContext, ToolRunContext } from "@pibot/brain/kit";
import { MessagesRepo, RunsRepo } from "@pibot/storage";
import {
  messageRepairRequest,
  type PiHealthItem,
  type PiRepairAction,
  type PiRepairRequest,
  piHealthTools,
} from "@pibot/teams-contract";
import { PiHealthReportsRepo } from "../../store/pi-health.ts";
import { type Language, say } from "../manager/lookup.ts";

/** The tapped fix behind this turn, if the person's message came from the check card. */
export function tappedRepair(
  ctx: CapabilityContext,
  context: ToolRunContext,
): PiRepairRequest | undefined {
  const run = new RunsRepo(ctx.db).get(context.runId);
  if (!run?.userMessageId) return undefined;
  const message = new MessagesRepo(ctx.db).get(run.userMessageId);
  return message?.role === "user" ? messageRepairRequest(message) : undefined;
}

/** Newest check written in this same run that still lists `itemId` with `action`. */
function latestRunCheckFor(
  ctx: CapabilityContext,
  context: ToolRunContext,
  itemId: string,
  action: PiRepairAction,
): string | undefined {
  const repo = new PiHealthReportsRepo(ctx.db);
  for (const report of repo.forRun(context.runId)) {
    const owner = repo.owner(report.id);
    if (!owner || owner.botId !== context.botId || owner.conversationId !== context.conversationId)
      continue;
    if (report.items.some((item) => item.id === itemId && item.actions.includes(action)))
      return report.id;
  }
  return undefined;
}

export type RequestErrorCode = "invalid_arguments" | "no_tapped_fix" | "not_the_tapped_fix";

export type ResolvedRequest =
  | { check: string; item: string; action: PiRepairAction }
  | { error: RequestErrorCode };

export function repairRequest(
  ctx: CapabilityContext,
  context: ToolRunContext,
  input: unknown,
): ResolvedRequest {
  const args = piHealthTools.pi_repair.schema.safeParse(input);
  if (!args.success) return { error: "invalid_arguments" };
  const tapped = tappedRepair(ctx, context);
  const { check, item, action } = args.data;
  if (check === undefined || item === undefined || action === undefined) {
    if (!tapped) return { error: "no_tapped_fix" };
    if (action !== undefined && action !== tapped.action) return { error: "not_the_tapped_fix" };
    // When Pi re-ran pi_health_check in this tapped turn (e.g. after a refusal or state change),
    // bind the no-arg repair to that fresh check so the stale comparison sees the new snapshot.
    const fresher = latestRunCheckFor(ctx, context, tapped.item, tapped.action);
    return fresher ? { ...tapped, check: fresher } : tapped;
  }
  // A turn the card started repairs only the item and fix the person tapped, never another item
  // or action. A newer checkId from a re-check in this chat for that same item and fix is allowed
  // (listedReportItem still verifies report ownership and that the check lists that fix).
  if (tapped && (tapped.item !== item || tapped.action !== action))
    return { error: "not_the_tapped_fix" };
  return { check, item, action };
}

/** The report Pi wrote in this very chat, and the listed item with that fix. */
export function listedReportItem(
  ctx: CapabilityContext,
  context: ToolRunContext,
  check: string,
  itemId: string,
  action: PiRepairAction,
): { repo: PiHealthReportsRepo; item: PiHealthItem } | undefined {
  const repo = new PiHealthReportsRepo(ctx.db);
  const owner = repo.owner(check);
  if (!owner || owner.botId !== context.botId || owner.conversationId !== context.conversationId)
    return undefined;
  const item = repo.get(check)?.items.find((value) => value.id === itemId);
  return item?.actions.includes(action) ? { repo, item } : undefined;
}

export function requestErrorText(language: Language, error: RequestErrorCode): string {
  return say(
    language,
    `没有修 [${error}]：${error === "not_the_tapped_fix" ? "这次要修的是用户在卡片上点的那一项，不带参数调用 pi_repair（或用重新体检后的 check、同一 item 和 action）" : "没有指明要修哪一项；先体检，再按结果里的 check（填 checkId）、item 和 action 调用"}`,
    `Not done [${error}]: ${error === "not_the_tapped_fix" ? "this turn repairs the fix the person tapped; call pi_repair with no arguments (or with the re-checked check id and the same item and action)" : "no item named; run the check, then pass check (checkId), item and action"}`,
  );
}
