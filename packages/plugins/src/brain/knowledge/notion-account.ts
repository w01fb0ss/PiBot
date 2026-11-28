/*
 * Which Notion account a knowledge source is connected as. The read is one read-only tool call
 * made by the program for the person, never by a model, and it takes the same gates as a Bot's
 * Notion read: trusted target resolution for a Bot that may use the connection, the policy
 * decision for that Bot (it must be "allow" — no card is raised for a display read), dispatch that
 * re-checks both, and audit rows before and after. The answer keeps display text only.
 */
import type { DatabaseSync } from "node:sqlite";
import { ConnectorToolError, type LocalService } from "@pibot/brain/kit";
import type { KnowledgeAccount, KnowledgeTargets } from "@pibot/plugins-contract/full";
import { connectorCallRequest } from "@pibot/policy";
import { ACCOUNT_TOOL, notionAccountOf } from "./notion.ts";

const CALL_TIMEOUT_MS = 30_000;
/** Statuses where the connection is signed in and can answer a call. */
const SIGNED_IN = new Set(["ready", "idle"]);

type Reason = NonNullable<KnowledgeAccount["reason"]>;

const unavailable = (reason: Reason): KnowledgeAccount => ({
  status: "unavailable",
  reason,
  workspace: null,
  name: null,
  email: null,
  checkedAt: new Date().toISOString(),
});

export async function readNotionAccount(
  local: LocalService,
  input: {
    db: DatabaseSync;
    sourceId: string;
    connectorId: string;
    targets: KnowledgeTargets;
    mainBotId: string;
  },
  signal: AbortSignal,
): Promise<KnowledgeAccount> {
  const port = local.connectors;
  const connector = port?.get(input.connectorId);
  if (!port || !connector || !SIGNED_IN.has(connector.status)) return unavailable("signin");
  // The connection is reachable only by the Bots its source is given to; a read on the person's
  // behalf borrows the first active Bot (or an active member of the first assigned group) so
  // access, policy and audit stay the ordinary ones.
  const actor = resolveKnowledgeActor(input.db, input.targets, input.mainBotId);
  if (!actor) return unavailable("no_bot");
  const { botId, groupId } = actor;
  const offered = port
    .discoverToolsForBot(botId, { connectorId: connector.id, limit: 100 }, true, groupId)
    .items.some((tool) => tool.tool === ACCOUNT_TOOL && tool.enabled && tool.readOnly);
  // A workspace-owned connection may not offer the tool; that is a missing detail, not a failure.
  if (!offered) return unavailable("tool_missing");
  const call = {
    connectorId: connector.id,
    catalogVersion: connector.catalogVersion,
    tool: ACCOUNT_TOOL,
    args: {},
  };
  let prepared: ReturnType<typeof port.resolveTool>;
  try {
    prepared = port.resolveTool(botId, call, groupId);
  } catch {
    // Resolution refuses for a fixed reason (access changed, tool gone); either way nothing ran.
    return unavailable("tool_missing");
  }
  if (!prepared.tool.readOnly) return unavailable("tool_missing");
  const policy = await local.getPolicy(signal);
  const decision = await policy.evaluate({
    botId,
    request: connectorCallRequest(prepared),
    settings: groupId
      ? local.permissions.effectiveGroup(groupId)
      : local.permissions.effective(botId),
    permissionSources: local.permissions.sources(botId, groupId),
    // A connection read touches no folder; the Bot's folders are not part of this decision.
    workplace: { home: local.deps.dataDir, folders: [], currentId: "home" },
    signal,
  });
  const started = performance.now();
  const audit = (reasonCode: string, verdict?: "allow" | "deny") =>
    local.approvals.audit.append({
      botId,
      kind: "connector.called",
      summary: "Read the Notion account of a knowledge library / 读取知识库的 Notion 账号",
      detail: {
        actor: "user",
        connectorId: connector.id,
        revision: connector.revision,
        catalogVersion: connector.catalogVersion,
        toolName: ACCOUNT_TOOL,
        target: input.sourceId,
        category: "connector",
        ...(verdict ? { decision: verdict } : {}),
        durationMs: Math.round(performance.now() - started),
        reasonCode,
      },
    });
  if (decision.decision !== "allow") {
    audit("knowledge_account_denied", "deny");
    return unavailable("denied");
  }
  audit("knowledge_account_running", "allow");
  let value: unknown;
  try {
    value = await port.dispatch(
      botId,
      call,
      prepared,
      AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
      () => {
        // Connector dispatch re-checks the grant, but a group grant alone does not prove
        // that the Bot used for this account read is still a member.
        const current = resolveKnowledgeActor(input.db, input.targets, input.mainBotId);
        if (
          current?.botId !== botId ||
          current.groupId !== groupId ||
          !SIGNED_IN.has(port.get(connector.id)?.status ?? "")
        )
          throw new ConnectorToolError("connector_unavailable");
      },
    );
  } catch {
    // Only the fixed outcome is recorded; the error text may quote the remote answer.
    audit("knowledge_account_error");
    signal.throwIfAborted();
    return unavailable("failed");
  }
  audit("knowledge_account_done");
  const text = notionAccountOf(value);
  if (!text.workspace && !text.name && !text.email) return unavailable("unreadable");
  return { status: "ok", reason: null, ...text, checkedAt: new Date().toISOString() };
}

/**
 * Picks an active (non-archived) Bot or current (non-departed) group member from a knowledge
 * source's targets so background reads attribute policy and audit to a real eligible member.
 */
export function resolveKnowledgeActor(
  db: DatabaseSync,
  targets: KnowledgeTargets,
  mainBotId: string,
): { botId: string; groupId?: string } | undefined {
  for (const botId of targets.all ? [mainBotId] : targets.bots) {
    const row = db
      .prepare("SELECT id FROM bots WHERE id = ? AND archived_at IS NULL LIMIT 1")
      .get(botId) as { id?: unknown } | undefined;
    if (typeof row?.id === "string") return { botId: row.id };
  }
  if (targets.all) return undefined;
  for (const groupId of targets.groups) {
    const row = db
      .prepare(
        `SELECT m.bot_id FROM group_members m
         JOIN groups g ON g.id = m.group_id
         JOIN bots b ON b.id = m.bot_id
         WHERE m.group_id = ? AND m.left_at IS NULL AND g.archived_at IS NULL AND b.archived_at IS NULL
         ORDER BY b.id = g.coordinator_bot_id DESC, m.position
         LIMIT 1`,
      )
      .get(groupId) as { bot_id?: unknown } | undefined;
    if (typeof row?.bot_id === "string") return { botId: row.bot_id, groupId };
  }
  return undefined;
}
