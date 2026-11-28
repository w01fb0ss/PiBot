import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Approval,
  type ApprovalFinalStatus,
  ApprovalFinalStatusSchema,
  type ApprovalModelOption,
  ApprovalPageSchema,
  ApprovalSchema,
  type BotPage,
  type KernelMethodParams,
} from "@pibot/protocol-base";
import { visibleImport, visibleImportedRows } from "../conversations/conversations.ts";
import { transaction } from "../database/database.ts";
import { readPage } from "../database/paging.ts";
import { RunEventsRepo } from "../runs/run-events.ts";

export type CreateApproval = Omit<
  Approval,
  "id" | "status" | "remembered" | "createdAt" | "resolvedAt" | "expiresAt"
> & { expiresAt?: string };
const columns = `id, bot_id AS botId, run_id AS runId, message_id AS messageId, conversation_id AS conversationId,
  tool_call_id AS toolCallId, category, risk, request, status, remembered,
  source,routine_run_id AS routineRunId,created_at AS createdAt, resolved_at AS resolvedAt, expires_at AS expiresAt`;
// Pending cards nothing else keeps: paused chat cards, send drafts and parked routine gates each
// have their own recovery. Startup recovery and the default Pi's repair share this one predicate.
const RECOVERABLE = `NOT EXISTS(SELECT 1 FROM chat_approval_pauses p WHERE p.approval_id=approvals.id) AND NOT EXISTS(SELECT 1 FROM send_drafts d WHERE d.approval_id=approvals.id) AND NOT EXISTS(SELECT 1 FROM parked_unattended_runs p WHERE p.id=approvals.routine_run_id)`;
// A task thread belongs to the topic that created it, even after the task has finished.
const groupTopics = `SELECT c.id, t.id AS topicId, t.archived_at AS archivedAt
  FROM conversations c JOIN (
    SELECT id,group_id,archived_at FROM conversations
    WHERE kind='group' AND internal_task_id IS NULL AND ${visibleImport}
  ) t ON t.id=COALESCE(c.thread_of,c.id) AND t.group_id=c.group_id
  WHERE c.group_id=? AND c.kind IN ('group','thread')
  AND c.internal_task_id IS NULL AND ${visibleImportedRows("c.import_id")}`;
function parseApproval(row: Record<string, unknown>): Approval {
  const { request, ...fields } = row;
  return ApprovalSchema.parse({
    ...JSON.parse(String(request)),
    ...fields,
    remembered: row.remembered === 1,
  });
}

export class ApprovalsRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateApproval): Approval {
    const now = new Date().toISOString();
    const source = input.source ?? (input.routineRunId ? "routine" : "chat");
    const maxWait = source === "chat" ? 600000 : 86400000;
    const value = ApprovalSchema.parse({
      ...input,
      source,
      routineRunId: input.routineRunId ?? null,
      expiresAt: input.expiresAt ?? new Date(Date.parse(now) + maxWait).toISOString(),
      id: randomUUID(),
      status: "pending",
      remembered: false,
      createdAt: now,
      resolvedAt: null,
    });
    if (value.risk === "danger" && value.canRemember)
      throw new TypeError("Dangerous approval cannot be remembered");
    if ((source === "chat") !== (value.routineRunId == null))
      throw new TypeError("Invalid approval source");
    if (value.routineRunId) {
      const routineRun = this.db
        .prepare("SELECT bot_id,run_id,reason,status,owner_token FROM unattended_runs WHERE id=?")
        .get(value.routineRunId);
      if (
        !routineRun ||
        routineRun.bot_id !== value.botId ||
        routineRun.run_id !== value.runId ||
        routineRun.status !== "running" ||
        !routineRun.owner_token ||
        (source === "trial") !== (routineRun.reason === "trial")
      )
        throw new TypeError("Approval does not belong to routine execution");
      // Permits the explicit connection+tool option on a routine's real draft only.
      if (value.canRemember && !(value.category === "send_out" && value.draft?.canRememberTool))
        throw new TypeError("Routine approval cannot create ordinary grants");
    }
    if (value.canPreauthorize && (source !== "routine" || value.risk === "danger"))
      throw new TypeError("Invalid routine preauthorization");
    if (Date.parse(value.expiresAt) - Date.parse(value.createdAt) > maxWait)
      throw new TypeError("Approval deadline exceeds source limit");
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt))
      throw new TypeError("Approval already expired");
    const message = this.db
      .prepare(`SELECT m.conversation_id FROM messages m
      WHERE m.id = ? AND m.run_id = ? AND m.bot_id = ? AND m.role<>'user'`)
      .get(value.messageId, value.runId, value.botId);
    if (!message) throw new TypeError("Approval does not belong to run and Bot");
    value.conversationId = String(message.conversation_id);
    return transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO approvals(id, bot_id, run_id, message_id, tool_call_id, category,
      risk, request, status, remembered, created_at, resolved_at, expires_at,source,routine_run_id,conversation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?,?,?,?)`)
        .run(
          value.id,
          value.botId,
          value.runId,
          value.messageId,
          value.toolCallId,
          value.category,
          value.risk,
          JSON.stringify(value),
          value.createdAt,
          value.expiresAt,
          source,
          value.routineRunId ?? null,
          String(message.conversation_id),
        );
      // A tool may ask again (e.g. a redirect to another domain); history shows its latest approval.
      this.db
        .prepare("UPDATE tool_calls SET approval_id = ? WHERE message_id = ? AND tool_call_id = ?")
        .run(value.id, value.messageId, value.toolCallId);
      new RunEventsRepo(this.db).append({
        runId: value.runId,
        conversationId: String(value.conversationId),
        kind: "approval.created",
        at: value.createdAt,
        payload: {
          approvalId: value.id,
          toolCallId: value.toolCallId,
          category: value.category,
          risk: value.risk,
          status: value.status,
          source: value.source,
        },
      });
      return value;
    });
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM approvals WHERE id = ?`).get(id);
    return row ? parseApproval(row) : undefined;
  }

  /** Called in the same transaction as saving an explicitly requested direct-run permission. */
  recordDirectRunRemembered(id: string): boolean {
    return (
      this.db
        .prepare(`UPDATE approvals SET remembered=1 WHERE id=? AND status='allowed' AND remembered=0
        AND json_type(request, '$.directRunRemember')='object'`)
        .run(id).changes === 1
    );
  }

  /** Called in the same transaction as the one-time decision. */
  selectModel(
    id: string,
    language: "zh" | "en",
    option: ApprovalModelOption,
    { videoModel, domain }: Pick<Approval, "videoModel" | "domain">,
  ) {
    const { localized } = option;
    const { title, facts } = localized[language];
    this.db
      .prepare(`UPDATE approvals SET request = json_patch(json_remove(request, '$.modelOptions'), json(?))
        WHERE id = ? AND status = 'pending'`)
      .run(JSON.stringify({ title, facts, localized, videoModel, domain: domain ?? null }), id);
  }

  blocksTaskCompletion(runId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM approvals WHERE run_id=? AND status IN ('pending','auto_denied','expired','cancelled') LIMIT 1",
      )
      .get(runId);
  }

  /** New user turns must not race another member's pending decision in this conversation. */
  hasPendingConversation(conversationId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM approvals a JOIN runs r ON r.id=a.run_id
      WHERE r.conversation_id=? AND r.status='running' AND a.status='pending' LIMIT 1`)
      .get(conversationId);
  }

  pending(
    query: BotPage & { source?: "chat" | "routine" | "trial"; routineRunId?: string } = {},
  ): Approval[] {
    const { botId, source, routineRunId, ...page } = ApprovalPageSchema.parse(query);
    const scope: [string, string][] = botId === undefined ? [] : [["bot_id", botId]];
    if (source) scope.push(["source", source]);
    if (routineRunId) scope.push(["routine_run_id", routineRunId]);
    return readPage(
      this.db,
      "approvals",
      columns,
      "created_at",
      page,
      [...scope, ["status", "pending"]],
      scope,
    ).map(parseApproval);
  }

  groupTimeline({
    groupId,
    topicId,
    since,
    ...page
  }: KernelMethodParams["approvals.groupTimeline"]): Approval[] {
    const belongs = `conversation_id IN (SELECT id FROM (${groupTopics}) WHERE topicId=?) AND source='chat'`;
    // Keep old pending cards actionable and recently answered cards at their original position.
    const cursor = page.before
      ? this.db
          .prepare(`SELECT created_at FROM approvals WHERE id=? AND ${belongs}`)
          .get(page.before, groupId, topicId)
      : undefined;
    if (page.before && !cursor) return [];
    return this.db
      .prepare(`SELECT ${columns} FROM approvals WHERE ${belongs}
        AND (? IS NULL OR status='pending' OR created_at>=? OR resolved_at>=?)
        AND (? IS NULL OR (created_at,id)<(?,?))
        ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(
        groupId,
        topicId,
        since ?? null,
        since ?? null,
        since ?? null,
        cursor?.created_at ?? null,
        cursor?.created_at ?? null,
        page.before ?? null,
        page.limit ?? 50,
      )
      .map(parseApproval);
  }

  groupFocus(groupId: string) {
    const row = this.db
      .prepare(`SELECT topicId,a.id AS approvalId FROM (${groupTopics}) c
        JOIN approvals a ON a.conversation_id=c.id
        WHERE c.archivedAt IS NULL AND a.status='pending' AND a.source='chat'
        ORDER BY a.created_at,a.id LIMIT 1`)
      .get(groupId);
    return row ? { topicId: String(row.topicId), approvalId: String(row.approvalId) } : null;
  }

  /** One pending card startup recovery would expire (not paused, no draft, no parked routine). */
  recoverable(id: string): Approval | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM approvals WHERE id=? AND status='pending'
      AND ${RECOVERABLE}`)
      .get(id);
    return row ? parseApproval(row) : undefined;
  }

  pendingForRecovery(page: BotPage = {}): Approval[] {
    const { botId, ...paging } = ApprovalPageSchema.parse(page);
    const scope: [string, string][] = botId ? [["bot_id", botId]] : [];
    return readPage(
      this.db,
      "approvals",
      columns,
      "created_at",
      paging,
      [...scope, ["status", "pending"], [RECOVERABLE, 1]],
      scope,
    ).map(parseApproval);
  }

  resolve(
    id: string,
    status: ApprovalFinalStatus,
    remembered = false,
    explanation?: Approval["explanation"],
  ): Approval | undefined {
    ApprovalFinalStatusSchema.parse(status);
    return transaction(this.db, () => {
      const current = this.get(id);
      if (current?.status !== "pending") return undefined;
      if (
        remembered &&
        (status !== "allowed" || current.risk === "danger" || !current.canRemember)
      ) {
        throw new TypeError("Approval cannot be remembered");
      }
      const now = new Date().toISOString();
      if (
        status === "allowed" &&
        Date.parse(current.expiresAt) <= Date.parse(now) &&
        !this.db.prepare("SELECT 1 FROM chat_approval_pauses WHERE approval_id=?").get(id)
      )
        throw new TypeError("Approval expired");
      this.db
        .prepare(`UPDATE approvals SET status = ?, remembered = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending'`)
        .run(status, Number(remembered), now, id);
      if (explanation) {
        const steps = ApprovalSchema.shape.explanation.parse(explanation);
        this.db
          .prepare(
            "UPDATE approvals SET request = json_set(request, '$.explanation', json(?)) WHERE id = ?",
          )
          .run(JSON.stringify(steps), id);
      }
      new RunEventsRepo(this.db).append({
        runId: current.runId,
        conversationId: String(current.conversationId),
        kind: "approval.resolved",
        at: now,
        payload: { approvalId: current.id, status, remembered },
      });
      return this.get(id);
    });
  }

  /** Brain pairs recovery/cancellation with audit append inside an outer transaction. */
  finishPending(
    status: "cancelled" | "expired",
    filter: { botId?: string; runId?: string; preserveParked?: boolean } = {},
  ): number {
    if (status !== "cancelled" && status !== "expired")
      throw new TypeError("Invalid recovery status");
    return transaction(this.db, () => {
      const preserve = Number(
        filter.preserveParked ?? (status === "expired" && !filter.botId && !filter.runId),
      );
      const rows = this.db
        .prepare(`SELECT id,run_id AS runId,conversation_id AS conversationId FROM approvals
        WHERE status='pending' AND (? IS NULL OR bot_id=?) AND (? IS NULL OR run_id=?)
        AND NOT EXISTS(SELECT 1 FROM send_drafts d WHERE d.approval_id=approvals.id)
        AND (?=0 OR NOT EXISTS(SELECT 1 FROM parked_unattended_runs p WHERE p.id=approvals.routine_run_id))`)
        .all(
          filter.botId ?? null,
          filter.botId ?? null,
          filter.runId ?? null,
          filter.runId ?? null,
          preserve,
        );
      const at = new Date().toISOString();
      const changed = this.db
        .prepare(`UPDATE approvals SET status = ?, remembered = 0, resolved_at = ?
      WHERE status = 'pending' AND (? IS NULL OR bot_id = ?) AND (? IS NULL OR run_id = ?)
      AND NOT EXISTS(SELECT 1 FROM send_drafts d WHERE d.approval_id=approvals.id)
      AND (? = 0 OR NOT EXISTS(SELECT 1 FROM parked_unattended_runs p WHERE p.id=approvals.routine_run_id))`)
        .run(
          status,
          at,
          filter.botId ?? null,
          filter.botId ?? null,
          filter.runId ?? null,
          filter.runId ?? null,
          preserve,
        ).changes;
      const events = new RunEventsRepo(this.db);
      for (const row of rows)
        events.append({
          runId: String(row.runId),
          conversationId: String(row.conversationId),
          kind: "approval.resolved",
          at,
          payload: { approvalId: String(row.id), status, remembered: false },
        });
      return Number(changed);
    });
  }
}
