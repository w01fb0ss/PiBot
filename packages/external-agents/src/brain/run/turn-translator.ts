// ACP `session/update` → Pi Bot's chat: text streams into replies (words after steps start
// a new message), tool calls become steps with the icon of the Pi Bot tool they resemble, the
// agent's plan is kept for the reply's card. Agent text is untrusted: redacted, capped, never HTML.
import { randomUUID } from "node:crypto";
import type { RequestPermissionParams, SessionUpdate, ToolKind } from "@pibot/acp-schemas";
import {
  auditText,
  type ChatReplies,
  type LocalService,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { ChatNoticesRepo } from "@pibot/storage";
import { z } from "zod";
import { maskAccount } from "../privacy/account-mask.ts";

/** Steps one turn records; an agent looping on tiny calls cannot flood the database. */
const MAX_STEPS = 500;

const STEP_TOOL: Record<ToolKind, string> = {
  execute: "run_command",
  edit: "write_file",
  delete: "write_file",
  move: "write_file",
  read: "read_file",
  search: "search_text",
  fetch: "web_fetch",
  think: "agent_step",
  switch_mode: "agent_step",
  other: "agent_step",
};

type FinishedStatus = "done" | "error" | "aborted" | "blocked";

interface Step {
  recordId: string;
  toolCallId: string;
  tool: string;
  messageId: string;
  summary: string;
  started: number;
  finished: false | FinishedStatus;
  exitCode?: number;
}

/** What one step showed beyond its title (kept for the receipt; redacted, capped). */
export interface StepDetail {
  toolCallId: string;
  kind: ToolKind;
  /** The command or path the step ran on (rawInput), redacted and capped. */
  input?: string;
  locations?: string[];
  output?: string;
}

/** Steps whose locations / output are kept; output per step is capped. */
const MAX_DETAILS = 100;
const OUTPUT_CHARS = 600;
const THOUGHT_CHARS = 4000;

const ContentSchema = z.array(
  z.union([
    z.object({
      type: z.literal("content"),
      content: z.object({ type: z.literal("text"), text: z.string() }),
    }),
    z.object({ type: z.literal("diff"), path: z.string().max(4096) }),
    z.object({ type: z.string() }),
  ]),
);

/** A step's command or target from the agent's rawInput (Claude, Codex, OpenCode shapes). */
function commandInput(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const command = value.command ?? value.cmd;
  if (typeof command === "string" && command.trim()) return command.trim().slice(0, 1000);
  if (Array.isArray(command) && command.every((part) => typeof part === "string"))
    return (command as string[]).join(" ").slice(0, 1000);
  for (const key of ["file_path", "filePath", "path", "pattern", "url", "description"])
    if (typeof value[key] === "string" && (value[key] as string).trim())
      return (value[key] as string).trim().slice(0, 1000);
  return undefined;
}

/**
 * A step's output for the receipt: redacted, account-masked, line breaks kept (other control
 * characters dropped), the last lines up to the character cap.
 */
function outputText(text: string, redactor: Pick<LocalService["deps"]["redactor"], "redact">) {
  const lines = redactor
    .redact(maskAccount(text))
    .replace(/\r\n?/g, "\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: step output is shown as text, so terminal control characters are stripped.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines.reverse()) {
    if (size + line.length + 1 > OUTPUT_CHARS || kept.length >= 40) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  return kept.join("\n").trim();
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export class TurnTranslator {
  private readonly steps = new Map<string, Step>();
  private permissionRefusalFallback = false;
  private stepsSinceText = false;
  /**
   * The start of the turn's text while it may still be the agent's own startup warning (Codex
   * prints "Warning: Under-development features enabled …" from the user's ~/.codex/config.toml
   * at the top of its reply; maintainers 2026-11-15). Undefined once decided.
   */
  private lead: string | undefined = "";
  plan: PlanEntry[] = [];
  counts = { steps: 0, commands: 0, edits: 0 };
  /** What this agent actually reported during the turn, for the receipt's "not reported" marks. */
  reported = { plan: false, thoughts: false, toolOutput: false, locations: false };
  details: StepDetail[] = [];
  thoughts = "";
  /** The agent's own usage_update: context use and the session's cost so far (not this turn's). */
  contextUse?: { used?: number; size?: number };
  sessionCost?: { amount: number; currency: string };

  constructor(
    private readonly local: LocalService,
    private readonly context: ToolRunContext,
    private readonly replies: ChatReplies,
    /** The agent program's display name ("Codex"), for its startup warnings' label. */
    private readonly agentName?: string,
  ) {}

  /**
   * A step Pi Bot records itself (a bridge call): the agent's words after it still start a new
   * reply, as after any other step.
   */
  markStep() {
    this.stepsSinceText = true;
  }

  permissionRefused(call: RequestPermissionParams["toolCall"], reason: string) {
    const { toolCallId, title, rawInput } = call;
    const kind = call.kind ?? "other";
    this.startStep(toolCallId, kind, title ?? "", rawInput);
    const step = this.steps.get(toolCallId);
    if (step && !step.finished) {
      this.finishStep(toolCallId, "blocked", reason);
      return;
    }
    if (step?.finished === "blocked" || this.permissionRefusalFallback) return;
    // Keep one extra refusal row for calls past the limit or steps that have already ended.
    this.permissionRefusalFallback = true;
    const fallbackId = randomUUID();
    this.startStep(fallbackId, kind, title ?? "", rawInput);
    this.finishStep(fallbackId, "blocked", reason);
  }

  update(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const raw = update.content.type === "text" ? (update.content as { text: string }).text : "";
        const text = this.afterWarnings(raw);
        if (!text) return;
        // The agent's words after its steps are a new reply, like a model's next turn.
        if (this.stepsSinceText) {
          this.replies.event({ type: "replyStart" });
          this.stepsSinceText = false;
        }
        this.replies.event({ type: "delta", text });
        return;
      }
      case "agent_thought_chunk": {
        this.replies.event({ type: "activity", activity: { phase: "waiting_model" } });
        const text =
          update.content.type === "text" ? (update.content as { text: string }).text : "";
        if (text) {
          this.reported.thoughts = true;
          // Kept bounded; the tail is what led to the next step.
          this.thoughts = (this.thoughts + text).slice(-THOUGHT_CHARS * 2);
        }
        return;
      }
      case "tool_call":
        this.startStep(
          update.toolCallId,
          update.kind ?? "other",
          update.title ?? "",
          update.rawInput,
        );
        this.detail(update.toolCallId, update);
        if (update.status === "completed" || update.status === "failed")
          this.endStep(update.toolCallId, update.status);
        return;
      case "tool_call_update": {
        const step = this.steps.get(update.toolCallId);
        const better = update.title?.trim() ? update.title : commandInput(update.rawInput);
        if (!step) {
          this.startStep(
            update.toolCallId,
            update.kind ?? "other",
            update.title ?? "",
            update.rawInput,
          );
        } else if (better && (update.title?.trim() || step.summary === "…")) {
          step.summary = this.summary(better);
          this.local.tools.update(step.recordId, { summary: step.summary });
        }
        this.detail(update.toolCallId, update);
        if (update.status === "completed" || update.status === "failed")
          this.endStep(update.toolCallId, update.status);
        return;
      }
      case "usage_update":
        this.contextUse = {
          ...(update.used !== undefined ? { used: update.used } : {}),
          ...(update.size !== undefined ? { size: update.size } : {}),
        };
        if (update.cost)
          this.sessionCost = { amount: update.cost.amount, currency: update.cost.currency };
        return;
      case "plan":
        this.reported.plan = true;
        this.plan = update.entries.slice(0, 50).map((entry) => ({
          content: auditText(maskAccount(entry.content), this.local.deps.redactor, 300),
          status: entry.status,
        }));
        return;
      default:
        return;
    }
  }

  /** Pi Bot tool names the agent's steps resemble (a group step's completion reads them). */
  toolNames() {
    return [...new Set([...this.steps.values()].map((step) => step.tool))];
  }

  /** The receipt's view of the agent's thoughts: redacted and capped, or nothing. */
  thoughtText() {
    return this.thoughts
      ? auditText(
          maskAccount(this.thoughts.slice(-THOUGHT_CHARS)),
          this.local.deps.redactor,
          THOUGHT_CHARS,
        )
      : undefined;
  }

  /** Locations and output an agent attaches to a step (ACP content / rawOutput). */
  private detail(id: string, update: Record<string, unknown> & { kind?: ToolKind | null }) {
    const step = this.steps.get(id);
    if (!step) return;
    let detail = this.details.find((item) => item.toolCallId === step.toolCallId);
    const locations = Array.isArray(update.locations)
      ? update.locations
          .map((item) =>
            item && typeof item === "object" ? (item as { path?: unknown }).path : "",
          )
          .filter((path): path is string => typeof path === "string" && !!path)
          .slice(0, 10)
          .map((path) => auditText(maskAccount(path), this.local.deps.redactor, 300))
      : [];
    const fromContent: string[] = [];
    const content = ContentSchema.safeParse(update.content);
    if (content.success)
      for (const item of content.data) {
        if (item.type === "content" && "content" in item) fromContent.push(item.content.text);
        else if (item.type === "diff" && "path" in item) fromContent.push(`(diff) ${item.path}`);
      }
    const fromRaw: string[] = [];
    const raw = update.rawOutput;
    // Codex reports only the command's exit code; it goes on the step like a Pi Bot command's.
    const exit =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>).exit_code : undefined;
    if (typeof exit === "number" && Number.isSafeInteger(exit)) {
      step.exitCode = exit;
      this.local.tools.update(step.recordId, { exitCode: exit });
    }
    if (typeof raw === "string") fromRaw.push(raw);
    else if (raw && typeof raw === "object") {
      const value = raw as Record<string, unknown>;
      for (const key of ["output", "stdout", "formatted_output", "aggregated_output", "stderr"])
        if (typeof value[key] === "string") fromRaw.push(value[key] as string);
    }
    // OpenCode sends the same text as content and as rawOutput.output: the raw output wins, and
    // content is added only when it says something else (e.g. which file a diff touched).
    const rawText = fromRaw.join("\n").trim();
    const extra = fromContent.filter((text) => text.trim() && !rawText.includes(text.trim()));
    const output = [rawText, ...extra].filter(Boolean).join("\n").trim();
    const input = commandInput(update.rawInput);
    if (input && !detail?.input) {
      detail ??= this.newDetail(step, update.kind);
      if (detail) detail.input = auditText(maskAccount(input), this.local.deps.redactor, 300);
    }
    if (!locations.length && !output) return;
    detail ??= this.newDetail(step, update.kind);
    if (!detail) return;
    if (locations.length) {
      this.reported.locations = true;
      detail.locations = locations;
    }
    if (output) {
      this.reported.toolOutput = true;
      detail.output = outputText(output, this.local.deps.redactor);
      // Live: the step shows what the agent saw, like a Pi Bot command's output.
      if (!this.context.executionTaskId)
        this.local.deps.peer.emit("chat.tool", {
          botId: this.context.botId,
          ...(this.context.conversationId ? { conversationId: this.context.conversationId } : {}),
          runId: this.context.runId,
          messageId: step.messageId,
          toolCallId: step.toolCallId,
          tool: step.tool,
          phase: "output",
          summary: step.summary,
          output: detail.output,
        });
    }
  }

  private newDetail(step: Step, kind?: ToolKind | null) {
    if (this.details.length >= MAX_DETAILS) return undefined;
    const detail: StepDetail = { toolCallId: step.toolCallId, kind: kind ?? "other" };
    this.details.push(detail);
    return detail;
  }

  /**
   * Leading "Warning: …" lines of the agent's own startup become a chat notice, so the reply
   * starts with the answer. Anything else passes through unchanged.
   */
  private afterWarnings(text: string): string {
    if (this.lead === undefined) return text;
    this.lead += text;
    for (;;) {
      const lead: string = this.lead ?? "";
      const match = /^\s*Warning: ([^\n]+)\n+/.exec(lead);
      if (match?.[1]) {
        this.warningNotice(match[1]);
        this.lead = lead.slice(match[0].length);
        continue;
      }
      // Still possibly a warning line in progress: wait for more (bounded).
      if ("Warning: ".startsWith(lead.trimStart().slice(0, 9)) && lead.length < 2000) {
        if (/^\s*Warning: [^\n]*$/.test(lead) || lead.trimStart().length < 9) return "";
      }
      this.lead = undefined;
      return lead;
    }
  }

  /**
   * A grey line in the chat instead of a step: it is about the agent's setup, not this turn's
   * work. The agent prints it every turn, so the repo keeps one per conversation and text.
   */
  private warningNotice(line: string) {
    const { conversationId, executionTaskId } = this.context;
    if (!conversationId || executionTaskId) return;
    const text = auditText(maskAccount(line), this.local.deps.redactor, 300);
    if (!text) return;
    const { db, peer, logger } = this.local.deps;
    try {
      const notice = new ChatNoticesRepo(db).addAgentWarning({
        conversationId,
        botId: this.context.botId,
        runId: this.context.runId,
        ...(this.agentName ? { agent: this.agentName.slice(0, 60) } : {}),
        text,
      });
      if (notice) peer.emit("chat.notice", notice);
    } catch {
      // Informational only; the reply already lost the line on purpose. A topic deleted while
      // the agent starts is the expected way to get here.
      logger.warn(
        JSON.stringify({
          module: "external-agent",
          event: "warning_notice_failed",
          botId: this.context.botId,
          runId: this.context.runId,
        }),
      );
    }
  }

  /** Steps still open when the turn ends (stop, error, agent exit). */
  finishOpen(status: "done" | "error" | "aborted") {
    // A reply that ended inside a would-be warning line still reaches the chat.
    if (this.lead) {
      const rest = this.lead;
      this.lead = undefined;
      this.replies.event({ type: "delta", text: rest });
    }
    this.replies.event({ type: "replyEnd" });
    for (const [id, step] of this.steps)
      if (!step.finished)
        this.endStep(
          id,
          status === "done" ? "completed" : "failed",
          status === "done" ? undefined : status,
        );
  }

  private summary(title: string) {
    return auditText(maskAccount(title), this.local.deps.redactor, 500) || "…";
  }

  private emit(step: Step, phase: "start" | "end", extra: Record<string, unknown> = {}) {
    if (this.context.executionTaskId) return;
    this.local.deps.peer.emit("chat.tool", {
      botId: this.context.botId,
      ...(this.context.conversationId ? { conversationId: this.context.conversationId } : {}),
      runId: this.context.runId,
      messageId: step.messageId,
      toolCallId: step.toolCallId,
      tool: step.tool,
      phase,
      summary: step.summary,
      ...extra,
    });
  }

  private startStep(id: string, kind: ToolKind, title: string, rawInput?: unknown) {
    const limit = MAX_STEPS + (this.permissionRefusalFallback ? 1 : 0);
    if (this.steps.has(id) || this.steps.size >= limit) return;
    const tool = STEP_TOOL[kind];
    // The step belongs to the reply that is current when it starts (the words above it).
    this.replies.event({
      type: "activity",
      activity: { phase: "preparing_tool", tool, characters: 0 },
    });
    // OpenCode opens a step with an empty title; its command or path stands in.
    const summary = this.summary(title.trim() ? title : (commandInput(rawInput) ?? ""));
    const toolCallId = `acp-${id}`.slice(0, 200);
    const record = this.local.tools.create({
      messageId: this.context.messageId,
      toolCallId,
      tool,
      summary,
      status: "running",
    });
    const step: Step = {
      recordId: record.id,
      toolCallId,
      tool,
      messageId: this.context.messageId,
      summary,
      started: Date.now(),
      finished: false,
    };
    this.steps.set(id, step);
    this.stepsSinceText = true;
    this.counts.steps++;
    if (tool === "run_command") this.counts.commands++;
    if (tool === "write_file") this.counts.edits++;
    this.emit(step, "start", { status: "running" });
  }

  private endStep(id: string, outcome: "completed" | "failed", stopped?: "error" | "aborted") {
    this.finishStep(
      id,
      stopped === "aborted" ? "aborted" : outcome === "completed" ? "done" : "error",
    );
  }

  private finishStep(id: string, status: FinishedStatus, reason?: string) {
    const step = this.steps.get(id);
    if (!step || step.finished) return;
    step.finished = status;
    const durationMs = Date.now() - step.started;
    const refusal = reason ? { denialReason: reason } : {};
    this.local.tools.update(step.recordId, {
      status,
      finishedAt: new Date().toISOString(),
      durationMs,
      ...refusal,
    });
    this.emit(step, "end", {
      status,
      durationMs,
      ...refusal,
      ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
    });
    this.replies.event({ type: "activity", activity: { phase: "waiting_model" } });
  }
}
