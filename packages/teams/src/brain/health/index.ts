// The default Pi's health check and repairs: executors, card texts, must-ask rule, list-card RPC.
import type { LocalToolResult } from "@pibot/agent";
import {
  type CapabilityContext,
  mainDirectRun,
  type RegisterRpc,
  type RpcRequestContext,
  type ToolExecutor,
} from "@pibot/brain/kit";
import type { PiRepairRequest } from "@pibot/teams-contract";
import { PiHealthReportsRepo } from "../../store/pi-health.ts";
import { say } from "../manager/lookup.ts";
import { repairCard, repairMustAsk } from "./cards.ts";
import { piHealthCheck } from "./check.ts";
import { piRepair } from "./repair.ts";
import { tapRepair } from "./tap.ts";

export function registerPiHealth(ctx: CapabilityContext, handle: RegisterRpc) {
  // Like Pi's management tools: the kernel offers and allows these only in Pi's own direct chat,
  // and each executor checks it again so a routing change can never run them for anyone else.
  const onlyPi =
    (
      run: (...args: Parameters<ToolExecutor>) => LocalToolResult | Promise<LocalToolResult>,
    ): ToolExecutor =>
    async (context, call, signal, authorization) =>
      mainDirectRun(ctx.local, context)
        ? run(context, call, signal, authorization)
        : {
            text: say(
              context.language,
              "只有默认 Pi 在和用户的私聊里能用",
              "Only the default Pi can use this, in its own chat with the person",
            ),
            isError: true,
          };
  const releases = [
    ctx.tools.executor(
      "pi_health_check",
      onlyPi((context, call) => piHealthCheck(ctx, context, call)),
    ),
    ctx.tools.executor(
      "pi_repair",
      onlyPi((context, call, signal) => piRepair(ctx, context, call.input, signal)),
    ),
    ctx.tools.card("pi_repair", repairCard(ctx)),
    ctx.tools.mustAsk("pi_repair", repairMustAsk(ctx)),
  ];
  const repo = new PiHealthReportsRepo(ctx.db);
  handle("teams.healthReports", ({ messageId }: { messageId: string }) =>
    repo.forMessage(messageId),
  );
  handle("teams.healthRepair", (params: PiRepairRequest, context: RpcRequestContext) =>
    tapRepair(ctx, params, context),
  );
  return {
    stop() {
      for (const release of releases) release();
    },
  };
}
