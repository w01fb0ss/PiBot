import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CodeAnalysisSchema,
  type Page,
  PageSchema,
  type ToolCallRecord,
  ToolCallRecordSchema,
  type ToolPerformance,
  ToolPerformanceSchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { defined } from "../database/paging.ts";
import { RunEventsRepo } from "./run-events.ts";
import { readCodeAnalysis } from "./tool-code-analysis.ts";

export interface StoredToolCall extends ToolCallRecord {
  messageId: string;
  logPath: string | null;
}
export type CreateToolCall = Pick<StoredToolCall, "messageId" | "toolCallId" | "tool" | "summary"> &
  Partial<Pick<StoredToolCall, "status" | "logPath">>;
export type ToolCallPatch = Partial<
  Pick<
    StoredToolCall,
    | "summary"
    | "status"
    | "exitCode"
    | "durationMs"
    | "logPath"
    | "finishedAt"
    | "denialReason"
    | "codeAnalysis"
    | "settingsAction"
    | "inputTranslation"
  >
> & { performance?: ToolPerformance };
const columns = `t.id, t.message_id AS messageId, t.tool_call_id AS toolCallId, t.tool, t.summary, t.code_analysis AS codeAnalysisJson, t.settings_action AS settingsActionJson,
  t.input_translation AS inputTranslation, t.status, t.exit_code AS exitCode, t.duration_ms AS durationMs, t.log_path AS logPath,
  t.created_at AS createdAt, t.finished_at AS finishedAt, t.denial_reason AS denialReason,
  t.yolo_risk AS yoloRisk,
  a.status AS approvalStatus, a.remembered AS approvalRemembered, a.risk AS approvalRisk, json_extract(a.request, '$.explanation') AS approvalExplanation,
  json_extract(a.request, '$.superseded') AS approvalSuperseded`;
const source = "tool_calls t LEFT JOIN approvals a ON a.id = t.approval_id";
function parseTool(row: Record<string, unknown>): StoredToolCall {
  const {
    messageId,
    logPath,
    codeAnalysisJson,
    settingsActionJson,
    inputTranslation,
    denialReason,
    approvalStatus,
    approvalRemembered,
    approvalRisk,
    approvalExplanation,
    approvalSuperseded,
    yoloRisk,
    ...record
  } = row;
  const codeAnalysis = readCodeAnalysis(codeAnalysisJson);
  return {
    ...ToolCallRecordSchema.parse({
      ...record,
      ...(codeAnalysis ? { codeAnalysis } : {}),
      ...(settingsActionJson ? { settingsAction: JSON.parse(String(settingsActionJson)) } : {}),
      ...(inputTranslation ? { inputTranslation } : {}),
      ...(denialReason ? { denialReason: String(denialReason) } : {}),
      ...(yoloRisk ? { yolo: { risk: yoloRisk } } : {}),
      ...(approvalStatus
        ? {
            approval: {
              status: approvalStatus,
              remembered: approvalRemembered === 1,
              risk: approvalRisk,
              ...(approvalExplanation
                ? { explanation: JSON.parse(String(approvalExplanation)) }
                : {}),
              // json_extract turns the JSON true into SQLite's 1.
              ...(approvalSuperseded === 1 ? { superseded: true } : {}),
            },
          }
        : {}),
    }),
    messageId: String(messageId),
    logPath: logPath === null ? null : String(logPath),
  };
}
export function toolRecord(tool: StoredToolCall): ToolCallRecord {
  const { messageId: _messageId, logPath: _logPath, ...record } = tool;
  return record;
}

export class ToolCallsRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): StoredToolCall | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM ${source} WHERE t.id = ?`).get(id);
    return row ? parseTool(row) : undefined;
  }

  create(input: CreateToolCall): StoredToolCall {
    const value = ToolCallRecordSchema.parse({
      id: randomUUID(),
      toolCallId: input.toolCallId,
      tool: input.tool,
      summary: input.summary,
      status: input.status ?? "running",
      exitCode: null,
      durationMs: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    });
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO tool_calls(id, message_id, tool_call_id, tool, summary, status,
      exit_code, duration_ms, log_path, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`)
        .run(
          value.id,
          input.messageId,
          value.toolCallId,
          value.tool,
          value.summary,
          value.status,
          input.logPath ?? null,
          value.createdAt,
        );
      const scope = this.scope(input.messageId);
      if (scope)
        new RunEventsRepo(this.db).append({
          ...scope,
          kind: "tool.called",
          at: value.createdAt,
          payload: {
            toolCallRecordId: value.id,
            toolCallId: value.toolCallId,
            tool: value.tool,
            status: value.status,
            summary: value.summary,
          },
        });
    });
    return { ...value, messageId: input.messageId, logPath: input.logPath ?? null };
  }

  update(id: string, patch: ToolCallPatch): StoredToolCall | undefined {
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return undefined;
      const {
        messageId,
        logPath: existingLog,
        denialReason: existingDenial,
        approval: _approval,
        yolo: _yolo,
        ...record
      } = current;
      const { logPath, performance: measured, ...fields } = defined(patch);
      if (fields.codeAnalysis) fields.codeAnalysis = CodeAnalysisSchema.parse(fields.codeAnalysis);
      const performance = measured ? ToolPerformanceSchema.parse(measured) : undefined;
      if (performance) fields.durationMs = performance.durationMs;
      const value = ToolCallRecordSchema.parse({ ...record, ...fields });
      this.db
        .prepare(`UPDATE tool_calls SET summary = ?, status = ?, exit_code = ?, duration_ms = ?,
      log_path = ?, finished_at = ?, denial_reason = ?, code_analysis = ?, settings_action = ?, input_translation = ? WHERE id = ?`)
        .run(
          value.summary,
          value.status,
          value.exitCode,
          value.durationMs,
          logPath === undefined ? existingLog : logPath,
          value.finishedAt,
          value.denialReason ?? existingDenial ?? null,
          value.codeAnalysis ? JSON.stringify(value.codeAnalysis) : null,
          value.settingsAction ? JSON.stringify(value.settingsAction) : null,
          value.inputTranslation ?? null,
          id,
        );
      const updated = this.get(id);
      if (updated && current.status !== updated.status && updated.status !== "running") {
        const scope = this.scope(messageId);
        if (scope) {
          const events = new RunEventsRepo(this.db);
          events.append({
            ...scope,
            kind: "tool.result",
            at: updated.finishedAt ?? new Date().toISOString(),
            payload: {
              toolCallRecordId: updated.id,
              toolCallId: updated.toolCallId,
              tool: updated.tool,
              status: updated.status,
              exitCode: updated.exitCode,
              durationMs: updated.durationMs,
              ...(updated.codeAnalysis ? { codeAnalysis: updated.codeAnalysis } : {}),
              ...(updated.denialReason ? { reasonCode: updated.denialReason } : {}),
              ...(performance ? { ...performance } : {}),
              ...events.toolResultPayload(updated.summary),
            },
          });
        }
      }
      return updated;
    });
  }

  /** The step was allowed by the conversation's YOLO switch instead of a card. */
  markYolo(id: string, risk: "normal" | "danger"): void {
    // A dangerous decision in the same step is never downgraded by a later normal one.
    this.db
      .prepare(
        "UPDATE tool_calls SET yolo_risk=CASE WHEN yolo_risk='danger' THEN 'danger' ELSE ? END WHERE id=?",
      )
      .run(risk, id);
  }

  /** The step's waiting card was let through when its conversation turned YOLO on. */
  markYoloApproval(approvalId: string, risk: "normal" | "danger"): void {
    this.db
      .prepare(
        "UPDATE tool_calls SET yolo_risk=CASE WHEN yolo_risk='danger' THEN 'danger' ELSE ? END WHERE approval_id=?",
      )
      .run(risk, approvalId);
  }

  list(messageId: string, page: Page = {}): StoredToolCall[] {
    const { before, limit = 50 } = PageSchema.parse(page);
    const cursor = before
      ? this.db
          .prepare(`SELECT created_at, id FROM tool_calls WHERE id = ? AND message_id = ?`)
          .get(before, messageId)
      : undefined;
    if (before && !cursor) return [];
    return this.db
      .prepare(`SELECT ${columns} FROM ${source} WHERE t.message_id = ?${
        cursor ? " AND (t.created_at < ? OR (t.created_at = ? AND t.id < ?))" : ""
      }
      ORDER BY t.created_at DESC, t.id DESC LIMIT ?`)
      .all(
        messageId,
        ...(cursor
          ? [String(cursor.created_at), String(cursor.created_at), String(cursor.id)]
          : []),
        limit,
      )
      .map(parseTool);
  }

  /** One joined query for the entire history page, without per-message approval/tool queries. */
  forMessages(messageIds: string[]): Map<string, ToolCallRecord[]> {
    const result = new Map<string, ToolCallRecord[]>();
    if (!messageIds.length) return result;
    if (messageIds.length > 200) throw new TypeError("Too many messages");
    const rows = this.db
      .prepare(`SELECT ${columns} FROM ${source}
      WHERE t.message_id IN (${messageIds.map(() => "?").join(",")}) ORDER BY t.created_at, t.rowid`)
      .all(...messageIds);
    for (const row of rows) {
      const tool = parseTool(row);
      const entries = result.get(tool.messageId) ?? [];
      entries.push(toolRecord(tool));
      result.set(tool.messageId, entries);
    }
    return result;
  }

  /** A run's latest calls of one tool, newest first, and how many it made in all. */
  recentForRun(
    runId: string,
    tool: string,
    limit: number,
  ): { calls: StoredToolCall[]; total: number } {
    const calls = this.db
      .prepare(`SELECT ${columns} FROM ${source} JOIN messages m ON m.id = t.message_id
      WHERE m.run_id = ? AND t.tool = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`)
      .all(runId, tool, Math.max(0, Math.min(limit, 50)))
      .map(parseTool);
    const total = Number(
      this.db
        .prepare(`SELECT count(*) AS n FROM tool_calls t JOIN messages m ON m.id = t.message_id
        WHERE m.run_id = ? AND t.tool = ?`)
        .get(runId, tool)?.n ?? 0,
    );
    return { calls, total };
  }

  getLogPath(runId: string, toolCallId?: string): string | undefined {
    // A run may hold one log per command. The step's tool call selects its own; without it only a
    // unique run log is safe to use — conflicting persisted paths must not choose an arbitrary file.
    const paths = this.db
      .prepare(`SELECT DISTINCT t.log_path FROM tool_calls t JOIN messages m ON m.id = t.message_id
      WHERE m.run_id = ?${toolCallId ? " AND t.tool_call_id = ?" : ""} AND t.log_path IS NOT NULL LIMIT 2`)
      .all(...(toolCallId ? [runId, toolCallId] : [runId]));
    if (paths.length > 1) throw new TypeError("Conflicting run log paths");
    return paths[0] ? String(paths[0].log_path) : undefined;
  }

  runBot(runId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT m.bot_id AS botId FROM messages m
      WHERE m.run_id = ? AND m.bot_id IS NOT NULL AND m.role<>'user' LIMIT 1`)
      .get(runId);
    return row ? String(row.botId) : undefined;
  }

  recover(): void {
    transaction(this.db, () => {
      const rows = this.db
        .prepare(`SELECT t.id,t.message_id AS messageId,t.tool,t.tool_call_id AS toolCallId,
          t.duration_ms AS durationMs FROM tool_calls t
        WHERE t.status IN ('pending','running') AND NOT EXISTS(SELECT 1 FROM parked_unattended_runs p JOIN runs e ON e.id=p.run_id WHERE e.message_id=t.message_id)`)
        .all();
      const at = new Date().toISOString();
      this.db
        .prepare(`UPDATE tool_calls SET status = 'aborted', finished_at = ?
        WHERE status IN ('pending', 'running') AND NOT EXISTS(SELECT 1 FROM parked_unattended_runs p JOIN runs e ON e.id=p.run_id WHERE e.message_id=tool_calls.message_id)`)
        .run(at);
      const events = new RunEventsRepo(this.db);
      for (const row of rows) {
        const scope = this.scope(String(row.messageId));
        if (scope)
          events.append({
            ...scope,
            kind: "tool.result",
            at,
            // No monotonic clock survives a crash; offline time is not tool execution time.
            payload: {
              toolCallRecordId: String(row.id),
              toolCallId: String(row.toolCallId),
              tool: String(row.tool),
              durationMs: row.durationMs,
              timingUnavailable: "restart",
              status: "aborted",
            },
          });
      }
    });
  }

  private scope(messageId: string): { runId: string; conversationId: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT run_id AS runId,conversation_id AS conversationId FROM messages WHERE id=? AND run_id IS NOT NULL",
      )
      .get(messageId);
    return row
      ? { runId: String(row.runId), conversationId: String(row.conversationId) }
      : undefined;
  }
}
