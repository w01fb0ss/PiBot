// The default Pi's management and dispatch tools: executors, card texts, receipts RPC.
import type { LocalToolResult } from "@pibot/agent";
import {
  type CapabilityContext,
  mainDirectRun,
  type RegisterRpc,
  type ToolExecutor,
} from "@pibot/brain/kit";
import { PiDispatchesRepo } from "../../store/pi-dispatches.ts";
import { botCard, groupCard, sendCard } from "./cards.ts";
import type { RoutingCatalog } from "./catalog.ts";
import { teamDirectory } from "./directory.ts";
import { DispatchFollower, dispatchWork } from "./dispatch.ts";
import { dispatchPolicy } from "./dispatch-policy.ts";
import { say } from "./lookup.ts";
import { botManage, groupManage, teamList } from "./manage.ts";

export function registerPiManager(
  ctx: CapabilityContext,
  handle: RegisterRpc,
  catalog: RoutingCatalog,
) {
  const follower = new DispatchFollower(ctx);
  // The kernel only offers and allows these in Pi's own direct chat; each executor checks it
  // again so a future routing change can never run them for anyone else.
  const onlyPi =
    (
      run: (
        context: Parameters<ToolExecutor>[0],
        call: Parameters<ToolExecutor>[1],
        signal: AbortSignal,
        authorization: Parameters<ToolExecutor>[3],
      ) => LocalToolResult | Promise<LocalToolResult>,
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
      "team_list",
      onlyPi((context, call) => teamList(ctx, context, call.input)),
    ),
    ctx.tools.executor(
      "team_directory",
      onlyPi((context, call) => teamDirectory(ctx, catalog, context, call.input)),
    ),
    ctx.tools.executor(
      "bot_manage",
      onlyPi((context, call, signal) => botManage(ctx, context, call.input, signal)),
    ),
    ctx.tools.executor(
      "group_manage",
      onlyPi((context, call) => groupManage(ctx, context, call.input)),
    ),
    ctx.local.provideToolPolicyFor("catalog_install", async (context, _call, _tool, input) => {
      if (!mainDirectRun(ctx.local, context)) return { requests: [] };
      const selection = await catalog.prepare(input);
      return {
        requests: [],
        prepared: selection?.entry,
        binding: selection?.binding,
      };
    }),
    ctx.tools.executor(
      "catalog_install",
      onlyPi((context, _call, signal, authorization) =>
        authorization
          ? catalog.install(context, authorization.data, signal, authorization.assertCurrent)
          : {
              text: say(context.language, "安装需要授权", "Installation needs authorization"),
              isError: true,
            },
      ),
    ),
    ctx.tools.card("catalog_install", catalog.card),
    ...(["bot", "group"] as const).flatMap((kind) => {
      const tool = kind === "bot" ? "send_to_bot" : "send_to_group";
      return [
        ctx.local.provideToolPolicyFor(tool, (context, _call, _name, input, signal) =>
          dispatchPolicy(ctx, kind, context, input, signal),
        ),
        ctx.tools.executor(
          tool,
          onlyPi((context, call, signal, authorization) =>
            dispatchWork(ctx, follower, kind, context, call, signal, authorization),
          ),
        ),
        ctx.tools.card(tool, sendCard(ctx, kind)),
      ];
    }),
    ctx.tools.card("bot_manage", botCard(ctx.db)),
    ctx.tools.card("group_manage", groupCard(ctx.db)),
  ];
  const repo = new PiDispatchesRepo(ctx.db);
  handle("teams.dispatches", ({ messageId }: { messageId: string }) => repo.forMessage(messageId));
  return {
    /** Receipts left open by a restart catch up with what happened meanwhile. */
    start() {
      repo.abandonUnsent();
      follower.recover();
    },
    groupChanged: (groupId: string) => follower.groupChanged(groupId),
    stop() {
      follower.stop();
      for (const release of releases) release();
    },
  };
}
