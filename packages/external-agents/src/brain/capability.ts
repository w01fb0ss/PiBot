// External coding agents as Bots (entry A: a Bot in the sidebar). The kernel hands
// runs of Bots of kind "agent" to this capability; everything about the agent process, its sandbox
// profile, its adapter and its ACP session lives here.
import {
  type BrainCapability,
  EXTERNAL_AGENT_REPLAY_PORT,
  type ExternalAgentReplayPort,
  type RpcRequestContext,
  resolveRunWorkplace,
  runPermissions,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { cleanupAgentPlaceholders } from "@pibot/execution";
import {
  type AgentDetection,
  agentDescriptor,
  type ExternalAgentId,
  type ExternalAgentMethodParams,
  type ExternalAgentMethodResults,
  RpcError,
} from "@pibot/external-agents-contract/full";
import { agentLaunchPolicy } from "@pibot/policy";
import { BotsRepo, ConversationsRepo, transaction } from "@pibot/storage";
import { confirmationSubject } from "../store/index.ts";
import { AgentStartError } from "./acp/agent-sessions.ts";
import { agentPlaceholderLedger } from "./acp/launch.ts";
import { createExternalAgentReplayPort } from "./acp/session-replay.ts";
import { AdapterInstallError, isAdapterAgent } from "./adapters/adapter-install.ts";
import { delegationTools } from "./delegation/delegate-tool.ts";
import { AgentRunError, runExternalAgent } from "./run/agent-run.ts";
import { ExternalAgentsService } from "./service.ts";

type Method = keyof ExternalAgentMethodParams;
/** After startup's own work (window, chain, first queries) has settled. */
const WARM_DETECTION_MS = 15_000;

export function externalAgentsCapability(): BrainCapability {
  return {
    id: "external-agents",
    register(ctx) {
      const local = ctx.local;
      const service = new ExternalAgentsService({
        version: ctx.version,
        db: ctx.db,
        local,
        logger: ctx.logger,
        redactor: ctx.redactor,
        dataDir: ctx.dataDir,
        platform: local.deps.platform,
        env: local.deps.env,
        userHome: local.deps.userHome,
        tempDir: local.deps.tempDir,
        ...(local.deps.resourcesDir ? { resourcesDir: local.deps.resourcesDir } : {}),
        ...(local.deps.proxy ? { proxy: local.deps.proxy } : {}),
        language: () => ctx.chat.currentLanguage(),
        optionsChanged: (key) => ctx.peer.emit("externalAgents.optionsChanged", key),
        statusChanged: (botId, status) =>
          ctx.peer.emit("externalAgents.statusChanged", { botId, status }),
      });
      void service.adapters
        .cleanStale()
        .catch(() =>
          ctx.logger.warn(
            JSON.stringify({ module: "external-agents", event: "adapter_cleanup_failed" }),
          ),
        );
      ctx.externalAgents.provide({
        kind: (botId) => service.bots.get(botId)?.agentId,
        run: (deps, run, text, bot, images) =>
          runExternalAgent(service, deps, run, text, bot, images),
        stepReadiness: (botId) => {
          const record = service.bots.get(botId);
          if (!record) return "unavailable";
          const isolation = service.isolation(record);
          return isolation === "unconfirmed"
            ? "unconfirmed"
            : isolation === "unavailable"
              ? "unavailable"
              : "ok";
        },
      });
      ctx.ports.provide<ExternalAgentReplayPort>(
        EXTERNAL_AGENT_REPLAY_PORT,
        createExternalAgentReplayPort({
          launch: {
            dataDir: ctx.dataDir,
            platform: local.deps.platform,
            env: local.deps.env,
            userHome: local.deps.userHome,
            tempDir: local.deps.tempDir,
            ...(local.deps.resourcesDir ? { resourcesDir: local.deps.resourcesDir } : {}),
            ...(local.deps.proxy ? { proxy: local.deps.proxy } : {}),
            redactor: ctx.redactor,
          },
          version: ctx.version,
          adapters: service.adapters,
          confirmations: service.confirmations,
          logger: ctx.logger,
        }),
      );
      // Pi Bot's own Bots hand work to an agent Bot (delegate_to_agent).
      const releaseDelegationTools = delegationTools(ctx, service);
      const handle = <K extends Method>(
        method: K,
        action: (
          params: ExternalAgentMethodParams[K],
          context: RpcRequestContext,
        ) => Promise<ExternalAgentMethodResults[K]>,
      ) =>
        ctx.rpc.handle(method, async (params, context) => {
          try {
            return await action(params, context);
          } catch (error) {
            // Business refusals keep a stable code for the UI; everything else is the wrapper's.
            if (error instanceof AgentRunError) throw new RpcError(-32602, error.code);
            if (error instanceof AdapterInstallError) throw new RpcError(-32602, error.message);
            throw error;
          }
        });
      const bound = (botId: string) => {
        const record = service.bots.get(botId);
        if (!record) throw new RpcError(-32602, "Unknown agent Bot");
        return record;
      };

      const detected = (result: AgentDetection) => ctx.peer.emit("externalAgents.detected", result);
      handle("externalAgents.detect", (params) => service.detection(detected, !!params.refresh));
      handle("externalAgents.list", async () => ({
        bots: service.bots.list().flatMap((record) => {
          const summary = service.summary(record);
          return summary ? [summary] : [];
        }),
      }));
      handle("externalAgents.checkStatus", async ({ botId, force }, { signal }) =>
        service.checkAccount(botId, signal, force),
      );
      handle("externalAgents.status", async ({ botId }) => {
        const status = service.accountStatus(botId);
        const record = bound(botId);
        const descriptor =
          record.agentId === "custom" ? undefined : agentDescriptor(record.agentId);
        return { ...status, command: status.command ?? descriptor?.loginCommand ?? null };
      });
      handle("externalAgents.prewarm", async ({ botId, conversationId }, { signal }) => {
        const record = bound(botId);
        const bot = new BotsRepo(ctx.db).get(botId);
        if (bot?.kind !== "agent" || bot.archivedAt)
          throw new RpcError(-32602, "Unknown active agent Bot");
        // Only the Bot's own direct topic: group steps and routines take their folders and
        // permissions from the group or routine, which nothing before the turn can know.
        const conversation = new ConversationsRepo(ctx.db).get(conversationId);
        if (
          conversation?.kind !== "dm" ||
          conversation.botId !== botId ||
          conversation.archivedAt ||
          conversation.routineId
        )
          return { started: false };
        // The same resolution as a real turn, so the prewarmed process matches its signature.
        const context: ToolRunContext = {
          botId,
          conversationId,
          runId: "prewarm",
          messageId: "prewarm",
          signal,
          language: ctx.chat.currentLanguage(),
        };
        const place = await resolveRunWorkplace(local, context, signal).catch(() => undefined);
        if (
          !place?.boundary.writeRoots.length ||
          (place.boundary.location && place.boundary.location.target !== "local")
        )
          return { started: false };
        const isolation = service.isolation(record);
        if (isolation === "unconfirmed" || isolation === "unavailable") return { started: false };
        const policy = agentLaunchPolicy(runPermissions(local, context));
        // Prewarm starts the agent process ahead of the turn, so only an outright allow may do it.
        if (policy.decision !== "allow") {
          local.approvals.audit.append({
            botId,
            kind: "policy.denied",
            summary: "External agent prewarm refused / 外部 Agent 预热被拒绝",
            detail: { toolName: "external_agent", reasonCode: policy.reason },
          });
          return { started: false };
        }
        let started = false;
        try {
          started = await service.prewarm(record, {
            conversationId,
            cwd: place.cwd,
            writeRoots: place.boundary.writeRoots,
            isolation,
            signal,
          });
        } catch (error) {
          if (error instanceof AgentStartError && error.code === "agent_login_required")
            service.rememberAccountStatus(botId, "login_required");
          // Initialize success says nothing about account validity; other failures stay unknown.
          throw error;
        }
        if (started)
          local.approvals.audit.append({
            botId,
            kind: "external_agent.prewarmed",
            summary: "External agent prewarmed / 外部 Agent 已预热",
            detail: {
              toolName: "external_agent",
              externalAgent: {
                agentId: record.agentId,
                isolation,
                roots: place.boundary.writeRoots.length,
              },
            },
          });
        return { started };
      });
      handle("externalAgents.installAdapter", async ({ agentId }, { signal }) => {
        if (!isAdapterAgent(agentId)) throw new RpcError(-32602, "adapter_not_needed");
        await service.adapters.install(agentId, signal);
        ctx.logger.info(
          JSON.stringify({ module: "external-agents", event: "adapter_installed", agentId }),
        );
        return { version: service.adapters.manifest(agentId).version };
      });
      handle("externalAgents.removeAdapter", async ({ agentId }) => {
        if (!isAdapterAgent(agentId)) return { removed: false };
        // A running agent keeps its files open; stop every process of that agent first.
        for (const record of service.bots.list())
          if (record.agentId === agentId) await service.sessions.stopBot(record.botId);
        await service.adapters.remove(agentId);
        return { removed: true };
      });
      /** The exact subject a Windows confirmation names; a custom command needs its Bot. */
      const subject = (agentId: ExternalAgentId, botId?: string) => {
        if (agentId !== "custom") return confirmationSubject({ agentId, custom: null });
        const record = botId ? service.bots.get(botId) : undefined;
        if (record?.agentId !== "custom") throw new RpcError(-32602, "Unknown agent Bot");
        return confirmationSubject(record, record.botId);
      };
      const auditUnisolated = (agentId: ExternalAgentId, reasonCode: string) => {
        const main = new BotsRepo(ctx.db).getMain();
        if (!main) return;
        local.approvals.audit.append({
          botId: main.id,
          kind: "permissions.changed",
          summary:
            reasonCode === "user_confirmed"
              ? "External agent may run unisolated / 外部 Agent 可不隔离运行"
              : "External agent unisolated permission revoked / 已撤销外部 Agent 不隔离运行",
          detail: {
            toolName: "external_agent",
            externalAgent: { agentId, isolation: "unisolated" },
            reasonCode,
          },
        });
      };
      handle("externalAgents.confirmUnisolated", async ({ agentId, botId }) => {
        if (local.deps.platform !== "win32") return { confirmed: false };
        service.confirmations.confirm(subject(agentId, botId));
        auditUnisolated(agentId, "user_confirmed");
        return { confirmed: true };
      });
      handle("externalAgents.revokeUnisolated", async ({ agentId, botId }) => {
        const revoked = service.confirmations.revoke(subject(agentId, botId));
        if (revoked) {
          // A running process keeps going unisolated until it stops: stop it now.
          for (const record of service.bots.list())
            if (record.agentId === agentId && (agentId !== "custom" || record.botId === botId))
              await service.sessions.stopBot(record.botId);
          auditUnisolated(agentId, "user_revoked");
        }
        return { revoked };
      });
      handle("externalAgents.createBot", async (params) => {
        const bot = await service.createBot(params);
        ctx.bots.introduce(bot.id);
        ctx.peer.emit("bots.changed", { botId: bot.id, reason: "created" });
        ctx.peer.emit("sidebar.changed", { conversationKey: `dm:${bot.id}` });
        return { botId: bot.id };
      });
      handle("externalAgents.setMemorySharing", async ({ botId, enabled }) => {
        const record = bound(botId);
        const bot = new BotsRepo(ctx.db).get(botId);
        if (!bot || bot.archivedAt || bot.kind !== "agent")
          throw new RpcError(-32602, "Unknown active agent Bot");
        if ((service.bots.defaults(botId).preferences.shareUserMemory === true) === enabled)
          return { enabled };
        transaction(ctx.db, () => {
          service.bots.setDefault(botId, { shareUserMemory: enabled });
          local.approvals.audit.append({
            botId,
            kind: "permissions.changed",
            summary:
              "External agent user memory sharing changed / 外部 Agent 关于你的记忆共享已更改",
            detail: {
              toolName: "external_agent",
              reasonCode: enabled ? "user_memory_shared" : "user_memory_unshared",
              externalAgent: { agentId: record.agentId },
            },
          });
        });
        ctx.peer.emit("bots.changed", { botId, reason: "updated" });
        return { enabled };
      });
      handle("externalAgents.bot", async ({ botId }, { signal }) => {
        const record = bound(botId);
        const summary = service.summary(record);
        if (!summary) throw new RpcError(-32602, "Unknown agent Bot");
        return {
          bot: summary,
          isolation: service.isolation(record),
          detected: service.knownAgent(record.agentId)
            ? await service.detectOne(record.agentId, signal)
            : null,
          allowances: service.allowanceView(record),
        };
      });
      handle("externalAgents.sessionOptions", async ({ botId, conversationId }) => {
        const record = bound(botId);
        if (!conversationId) service.refreshDefaultOptions(record);
        const descriptor =
          record.agentId === "custom" ? undefined : agentDescriptor(record.agentId);
        return {
          ...service.options(botId, conversationId),
          notices:
            descriptor?.noPerCommandAsk && local.deps.platform !== "win32"
              ? ["no_per_command_ask" as const]
              : [],
        };
      });
      handle(
        "externalAgents.setOption",
        async ({ botId, conversationId, kind, configId, value }, { signal }) => {
          bound(botId);
          return service.setOption(
            botId,
            conversationId,
            { kind, value, ...(configId ? { configId } : {}) },
            signal,
          );
        },
      );
      // Maintainers 2026-11-14: detection runs once in the background after start, so New Bot's
      // 外部 Agent tab shows results at once. Off the window-first path and the startup chain;
      // no periodic poll (opening the tab refreshes).
      let warm: ReturnType<typeof setTimeout> | undefined;
      return {
        start: () => {
          // A crashed or quit run's empty placeholders (Linux), before any agent starts again.
          if (local.deps.platform === "linux")
            void cleanupAgentPlaceholders(agentPlaceholderLedger(ctx.dataDir)).catch(() =>
              ctx.logger.warn(
                JSON.stringify({ module: "external-agents", event: "placeholder_cleanup_failed" }),
              ),
            );
          warm = setTimeout(() => {
            service
              .refreshDetection(detected)
              .catch(() =>
                ctx.logger.warn(
                  JSON.stringify({ module: "external-agents", event: "detect_failed" }),
                ),
              );
          }, WARM_DETECTION_MS);
          warm.unref?.();
        },
        stop: () => {
          if (warm) clearTimeout(warm);
          releaseDelegationTools();
          return service.dispose();
        },
      };
    },
  };
}
