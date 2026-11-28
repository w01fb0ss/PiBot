/*
 * How a knowledge source is reached: the vault's file permission, and the connector channel a
 * Notion library goes through. Kept apart from the two executors so the permission reasoning and
 * the judged-connection rule sit in one place.
 */
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LocalToolCall } from "@pibot/agent";
import {
  type ConnectorCallInput,
  ConnectorToolError,
  createProtectedReadPathCheck,
  createReadPathBoundary,
  dispatchReadConnector,
  type LocalService,
  runPermissionSources,
  runPermissions,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { samePathSpelling, sensitiveReadBoundary } from "@pibot/execution";
import {
  type KnowledgeConfig,
  type KnowledgeSource,
  type KnowledgeTargets,
  RpcError,
} from "@pibot/plugins-contract/full";
import type { CallAuthorization, KnowledgeToolContext, KnowledgeToolDeps } from "./common.ts";
import type { NotionAccess } from "./notion.ts";
import { resolveKnowledgeActor } from "./notion-account.ts";
import type { VaultAccess } from "./obsidian.ts";

/**
 * Obsidian is a folder on this machine, so its gate is the person's file permission: the vault's
 * own root decides, and every note inside it inherits that answer.
 *
 * Owner decision 2026-11-05: assigning a vault to this Bot or group *is* the consent to read it, so
 * an "ask" here is taken as allowed and no card is raised; the audit record below is where that
 * consent stays visible. A "deny" (system folders, Pi Bot's own data, secrets) still refuses, which
 * keeps a mistakenly chosen home folder from becoming readable. Only sources assigned to this Bot
 * or group reach this function at all: `selectSources` reads the assignment on every call.
 */
export async function vaultAccess(
  ctx: KnowledgeToolContext,
  context: ToolRunContext,
  signal: AbortSignal,
): Promise<VaultAccess> {
  const { local } = ctx;
  const boundary = await createReadPathBoundary(local, context, signal);
  const { workplace } = boundary;
  const policy = await local.getPolicy(signal);
  const settings = local.tasks.settings(context, runPermissions(local, context));
  const permissionSources = runPermissionSources(local, context);
  const grants = local.grants(context.botId, context);
  const answers = new Map<string, Promise<boolean>>();
  const decide = (path: string, category: "read_file" | "list_dir", current: AbortSignal) => {
    boundary.assertCurrent(current);
    if (!boundary.permits(path)) return Promise.resolve(false);
    const key = `${category}:${path}`;
    const cached = answers.get(key);
    if (cached) return cached;
    const pending = policy
      .evaluate({
        botId: context.botId,
        request: { category, path },
        settings,
        permissionSources,
        sensitiveReadRoots: boundary.sensitiveReadRoots,
        grants,
        workplace: workplace.value,
        boundary: workplace.boundary,
        cwd: workplace.cwd,
        signal: current,
      })
      .then(
        (result) => {
          boundary.assertCurrent(current);
          return (
            result.decision !== "deny" &&
            result.path?.path !== undefined &&
            samePathSpelling(result.path.path, path)
          );
        },
        (error) => {
          answers.delete(key);
          throw error;
        },
      );
    answers.set(key, pending);
    return pending;
  };
  return {
    signal,
    authorizePath: (path, kind, current) =>
      decide(path, kind === "file" ? "read_file" : "list_dir", current),
  };
}

/**
 * A click on a reply's note link is still a read of the person's folder, so it asks the
 * very same gate a `read_file` call does — a denied folder stays denied even though the person
 * clicked, and a decision that changes before the system open is not remembered.
 *
 * Only the fields policy and workplace resolution read are filled: a click runs no tools, so the
 * run-only state (task authority, routines, tool bookkeeping) is absent by design rather than
 * copied from a finished run.
 */
export async function clickVaultAccess(
  local: LocalService,
  scope: Pick<ToolRunContext, "botId" | "runId" | "conversationId"> & { groupId?: string },
  signal: AbortSignal,
): Promise<VaultAccess> {
  return vaultAccess({ local } as KnowledgeToolContext, scope as ToolRunContext, signal);
}

/**
 * Folder summary inspection (`knowledge.inspect`) opens PDFs to detect scanned documents, so it
 * must go through the same `read_file`/`list_dir` policy gate and protected-path boundary as a
 * Bot's own vault search. Denied files and protected roots stay outside content extraction.
 */
export async function inspectVaultAccess(
  local: LocalService,
  db: DatabaseSync,
  mainBotId: string,
  targets: KnowledgeTargets,
  signal: AbortSignal,
): Promise<VaultAccess> {
  const assigned = resolveKnowledgeActor(db, targets, mainBotId);
  const actor = assigned ?? { botId: mainBotId };
  const botHome = join(resolve(local.deps.dataDir), "bots", actor.botId, "home");
  const platform = local.deps.platform;
  const protectedPaths = await sensitiveReadBoundary(
    platform,
    [local.deps.userHome, botHome],
    local.deps.env,
    {
      dataDir: local.deps.dataDir,
      botHome,
      skillGroupId: actor.groupId,
      skillPackageIds: local.skills?.packageIds?.(actor.botId, actor.groupId),
    },
  );
  const permits = createProtectedReadPathCheck(local.deps.userHome, protectedPaths, platform);
  const policy = await local.getPolicy(signal);
  const settings = actor.groupId
    ? local.permissions.effectiveGroup(actor.groupId)
    : local.permissions.effective(actor.botId);
  const permissionSources = local.permissions.sources(actor.botId, actor.groupId);
  const grants = local.grants(actor.botId);
  const workplace = { home: botHome, folders: [], currentId: "home" };
  const answers = new Map<string, Promise<boolean>>();
  const decide = (path: string, category: "read_file" | "list_dir", current: AbortSignal) => {
    current.throwIfAborted();
    if (!permits(path)) return Promise.resolve(false);
    const key = `${category}:${path}`;
    const cached = answers.get(key);
    if (cached) return cached;
    const pending = policy
      .evaluate({
        botId: actor.botId,
        request: { category, path },
        settings,
        permissionSources,
        sensitiveReadRoots: protectedPaths.denyRead,
        grants,
        workplace,
        cwd: botHome,
        signal: current,
      })
      .then(
        (result) =>
          (result.decision === "allow" || (assigned !== undefined && result.decision === "ask")) &&
          result.path?.path !== undefined &&
          samePathSpelling(result.path.path, path),
        (error) => {
          answers.delete(key);
          throw error;
        },
      );
    answers.set(key, pending);
    return pending;
  };
  return {
    signal,
    authorizePath: (path, kind, current) =>
      decide(path, kind === "file" ? "read_file" : "list_dir", current),
  };
}

/**
 * Notion goes through the ordinary connector channel: the call's policy request is built in the
 * prepare phase (see `knowledgePolicyRequests`), so the connection's confirmation mode, approval and
 * audit are the ordinary ones; `resolveTool` re-checks access, the enabled tool and its read-only
 * flag on every attempt, and `dispatch` repeats that before the remote call. Nothing here holds a
 * token or opens a transport.
 */
export function notionAccess(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  context: ToolRunContext,
  call: LocalToolCall,
  authorization: CallAuthorization | undefined,
  config: KnowledgeConfig,
  signal: AbortSignal,
): NotionAccess {
  if (config.kind !== "notion") throw new RpcError(-32602, "knowledge_source_missing");
  const connectorId = config.connectorId;
  // Prepare deliberately builds no request for a missing connection, so report it as gone rather
  // than as "judged set missing": nothing is dialled either way.
  if (!deps.connectors.get(connectorId)) throw new ConnectorToolError("connector_unavailable");
  // Only connections this call's prepare phase judged may be dialled. The set arrives on the
  // call's own prepared data, so a source assigned after prepare (or a source whose request was
  // never built) is reported as changed instead of reaching a connection no decision covered.
  if (!judgedConnections(authorization?.data).includes(connectorId))
    throw new RpcError(-32602, "knowledge_source_changed");
  const tools = () => {
    const connector = deps.connectors.get(connectorId);
    if (!connector) return [];
    return deps.service.discoverToolsForBot(
      context.botId,
      { connectorId, limit: 100 },
      true,
      context.groupId,
    ).items;
  };
  return {
    signal,
    tools,
    call: async (tool, args, current) => {
      const connector = deps.connectors.get(connectorId);
      if (!connector) throw new ConnectorToolError("connector_unavailable");
      const input: ConnectorCallInput = {
        connectorId,
        catalogVersion: connector.catalogVersion,
        tool,
        // The search module builds args from the tool's own schema; dispatch revalidates them.
        args: args as ConnectorCallInput["args"],
      };
      const prepared = deps.service.resolveTool(context.botId, input, context.groupId);
      // The connection call was judged before the tool ran, so this phase only dispatches it: the
      // shared read path adds the 30 s timeout, the "no secrets in args" check, the connector
      // audit and the approval re-check, exactly like a direct `connector_call`.
      return dispatchReadConnector(
        {
          local: ctx.local,
          context,
          assertDispatch: () => authorization?.assertCurrent(),
          recordInputTranslation: authorization?.recordInputTranslation,
        },
        { call, explanation: [] },
        input,
        prepared,
        current,
      );
    },
  };
}

/** What prepare hands back to this call's executor: the connections it judged. */
export interface KnowledgePrepared {
  judged: readonly string[];
}

/**
 * The connection ids this knowledge call's prepare phase judged. The kernel returns the
 * capability's own prepare result on the call's prepared data (never a module-level map), so the
 * set follows exactly this call: concurrent calls cannot evict it, a slow approval cannot lose it,
 * and it is released with the call.
 */
function judgedConnections(data: unknown): readonly string[] {
  if (typeof data !== "object" || data === null) return [];
  const judged = (data as { judged?: unknown }).judged;
  return Array.isArray(judged) ? judged.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Owner decision 2026-11-05: an assigned vault is the consent to read it, so vault reads raise no
 * card; this record is how that consent stays visible afterwards. It carries the library id, the
 * run and how many notes were read — never a path or a note body.
 */
export function auditVaultRead(
  ctx: KnowledgeToolContext,
  context: ToolRunContext,
  entry: { source: KnowledgeSource },
  tool: string,
  notes: number,
) {
  ctx.local.approvals.audit.append({
    botId: context.botId,
    runId: context.runId,
    kind: "file.read",
    summary: "Read an assigned knowledge library / 读取已分配的知识库",
    detail: { toolName: tool, target: entry.source.id, messageCount: Math.min(notes, 50) },
  });
}
