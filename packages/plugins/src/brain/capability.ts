import { createConnectorConnectionFactory } from "@pibot/agent";
import {
  abortable,
  activeGroup,
  type BrainCapability,
  type ConnectorsPort,
  type PluginSkillsHost,
  type SkillsPort,
} from "@pibot/brain/kit";
import type { Plugin } from "@pibot/plugin-sdk";
import {
  CONNECTION_HEALTH_PORT,
  type ConnectionHealthPort,
  type Connector,
  ConnectorManifestSchema,
  type FailedConnection,
  DiscoverySourceIdSchema as OriginToolSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { dangerousReasons } from "@pibot/policy";
import { BotsRepo, DiagnosticsRepo, transaction } from "@pibot/storage";
import { restoreFirstUseConfirmation } from "../store/connection-confirmation-restore.ts";
import { migrateConnectionAccess } from "../store/connection-migration.ts";
import {
  ConnectionActivityRepo,
  ConnectorCatalogRepo,
  ConnectorOperationsRepo,
  ConnectorsRepo,
  installationOrigin,
  isKnowledgeManagedInstallation,
  KnowledgeRepo,
  PluginAccessRepo,
  PluginsRepo,
  reconcileKnowledgeAccess,
  skillCopyTargets,
  syncKnowledgeAccess,
} from "../store/index.ts";
import { defaultBuiltinPluginDir, loadBuiltinPlugins } from "./declarative-loader.ts";
import { DiscoveryService } from "./discovery/service.ts";
import { ImportedSkillCopies } from "./imported-skill-copies.ts";
import { connectorAuthInboxSource } from "./inbox/reauth.ts";
import { clickVaultAccess, inspectVaultAccess } from "./knowledge/access.ts";
import {
  READ_TOOLS as NOTION_READ_TOOLS,
  WRITE_TOOLS as NOTION_WRITE_TOOLS,
  notionManifest,
} from "./knowledge/notion.ts";
import { readNotionAccount } from "./knowledge/notion-account.ts";
import { knowledgePolicyRequests } from "./knowledge/policy.ts";
import { registerKnowledgeTools } from "./knowledge/tools.ts";
import { knowledgeWrites } from "./knowledge/write.ts";
import { isKnowledgeWrite } from "./knowledge/write-input.ts";
import { mcpDescription } from "./mcp-description.ts";
import { cleanupOrphanPluginDirectories } from "./orphan-cleanup.ts";
import { ConnectorPool } from "./pool/pool.ts";
import { connectionDestinations } from "./service/connection-destinations.ts";
import { USER_SECRET_SCOPE } from "./service/connector-import.ts";
import { ConnectorService, registerConnectorRpc } from "./service/connector-service.ts";
import { KnowledgeService, registerKnowledgeRpc } from "./service/knowledge-service.ts";
import { registerPluginInstall } from "./service/plugin-install.ts";

/**
 * Plugins as a brain capability. The service owns plugins, connections, the MCP pool
 * and the `plugins.*` / `connectors.*` / `apps.*` RPC. The run engine reaches it only through the
 * kernel-owned `ConnectorsPort`: connector tool calls, first-use consent, send drafts, approvals
 * and unattended pre-authorization all ask the port, never the repositories.
 */
export function pluginsCapability(
  options: { plugins?: readonly Plugin[]; builtinDir?: string; includeLocalGmail?: boolean } = {},
): BrainCapability {
  return {
    id: "plugins",
    async register(ctx) {
      const { db, local } = ctx;
      const audit = local.approvals.audit;
      const operations = new ConnectorOperationsRepo(db, audit);
      const pluginAccess = new PluginAccessRepo(db, audit);
      const connectors = new ConnectorsRepo(db, audit, pluginAccess);
      const plugins = new PluginsRepo(db, audit);
      const mainBot = new BotsRepo(db).getMain();
      if (!mainBot) throw new Error("Main Bot missing before connectors start");
      await migrateConnectionAccess(db, audit, mainBot.id, local.shutdown.signal);
      await restoreFirstUseConfirmation(db, audit, mainBot.id, local.shutdown.signal);
      const orphanCleanupAbort = new AbortController();
      const orphanCleanupSignal = AbortSignal.any([
        orphanCleanupAbort.signal,
        local.shutdown.signal,
      ]);
      let orphanCleanupWork: Promise<void> | undefined;
      const scheduleOrphanCleanup = () => {
        orphanCleanupWork ??= new Promise<void>((resolve) => setTimeout(resolve, 0))
          .then(async () => {
            if (orphanCleanupSignal.aborted) return;
            const result = await cleanupOrphanPluginDirectories(
              ctx.dataDir,
              (installationId) => plugins.get(installationId) !== undefined,
              orphanCleanupSignal,
            );
            if (result.removedStages + result.removedInstallations > 0)
              ctx.logger.info(
                JSON.stringify({ module: "plugins", event: "plugin_orphans_removed", ...result }),
              );
            if (result.failures > 0)
              ctx.logger.warn(
                JSON.stringify({
                  module: "plugins",
                  event: "plugin_orphan_cleanup_failed",
                  failureCount: result.failures,
                }),
              );
          })
          .catch(() => {
            if (!orphanCleanupSignal.aborted)
              ctx.logger.warn(
                JSON.stringify({ module: "plugins", event: "plugin_orphan_cleanup_failed" }),
              );
          });
      };
      try {
        const backfill = plugins.backfillImportedSecretAllowLists(mainBot.id);
        for (const failure of backfill.failures)
          ctx.logger.warn(
            JSON.stringify({
              module: "plugins",
              event: "plugin_secret_reference_backfill_failed",
              installationId: failure.installationId,
              reasonCode: failure.reasonCode,
            }),
          );
      } catch {
        // Compatibility repair must never prevent the brain from starting. The runtime still
        // refuses every unrecorded secret reference, so leaving old rows untouched fails closed.
        ctx.logger.warn(
          JSON.stringify({ module: "plugins", event: "plugin_secret_reference_backfill_failed" }),
        );
      }
      const pluginSkills = ctx.ports.get<PluginSkillsHost>("plugin-skills");
      if (!pluginSkills) throw new Error("Plugin skills host unavailable");
      const skillCopies = new ImportedSkillCopies(ctx, plugins, mainBot.id);
      ctx.sleep.participate({ idle: () => skillCopies.idle });
      const definitions =
        options.plugins ??
        (await loadBuiltinPlugins(options.builtinDir ?? defaultBuiltinPluginDir(), {
          includeLocalGmail: options.includeLocalGmail,
        }));
      const recordDiagnostic = (result: {
        connectorId: string;
        errorCode: string | null;
        status: number | null;
      }) => {
        try {
          new DiagnosticsRepo(db).connector(result.connectorId, result.errorCode, result.status);
        } catch {
          ctx.logger.warn(
            JSON.stringify({
              module: "diagnostics",
              event: "connector_metadata_failed",
              connectorId: result.connectorId,
            }),
          );
        }
      };
      const knowledge = new KnowledgeRepo(db);
      const service = new ConnectorService({
        commitInteractiveOAuth: (id, commit) =>
          transaction(db, () => {
            commit();
            knowledge.invalidateNotionAccount(id);
          }),
        commandRisk: async (command, signal) => {
          const policy = await local.getPolicy(signal);
          signal.throwIfAborted();
          const analysis = policy.analyzeCommand(command);
          if (dangerousReasons(analysis, [], local.deps.platform).length) return "dangerous";
          return analysis.incomplete ? "unverified" : undefined;
        },
        logNativeState: (result) => {
          recordDiagnostic(result);
          ctx.logger.info(
            JSON.stringify({ module: "connector", event: "native_state", ...result }),
          );
        },
        logCallResult: (result) => {
          recordDiagnostic(result);
          ctx.logger.info(
            JSON.stringify({
              module: "connector",
              event: "call_result",
              ...result,
              tool: local.deps.redactor.redact(result.tool).slice(0, 256),
            }),
          );
        },
        // Codes only; the stderr tail stays in brain memory for the detail panel.
        logStartFailure: (event) => ctx.logger.warn(JSON.stringify(event)),
        logStderr: (connectorId) =>
          ctx.logger.warn(
            JSON.stringify({
              module: "connector",
              event: "stdio_failed",
              connectorId,
            }),
          ),
        displayRedact: (value) => ctx.redactor.redact(value),
        // Composition-root order (brain-app) is the user-visible apps.list order.
        pluginDefinitions: definitions,
        skillCopies,
        drafts: local.drafts.repo,
        plugins,
        connectors,
        operations,
        catalog: new ConnectorCatalogRepo(db, operations, audit),
        audit,
        secrets: ctx.secrets,
        userSecrets: local.userSecrets,
        pluginSkills,
        pool: new ConnectorPool(),
        factory: createConnectorConnectionFactory(ctx.fetch),
        proxy: local.deps.proxy,
        importHost: ctx.host.connectorImports,
        ...(ctx.host.pickFolder
          ? {
              pickWorkingDirectory: async (signal: AbortSignal) => {
                const result = await ctx.host.pickFolder?.(signal);
                return result ? { path: result } : null;
              },
            }
          : {}),
        confirmUnisolated: ctx.host.confirmConnectorCommand,
        openExternal: (url) =>
          ctx.host.openExternal
            ? ctx.host.openExternal(url, local.shutdown.signal)
            : Promise.reject(new RpcError(-32603, "browser_unavailable")),
        registerSecret: (value) => ctx.redactor.add(value),
        onNeedsAuth: () => ctx.peer.emit("inbox.changed", {}),
        onCleanupRetry: (installationId, attempt) =>
          ctx.logger.warn(
            JSON.stringify({
              module: "plugins",
              event: "plugin_uninstall_cleanup_retry",
              installationId,
              attempt,
            }),
          ),
        platform: local.deps.platform,
        emit: (event, payload) => {
          ctx.peer.emit(event, payload);
          // Re-authorization inbox items derive from connector status, so any status change can
          // add or remove one: without this the sidebar count kept "1" after a successful reauth.
          if (event === "connectors.changed") ctx.peer.emit("inbox.changed", {});
        },
        commandEnv: { ...local.deps.env },
        pathEntries: () => local.permissions.repo.get().pathEntries ?? [],
        home: local.deps.userHome,
        dataDir: ctx.dataDir,
        tempDir: local.deps.tempDir,
        actorBotId: mainBot.id,
      });
      registerPluginInstall(ctx, service);
      const originOf = (installationId: string) => {
        const tool = OriginToolSchema.safeParse(installationOrigin(db, installationId));
        return tool.success ? { originTool: tool.data } : {};
      };
      const summary = (row: Record<string, unknown>) => {
        const installation = plugins.get(String(row.id));
        if (!installation) throw new Error("Plugin installation disappeared");
        const definition = service.registry.fromInstallation(installation);
        const manifest = ConnectorManifestSchema.parse(JSON.parse(String(row.manifest_json)));
        const card = definition?.card(local.deps.platform);
        return {
          installationId: installation.id,
          pluginId: installation.pluginId,
          revision: installation.revision,
          enabled: installation.enabled,
          sourceKind: installation.sourceKind,
          application: plugins.isApplication(installation.id),
          ...(isKnowledgeManagedInstallation(db, installation.id)
            ? { managedByKnowledge: true as const }
            : {}),
          applicationPlatforms: plugins.applicationPlatforms(installation.id),
          ...originOf(installation.id),
          ...(installation.sourceKind === "directory"
            ? { skillTargets: skillCopyTargets(db, installation.id) }
            : {}),
          name: card?.name ?? manifest.name,
          description: card?.description ?? mcpDescription(manifest),
          toolCount: Number(row.tool_count ?? 0),
          connectorCount: Number(row.connector_count ?? 0),
          skillCount: definition?.skills?.length ?? plugins.importSkillCount(installation.id),
          skillUpdateCount: skillCopies.updateCount(installation.id),
          access: pluginAccess.get(installation.id),
        };
      };
      const summaryPage = (input: { before?: string; limit?: number } = {}) => {
        const page = plugins.availableRows(input);
        return { items: page.items.map(summary), nextBefore: page.nextBefore };
      };
      const port: ConnectorsPort = {
        commandCandidates: (target) => service.commandCandidates(target),
        availability: (...args) => service.availability(...args),
        unavailable: (target) => service.unavailable(target),
        get: (id) => connectors.get(id),
        access: (id) => connectors.access(id),
        tool: (connectorId, catalogVersion, toolName) =>
          connectors.tool(connectorId, catalogVersion, toolName),
        plugin: (installationId) => plugins.get(installationId),
        getConnector: (input) => service.getConnector(input),
        discoverToolsForBot: (botId, input, readOnly, groupId) =>
          service.discoverToolsForBot(botId, input, readOnly, groupId),
        capabilitySuggestions: (connectorId) => service.capabilitySuggestions(connectorId),
        capabilityConnectors: (capabilityId) => service.capabilityConnectors(capabilityId),
        capabilityTools: (botId, connectorId, capabilityId, groupId) =>
          service.capabilityTools(botId, connectorId, capabilityId, groupId),
        resolveTool: (botId, input, groupId) => service.resolveTool(botId, input, groupId),
        dispatch: (...args) => service.dispatch(...args),
        dispatchCapability: (...args) => service.dispatchCapability(...args),
        dispatchDraft: (...args) => service.dispatchDraft(...args),
      };
      ctx.connectors.provide(port);
      ctx.inbox.source(connectorAuthInboxSource);
      service.recoverPending();
      registerConnectorRpc(ctx.rpc.handle, service);
      // Knowledge sources reuse the same wrapper; they only hold references, so nothing here
      // touches the connector pool.
      const knowledgeService = new KnowledgeService({
        repo: knowledge,
        host: ctx.host,
        emit: (event, payload) => ctx.peer.emit(event, payload),
        shutdown: local.shutdown.signal,
        db,
        // A click on a note link asks the same read gate as a knowledge tool call, so a
        // policy deny cannot be turned into an allow by clicking.
        readAccess: (scope, signal) => clickVaultAccess(local, scope, signal),
        // Folder summary inspection asks the same read gate and protected-path boundary so
        // denied files never enter PDF extraction.
        inspectAccess: (targets, signal) =>
          inspectVaultAccess(local, db, mainBot.id, targets, signal),
        // Each click is recorded like a read — which source, which run and the fixed
        // outcome — never the note, the path or the href.
        audit: ({ botId, runId, sourceId, status }) =>
          audit.append({
            botId,
            runId,
            kind: "file.read",
            summary: "Opened an assigned knowledge note / 打开已分配的知识库笔记",
            // The click's own fixed outcome travels as a reason code: `status` already means the
            // approval outcome here, and no free text or note path may enter the record.
            detail: { toolName: "knowledge.openReference", target: sourceId, reasonCode: status },
          }),
        // The Notion source's connection is a brain-owned remote MCP install; OAuth,
        // access and confirmation stay with the ordinary connector path, while its access row
        // follows the knowledge source's assignments.
        notion: {
          create: () => service.createManagedConnection(notionManifest()).id,
          exists: (connectorId) => connectors.get(connectorId) !== undefined,
          sync: (sourceId) => syncKnowledgeAccess(db, audit, mainBot.id, sourceId),
          account: (input, signal) =>
            readNotionAccount(local, { ...input, db, mainBotId: mainBot.id }, signal),
          writeToolsState: (connectorId, confirmed) => {
            const connector = connectors.get(connectorId);
            if (!connector?.enabled || !["ready", "idle"].includes(connector.status))
              return undefined;
            const states = connectors.toolPolicyStates(connectorId);
            const actions = Object.entries(NOTION_WRITE_TOOLS) as [
              keyof typeof NOTION_WRITE_TOOLS,
              string,
            ][];
            const available = actions.filter(([, name]) => states.has(name));
            const missingWrites = actions
              .filter(([, name]) => !states.has(name))
              .map(([action]) => action);
            const readAvailable = NOTION_READ_TOOLS.some((name) => {
              const state = states.get(name);
              return state?.readOnly && state.enabled;
            });
            return {
              revision: connector.revision,
              total: available.length,
              enabled: available.filter(
                ([action, name]) => confirmed.includes(action) && states.get(name)?.enabled,
              ).length,
              readOnlyMode: connector.confirmationMode === "read_only",
              availableWrites: available.map(([action]) => action),
              missingWrites,
              readAvailable,
              readToolToEnable: readAvailable
                ? undefined
                : NOTION_READ_TOOLS.find((name) => states.has(name)),
            };
          },
          setWriteToolsEnabled: (connectorId, actions) => {
            const connector = connectors.get(connectorId);
            if (!connector) return;
            const states = connectors.toolPolicyStates(connectorId);
            const updates: { tool: string; enabled: boolean; readOnly: boolean }[] = [];
            for (const action of Object.keys(
              NOTION_WRITE_TOOLS,
            ) as (keyof typeof NOTION_WRITE_TOOLS)[]) {
              const name = NOTION_WRITE_TOOLS[action];
              const state = states.get(name);
              const enabled = actions.includes(action);
              if (!state || (state.enabled === enabled && !state.readOnly)) continue;
              updates.push({ tool: name, enabled, readOnly: false });
            }
            if (updates.length === 0) return;
            service.updateConnector({
              id: connector.id,
              expectedRevision: connector.revision,
              tools: updates,
            });
          },
          reconcile: () => reconcileKnowledgeAccess(db, audit, mainBot.id),
          uninstall: (connectorId) => {
            const connector = connectors.get(connectorId);
            const installation = connector && plugins.get(connector.pluginInstallationId);
            // Only the install the brain marked as belonging to a knowledge source is
            // ours to remove. `source_kind`/`plugin_id` also match a Notion MCP the person
            // imported themselves, and removing that would take away a connection they set up.
            if (
              !connector ||
              !installation ||
              installation.pluginId !== notionManifest().id ||
              !isKnowledgeManagedInstallation(db, installation.id)
            )
              return;
            service.uninstall({
              installationId: installation.id,
              expectedRevision: installation.revision,
            });
          },
        },
      });
      // Installations written before this task may still grant `all`; tighten them before
      // any Bot can read a source through them.
      knowledgeService.reconcile();
      registerKnowledgeRpc(ctx.rpc.handle, knowledgeService);
      // The tools read the same assignment the RPC tables manage, so revoking a source
      // stops the next call; the prompt only needs names, which the kernel asks for per model call.
      const knowledgeContext = {
        executor: (tool: string, run: import("@pibot/brain/kit").ToolExecutor) =>
          ctx.tools.executor(tool, run),
        local,
        logger: ctx.logger,
      };
      const knowledgeDeps = { db, repo: knowledge, connectors, service };
      const writes = knowledgeWrites(knowledgeContext, knowledgeDeps);
      registerKnowledgeTools(knowledgeContext, knowledgeDeps, writes);
      local.provideToolPolicy((context, call, tool, input, signal) =>
        isKnowledgeWrite(tool)
          ? writes.prepare(context, call, tool, input, signal)
          : knowledgePolicyRequests(knowledgeDeps, context, call, tool, input),
      );
      local.provideKnowledge((botId, groupId) =>
        knowledge.assigned({ botId, groupId }).map(({ source }) => ({
          name: source.name,
          kind: source.kind,
          writable: source.writable,
        })),
      );
      ctx.rpc.handle(
        "connections.commands",
        ({ botId, groupId, readOnly, cursor, limit }, { signal }) => {
          const bot = new BotsRepo(db).get(botId);
          if (!bot || bot.archivedAt) throw new RpcError(-32602, "bot_unavailable");
          if (groupId) activeGroup(db, groupId, botId);
          const commands =
            bot.kind === "agent" || bot.category === "image"
              ? []
              : local.connectionCommands(botId, groupId, readOnly ?? false, signal);
          const start = cursor ? commands.findIndex((command) => command.id === cursor) + 1 : 0;
          const items = commands.slice(start, start + limit);
          return Promise.resolve({
            items,
            nextCursor: commands.length > start + limit ? (items.at(-1)?.id ?? null) : null,
          });
        },
      );
      ctx.rpc.handle("connections.availability", (params) => {
        if (params.target.kind === "group") activeGroup(ctx.db, params.target.id);
        else {
          const bot = new BotsRepo(ctx.db).get(params.target.id);
          if (!bot || bot.archivedAt) throw new RpcError(-32602, "bot_unavailable");
        }
        return Promise.resolve(service.availability(params.target, params.connection, params.tool));
      });
      const activity = new ConnectionActivityRepo(db);
      ctx.rpc.handle("connectors.recentUse", ({ id, before, limit }) => {
        const tools = connectors.toolPolicyStates(id);
        const readOnly = new Set(
          [...tools].flatMap(([name, state]) => (state.readOnly ? [name] : [])),
        );
        return Promise.resolve(activity.recent(id, { before, limit }, readOnly));
      });
      ctx.rpc.handle("connectors.dataDestinations", ({ id }) =>
        Promise.resolve(
          connectionDestinations(
            {
              connectors,
              plugins,
              registry: service.registry,
              activity,
              platform: local.deps.platform,
            },
            id,
          ),
        ),
      );
      ctx.rpc.handle("plugins.pendingSkillAssignments", (params) =>
        Promise.resolve(skillCopies.pendingPage(params)),
      );
      ctx.rpc.handle("plugins.skillAssignments", ({ installationId }) =>
        Promise.resolve(skillCopies.status(installationId)),
      );
      ctx.rpc.handle(
        "plugins.assignSkills",
        ({ installationId, expectedRevision, targets }, context) =>
          skillCopies.assign(installationId, expectedRevision, targets, context.signal),
      );
      const discovery = new DiscoveryService({
        db,
        home: local.deps.userHome,
        env: local.deps.env,
        logger: ctx.logger,
        audit,
        actorBotId: mainBot.id,
        connectors: service,
        skills: () => ctx.ports.get<SkillsPort>("imported-skills"),
        secretExists: (name) => ctx.secrets.has(USER_SECRET_SCOPE, name),
        ...(ctx.host.connectorImports ? { importHost: ctx.host.connectorImports } : {}),
        shutdown: local.shutdown.signal,
      });
      ctx.rpc.handle("plugins.pickSettingPath", async ({ kind }, context) => {
        const picker = kind === "directory" ? ctx.host.pickFolder : ctx.host.pickFile;
        if (!picker)
          throw new RpcError(RpcErrorCodes.unsupported, "plugin_setting_picker_unavailable");
        const signal = AbortSignal.any([
          context.signal,
          local.shutdown.signal,
          AbortSignal.timeout(630_000),
        ]);
        const path = await abortable(picker(signal), signal);
        return { path: path ?? null };
      });
      ctx.rpc.handle("connections.discoverConsent", ({ allow }) =>
        Promise.resolve(discovery.setConsent(allow)),
      );
      ctx.rpc.handle("connections.discover", (_params, context) =>
        discovery.discover(context.signal),
      );
      ctx.rpc.handle("connections.bringOver", ({ keys, batchId }, context) =>
        discovery.bringOver(keys, context.signal, batchId),
      );
      ctx.rpc.handle("connections.cancelBringOver", ({ batchId }) =>
        discovery.cancelBringOver(batchId),
      );
      ctx.rpc.handle("connections.previewSetup", ({ key }, context) =>
        discovery.previewSetup(key, context.signal),
      );
      // A bring-over of skills shows the same preview as a picked folder first.
      ctx.rpc.handle("connections.previewBringOver", ({ keys, batchId }, context) =>
        discovery.previewBringOver(keys, context.signal, batchId),
      );
      ctx.rpc.handle("connections.adoptBringOver", ({ key }, context) =>
        discovery.adoptForSetup(key, context.signal),
      );
      let migrationWork: Promise<void> | undefined;
      ctx.rpc.handle("connections.tokens", () =>
        Promise.resolve({
          items: service.apps
            .tokens()
            .map((token) => ({ ...token, ...originOf(token.installationId) })),
        }),
      );
      ctx.rpc.handle("plugins.available", (params) => Promise.resolve(summaryPage(params)));
      // The default Pi's health check lists failed connections and offers the same restart as
      // "Test connection"; names are redacted like everywhere else they are shown.
      const failedView = (connector: Connector): FailedConnection => ({
        id: connector.id,
        name: ctx.redactor.redact(connector.name).slice(0, 200),
        revision: connector.revision,
        detail: connector.statusDetailCode,
        since: connector.updatedAt,
      });
      ctx.ports.provide<ConnectionHealthPort>(CONNECTION_HEALTH_PORT, {
        failed: (limit) => connectors.failed(limit).map(failedView),
        failedOne: (id) => connectors.failed(1, id).map(failedView)[0],
        restart: (id, expectedRevision, signal) =>
          service.restart({ id, expectedRevision }, signal),
      });
      return {
        start() {
          scheduleOrphanCleanup();
          migrationWork = new Promise<void>((resolve) => setTimeout(resolve, 0))
            .then(() => skillCopies.migrate())
            .catch(() => {
              if (!local.shutdown.signal.aborted)
                ctx.logger.warn(
                  JSON.stringify({ module: "plugins", event: "skill_copy_migration_incomplete" }),
                );
            });
        },
        async stop() {
          orphanCleanupAbort.abort();
          await orphanCleanupWork;
          await skillCopies.stop();
          await service.dispose();
          await migrationWork;
        },
      };
    },
  };
}
