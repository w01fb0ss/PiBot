import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ChatDependencyNotice,
  ChatDependencyNoticeSchema,
  type ChatNotice,
  ChatNoticeSchema,
  IdSchema,
  type Page,
} from "@pibot/protocol-base";
import { readPage } from "../database/paging.ts";

const columns =
  "id,conversation_id AS conversationId,bot_id AS botId,kind,detail,created_at AS createdAt";

function parse(row: Record<string, unknown>): ChatNotice {
  const { detail, ...fields } = row;
  // Brain-only facts (a proposal's folder) stay in storage; the record itself is what is shown.
  const {
    folderKey: _key,
    folderPath: _path,
    sandboxKind: _sandboxKind,
    sandboxRule: _sandboxRule,
    ...shown
  } = JSON.parse(String(detail)) as Record<string, unknown>;
  return ChatNoticeSchema.parse({ ...fields, ...shown });
}
type AutoCheckNotice = Extract<ChatNotice, { kind: "auto_check" }>;
type ProposalNotice = Extract<ChatNotice, { kind: "auto_check_proposal" }>;
type HandoffNotice = Extract<ChatNotice, { kind: "computer_handoff" }>;
type MoveNotice = Extract<ChatNotice, { kind: "workplace_move_proposal" }>;
type StoppedNotice = Extract<ChatNotice, { kind: "continuation_stopped" }>;
type AttachmentDeliveryNotice = Extract<ChatNotice, { kind: "attachment_delivery_missing" }>;
type BrowserExtensionNotice = Extract<ChatNotice, { kind: "browser_extension" }>;
type AgentWarningNotice = Extract<ChatNotice, { kind: "agent_warning" }>;
const own = ["id", "conversationId", "botId", "kind", "createdAt"] as const;
function detailOf(notice: ChatNotice) {
  const detail: Record<string, unknown> = { ...notice };
  for (const key of own) delete detail[key];
  return detail;
}

/** Chat system records (centered lines); never part of `messages` or any model context. */
export class ChatNoticesRepo {
  constructor(private readonly db: DatabaseSync) {}

  addGroupVerification(
    input: Omit<Extract<ChatNotice, { kind: "group_verification" }>, "id" | "kind" | "createdAt">,
  ) {
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "group_verification",
      createdAt: new Date().toISOString(),
    });
    this.insert(notice, detailOf(notice));
    return notice;
  }

  addDispatchModelSwitch(
    input: Omit<
      Extract<ChatNotice, { kind: "dispatch_model_switch" }>,
      "id" | "kind" | "createdAt"
    >,
  ) {
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "dispatch_model_switch",
      createdAt: new Date().toISOString(),
    });
    this.insert(notice, detailOf(notice));
    return notice;
  }

  addConnectionNeeded(
    input: Omit<Extract<ChatNotice, { kind: "connection_needed" }>, "id" | "kind" | "createdAt">,
  ) {
    const existing = this.db
      .prepare(
        "SELECT id FROM chat_notices WHERE kind='connection_needed' AND json_extract(detail,'$.runId')=? AND json_extract(detail,'$.availability.connection')=? LIMIT 1",
      )
      .get(input.runId, input.availability.connection);
    if (existing) return undefined;
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "connection_needed",
      createdAt: new Date().toISOString(),
    });
    this.insert(notice, detailOf(notice));
    return notice;
  }

  addBrowserHandBack(input: {
    conversationId: string;
    botId: string;
    durationMs: number;
    domains: string[];
    signedIn?: string[];
  }): ChatNotice {
    const notice = ChatNoticeSchema.parse({
      id: randomUUID(),
      conversationId: input.conversationId,
      botId: input.botId,
      kind: "browser_handback",
      durationMs: Math.round(input.durationMs),
      domains: input.domains,
      ...(input.signedIn?.length ? { signedIn: input.signedIn } : {}),
      createdAt: new Date().toISOString(),
    });
    // detail is JSON, so optional fields need no migration; older rows parse unchanged.
    this.insert(notice, detailOf(notice));
    return notice;
  }

  /** The topic's automatic follow-ups stopped; reason code and rounds spent only. */
  addContinuationStopped(input: Omit<StoppedNotice, "id" | "kind" | "createdAt">): StoppedNotice {
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "continuation_stopped",
      createdAt: new Date().toISOString(),
    }) as StoppedNotice;
    this.insert(notice, detailOf(notice));
    return notice;
  }

  addAttachmentDeliveryMissing(
    input: Omit<AttachmentDeliveryNotice, "id" | "kind" | "createdAt">,
  ): AttachmentDeliveryNotice {
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "attachment_delivery_missing",
      createdAt: new Date().toISOString(),
    }) as AttachmentDeliveryNotice;
    this.insert(notice, detailOf(notice));
    return notice;
  }

  addBrowserExtension(input: Omit<BrowserExtensionNotice, "id" | "kind" | "createdAt">) {
    const existing = this.db
      .prepare(
        "SELECT id FROM chat_notices WHERE kind='browser_extension' AND conversation_id=? LIMIT 1",
      )
      .get(input.conversationId);
    if (existing) return undefined;
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "browser_extension",
      createdAt: new Date().toISOString(),
    }) as BrowserExtensionNotice;
    this.insert(notice, detailOf(notice));
    return notice;
  }

  /**
   * An external agent's startup warning; undefined when this conversation already has the
   * same text (the agent prints it on every turn).
   */
  addAgentWarning(
    input: Omit<AgentWarningNotice, "id" | "kind" | "createdAt">,
  ): AgentWarningNotice | undefined {
    const existing = this.db
      .prepare(
        "SELECT id FROM chat_notices WHERE kind='agent_warning' AND conversation_id=? AND json_extract(detail,'$.text')=? LIMIT 1",
      )
      .get(input.conversationId, input.text);
    if (existing) return undefined;
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "agent_warning",
      createdAt: new Date().toISOString(),
    }) as AgentWarningNotice;
    this.insert(notice, detailOf(notice));
    return notice;
  }

  /** External-agent sandbox diagnostics: one quiet line per run, kind and rule. */
  addSandboxAgentWarning(input: {
    conversationId: string;
    botId: string;
    runId: string;
    agent?: string;
    text: string;
    sandbox: {
      kind: NonNullable<AgentWarningNotice["sandbox"]>["kind"];
      rule: string;
      target: string;
    };
  }): AgentWarningNotice | undefined {
    const existing = this.db
      .prepare(
        "SELECT id FROM chat_notices WHERE kind='agent_warning' AND conversation_id=? AND json_extract(detail,'$.runId')=? AND json_extract(detail,'$.sandboxKind')=? AND json_extract(detail,'$.sandboxRule')=? LIMIT 1",
      )
      .get(input.conversationId, input.runId, input.sandbox.kind, input.sandbox.rule);
    if (existing) return undefined;
    const notice = ChatNoticeSchema.parse({
      conversationId: input.conversationId,
      botId: input.botId,
      runId: input.runId,
      ...(input.agent ? { agent: input.agent } : {}),
      text: input.text,
      sandbox: input.sandbox,
      id: randomUUID(),
      kind: "agent_warning",
      createdAt: new Date().toISOString(),
    }) as AgentWarningNotice;
    this.insert(notice, detailOf(notice));
    return notice;
  }

  /** A command warning is once per run/category/rule, independent of target text or retries. */
  addSandboxBlock(
    input: Omit<AgentWarningNotice, "id" | "kind" | "createdAt"> & {
      sandbox: NonNullable<AgentWarningNotice["sandbox"]>;
    },
  ): AgentWarningNotice | undefined {
    const existing = this.db
      .prepare(
        "SELECT id FROM chat_notices WHERE kind='agent_warning' AND conversation_id=? AND json_extract(detail,'$.runId')=? AND json_extract(detail,'$.sandbox.kind')=? AND json_extract(detail,'$.sandbox.rule')=? AND COALESCE(json_extract(detail,'$.sandbox.website.domain'),'')=? LIMIT 1",
      )
      .get(
        input.conversationId,
        input.runId,
        input.sandbox.kind,
        input.sandbox.rule,
        input.sandbox.website?.domain ?? "",
      );
    if (existing) return undefined;
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "agent_warning",
      createdAt: new Date().toISOString(),
    }) as AgentWarningNotice;
    this.insert(notice, detailOf(notice));
    return notice;
  }

  /** The caller already matched the exact command/cwd in this run; this adds navigation only. */
  linkSandboxApproval(
    id: string,
    runId: string,
    conversationId: string,
    approvalId: string,
    approvalToolCallId: string,
  ): AgentWarningNotice | undefined {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM chat_notices WHERE id=? AND conversation_id=? AND kind='agent_warning' AND json_extract(detail,'$.runId')=?`,
      )
      .get(id, conversationId, runId);
    if (!row) return undefined;
    const notice = parse(row) as AgentWarningNotice;
    if (!notice.sandbox) return undefined;
    const updated = ChatNoticeSchema.parse({
      ...notice,
      sandbox: { ...notice.sandbox, approvalId, approvalToolCallId },
    }) as AgentWarningNotice;
    this.db
      .prepare("UPDATE chat_notices SET detail=? WHERE id=?")
      .run(JSON.stringify(detailOf(updated)), id);
    return updated;
  }

  /** A check that starts now ("running"); `updateAutoCheck` records how it ended. */
  addAutoCheck(input: Omit<AutoCheckNotice, "id" | "kind" | "createdAt">): AutoCheckNotice {
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "auto_check",
      createdAt: new Date().toISOString(),
    }) as AutoCheckNotice;
    this.insert(notice, detailOf(notice));
    return notice;
  }

  updateAutoCheck(
    id: string,
    change: Partial<
      Omit<AutoCheckNotice, "id" | "kind" | "createdAt" | "conversationId" | "botId" | "runId">
    >,
  ): AutoCheckNotice | undefined {
    const current = this.get(id);
    if (current?.kind !== "auto_check") return undefined;
    const next = ChatNoticeSchema.parse({ ...current, ...change }) as AutoCheckNotice;
    this.db
      .prepare("UPDATE chat_notices SET detail = ? WHERE id = ?")
      .run(JSON.stringify(detailOf(next)), next.id);
    return next;
  }

  /** A proposal card; the folder it was made for is kept for brain only. */
  addProposal(
    input: Omit<ProposalNotice, "id" | "kind" | "createdAt" | "status">,
    folder: { key: string; path: string },
  ): ProposalNotice {
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "auto_check_proposal",
      status: "pending",
      createdAt: new Date().toISOString(),
    }) as ProposalNotice;
    this.insert(notice, { ...detailOf(notice), folderKey: folder.key, folderPath: folder.path });
    return notice;
  }

  /** The pending proposal and the folder it was made for; undefined once answered. */
  pendingProposal(id: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM chat_notices WHERE id = ? AND kind = 'auto_check_proposal'`)
      .get(IdSchema.parse(id));
    if (!row) return undefined;
    const notice = parse(row) as ProposalNotice;
    if (notice.status !== "pending") return undefined;
    const detail = JSON.parse(String(row.detail)) as { folderKey?: unknown; folderPath?: unknown };
    if (typeof detail.folderKey !== "string" || typeof detail.folderPath !== "string")
      return undefined;
    return { notice, folder: { key: detail.folderKey, path: detail.folderPath } };
  }

  /** Answers a pending proposal once; undefined when it was already answered meanwhile. */
  resolveProposal(
    id: string,
    status: "accepted" | "declined",
    commands: readonly string[],
  ): ProposalNotice | undefined {
    const pending = this.pendingProposal(id);
    if (!pending) return undefined;
    const next = ChatNoticeSchema.parse({ ...pending.notice, status, commands }) as ProposalNotice;
    this.db.prepare("UPDATE chat_notices SET detail = ? WHERE id = ?").run(
      JSON.stringify({
        ...detailOf(next),
        folderKey: pending.folder.key,
        folderPath: pending.folder.path,
      }),
      id,
    );
    return next;
  }

  /** A Bot's "move this topic to a runner folder" card; nothing changes until answered. */
  addMoveProposal(input: Omit<MoveNotice, "id" | "kind" | "createdAt" | "status">): MoveNotice {
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "workplace_move_proposal",
      status: "pending",
      createdAt: new Date().toISOString(),
    }) as MoveNotice;
    this.insert(notice, detailOf(notice));
    return notice;
  }

  /** Answers a pending move card once; undefined when it is unknown or already answered. */
  resolveMoveProposal(id: string, status: "accepted" | "declined"): MoveNotice | undefined {
    const current = this.get(IdSchema.parse(id));
    if (current?.kind !== "workplace_move_proposal" || current.status !== "pending")
      return undefined;
    const next = ChatNoticeSchema.parse({ ...current, status }) as MoveNotice;
    this.db
      .prepare("UPDATE chat_notices SET detail = ? WHERE id = ?")
      .run(JSON.stringify(detailOf(next)), id);
    return next;
  }

  /** An open "come help for a moment" card. */
  addHandoff(
    input: Omit<HandoffNotice, "id" | "kind" | "createdAt" | "status" | "resolvedAt">,
  ): HandoffNotice {
    const notice = ChatNoticeSchema.parse({
      ...input,
      id: randomUUID(),
      kind: "computer_handoff",
      status: "pending",
      createdAt: new Date().toISOString(),
    }) as HandoffNotice;
    this.insert(notice, detailOf(notice));
    return notice;
  }

  /** Closes a pending card once; undefined when it was already closed. */
  closeHandoff(
    id: string,
    status: Exclude<HandoffNotice["status"], "pending">,
  ): HandoffNotice | undefined {
    const current = this.get(id);
    if (current?.kind !== "computer_handoff" || current.status !== "pending") return undefined;
    const next = ChatNoticeSchema.parse({
      ...current,
      status,
      resolvedAt: new Date().toISOString(),
    }) as HandoffNotice;
    this.db
      .prepare("UPDATE chat_notices SET detail = ? WHERE id = ?")
      .run(JSON.stringify(detailOf(next)), next.id);
    return next;
  }

  /**
   * Cards left open by a brain that stopped: their runs are gone, so they read as cancelled
   * (bounded batches; called once at start).
   */
  cancelOpenHandoffs(): HandoffNotice[] {
    const closed: HandoffNotice[] = [];
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT ${columns} FROM chat_notices WHERE kind = 'computer_handoff' AND json_extract(detail, '$.status') = 'pending' LIMIT 200`,
        )
        .all();
      const before = closed.length;
      for (const row of rows) {
        const next = this.closeHandoff(String(row.id), "cancelled");
        if (next) closed.push(next);
      }
      // Rows that cannot be closed would be selected again forever.
      if (rows.length < 200 || closed.length === before) break;
    }
    return closed;
  }
  get(id: string): ChatNotice | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM chat_notices WHERE id = ?`)
      .get(IdSchema.parse(id));
    return row ? parse(row) : undefined;
  }

  private insert(notice: ChatNotice, detail: Record<string, unknown>) {
    this.db
      .prepare(
        "INSERT INTO chat_notices(id,conversation_id,bot_id,kind,detail,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        notice.id,
        notice.conversationId,
        notice.botId,
        notice.kind,
        JSON.stringify(detail),
        notice.createdAt,
      );
  }

  listDependencies(conversationId: string, page: Page): ChatDependencyNotice[] {
    return readPage(
      this.db,
      "chat_notices",
      "id,conversation_id AS conversationId,created_at AS createdAt,json_extract(detail,'$.runId') AS runId,json_extract(detail,'$.dependency') AS dependency",
      "created_at",
      page,
      [
        ["conversation_id", IdSchema.parse(conversationId)],
        ["kind", "agent_warning"],
        ["json_type(detail,'$.dependency')", "text"],
      ],
    ).map((row) => ChatDependencyNoticeSchema.parse(row));
  }

  /** Newest first; `before` is a notice id of this conversation. */
  list(conversationId: string, page: Page = {}): ChatNotice[] {
    const scope: [string, string][] = [["conversation_id", IdSchema.parse(conversationId)]];
    return readPage(this.db, "chat_notices", columns, "created_at", page, scope).map(parse);
  }
}
