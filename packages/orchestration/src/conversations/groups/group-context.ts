import type { DatabaseSync } from "node:sqlite";
import type { GroupContextPart, PromptContext } from "@pibot/agent";
import type { BrainRedactor, ToolRunContext } from "@pibot/brain/orchestration-kit";
import { activeGroup } from "@pibot/brain/orchestration-kit";
import {
  type Group,
  type GroupTask,
  HANDOFF_LIMIT,
  RpcError,
  type Run,
  resolveGroupMentions,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  GroupCyclesRepo,
  GroupTasksRepo,
  GroupWorkflowsRepo,
  MessagesRepo,
  RunsRepo,
} from "@pibot/storage";
import { groupImageDelivery, groupImageSourceRun } from "./group-image-metadata.ts";
import { groupImageReferences } from "./group-image-references.ts";
import { templatePromptPart, templateRequest } from "./group-plan-template.ts";
import {
  GROUP_IMAGE_ON_DEMAND_COMPACT,
  GROUP_IMAGE_ON_DEMAND_INSTRUCTION,
  GROUP_PLAN_COMPACT_INSTRUCTION,
  GROUP_PLAN_INSTRUCTION,
} from "./group-plan-validation.ts";
import { groupContextPrompts } from "./prompts/group-context.ts";

/**
 * The members a group message @mentions, in text order. Each `@` token at a boundary is a member
 * UUID or the longest exact member name. A name is resolved to the Bot the composer picked for it
 * (`picked`, IDs from the @ list) and only falls back to the name when one member has it. Names are
 * unique now, but older data (or an edited pick) can still leave two members with the
 * same name: that is a clear `mentionUnresolved` refusal, never an internal error.
 */
export function mentions(
  db: DatabaseSync,
  group: Group,
  text: string,
  picked: readonly string[] = [],
): string[] {
  const bots = new BotsRepo(db);
  const members = group.members.map((m) => bots.get(m.botId)).filter((b) => !!b);
  return resolveGroupMentions(members, text, picked);
}

const clip = (text: string, max: number) =>
  text.length > max ? `${Array.from(text).slice(0, max).join("")}…` : text;

/**
 * The coordinator's task list, as droppable parts. Stable pages with a byte budget: never allocate
 * an unbounded all-task snapshot. Open tasks are read first so this cap, like the hook's trimming,
 * leaves out finished ones before them. Returns how many tasks were left out.
 */
function taskSnapshots(
  tasks: GroupTasksRepo,
  groupId: string,
  rank: (task: GroupTask) => number,
  parts: GroupContextPart[],
): number {
  let remaining = 16000,
    listed = 0;
  for (const section of ["open", "closed"] as const) {
    let before: string | undefined;
    for (;;) {
      const page = tasks.list(groupId, { before, limit: 50 }, undefined, { section });
      for (const t of page) {
        const line = JSON.stringify({
          id: t.id,
          bot: t.assigneeBotId,
          title: t.title,
          status: t.status,
          summary: t.summary?.slice(0, 500),
        });
        if (line.length > remaining) {
          remaining = 0;
          break;
        }
        parts.push({ text: line, taskRank: rank(t) });
        remaining -= line.length;
        listed++;
      }
      if (remaining === 0 || page.length < 50) break;
      before = page.at(-1)?.id;
    }
    if (remaining === 0) break;
  }
  if (remaining > 0) return 0;
  const counts = tasks.summary({ groupId });
  return Math.max(0, counts.openCount + counts.closedCount - listed);
}

export function groupPrompt(
  db: DatabaseSync,
  redactor: BrainRedactor,
  context: ToolRunContext,
  memory: string,
  planInstruction = GROUP_PLAN_INSTRUCTION,
): PromptContext {
  context.signal.throwIfAborted();
  const group = activeGroup(db, context.groupId as string, context.botId, context.conversationId);
  const bots = new BotsRepo(db),
    tasks = new GroupTasksRepo(db, (t) => redactor.redact(t));
  const members = group.members.map((m) => {
    const b = bots.get(m.botId);
    return {
      id: m.botId,
      name: b?.name,
      roleId: b?.role?.id,
      work: b?.description ?? "",
      category: b?.category,
      ...(b?.category === "image"
        ? {
            capability: groupContextPrompts.imageMember,
            imageModel: { provider: b.modelProvider, id: b.modelId },
          }
        : b?.kind === "agent"
          ? {
              // An external agent works plan steps and assigned tasks in its own session.
              capability: groupContextPrompts.agentMember,
            }
          : {}),
    };
  });
  // The group result rule lives only in the trusted system prompt (rebuilt every run). Repeating it
  // here put ~1.3 KB of fixed text under the reference header cap (half of the context budget), so
  // models with small declared windows (8K tokens) aborted every group run before any request.
  const safety = groupContextPrompts.safety;
  // Everything after the safety line is a part the context hook may trim to fit the
  // model's window: task snapshots are dropped least relevant first, long texts use a compact form.
  const parts: GroupContextPart[] = [];
  // Only a group with an image member plans around paid generations, so the on-demand rule is not
  // added to every coordinator's instructions.
  const hasImageMember = members.some((member) => member.category === "image");
  if (context.botId === group.coordinatorBotId && !context.threadId)
    parts.push({
      stable: true,
      // The image line still follows the member-derived plan instruction.
      text: hasImageMember
        ? `${planInstruction}\n${GROUP_IMAGE_ON_DEMAND_INSTRUCTION}`
        : planInstruction,
      compact: hasImageMember
        ? `${GROUP_PLAN_COMPACT_INSTRUCTION}${GROUP_IMAGE_ON_DEMAND_COMPACT}`
        : GROUP_PLAN_COMPACT_INSTRUCTION,
    });
  const role = context.botId === group.coordinatorBotId ? "coordinator / 统筹" : "member / 成员";
  parts.push({
    stable: true,
    text: JSON.stringify({ group: group.name, members, announcement: group.announcement, role }),
    compact: JSON.stringify({
      group: group.name,
      members: members.map(({ work: _work, ...member }) => member),
      announcement: clip(group.announcement, 500),
      role,
    }),
  });
  const sourceRun = new RunsRepo(db).get(context.runId);
  const source = sourceRun?.userMessageId
    ? new MessagesRepo(db).get(sourceRun.userMessageId)
    : undefined;
  const template = templateRequest(db, group, context, sourceRun?.userMessageId);
  const templatePart =
    template &&
    templatePromptPart(
      db,
      group,
      template,
      sourceRun?.cycleId,
      group.members.flatMap(({ botId }) => {
        const bot = bots.get(botId);
        return bot ? [bot] : [];
      }),
      context.runId,
    );
  if (templatePart) parts.push(templatePart);
  if (source?.attachments?.length)
    parts.push({
      text: JSON.stringify({
        sourceMessageId: source.id,
        attachments: source.attachments.map((a) => ({
          id: a.id,
          name: redactor.redact(a.name).slice(0, 80),
          kind: a.kind,
        })),
      }),
    });
  const thread = context.threadId ? tasks.forThread(context.threadId) : undefined;
  if (context.threadId && (!thread || thread.groupId !== group.id))
    throw new RpcError(-32602, "Missing task thread");
  if (thread) {
    const own = {
      taskId: thread.id,
      title: thread.title,
      instructions: thread.instructions,
      owner: thread.assigneeBotId,
      status: thread.status,
    };
    // The thread's own session already holds the full instructions; the header copy can shrink.
    parts.push({
      text: JSON.stringify(own),
      compact: JSON.stringify({ ...own, instructions: clip(thread.instructions, 2000) }),
    });
  }
  // Less relevant first when trimming: unrelated before related, finished before open, old before new.
  const rank = (task: GroupTask) =>
    ((task.id === context.taskId ||
    task.threadConversationId === context.threadId ||
    (!!source && task.source?.messageId === source.id)
      ? 2
      : 0) +
      (task.status === "open" ? 1 : 0)) *
      1e15 +
    (Date.parse(task.createdAt) || 0);
  if (!thread && context.botId !== group.coordinatorBotId)
    for (const task of tasks.openForBot(group.id, context.botId, { limit: 50 }))
      parts.push({
        text: JSON.stringify({
          taskId: task.id,
          title: task.title,
          instructions: task.instructions.slice(0, 500),
          status: task.status,
        }),
        taskRank: rank(task),
      });
  if (source?.role === "user" && (source.mentions?.length ?? 0) > 1)
    parts.push({
      text: groupContextPrompts.mentionedRouting,
    });
  const omittedTasks =
    context.botId === group.coordinatorBotId ? taskSnapshots(tasks, group.id, rank, parts) : 0;
  const cycle = new GroupCyclesRepo(db).get(group.id);
  parts.push({
    text: JSON.stringify({
      paused: group.paused,
      rounds: cycle.rounds,
      limit: group.autoRoundLimit,
      limited: cycle.limited,
      // Shown only once used, so a group without hand-offs pays no prompt characters.
      ...(cycle.handoffs ? { handoffs: cycle.handoffs, handoffLimit: HANDOFF_LIMIT } : {}),
    }),
  });
  const messages = groupImageReferences(db, context, group).map(({ message: m, priority }) => ({
    id: m.id,
    role: m.role === "user" ? ("user" as const) : ("assistant" as const),
    text: Array.from(redactor.redact(m.content)).slice(0, 500).join(""),
    botName: m.botId ? bots.get(m.botId)?.name : undefined,
    priority,
    imageDelivery: groupImageDelivery(m, db, group),
    sourceRunId: groupImageSourceRun(db, group, m),
    attachments: m.attachments?.map((a) => ({
      id: a.id,
      name: redactor.redact(a.name).slice(0, 80),
      kind: a.kind,
      mimeType: a.mimeType,
    })),
  }));
  // Task sessions restore their complete own JSONL. Collaborators also receive bounded pages of
  // visible thread history, since per-Bot SDK sessions cannot see another Bot's thread replies.
  if (context.threadId) {
    const history = [];
    let before: string | undefined,
      remaining = 32000;
    for (;;) {
      const page = new MessagesRepo(db).list(context.threadId, { before, limit: 200 });
      for (const m of page.slice().reverse()) {
        if (m.status === "streaming" || m.id === context.messageId) continue;
        const text = redactor.redact(m.content);
        if (text.length > remaining) {
          remaining = 0;
          break;
        }
        history.push({
          id: m.id,
          role: m.role === "user" ? ("user" as const) : ("assistant" as const),
          text,
          botName: m.botId ? bots.get(m.botId)?.name : undefined,
          priority: false,
          imageDelivery: groupImageDelivery(m, db, group),
          sourceRunId: groupImageSourceRun(db, group, m),
          attachments: m.attachments?.map((a) => ({
            id: a.id,
            name: redactor.redact(a.name).slice(0, 80),
            kind: a.kind,
            mimeType: a.mimeType,
          })),
        });
        remaining -= text.length;
      }
      if (remaining === 0 || page.length < 200) break;
      before = page[0]?.id;
    }
    messages.push(...history.reverse());
    if (remaining === 0)
      parts.push({
        text: groupContextPrompts.olderThreadOmitted,
      });
  }
  const imageStatus = [
    ...new Set(
      messages.flatMap(
        (m) => m.attachments?.filter((a) => a.kind === "image").map((a) => a.id) ?? [],
      ),
    ),
  ].map((attachmentId) => ({ attachmentId, status: "not_loaded" as const }));
  return {
    memory,
    group: {
      information: redactor.redact(safety),
      parts: parts.map((part) => ({
        ...part,
        text: redactor.redact(part.text),
        ...(part.compact !== undefined ? { compact: redactor.redact(part.compact) } : {}),
      })),
      ...(omittedTasks ? { omittedTasks } : {}),
      messages,
      imageStatus,
    },
  };
}

/**
 * External ACP agents get a small program-built brief, rather than the coordinator's JSON
 * prompt. It deliberately contains no memory, attachments, private member chats or tool names.
 */
export async function agentStepBrief(
  db: DatabaseSync,
  redactor: BrainRedactor,
  context: ToolRunContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  if (!context.groupId) return undefined;
  const group = activeGroup(db, context.groupId, context.botId, context.conversationId);
  if (!group.externalAgentStepContext) return undefined;
  const bots = new BotsRepo(db);
  if (!group.members.some(({ botId }) => bots.get(botId)?.kind === "agent")) return undefined;
  const tasks = new GroupTasksRepo(db, (task) => redactor.redact(task));
  const task = context.taskId ? tasks.get(context.taskId) : undefined;
  const lines = [
    context.language === "zh" ? "## 这一步的背景" : "## Context for this step",
    `${context.language === "zh" ? "群" : "Group"}：${group.name}`,
  ];
  if (task) {
    lines.push(
      `${context.language === "zh" ? "这一步" : "Step"}：${task.title}`,
      task.instructions,
    );
    const workflowRow = context.threadId
      ? db
          .prepare(
            "SELECT workflow_run_id AS workflowRunId FROM group_workflow_steps WHERE task_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(task.id)
      : undefined;
    const workflow = workflowRow
      ? new GroupWorkflowsRepo(db).get(
          String((workflowRow as { workflowRunId: string }).workflowRunId),
        )
      : undefined;
    if (workflow) {
      const done = new GroupWorkflowsRepo(db)
        .steps(workflow.id)
        .filter((step) => step.status === "passed" && step.taskId && step.taskId !== task.id)
        .slice(-5);
      for (const step of done) {
        const previous = tasks.get(step.taskId as string);
        if (previous?.summary)
          lines.push(
            `${context.language === "zh" ? "已完成步骤" : "Completed step"}：${previous.title}\n${previous.summary.slice(0, 1500)}`,
          );
      }
      const definition = (workflow.workflow as { contract?: { steps?: unknown[] } }).contract
        ?.steps;
      const current = Array.isArray(definition)
        ? definition.find(
            (item) =>
              item &&
              typeof item === "object" &&
              (item as { title?: unknown }).title === task.title,
          )
        : undefined;
      const checks =
        current && typeof current === "object"
          ? (current as { checks?: unknown }).checks
          : undefined;
      if (Array.isArray(checks) && checks.length)
        lines.push(`${context.language === "zh" ? "检查要求" : "Checks"}：${checks.join("；")}`);
    }
  }
  // A direct @mention's own text follows this brief, so it is not repeated here. Only a writing
  // step gets its own worktree; otherwise the agent works in the group's folder directly.
  lines.push(
    context.groupMemberWorktreeId
      ? context.language === "zh"
        ? "工作位置：你在这一步自己的工作区里改文件；Pi Bot 检查通过后合并。"
        : "Workspace: make changes in this step's own folder; Pi Bot will merge them after checks."
      : context.language === "zh"
        ? "工作位置：你直接在群的工作文件夹里工作，改动立即生效。"
        : "Workspace: you work directly in the group's folder; changes take effect immediately.",
    context.language === "zh"
      ? "请以 ## 交回 结尾，并包含：结果、改动的文件、没做完的、怎么验证的。"
      : "End with ## Hand-back and include: Result, Changed files, Not finished, Verification.",
  );
  return redactor.redact(lines.join("\n\n")).slice(0, 9000);
}
export function guardGroupRun(db: DatabaseSync, record: Run) {
  if (!record.groupId) return;
  const group = activeGroup(db, record.groupId, record.botId, record.conversationId);
  const task = record.taskId ? new GroupTasksRepo(db, (t) => t).get(record.taskId) : undefined;
  if (
    record.taskId &&
    (!task ||
      task.groupId !== group.id ||
      (task.threadConversationId !== record.conversationId &&
        (record.conversationId !== group.conversationId || task.assigneeBotId !== record.botId)) ||
      (record.automatic ? task.status !== "open" : task.assigneeBotId !== record.botId))
  )
    throw new RpcError(-32602, "Task identity unavailable");
  if (record.automatic) {
    const cycle = new GroupCyclesRepo(db).get(group.id);
    if (group.paused || cycle.cycleId !== record.cycleId)
      throw new RpcError(-32602, "Automatic run stale or paused");
  }
  if (record.parentRunId && !new RunsRepo(db).get(record.parentRunId))
    throw new RpcError(-32602, "Parent run missing");
}
