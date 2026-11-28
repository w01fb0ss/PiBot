// The default Pi's health check: its saved reports (the list card, the repair's stale check) and
// the read-only scans it runs over the app's own records. Nothing here changes app state; every
// repair goes through the owning service.
import type { DatabaseSync } from "node:sqlite";
import { pendingPlanActionRows, pendingPlanRows } from "@pibot/storage";
import { type PiHealthReport, PiHealthReportSchema } from "@pibot/teams-contract";

/** Each scan reads at most this many rows; the check caps what it lists on top of that. */
const SCAN = 200;

const columns = `id,tool_call_id AS toolCallId,pi_message_id AS messageId,scope_json AS scope,
  items_json AS items,more,resolutions_json AS resolutions,created_at AS createdAt`;

function parse(row: Record<string, unknown>): PiHealthReport {
  const { targetId: _targetId, ...scope } = JSON.parse(String(row.scope));
  return PiHealthReportSchema.parse({
    ...row,
    scope,
    items: JSON.parse(String(row.items)),
    resolutions: JSON.parse(String(row.resolutions)),
    more: Number(row.more),
  });
}

export class PiHealthReportsRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    id: string;
    piBotId: string;
    piRunId: string;
    scopeTargetId?: string;
    report: Omit<PiHealthReport, "id" | "resolutions" | "createdAt">;
  }): PiHealthReport {
    const value = PiHealthReportSchema.parse({
      ...input.report,
      id: input.id,
      resolutions: [],
      createdAt: new Date().toISOString(),
    });
    this.db
      .prepare(`INSERT INTO pi_health_reports(id,pi_bot_id,pi_run_id,pi_message_id,tool_call_id,
        scope_json,items_json,more,created_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(pi_run_id,tool_call_id) DO NOTHING`)
      .run(
        value.id,
        input.piBotId,
        input.piRunId,
        value.messageId,
        value.toolCallId,
        JSON.stringify({ ...value.scope, targetId: input.scopeTargetId }),
        JSON.stringify(value.items),
        value.more,
        value.createdAt,
      );
    const existing = this.db
      .prepare(`SELECT ${columns} FROM pi_health_reports WHERE pi_run_id=? AND tool_call_id=?`)
      .get(input.piRunId, value.toolCallId);
    return this.get(value.id) ?? (existing ? parse(existing) : value);
  }

  get(id: string): PiHealthReport | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM pi_health_reports WHERE id=?`).get(id);
    return row ? parse(row) : undefined;
  }

  /** Reports written during one Pi run, newest first, so a re-check supersedes an earlier tap. */
  forRun(piRunId: string): PiHealthReport[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM pi_health_reports WHERE pi_run_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20`,
      )
      .all(piRunId)
      .map(parse);
  }

  /** The check's own Pi conversation: a repair only accepts a report Pi wrote in this chat. */
  owner(id: string): { botId: string; conversationId: string } | undefined {
    const row = this.db
      .prepare(`SELECT r.pi_bot_id AS botId,m.conversation_id AS conversationId
        FROM pi_health_reports r JOIN messages m ON m.id=r.pi_message_id WHERE r.id=?`)
      .get(id);
    return row
      ? { botId: String(row.botId), conversationId: String(row.conversationId) }
      : undefined;
  }

  forMessage(messageId: string): PiHealthReport[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM pi_health_reports WHERE pi_message_id=? ORDER BY created_at,id LIMIT 10`,
      )
      .all(messageId)
      .map(parse);
  }

  /** A cursor comes from a page Pi already returned in this chat and scope. */
  hasPageItem(
    botId: string,
    messageId: string,
    scope: PiHealthReport["scope"],
    targetId: string | undefined,
    itemId: string,
  ): boolean {
    // Older reports saved only the displayed scope name.
    return !!this.db
      .prepare(`SELECT 1 FROM messages m JOIN pi_health_reports r ON r.pi_message_id=m.id
        WHERE m.conversation_id=(SELECT conversation_id FROM messages WHERE id=?)
        AND r.pi_bot_id=? AND json_extract(r.scope_json,'$.kind')=?
        AND (json_extract(r.scope_json,'$.targetId')=? OR
          (json_extract(r.scope_json,'$.targetId') IS NULL AND json_extract(r.scope_json,'$.name') IS ?))
        AND EXISTS(SELECT 1 FROM json_each(r.items_json) item WHERE json_extract(item.value,'$.id')=?)
        LIMIT 1`)
      .get(messageId, botId, scope.kind, targetId ?? null, scope.name ?? null, itemId);
  }

  /** Appends what a repair did to one item; the card shows the latest outcome per item. */
  resolve(id: string, resolution: PiHealthReport["resolutions"][number]): string | undefined {
    const report = this.get(id);
    if (!report) return undefined;
    const resolutions = [...report.resolutions, resolution].slice(-200);
    this.db
      .prepare("UPDATE pi_health_reports SET resolutions_json=? WHERE id=?")
      .run(JSON.stringify(resolutions), id);
    return report.messageId;
  }
}

export interface PendingApprovalRow {
  id: string;
  botId: string;
  runId: string;
  conversationId: string | null;
  groupId: string | null;
  category: string;
  createdAt: string;
  /** Present while the approval is paused (timed out) and still open to a resume. */
  paused: { at: string } | null;
  /** Kept on purpose: a send draft, a routine's gate, or a pause being resumed or closed. */
  kept: boolean;
}

export interface ActiveRunRow {
  id: string;
  botId: string;
  conversationId: string;
  groupId: string | null;
  status: "queued" | "running";
  taskId: string | null;
  createdAt: string;
  startedAt: string | null;
}

export interface TopicHolderRow {
  conversationId: string;
  kind: "run" | "subtask" | "approval" | "background";
  id: string;
  /** The run behind a sub-task, when it has one. */
  runId: string | null;
  at: string;
}

export interface PlanRow {
  messageId: string;
  groupId: string;
  groupName: string;
  at: string;
}

export interface RunningWorkflowRow {
  id: string;
  groupId: string;
  groupName: string;
  cycleId: string;
  updatedAt: string;
  held: boolean;
  stepsReady: number;
  stepsRunning: number;
}

export interface IdleTaskRow {
  id: string;
  groupId: string;
  groupName: string;
  title: string;
  assigneeBotId: string;
  threadConversationId: string;
  lastActivity: string;
}

export interface RunningBackgroundRow {
  id: string;
  botId: string;
  conversationId: string | null;
  groupId: string | null;
  startedAt: string;
  status: string;
}

/** Read-only scans over the app's own records (bounded, oldest first, stable order). */
export class PiHealthScansRepo {
  constructor(private readonly db: DatabaseSync) {}

  roundLimitedGroups(): string[] {
    return this.db
      .prepare(`SELECT c.group_id AS id FROM group_cycles c JOIN groups g ON g.id=c.group_id
        WHERE c.limited=1 AND c.round_limit_id IS NOT NULL AND g.archived_at IS NULL
        ORDER BY c.group_id LIMIT ?`)
      .all(SCAN)
      .map((row) => String(row.id));
  }

  pendingApprovals(): PendingApprovalRow[] {
    return this.db
      .prepare(`SELECT a.id,a.bot_id AS botId,a.run_id AS runId,m.conversation_id AS conversationId,
        c.group_id AS groupId,a.category,a.created_at AS createdAt,
        p.paused_at AS pausedAt,p.approval_id AS pauseId,
        (EXISTS(SELECT 1 FROM send_drafts d WHERE d.approval_id=a.id)
          OR a.routine_run_id IS NOT NULL
          OR (p.approval_id IS NOT NULL AND (p.resumed_run_id IS NOT NULL OR p.consumed=1))) AS kept
        FROM approvals a LEFT JOIN messages m ON m.id=a.message_id
        LEFT JOIN conversations c ON c.id=m.conversation_id
        LEFT JOIN chat_approval_pauses p ON p.approval_id=a.id
        WHERE a.status='pending' ORDER BY a.created_at,a.id LIMIT ?`)
      .all(SCAN)
      .map((row) => ({
        id: String(row.id),
        botId: String(row.botId),
        runId: String(row.runId),
        conversationId: row.conversationId == null ? null : String(row.conversationId),
        groupId: row.groupId == null ? null : String(row.groupId),
        category: String(row.category),
        createdAt: String(row.createdAt),
        paused: row.pauseId == null ? null : { at: String(row.pausedAt) },
        kept: Number(row.kept) === 1,
      }));
  }

  /** Queued or running runs (routine runs belong to their own owner and are left out). */
  activeRuns(): ActiveRunRow[] {
    return this.db
      .prepare(`SELECT id,bot_id AS botId,conversation_id AS conversationId,group_id AS groupId,
        status,task_id AS taskId,created_at AS createdAt,started_at AS startedAt FROM runs
        WHERE status IN ('queued','running') AND kind<>'routine' ORDER BY created_at,id LIMIT ?`)
      .all(SCAN)
      .map((row) => ({
        id: String(row.id),
        botId: String(row.botId),
        conversationId: String(row.conversationId),
        groupId: row.groupId == null ? null : String(row.groupId),
        status: row.status === "queued" ? "queued" : "running",
        taskId: row.taskId == null ? null : String(row.taskId),
        createdAt: String(row.createdAt),
        startedAt: row.startedAt == null ? null : String(row.startedAt),
      }));
  }

  /**
   * What makes a topic refuse new messages from the records alone, the same rows `TopicsRepo.busy`
   * and `GroupTopicsRepo.busy` read: unfinished runs, sub-tasks, pending approvals and running
   * background commands.
   */
  topicHolders(): TopicHolderRow[] {
    return this.db
      .prepare(`SELECT * FROM (
        SELECT conversation_id AS conversationId,'run' AS kind,id,NULL AS runId,created_at AS at
          FROM runs WHERE status IN ('queued','running') AND kind<>'routine'
        UNION ALL SELECT source_conversation_id,'subtask',id,run_id,updated_at FROM task_instances
          WHERE status IN ('queued','running','stopping')
        UNION ALL SELECT m.conversation_id,'approval',a.id,a.run_id,a.created_at FROM approvals a
          JOIN messages m ON m.id=a.message_id WHERE a.status='pending'
        UNION ALL SELECT conversation_id,'background',id,run_id,started_at FROM background_commands
          WHERE status='running' AND conversation_id IS NOT NULL
      ) ORDER BY conversationId,at,id LIMIT ?`)
      .all(SCAN * 2)
      .map((row) => ({
        conversationId: String(row.conversationId),
        kind: row.kind as TopicHolderRow["kind"],
        id: String(row.id),
        runId: row.runId == null ? null : String(row.runId),
        at: String(row.at),
      }));
  }

  /** Cards the inbox lists as plans waiting for the person (same projection as 「等你处理」). */
  waitingPlans(): PlanRow[] {
    return this.planRows(pendingPlanRows);
  }

  /** Blocked steps, manual reviews and plan-attempt limits waiting for the person. */
  waitingPlanActions(): PlanRow[] {
    return this.planRows(pendingPlanActionRows);
  }

  private planRows(sql: string): PlanRow[] {
    return this.db
      .prepare(`SELECT id,at,groupId,groupName FROM (${sql}) ORDER BY at,id LIMIT ?`)
      .all(SCAN)
      .map((row) => ({
        messageId: String(row.id),
        groupId: String(row.groupId),
        groupName: String(row.groupName),
        at: String(row.at),
      }));
  }

  /** Started plans the engine still counts as running (held ones are listed by the inbox). */
  runningWorkflows(): RunningWorkflowRow[] {
    return this.db
      .prepare(`SELECT w.id,w.group_id AS groupId,g.name AS groupName,w.cycle_id AS cycleId,
        w.updated_at AS updatedAt,
        json_extract(w.workflow_json,'$.progress.hold.kind') IS NOT NULL AS held,
        (SELECT COUNT(*) FROM group_workflow_steps s WHERE s.workflow_run_id=w.id AND s.status='ready') AS ready,
        (SELECT COUNT(*) FROM group_workflow_steps s WHERE s.workflow_run_id=w.id AND s.status='running') AS running
        FROM group_workflow_runs w JOIN groups g ON g.id=w.group_id
        WHERE w.status='running' AND g.archived_at IS NULL AND g.paused=0
        ORDER BY w.updated_at,w.id LIMIT ?`)
      .all(SCAN)
      .map((row) => ({
        id: String(row.id),
        groupId: String(row.groupId),
        groupName: String(row.groupName),
        cycleId: String(row.cycleId),
        updatedAt: String(row.updatedAt),
        held: Number(row.held) === 1,
        stepsReady: Number(row.ready),
        stepsRunning: Number(row.running),
      }));
  }

  /** Unfinished runs of a group's members (any topic), for "is anyone still working". */
  groupActiveRuns(groupId: string): string[] {
    return this.db
      .prepare(
        "SELECT id FROM runs WHERE group_id=? AND status IN ('queued','running','waiting') LIMIT 50",
      )
      .all(groupId)
      .map((row) => String(row.id));
  }

  /**
   * Open group tasks with no message, run or step change since `before`, that are not a step of
   * a plan still in progress (those are the plan's business).
   */
  idleTasks(before: string): IdleTaskRow[] {
    return this.db
      .prepare(`SELECT * FROM (SELECT t.id,t.group_id AS groupId,g.name AS groupName,t.title,
        t.assignee_bot_id AS assigneeBotId,t.thread_conversation_id AS threadConversationId,
        MAX(t.created_at,
          COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=t.thread_conversation_id),''),
          COALESCE((SELECT MAX(r.created_at) FROM runs r WHERE r.task_id=t.id),'')) AS lastActivity
        FROM group_tasks t JOIN groups g ON g.id=t.group_id
        WHERE t.status='open' AND g.archived_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.task_id=t.id AND r.status IN ('queued','running','waiting'))
        AND NOT EXISTS(SELECT 1 FROM group_workflow_steps s JOIN group_workflow_runs w ON w.id=s.workflow_run_id
          WHERE s.task_id=t.id AND w.status IN ('running','waiting')))
        WHERE lastActivity<? ORDER BY lastActivity,id LIMIT ?`)
      .all(before, SCAN)
      .map((row) => ({
        id: String(row.id),
        groupId: String(row.groupId),
        groupName: String(row.groupName),
        title: String(row.title),
        assigneeBotId: String(row.assigneeBotId),
        threadConversationId: String(row.threadConversationId),
        lastActivity: String(row.lastActivity),
      }));
  }

  runningBackground(): RunningBackgroundRow[] {
    return this.db
      .prepare(`SELECT id,bot_id AS botId,conversation_id AS conversationId,group_id AS groupId,
        started_at AS startedAt,status FROM background_commands WHERE status='running'
        ORDER BY started_at,id LIMIT ?`)
      .all(SCAN)
      .map((row) => ({
        id: String(row.id),
        botId: String(row.botId),
        conversationId: row.conversationId == null ? null : String(row.conversationId),
        groupId: row.groupId == null ? null : String(row.groupId),
        startedAt: String(row.startedAt),
        status: String(row.status),
      }));
  }
}
