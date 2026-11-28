// The person taps one of an item's fixes on the check card: Pi gets a message in plain words
// ("修这一项：轻量开发组 · 评审到上限 — 按剩下的步骤继续") that carries the exact fix for the program.
// The repair itself is Pi's pi_repair call, judged by policy with its card like any other.
import type { CapabilityContext, RpcRequestContext } from "@pibot/brain/kit";
import { RpcError } from "@pibot/protocol";
import { BotsRepo } from "@pibot/storage";
import type { PiRepairRequest } from "@pibot/teams-contract";
import { PiHealthReportsRepo } from "../../store/pi-health.ts";
import { say } from "../manager/lookup.ts";
import { actionText } from "./texts.ts";

export async function tapRepair(
  ctx: CapabilityContext,
  request: PiRepairRequest,
  { source, phone }: RpcRequestContext,
): Promise<{ runId: string }> {
  // The person's own tap on this computer or the paired phone; an editor never stands in.
  if (source === "acp") throw new RpcError(-32602, "pi_repair_no_acp");
  const repo = new PiHealthReportsRepo(ctx.db);
  const owner = repo.owner(request.check);
  const main = new BotsRepo(ctx.db).getMain();
  const item = repo.get(request.check)?.items.find((value) => value.id === request.item);
  if (!owner || !main || owner.botId !== main.id || !item?.actions.includes(request.action))
    throw new RpcError(-32602, "health_item_unknown");
  const language = ctx.chat.currentLanguage();
  const where =
    [item.where.botName, item.where.groupName, item.where.title].filter(Boolean).join(" · ") ||
    say(language, "这一项", "this item");
  const action = actionText(request.action, language, item.roundLimit);
  const text = say(
    language,
    `修这一项：${where} — ${action}`,
    `Fix this: ${where} — ${action.toLowerCase()}`,
  );
  const sent = await ctx.chat.send(
    main.id,
    text,
    [],
    [],
    owner.conversationId,
    false,
    undefined,
    undefined,
    undefined,
    {
      inputOrigin: phone ? "phone" : "user",
      repairRequest: { check: request.check, item: request.item, action: request.action },
    },
  );
  return { runId: sent.runId };
}
