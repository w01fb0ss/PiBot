// One turn of an external-agent Bot. The run queue owns admission, the topic slot
// and stop; this owns the agent process, the ACP prompt and its translation into Pi Bot's chat,
// steps, approval cards, the turn's file changes and the receipt facts. Modelled on the image
// run: the same terminal bookkeeping, the same events, nothing of the pi model loop.
import { promptResult } from "@pibot/acp-schemas";
import { AgentError, type BotSession } from "@pibot/agent";
import {
  auditText,
  ChatReplies,
  type ChatRun,
  type ExternalAgentRunHost,
  type LocalService,
  resolveRunWorkplace,
  runPermissions,
  selectedSkillName,
  type ToolRunContext,
  topicWorkplaceSnapshot,
  withWorkplaceErrors,
} from "@pibot/brain/kit";
import type { SandboxBlockItem } from "@pibot/execution";
import type { AgentErrorCode } from "@pibot/external-agents-contract/full";
import { agentDescriptor, type Bot, MessageSchema } from "@pibot/external-agents-contract/full";
import { agentLaunchPolicy, EXTERNAL_AGENT_EXPLICIT_ALWAYS_REQUIRED } from "@pibot/policy";
import { ChatNoticesRepo, RunsRepo, SettingsRepo, transaction } from "@pibot/storage";
import { z } from "zod";
import { AcpClosedError, AcpRemoteError } from "../acp/acp-connection.ts";
import { AgentStartError } from "../acp/agent-sessions.ts";
import { maskAccount } from "../privacy/account-mask.ts";
import type { ExternalAgentsService } from "../service.ts";
import { agentFileChanges } from "./agent-file-changes.ts";
import { attachCreatedFiles } from "./agent-outputs.ts";
import { runAgentReview } from "./agent-review.ts";
import { answerPermission, PIBOT_BRIDGE_GATED, TurnPermissionCalls } from "./permission-bridge.ts";
import { TurnTranslator } from "./turn-translator.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/**
 * Token counts exactly as the agent reports them on the prompt answer (ACP `usage`: Codex and
 * Claude send it; others may not). Only the fields it sent; nothing estimated.
 */
const TokensSchema = z.object({
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  cachedReadTokens: count.optional(),
  cachedWriteTokens: count.optional(),
  thoughtTokens: count.optional(),
  totalTokens: count.optional(),
});
function agentTokens(outcome: unknown) {
  const parsed = TokensSchema.safeParse((outcome as { usage?: unknown } | null)?.usage);
  if (!parsed.success) return undefined;
  const value = Object.fromEntries(
    Object.entries(parsed.data).filter(([, amount]) => amount !== undefined),
  );
  return Object.keys(value).length ? value : undefined;
}
function sumTokens(parts: ReturnType<typeof agentTokens>[]) {
  const known = parts.filter((part) => part !== undefined);
  if (known.length < 2) return known[0];
  const total: Record<string, number> = {};
  for (const part of known)
    for (const [name, amount] of Object.entries(part))
      if (typeof amount === "number") total[name] = (total[name] ?? 0) + amount;
  return total;
}
function sumCost(parts: ReturnType<typeof agentCost>[]) {
  const known = parts.filter((part) => part !== undefined);
  const first = known[0];
  // Different currencies cannot be added; the first prompt's own report stays.
  if (!first || known.some((part) => part.currency !== first.currency)) return first;
  return { amount: known.reduce((sum, part) => sum + part.amount, 0), currency: first.currency };
}
/** A cost the agent itself reports (ACP `usage.cost` or `_meta.cost`), never computed by Pi Bot. */
const CostSchema = z.object({
  amount: z.number().nonnegative().max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
function agentCost(outcome: unknown) {
  const value = outcome as { usage?: { cost?: unknown }; _meta?: { cost?: unknown } } | null;
  const parsed = CostSchema.safeParse(value?.usage?.cost ?? value?._meta?.cost);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A group step's prompt: the step's own instructions (with its inputs, as the coordinator wrote
 * them) and how to finish, since the agent has no Pi Bot tools to report back with.
 */
function stepPrompt(instructions: string, language: "zh" | "en") {
  return language === "zh"
    ? `这是 Pi Bot 群聊计划里交给你的一步。在当前文件夹里完成它；做完后用一段话说明结果和改了哪些文件，这段话会交回给统筹。\n\n${instructions}`
    : `This is a step of a Pi Bot group plan assigned to you. Do it in the current folder; when you are done, reply with the result and the files you changed. That reply goes back to the coordinator.\n\n${instructions}`;
}

/**
 * A routine's turn: Pi Bot's own records for this run (the period's folder and earlier attempts,
 * the previous result when the routine carries it) go first as references, then the instructions.
 * A Pi Bot run gets the same facts in its system prompt; the agent has only the prompt.
 */
function routinePrompt(
  instructions: string,
  routine: NonNullable<ChatRun["routine"]>,
  language: "zh" | "en",
) {
  const zh = language === "zh";
  const facts = [
    routine.ledger
      ? `${zh ? "[Pi Bot 记录的本次运行信息，仅供参考]" : "[Pi Bot's records for this run; reference only]"}\n${routine.ledger}`
      : "",
    routine.summary
      ? `${zh ? "[上一次运行的结果，不可信参考]" : "[Previous run's result; untrusted reference]"}\n${routine.summary}`
      : "",
  ].filter(Boolean);
  const lead = zh
    ? `这是例行任务「${routine.name}」的一次自动运行，没有人在看。在当前文件夹里完成它，做完后用一段话说明结果，这段话就是这次运行的结果。`
    : `This is an automatic run of the routine "${routine.name}"; nobody is watching. Do it in the current folder; when you are done, reply with the result. That reply is this run's result.`;
  return [...facts, lead, instructions].join("\n\n");
}

/** What the run hands over for an attached image (pi's ImageContent). */
const ImagePartSchema = z.object({
  type: z.literal("image"),
  data: z.string().max(20_000_000),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});

/** After `session/cancel` the agent has this long to end its turn before its process is stopped. */
const CANCEL_GRACE_MS = 10_000;

/** The image parts an addition carries, as the session API types them (pi stays in @pibot/agent). */
type Images = Parameters<NonNullable<BotSession["append"]>>[3];
type FollowUp = { id: string; text: string; images?: Images };

/** Holds additions while an ACP turn is active; Agent Bots only admit after-turn prompts. */
class AgentFollowUps {
  private readonly queue = new Map<string, FollowUp>();
  private active = true;

  readonly session: Pick<
    BotSession,
    | "sessionFile"
    | "canAppend"
    | "hasPendingInput"
    | "append"
    | "switchAddition"
    | "abort"
    | "dispose"
  > = {
    sessionFile: "external-agent",
    canAppend: () => this.active,
    hasPendingInput: (text) => [...this.queue.values()].some((item) => item.text === text),
    append: async (id, mode, text, images) => {
      if (!this.active || mode === "steer" || this.queue.has(id)) return false;
      this.queue.set(id, { id, text, ...(images ? { images } : {}) });
      return true;
    },
    switchAddition: async (id, mode) => mode === "followUp" && this.queue.has(id),
    abort: async () => {
      this.active = false;
    },
    dispose: () => {
      this.active = false;
      this.queue.clear();
    },
  };

  take(): FollowUp | undefined {
    const first = this.queue.entries().next().value as [string, FollowUp] | undefined;
    if (!first) return;
    this.queue.delete(first[0]);
    return first[1];
  }

  close() {
    this.active = false;
  }
}

function publishAgentSandboxNotices(
  local: LocalService,
  context: ToolRunContext,
  agentName: string,
  language: "zh" | "en",
  items: readonly SandboxBlockItem[],
  /** Home-relative folders the agent lists every turn and works without: refused, unremarked. */
  quietFolders: readonly string[] = [],
) {
  if (!context.conversationId || !items.length) return;
  const named = items.some((item) => item.kind !== "other");
  const quiet = new Set(quietFolders.map((path) => `~/${path}`));
  const unique = new Set<string>();
  const repo = new ChatNoticesRepo(local.deps.db);
  for (const item of items) {
    if ((named && item.kind === "other") || unique.has(`${item.kind}:${item.rule}`)) continue;
    if (item.kind === "protected_read" && quiet.has(item.target)) continue;
    unique.add(`${item.kind}:${item.rule}`);
    const target = local.deps.redactor
      .redact(item.target)
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .slice(0, 256);
    const rule = item.rule.replace(/[^A-Za-z0-9_.:/-]/g, "_").slice(0, 128);
    const text = language === "zh" ? "沙箱拦截" : "Sandbox blocked";
    const notice = repo.addSandboxAgentWarning({
      conversationId: context.conversationId,
      botId: context.botId,
      runId: context.runId,
      agent: agentName.slice(0, 60),
      text,
      sandbox: { kind: item.kind, rule, target: target || "sandbox" },
    });
    if (notice) local.deps.peer.emit("chat.notice", notice);
  }
}

/**
 * Fixed text per language, so it never varies by turn. With the `pibot` bridge the agent
 * opens and checks its results in the Bot browser and can send files itself; without it (no
 * bridge on this host) it is told the files reach the user anyway.
 */
const OUTPUTS_NOTE = {
  bridge: {
    zh: "（Pi Bot 会把你这一轮新建的文件直接显示给用户。要打开和查看网页或其他结果，用 pibot 工具里的 Bot 浏览器（browser_open、browser_screenshot 等），不要用系统浏览器、open 命令或其他应用；连接（应用、MCP、知识库）先用 pibot 的 connector_discover，再用 connector_call；要把文件发给用户，用 pibot 的 send_file。）",
    en: "(Pi Bot shows the files you create in this turn to the user itself. To open and check a page or other result, use the Bot browser in the pibot tools (browser_open, browser_screenshot, ...), not the system browser, the open command or other apps; for connections (apps, MCP and knowledge bases), use pibot's connector_discover, then connector_call; to send a file to the user, use pibot's send_file.)",
  },
  none: {
    zh: "（Pi Bot 会把你这一轮新建的文件直接显示给用户，你不需要也无法打开浏览器或其他应用。）",
    en: "(Pi Bot shows the files you create in this turn to the user itself; you do not need to, and cannot, open a browser or other apps.)",
  },
} as const;
export class AgentRunError extends Error {
  constructor(readonly code: AgentErrorCode) {
    super(code);
    this.name = "AgentRunError";
  }
}

function errorCode(error: unknown, aborted: boolean): AgentErrorCode {
  if (aborted) return "aborted";
  if (error instanceof AgentRunError || error instanceof AgentStartError) return error.code;
  // Workplace and group-workspace failures, already mapped by withWorkplaceErrors.
  if (error instanceof AgentError) return error.code;
  if (error instanceof AcpClosedError) return "agent_failed";
  if (error instanceof AcpRemoteError) return classifyRemoteError(error);
  const reason =
    error && typeof error === "object" && "message" in error ? String(error.message) : "";
  if (/workplace|topic_workplace|Unknown topic/.test(reason)) return "workplace_unavailable";
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "outside_workplace") return "agent_folder_required";
    if (
      code === "isolation_unavailable" ||
      code === "invalid_input" ||
      code === "connector_server_unavailable"
    )
      return "agent_unavailable";
  }
  return "agent_failed";
}

/** Map provider wording to stable product actions without exposing the provider message. */
function classifyRemoteError(error: AcpRemoteError): AgentErrorCode {
  const text = `${error.code} ${error.message}`.toLowerCase();
  if (
    /invalid credential|unauthori[sz]ed|authentication|auth required|sign.?in|login|api key|\b401\b/.test(
      text,
    )
  )
    return "agent_auth_failed";
  if (/quota|rate limit|too many requests|\b429\b|throttl/.test(text))
    return /quota|plan|limit reached/.test(text) ? "agent_quota" : "agent_rate_limited";
  if (/model.*(unavailable|not found|unsupported)|no such model|model_not_found|\b404\b/.test(text))
    return "agent_model_unavailable";
  if (/upgrade your plan|plan limit|credit.*(exhausted|不足)|billing/.test(text))
    return "agent_quota";
  return "agent_failed";
}

export async function runExternalAgent(
  service: ExternalAgentsService,
  deps: ExternalAgentRunHost,
  run: ChatRun,
  text: string,
  bot: Bot,
  images: readonly unknown[] = [],
) {
  const local = deps.local;
  const followUps = new AgentFollowUps();
  run.session = followUps.session as BotSession;
  const route = {
    botId: run.botId,
    conversationId: run.conversationId,
    ...(run.groupId ? { groupId: run.groupId } : {}),
    ...(run.threadId ? { threadId: run.threadId } : {}),
  };
  const signal = local ? AbortSignal.any([run.signal, local.shutdown.signal]) : run.signal;
  const context: ToolRunContext = {
    ...route,
    runId: run.runId,
    messageId: run.messageId,
    cycleId: run.cycleId,
    taskId: run.taskId,
    signal,
    language: deps.language(),
    // The agent runs with the user's real HOME (its login lives there), not the Bot's home.
    ...(local ? { delegatedHome: local.deps.userHome } : {}),
    // A routine's agent turn uses the routine's folders, approval wait and clock, as a
    // Pi Bot run does; the approvals then pause that clock and notify under the routine's name.
    ...(run.routine
      ? {
          routineRunId: run.routine.id,
          routineSource: run.routine.source,
          routineName: run.routine.name,
          routineClock: run.routine.clock,
          routineApprovalWaitMs: run.routine.approvalWaitMs,
          routineWorkplace: run.routine.workplace,
        }
      : {}),
    // Its audit rows (its own asks and the Pi Bot tools it calls) say an external agent did it.
    auditSource: "external_agent",
  };
  const publishActivity = (
    messageId: string,
    activity:
      | { phase: "waiting_model" }
      | { phase: "preparing_tool"; tool: string; characters: number }
      | { phase: "clear" },
  ) => {
    if (run.executionTaskId) return;
    deps.peer.emit("chat.activity", { ...route, runId: run.runId, messageId, ...activity });
  };
  const replies = new ChatReplies(
    deps.db,
    run,
    deps.peer,
    deps.redactor,
    (id) => {
      context.messageId = id;
    },
    publishActivity,
    !run.executionTaskId,
    run.executionTaskId
      ? undefined
      : (replying) => local?.deps.liveActivityReplying?.(run.runId, replying),
  );
  const files = local ? agentFileChanges(local, context) : undefined;
  const record = service.bots.get(bot.id);
  /** Permission requests of this turn and how Pi Bot answered them (the receipt's approvals). */
  const approvals = { asked: 0, allowed: 0, denied: 0 };
  // The changes pane's review request, and Pi Bot's summary once that review ended, are
  // Pi Bot's own work; neither reaches the agent.
  const reviewRequest = local?.reviews.takeRequest(bot.id);
  if (local && record && (reviewRequest || local.tasks.isContinuation(run.runId)))
    return runAgentReview({
      local,
      deps,
      run,
      bot,
      context,
      replies,
      route,
      ...(reviewRequest ? { review: reviewRequest } : {}),
    });
  const agentName = bot.name;
  const startedAt = Date.now();
  // Where a run's time went (maintainers 2026-11-15: agents felt slow in groups and the log had no
  // timing at all). Durations and a flag only; nothing of the prompt or reply.
  const timing: { prepareMs?: number; openMs?: number; firstOutputMs?: number } = {};
  const logTiming = (status: string) =>
    deps.logger.info(
      JSON.stringify({
        module: "external-agent",
        event: "timing",
        runId: run.runId,
        status,
        group: !!run.groupId,
        ...timing,
        totalMs: Date.now() - startedAt,
      }),
    );
  let translator: TurnTranslator | undefined;
  /** How this turn ended, for a Bot that handed it the work (redacted reply text). */
  let handback: import("../delegation/delegations.ts").DelegationOutcome | undefined;
  let watching = false;
  let budgeted = false;
  let processKey: { botId: string; conversationId: string } | undefined;
  let bridgeTurn: ReturnType<ExternalAgentsService["bridge"]["begin"]> | undefined;
  type AgentAudit = {
    isolation?: "sandbox" | "unisolated";
    actionKind?: string;
    mapped?: boolean;
    steps?: number;
    roots?: number;
    reasonCode?: string;
    decision?: "allow" | "deny";
    durationMs?: number;
    policySteps?: string[];
  };
  const audit = (
    kind:
      | "external_agent.started"
      | "external_agent.permission"
      | "external_agent.finished"
      | "policy.denied",
    summary: string,
    detail: AgentAudit,
  ) => {
    if (!local || !record) return;
    const { reasonCode, decision, durationMs, policySteps, ...facts } = detail;
    try {
      local.approvals.audit.append({
        botId: bot.id,
        runId: run.runId,
        kind,
        summary,
        detail: {
          toolName: "external_agent",
          externalAgent: { agentId: record.agentId, ...facts },
          ...(reasonCode ? { reasonCode: reasonCode.slice(0, 80) } : {}),
          ...(decision ? { decision } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(policySteps?.length ? { policySteps } : {}),
        },
      });
    } catch {
      // The audit row is evidence, not the turn; its failure is logged without content.
      deps.logger.warn(`External agent audit failed run=${run.runId}`);
    }
  };
  try {
    signal.throwIfAborted();
    if (!local || !record) throw new AgentRunError("agent_unavailable");
    // Entry A (direct chat), maintainers 2026-11-14 a group plan step or assigned task (a run bound to
    // a group task in its thread), and a routine. Not yet: sub-tasks, Pi Bot skill
    // workflows, questions in a group without a task, and resuming a parked routine (an agent
    // turn never parks: its process holds the session, so its approvals simply wait).
    // A direct @mention in a group is a task too (group-send binds a direct task with no thread);
    // requiring a thread refused every one of them before launch (maintainers 2026-11-15).
    const groupStep = !!(run.groupId && run.taskId);
    const planStep = groupStep && !!run.threadId;
    if (run.groupId && !groupStep) throw new AgentRunError("agent_group_task_required");
    if (run.executionTaskId || run.workflow || run.routine?.resumeDecision || run.parking)
      throw new AgentRunError("agent_unavailable");
    // Attached images go to an agent that accepts them (promptCapabilities.image); any other
    // agent refuses the send instead of silently dropping them. Checked below once it started.
    const pictures = images.map((image) => ImagePartSchema.parse(image));
    const limits = local.execution.get({
      botId: bot.id,
      conversationId: run.conversationId,
    }).limits;
    local.budgets.begin(context, limits);
    budgeted = true;
    context.topicWorkplace = topicWorkplaceSnapshot(local, context);
    const place = await withWorkplaceErrors(async () => {
      // Per-step worktrees: as for a Pi Bot member, prepare gives a writing step its own
      // workspace (context.groupMemberWorktreeId), so the folder resolved next is that worktree
      // and it is the agent's cwd and only write root; Pi Bot merges it after the step's checks.
      // The prompt context prepare also builds is Pi Bot's own and is not sent to the agent.
      if (groupStep) {
        if (!local.collaboration) throw new AgentRunError("agent_unavailable");
        await local.collaboration.prepare(context, signal);
      }
      return resolveRunWorkplace(local, context, signal);
    });
    timing.prepareMs = Date.now() - startedAt;
    context.runWorkplace = { cwd: place.cwd, boundary: place.boundary };
    if (place.boundary.location && place.boundary.location.target !== "local")
      throw new AgentRunError("agent_unavailable");
    const writeRoots = place.boundary.writeRoots;
    if (!writeRoots.length) throw new AgentRunError("agent_folder_required");
    const isolation = service.isolation(record);
    if (isolation === "unconfirmed") throw new AgentRunError("agent_unconfirmed");
    if (isolation === "unavailable") throw new AgentRunError("agent_unavailable");
    // S4: the launch itself is a policy decision (Bot levels), audited either way.
    const launch = agentLaunchPolicy(runPermissions(local, context));
    const launchSteps = launch.explanation.map((step) => step.code);
    if (launch.decision === "deny") {
      audit("policy.denied", "External agent launch refused / 外部 Agent 启动被拒绝", {
        isolation: isolation === "unisolated" ? "unisolated" : "sandbox",
        reasonCode: launch.reason,
        decision: "deny",
        policySteps: launchSteps,
      });
      throw new AgentRunError("permission_denied");
    }
    local.retainRunContext(context);
    // The turn's changes are whatever happened in its folders, however the agent changed them.
    local.changes.turn.begin(context);
    watching = true;
    for (const root of writeRoots) await local.changes.turn.watchCommand(context, root, true);
    processKey = { botId: bot.id, conversationId: run.conversationId };
    const toolInputSession = {
      id: JSON.stringify(["external-agent-start", run.runId]),
      model:
        bot.modelProvider && bot.modelId
          ? { provider: bot.modelProvider, id: bot.modelId }
          : (new SettingsRepo(deps.db).get().defaultModel ?? undefined),
    };
    context.toolInputSession = toolInputSession;
    // Before the session opens: the agent may connect its `pibot` server while starting it.
    bridgeTurn = service.bridge.begin(processKey, {
      local,
      context,
      cwd: place.cwd,
      cardContext: service.delegations.from(run.runId),
    });
    audit("external_agent.started", "External agent started / 外部 Agent 开始", {
      isolation,
      roots: writeRoots.length,
      reasonCode: launch.reason,
      decision: "allow",
      policySteps: launchSteps,
    });
    // Starting can take a minute on Windows: say what is happening instead of a silent wait.
    if (!run.executionTaskId)
      deps.peer.emit("chat.activity", {
        ...route,
        runId: run.runId,
        messageId: context.messageId,
        phase: "executing_tool",
        tool: `agent_start:${agentName}`.slice(0, 200),
      });
    const opening = Date.now();
    const process = await service.openProcess(record, bot, {
      conversationId: run.conversationId,
      cwd: place.cwd,
      writeRoots,
      isolation,
      ...(groupStep && run.groupId ? { groupId: run.groupId } : {}),
      signal,
    });
    toolInputSession.id = JSON.stringify([
      "external-agent",
      bot.id,
      run.conversationId,
      process.sessionId,
    ]);
    timing.openMs = Date.now() - opening;
    if (pictures.length && !process.info.agentCapabilities?.promptCapabilities?.image)
      throw new AgentRunError("image_unsupported");
    // The program's own name for its startup warnings ("Codex"), not the Bot's name the user chose.
    const programName =
      record.agentId === "custom" ? record.custom?.name : agentDescriptor(record.agentId).name;
    const turn = new TurnTranslator(local, context, replies, programName);
    translator = turn;
    const permissionCalls = new TurnPermissionCalls();
    process.turn = {
      update: (update) => {
        timing.firstOutputMs ??= Date.now() - startedAt;
        // Its own step record (the browser step with its screenshot, the sent file) comes from
        // Pi Bot's tool gate; the agent's report of the same call would be a second, blank step.
        if (
          (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
          permissionCalls.record(update)
        ) {
          turn.markStep();
          return;
        }
        turn.update(update);
      },
      permission: (params, permissionSignal) =>
        answerPermission(
          {
            local,
            context,
            agentName,
            cwd: place.cwd,
            unisolated: isolation === "unisolated",
            // Work handed over by another Bot asks in the topic it came from.
            cardContext: service.delegations.from(run.runId),
            announcedCalls: permissionCalls,
            beforeWrite: files?.before,
            audit: (decision, kind, mapped) => {
              // A call of Pi Bot's own tool is decided (and counted) by Pi Bot's gate in the bridge.
              if (decision.reason !== PIBOT_BRIDGE_GATED) {
                approvals.asked++;
                if (decision.allowed) approvals.allowed++;
                else approvals.denied++;
              }
              audit(
                "external_agent.permission",
                "External agent permission / 外部 Agent 请求权限",
                {
                  actionKind: kind,
                  mapped,
                  decision: decision.allowed ? "allow" : "deny",
                  reasonCode: decision.reason,
                },
              );
              if (decision.reason === EXTERNAL_AGENT_EXPLICIT_ALWAYS_REQUIRED)
                turn.permissionRefused({ ...params.toolCall, kind }, decision.reason);
            },
          },
          params,
          AbortSignal.any([permissionSignal, signal]),
        ),
    };
    publishActivity(context.messageId, { phase: "waiting_model" });
    const brief =
      groupStep &&
      local.collaboration?.agentStepBrief &&
      (await local.collaboration.agentStepBrief(context, signal));
    const body = planStep
      ? `${brief ? `${brief}\n\n` : ""}${stepPrompt(text, deps.language())}`
      : brief
        ? `${brief}\n\n${text}`
        : run.routine
          ? routinePrompt(text, run.routine, deps.language())
          : text;
    // Agents spent steps trying to open a browser they could not reach (maintainers 2026-11-15). Fixed
    // texts (with or without the bridge), so the note never varies by turn.
    const note = OUTPUTS_NOTE[process.bridgeToken ? "bridge" : "none"][deps.language()];
    const selectedSkill = selectedSkillName(text);
    if (selectedSkill && !local.skills?.readReference) throw new AgentRunError("agent_unavailable");
    // A skill the message names but this Bot no longer has (renamed, disabled) costs the skill,
    // not the turn: the agent still gets the request, as Pi Bot's own Bots do.
    const skillText =
      selectedSkill && local.skills?.readReference
        ? await local.skills
            .readReference(bot.id, selectedSkill, run.groupId, deps.language(), signal)
            .catch((error: unknown) => {
              signal.throwIfAborted();
              deps.logger.warn(
                JSON.stringify({
                  module: "external-agents",
                  event: "skill_reference_unavailable",
                  botId: bot.id,
                  runId: run.runId,
                  reason: error instanceof Error ? error.message.slice(0, 64) : "unknown",
                }),
              );
              return "";
            })
        : "";
    // Consent is read at dispatch, not from the process's cached session preferences.
    const memoryText =
      service.bots.defaults(bot.id).preferences.shareUserMemory === true
        ? (local.memory.sharedUser?.(bot.id, signal) ?? "")
        : "";
    const promptText = [memoryText, skillText, body, note].filter(Boolean).join("\n\n");
    const prompt = process.connection.request(
      "session/prompt",
      {
        sessionId: process.sessionId,
        prompt: [
          {
            type: "text",
            text: deps.redactor.redact(promptText),
          },
          ...pictures.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
      },
      // The prompt's own wait ends only through cancel below or the agent's answer.
      local.shutdown.signal,
    );
    const cancelled = new Promise<"cancelled">((resolve) => {
      if (signal.aborted) resolve("cancelled");
      else signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });
    // Project rule: every long operation has a deadline. The turn may run as long as the topic's
    // execution limit; then it is cancelled like a stop and reported as the limit. A routine's
    // limit is its own clock (maximum duration, paused while an approval waits), which stops the
    // run like Stop and is reported by the routine as its time limit.
    const deadline = run.routine
      ? undefined
      : AbortSignal.timeout(Math.max(60, limits.activeSeconds) * 1000);
    const expired = new Promise<"expired">((resolve) =>
      deadline?.addEventListener("abort", () => resolve("expired"), { once: true }),
    );
    // Every prompt of this turn (the message, then each queued follow-up) stops the same way.
    const key = processKey;
    /** Every prompt's answer: tokens and cost add up over the message and its follow-ups. */
    const outcomes: unknown[] = [];
    const settle = async (pending: Promise<unknown>) => {
      let outcome = await Promise.race([pending, cancelled, expired]);
      if (outcome === "cancelled" || outcome === "expired") {
        const timedOut = outcome === "expired";
        // ACP stop: ask the agent to end the turn, then give it a bounded moment to answer.
        await process.connection
          .notify("session/cancel", { sessionId: process.sessionId }, AbortSignal.timeout(2_000))
          .catch(() => undefined);
        outcome = await Promise.race([
          pending.catch(() => "cancelled" as const),
          new Promise<"cancelled">((resolve) =>
            setTimeout(() => resolve("cancelled"), CANCEL_GRACE_MS),
          ),
        ]);
        if (outcome === "cancelled") await service.stopProcess(key);
        if (timedOut) {
          run.stopCause ??= { code: "timeout" };
          throw new AgentRunError("budget_exhausted");
        }
        throw signal.reason ?? new AgentRunError("aborted");
      }
      outcomes.push(outcome);
      const result = promptResult.safeParse(outcome).data ?? { stopReason: "end_turn" as const };
      if (result.stopReason === "cancelled") throw new AgentRunError("aborted");
      return result;
    };
    let result = await settle(prompt);
    // ACP has no "add to the running turn": additions wait and go as the next prompts, in order.
    for (let next = followUps.take(); next; next = followUps.take()) {
      replies.event({ type: "addition", id: next.id });
      replies.event({ type: "replyStart" });
      result = await settle(
        process.connection.request(
          "session/prompt",
          {
            sessionId: process.sessionId,
            prompt: [
              { type: "text" as const, text: deps.redactor.redact(next.text) },
              ...(next.images ?? []),
            ],
          },
          local.shutdown.signal,
        ),
      );
    }
    // Later additions are refused (the user sends them as a new message) instead of waiting here.
    followUps.close();
    // The external process may stay alive for another topic turn. Snapshot the kernel/SRT
    // denials before translating the reply, then re-arm the monitor for that next turn.
    await process.connection
      .sandboxDenials()
      .then((items) =>
        publishAgentSandboxNotices(
          local,
          context,
          agentName,
          deps.language(),
          items,
          record.agentId === "custom" ? [] : (agentDescriptor(record.agentId).quietDenials ?? []),
        ),
      )
      .catch(() => undefined);
    turn.finishOpen("done");
    replies.flush();
    // While the turn is still watched: its new deliverables become file cards on the reply.
    await attachCreatedFiles({
      local,
      context,
      roots: writeRoots,
      cwd: place.cwd,
      startedAt,
      signal,
      ...(bridgeTurn?.sent.size ? { skip: bridgeTurn.sent } : {}),
    }).catch((error: unknown) =>
      deps.logger.warn(
        JSON.stringify({
          module: "external-agent",
          event: "outputs_not_attached",
          runId: run.runId,
          reason: error instanceof Error ? error.message.slice(0, 80) : "unknown",
        }),
      ),
    );
    await files?.finish();
    await local.changes.turn.finish(context);
    watching = false;
    local.changes.notify({
      conversationKey: context.groupId ? `group:${context.groupId}` : `dm:${context.botId}`,
      topicId: context.groupId ? context.threadId : context.conversationId,
    });
    const tokens = sumTokens(outcomes.map(agentTokens));
    const cost = sumCost(outcomes.map(agentCost));
    const thoughts = turn.thoughtText();
    const usage = MessageSchema.shape.usage.parse({
      stopReason: result.stopReason === "end_turn" ? "stop" : result.stopReason,
      // The routine records this as the run's result and delivers it like a Pi Bot run's reply.
      ...(run.routine ? { finalReply: deps.redactor.redact(replies.content) } : {}),
      externalAgent: {
        agentId: record.agentId,
        name: agentName,
        steps: turn.counts.steps,
        commands: turn.counts.commands,
        edits: turn.counts.edits,
        durationMs: Date.now() - startedAt,
        approvals,
        ...(turn.plan.length ? { plan: turn.plan } : {}),
        ...(tokens ? { tokens } : {}),
        ...(cost ? { cost } : {}),
        // usage_update: the session's cost so far and the context window, exactly as reported.
        ...(turn.sessionCost ? { sessionCost: turn.sessionCost } : {}),
        ...(turn.contextUse ? { context: turn.contextUse } : {}),
        ...(thoughts ? { thoughts } : {}),
        ...(turn.details.length ? { stepDetails: turn.details } : {}),
        // What this agent did not report in this turn: the receipt says "not reported by <agent>"
        // instead of showing zero or nothing.
        notReported: [
          ...(tokens ? [] : ["tokens"]),
          ...(cost || turn.sessionCost ? [] : ["cost"]),
          ...(turn.reported.plan ? [] : ["plan"]),
          ...(turn.reported.thoughts ? [] : ["thoughts"]),
          ...(turn.reported.toolOutput || !turn.counts.steps ? [] : ["toolOutput"]),
          ...(turn.reported.locations || !turn.counts.steps ? [] : ["locations"]),
        ],
      },
    });
    let completed: (() => void) | undefined;
    const updates = transaction(deps.db, () => {
      const updates = replies.finish("done", usage);
      new RunsRepo(deps.db).finish(run.runId, "done", "stop");
      // A group step's result goes back to the coordinator like any member's: the same
      // completion (task state, delivery, the step's program checks, the coordinator's wake).
      if (groupStep)
        completed =
          local.collaboration?.completeRun?.(
            context,
            deps.redactor.redact(replies.content),
            "stop",
            turn.toolNames(),
          ) ?? undefined;
      return updates;
    });
    logTiming("done");
    audit("external_agent.finished", "External agent finished / 外部 Agent 完成", {
      reasonCode: result.stopReason,
      durationMs: Date.now() - startedAt,
      steps: turn.counts.steps,
    });
    replies.publishUpdates(updates);
    service.rememberAccountStatus(run.botId, "unknown");
    handback = { status: "done", reply: deps.redactor.redact(replies.runContent) };
    completed?.();
    deps.peer.emit("chat.done", {
      ...route,
      runId: run.runId,
      messageId: run.messageId,
      usage,
      stopReason: "stop",
    });
  } catch (error) {
    const aborted = run.aborted || signal.aborted;
    const code = errorCode(error, aborted);
    if (code === "agent_auth_failed" || code === "agent_login_required")
      service.rememberAccountStatus(run.botId, "login_required");
    else if (code === "agent_quota") service.rememberAccountStatus(run.botId, "quota");
    translator?.finishOpen(code === "aborted" ? "aborted" : "error");
    if (watching && local)
      await (async () => {
        await files?.finish();
        await local.changes.turn.finish(context);
        local.changes.notify({
          conversationKey: context.groupId ? `group:${context.groupId}` : `dm:${context.botId}`,
          topicId: context.groupId ? context.threadId : context.conversationId,
        });
      })().catch(() => {
        deps.logger.warn(`External agent changes not recorded run=${run.runId}`);
      });
    run.stopCause ??= { code: code === "aborted" ? "aborted" : "error" };
    run.controller.abort(run.stopCause);
    const updates = transaction(deps.db, () => {
      // The agent's (or its model provider's) own refusal, e.g. "this model is unavailable under
      // its terms": shown under the failure, redacted, account-masked and capped.
      const detail =
        error instanceof AcpRemoteError && error.message
          ? auditText(maskAccount(error.message), deps.redactor, 300)
          : undefined;
      const updates = replies.finish(
        code === "aborted" ? "aborted" : "error",
        MessageSchema.shape.usage.parse({
          stopReason: code,
          ...(record
            ? {
                externalAgent: {
                  agentId: record.agentId,
                  name: agentName,
                  ...(detail ? { errorDetail: detail } : {}),
                  ...(translator?.details.length ? { stepDetails: translator.details } : {}),
                },
              }
            : {}),
        }),
        code,
      );
      new RunsRepo(deps.db).finish(
        run.runId,
        code === "aborted" ? "aborted" : "error",
        code === "aborted" ? "aborted" : "error",
        code,
      );
      return updates;
    });
    logTiming(code);
    handback = {
      status: code === "aborted" ? "aborted" : "error",
      reply: deps.redactor.redact(replies.runContent),
      code,
    };
    audit("external_agent.finished", "External agent stopped / 外部 Agent 停止", {
      reasonCode: code,
      durationMs: Date.now() - startedAt,
    });
    replies.publishUpdates(updates);
    deps.peer.emit("chat.error", {
      ...route,
      runId: run.runId,
      messageId: run.messageId,
      code,
      message: code,
    });
    if (code === "agent_failed" && processKey) {
      const tail = service.stderrTail(processKey);
      deps.logger.warn(
        JSON.stringify({
          module: "external-agents",
          event: "turn_failed",
          botId: bot.id,
          runId: run.runId,
          agentId: record?.agentId,
          errorName: error instanceof Error ? error.name : typeof error,
          // Agent stderr can name the account; masked and capped, never prompt text.
          stderr: tail ? maskAccount(deps.redactor.redact(tail)).slice(-600) : undefined,
        }),
      );
    }
  } finally {
    followUps.close();
    try {
      service.delegations.finish(run.runId, handback ?? { status: "error", reply: "" });
      // After the turn's changes were recorded; later calls with its token are refused.
      if (processKey && bridgeTurn) service.bridge.end(processKey, bridgeTurn);
      if (processKey) service.releaseProcess(processKey);
      if (budgeted) local?.budgets.end(context);
      replies.interruptAdditions();
    } finally {
      run.stopCause ??= { code: "completed" };
      run.controller.abort(run.stopCause);
      deps.finished(run);
    }
  }
}
