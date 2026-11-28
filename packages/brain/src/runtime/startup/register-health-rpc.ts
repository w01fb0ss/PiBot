import {
  type CommandPause,
  type createPeer,
  type KernelEvents,
  type KernelMethods,
  RpcError,
  RpcErrorCodes,
  type RuntimeHealth,
} from "@pibot/protocol-base";
import type { AuditRepo, BotsRepo } from "@pibot/storage";
import type { ChatService } from "../../conversations/chat/chat.ts";
import { abortable } from "../../core/abort.ts";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import type { LocalService } from "../../local-service.ts";
import { FORCE_RELEASE_TIMEOUT_MS } from "../continuation/continuation-limits.ts";
import type { ModelProvidersPort } from "../models/port.ts";

interface StartupContext {
  handle: KernelRegisterRpc;
  chat: ChatService;
  interactiveDrainHealthy: boolean;
  groups: GroupOrchestrationPort;
  modelPort: ModelProvidersPort | undefined;
  capabilities: LocalService;
  interactiveAttached: boolean;
  peer: ReturnType<typeof createPeer<typeof KernelMethods, typeof KernelEvents>>;
  clientChange: Promise<void>;
  bots: BotsRepo;
  logger: import("@pibot/observability").Logger;
  audit: AuditRepo;
}
export function registerHealthRpc(ctx: StartupContext) {
  // events.resume is the eighteenth method, owned and registered by createPeer.
  // Drain failures survive until restart, so the UI pulls them on (re)connect.
  ctx.handle("runtime.health.get", async (): Promise<RuntimeHealth> => {
    const run = ctx.chat.queue.health();
    // A closed interactive admission outranks a single run: no request can be served anyway.
    if (!ctx.interactiveDrainHealthy)
      return { healthy: false, reason: "interactive_drain_failed", botIds: run.botIds };
    return run;
  });
  // A local command pause clears by itself once a check proves the previous command stopped; the
  // UI pulls it on (re)connect like the drain health above, and live changes arrive as events.
  const commandPause = (): CommandPause => ({
    paused: ctx.capabilities.target.commandPause?.() ?? null,
    ...(ctx.capabilities.target.windowsCommandCleanupPending?.()
      ? { cleanupUnconfirmed: true as const }
      : {}),
  });
  ctx.handle("runtime.commands.get", async () => commandPause());
  ctx.handle("runtime.commands.recheck", async (): Promise<CommandPause> => {
    const recheck = ctx.capabilities.target.recheckCommandPause;
    if (!recheck) return commandPause();
    await recheck();
    // A recovery is announced by the drain event; a refused check changes nothing to announce,
    // and the result alone tells the person it is still paused.
    return commandPause();
  });
  /**
   * The client-wide failure has its own state in this factory, so reopening it is
   * the same detach a client performs, bounded: a drain that never settles must fail the release
   * rather than hang the call. The release's own request is not awaited: it is one of the pending
   * interactive requests and would wait on itself.
   */
  const reopenInteractive = async (health: RuntimeHealth): Promise<RuntimeHealth> => {
    if (ctx.interactiveDrainHealthy && health.healthy) return health;
    const deadline = AbortSignal.timeout(FORCE_RELEASE_TIMEOUT_MS);
    const drained = await Promise.allSettled([
      abortable(ctx.chat.drainInteractive(), deadline),
      abortable(ctx.groups.drainInteractive(), deadline),
      abortable(ctx.modelPort?.drainInteractive() ?? Promise.resolve(), deadline),
      abortable(ctx.capabilities.background.stopAll("app_quit"), deadline),
    ]);
    const run = ctx.chat.queue.health();
    if (drained.some((result) => result.status === "rejected") || !run.healthy)
      throw new RpcError(RpcErrorCodes.busy, "drain_unconfirmed");
    ctx.interactiveDrainHealthy = true;
    ctx.interactiveAttached = true;
    ctx.chat.admitInteractive(true);
    ctx.groups.admitInteractive(true);
    ctx.peer.emit("runtime.health", run);
    return run;
  };
  /**
   * Serialized through `clientChange`: a release reopens the interactive admission a detach
   * closed, and interleaving the two would let a stale detach close what this just restored.
   */
  const release = async (botId: string | undefined): Promise<RuntimeHealth> => {
    const change = ctx.clientChange.then(async () => {
      const health = await ctx.chat.queue.forceRelease(botId);
      return botId ? health : reopenInteractive(health);
    });
    ctx.clientChange = change.then(
      () => {},
      () => {
        // A refused release changes nothing: the client stays detached and unhealthy.
      },
    );
    return change;
  };
  // The user confirms before any session is aborted; both outcomes are audited.
  ctx.handle("runtime.forceRelease", async ({ botId }): Promise<RuntimeHealth> => {
    const owner = botId ?? ctx.bots.getMain()?.id;
    const record = (reasonCode: "requested" | "released" | "refused") => {
      try {
        // A client-wide release has no owning Bot; file it under the main Bot so it stays visible.
        if (!owner) {
          ctx.logger.warn("Force release audit skipped: no bot to file it under");
          return;
        }
        ctx.audit.append({
          botId: owner,
          kind: "runtime.force_release",
          summary: "Force release / 强制释放",
          detail: { reasonCode },
        });
      } catch {
        // Secondary to the release: an audit failure must not replace its result or its error.
        ctx.logger.warn("Force release audit not written");
      }
    };
    record("requested");
    try {
      const health = await release(botId);
      record("released");
      return health;
    } catch (error) {
      record("refused");
      throw error instanceof RpcError
        ? error
        : new RpcError(RpcErrorCodes.busy, "drain_unconfirmed");
    }
  });
}
