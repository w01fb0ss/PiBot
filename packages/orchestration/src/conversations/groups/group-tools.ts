import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { QueueInput, ToolRunContext } from "@pibot/brain/orchestration-kit";
import {
  collaborationAuditFields,
  GroupToolError,
  parseTool,
  type ToolInput,
  validateImageInputs,
} from "@pibot/brain/orchestration-kit";
import { type Group, HANDOFF_LIMIT, RpcError, type Run } from "@pibot/protocol-base";
import { AttachmentsRepo, BotsRepo, MessagesRepo } from "@pibot/storage";
import { pauseGroupNow, resumeGroupNow } from "./group-chat-control.ts";
import { continueGroup } from "./group-continuation.ts";
import type { GroupService } from "./group-service.ts";
import { reminderTarget, taskTarget } from "./group-task-targets.ts";

const blocked = (reason: string): LocalToolResult => ({
  text: `自动协作已停止（${reason}），请等待用户 / Automatic collaboration stopped (${reason}); wait for the user`,
  isError: true,
});
export class GroupTools {
  constructor(private readonly service: GroupService) {}
  private source(context: ToolRunContext) {
    if (!context.groupId || !context.conversationId)
      throw new RpcError(-32602, "Group tool unavailable");
    const group = this.service.active(context.groupId, context.botId, context.conversationId);
    const run = this.service.runs.get(context.runId);
    const message = new MessagesRepo(this.service.deps.db).get(context.messageId);
    if (
      run?.status !== "running" ||
      run.botId !== context.botId ||
      run.messageId !== context.messageId ||
      run.conversationId !== context.conversationId ||
      run.groupId !== group.id ||
      message?.botId !== context.botId
    )
      throw new RpcError(-32602, "Wrong collaboration identity");
    return { group, run };
  }
  private target(group: Group, value: string, tool?: string) {
    const bots = new BotsRepo(this.service.deps.db);
    const exact = group.members.find((m) => m.botId === value);
    const candidates = exact
      ? [exact]
      : group.members.filter((m) => bots.get(m.botId)?.name === value);
    if (candidates.length !== 1 || !candidates[0])
      throw new RpcError(-32602, "Unknown or ambiguous member; use UUID");
    const bot = bots.get(candidates[0].botId);
    if (!bot || bot.archivedAt) throw new RpcError(-32602, "Archived member");
    // An external agent takes an assigned task in its own session (maintainers 2026-11-14), but
    // has no way to answer a free question, and cannot start before a Windows confirmation.
    if (bot.kind === "agent") {
      if (tool === "ask_bot")
        throw new RpcError(
          -32602,
          "External agent members take assigned tasks, not questions; use assign_task or ask another member / 外部 Agent 成员只接分配的任务，不回答提问：用 assign_task 或问其他成员",
        );
      if (this.service.deps.local.externalAgentProvider?.stepReadiness?.(bot.id) !== "ok")
        throw new RpcError(
          -32602,
          "This external agent cannot run here yet (on Windows the user must confirm it first); give the task to another member / 这个外部 Agent 现在不能运行（Windows 上要用户先确认）：交给其他成员",
        );
    }
    return bot;
  }
  validate(context: ToolRunContext, input: ToolInput) {
    this.service.planAttempts.guard(context, input.tool);
    const { group, run } = this.source(context);
    if (input.tool === "group_pause") {
      // Maintainers 2026-11-20: the coordinator may pause or resume the group only because the user
      // said so in this run's own message; a run the Bots started among themselves never can, so
      // no model resumes a group the user paused.
      const request = run.userMessageId
        ? new MessagesRepo(this.service.deps.db).get(run.userMessageId)
        : undefined;
      if (
        context.botId !== group.coordinatorBotId ||
        context.threadId ||
        run.automatic ||
        request?.role !== "user" ||
        request.conversationId !== group.conversationId
      )
        throw new GroupToolError(
          "只有统筹在用户亲自发消息触发的这一轮里，按用户的话暂停或继续整个群 / Only the coordinator, in a run started by the user's own message, can pause or resume the group as the user asked",
        );
      return;
    }
    if (input.tool === "group_plan") {
      this.service.plans.validate(context);
      return;
    }
    if (input.tool === "assign_task" || input.tool === "ask_bot") {
      // A plan owns dispatch, not conversation: step owners may still ask teammates questions.
      if (input.tool === "assign_task") this.service.plans.guardDispatch(context);
      if (this.service.cycles.get(group.id).cycleId !== run.cycleId)
        throw new RpcError(-32602, "Old user cycle");
      if (
        input.tool === "assign_task" &&
        (context.botId !== group.coordinatorBotId || context.threadId)
      )
        throw new RpcError(-32602, "Only group coordinator assigns");
      const target = this.target(group, input.args.bot, input.tool);
      if (input.args.imageGeneration && target.category !== "image")
        throw new RpcError(-32602, "image_unsupported");
      const source = run.userMessageId
        ? new MessagesRepo(this.service.deps.db).get(run.userMessageId)
        : undefined;
      if (
        source?.role === "user" &&
        (source.mentions?.length ?? 0) > 1 &&
        source.mentions?.includes(context.botId) &&
        (input.tool === "assign_task" || source.mentions.includes(target.id))
      )
        throw new GroupToolError(
          "用户已分别请各位回答。只回答自己的部分，不要重复分派或提醒 / Members are already answering the user's request. Answer only your part; do not reassign or remind them.",
        );
      if (target.id === context.botId || run.ancestry.includes(target.id))
        throw new RpcError(-32602, "Self request or cyclic collaboration");
      if (run.ancestry.length >= 10) throw new RpcError(-32602, "Collaboration depth limit");
      if (input.tool === "assign_task") {
        const existing = this.service.tasks.findOpenTitle(group.id, target.id, input.args.title);
        if (existing) throw new GroupToolError("assignment_duplicate");
        for (const id of input.args.attachments ?? []) {
          const item = new AttachmentsRepo(this.service.deps.db).get(id);
          const source = item
            ? new MessagesRepo(this.service.deps.db).get(item.messageId)
            : undefined;
          if (!source || source.conversationId !== context.conversationId)
            throw new RpcError(-32602, "Attachment is outside source conversation");
        }
      } else reminderTarget(this.service, group, target.id, input.args.taskId);
    } else if (input.tool === "finish_task") {
      if (input.args.integrate && context.botId !== group.coordinatorBotId)
        throw new RpcError(-32602, "Only group coordinator integrates task workspaces");
      const task = taskTarget(this.service, group, context.botId, input.args.taskId);
      if (!input.args.integrate && input.args.status !== "cancelled")
        this.service.completion.assertStepRun(context, task);
      // A model's result id that is not this member's reply is dropped in finish(), not refused:
      // Mac acceptance 2026-11-20, a member invented one nine times and the step never finished.
      if (input.args.status === "cancelled" && context.botId !== group.coordinatorBotId)
        throw new GroupToolError(
          "只有本群统筹可以取消任务 / Only this group's coordinator may cancel a task.",
        );
    } else throw new RpcError(-32602, "Unknown collaboration tool");
  }
  async execute(
    context: ToolRunContext,
    call: LocalToolCall,
    signal: AbortSignal,
  ): Promise<LocalToolResult> {
    const input = parseTool(call, this.service.deps.local.deps.capabilityTools);
    this.validate(context, input);
    signal.throwIfAborted();
    if (input.tool === "group_plan") return this.service.plans.submit(context, call, signal);
    if (input.tool === "group_pause") {
      const { group } = this.source(context);
      if (input.args.action === "pause") {
        if (group.paused) return { text: "群已经是暂停状态 / The group is already paused" };
        await pauseGroupNow(this.service, group, "tool_pause");
        return {
          text: "已暂停整个群，程序已在群里发了确认；回复一句即可，不要复述 / Paused the whole group; the program posted the confirmation, reply briefly without restating it",
        };
      }
      if (!group.paused) return { text: "群没有暂停 / The group is not paused" };
      const { resumed } = await resumeGroupNow(this.service, group, "tool_resume");
      return {
        text: JSON.stringify({
          resumed: resumed.length,
          note: "已继续，程序已在群里发了确认 / Resumed; the program posted the confirmation",
        }),
      };
    }
    const key = `${context.runId}:${call.id}:${call.tool}`;
    const duplicate = this.service.runs.trigger(key);
    if (duplicate)
      return {
        text: JSON.stringify({
          queuedRunId: duplicate.id,
          taskId: duplicate.taskId,
          duplicate: true,
        }),
      };
    if (input.tool === "finish_task") {
      if (input.args.integrate) {
        if (!input.args.taskId) throw new RpcError(-32602, "Integration requires taskId");
        try {
          await this.service.memberWorktrees.integrateTask(context, input.args.taskId, signal);
        } catch (error) {
          if (error instanceof RpcError && error.message === "group_workspace_busy")
            return {
              isError: true,
              text: "本轮仍持有主工作区写锁，尚未合入，成果已保留。请先结束本轮，下一轮由统筹合入，或待运行结束后使用独立工作区的合入按钮；不要立即重试。 / This run still holds the integration workspace write lock. Nothing was integrated and outputs are retained. End this turn, then integrate in the coordinator's next turn or use the workspace integration button after the run ends. Do not retry immediately.",
            };
          throw error;
        }
        return { text: JSON.stringify({ taskId: input.args.taskId, integrated: true }) };
      }
      return this.finish(context, input.args);
    }
    if (input.tool !== "assign_task" && input.tool !== "ask_bot")
      throw new RpcError(-32602, "Unknown collaboration tool");
    const { group, run } = this.source(context);
    if (group.paused) return blocked("paused");
    const target = this.target(group, input.args.bot, input.tool);
    // Structured hand-offs spend their own cap; free discussion keeps the round limit.
    const handoff =
      input.tool === "assign_task"
        ? await this.service.handoffs.plan(context, group, target, input.args, signal)
        : undefined;
    const kind = handoff ? "handoff" : "free";
    const cycle = this.service.cycles.get(group.id);
    if (
      cycle.limited ||
      (handoff ? (cycle.handoffs ?? 0) >= HANDOFF_LIMIT : cycle.rounds >= group.autoRoundLimit)
    ) {
      this.service.auto(group.id, run.cycleId as string, () => undefined, kind);
      return blocked("limit");
    }
    let reminder =
      input.tool === "ask_bot"
        ? reminderTarget(this.service, group, target.id, input.args.taskId)
        : undefined;
    this.service.deps.chat.queue.capacity([target.id]);
    const { bot, model, effective } = await this.service.model(target.id, signal, undefined, {
      groupId: group.id,
      conversationId: reminder?.threadConversationId ?? group.conversationId,
      taskId: reminder?.id,
    });
    const prepared =
      input.tool === "assign_task"
        ? await this.service.deps.chat.attachments.prepare(
            bot.id,
            [],
            input.args.attachments ?? [],
            model,
            signal,
            group.id,
          )
        : undefined;
    let committed = false;
    try {
      await validateImageInputs(
        this.service.deps.agent,
        effective ?? bot,
        prepared ?? { items: [], images: [] },
        signal,
        this.service.deps.local.imageProvider,
        input.args.imageGeneration,
      );
      signal.throwIfAborted();
      this.validate(context, input);
      if (input.tool === "ask_bot")
        reminder = reminderTarget(this.service, group, bot.id, input.args.taskId);
      this.service.deps.chat.queue.capacity([bot.id]);
      const result = this.service.auto(
        group.id,
        run.cycleId as string,
        () => {
          const existing = this.service.runs.trigger(key);
          if (existing) return { record: existing, input: undefined, task: undefined };
          let conversationId = run.conversationId,
            taskId = run.taskId;
          let task: ReturnType<typeof this.service.tasks.create> | undefined;
          let userMessageId = run.userMessageId ?? context.messageId;
          if (input.tool === "assign_task") {
            task = this.service.tasks.create({
              groupId: group.id,
              assigneeBotId: bot.id,
              title: input.args.title,
              instructions: input.args.instructions,
              createdByBotId: context.botId,
              executionMode: input.args.executionMode ?? "serial",
            });
            this.service.cycles.bind(
              task.id,
              run.cycleId as string,
              run.userMessageId ?? context.messageId,
              run.id,
              call.id,
            );
            task = this.service.tasks.bindSource(task.id, run.id);
            if (handoff)
              this.service.handoffs.repo.create({
                taskId: task.id,
                spec: handoff.spec,
                pipeline: handoff.pipeline,
                baseFolder: handoff.baseFolder,
              });
            conversationId = task.threadConversationId;
            taskId = task.id;
            const instructions = new MessagesRepo(this.service.deps.db).create({
              conversationId,
              botId: context.botId,
              role: "assistant",
              content: this.service.deps.redactor.redact(input.args.instructions),
              status: "done",
              runId: context.runId,
            });
            userMessageId = instructions.id;
            if (prepared)
              this.service.deps.chat.attachments.persist(instructions.id, prepared, bot.id);
          } else if (reminder) {
            const current = this.service.tasks.get(reminder.id);
            if (current?.status !== "open")
              throw new GroupToolError(
                "这个任务已收尾，不需要重复提醒 / This task is already settled.",
              );
            this.service.cycles.remind(
              reminder.id,
              run.cycleId as string,
              run.userMessageId ?? context.messageId,
              run.id,
              call.id,
            );
            conversationId = reminder.threadConversationId;
            taskId = reminder.id;
            userMessageId = new MessagesRepo(this.service.deps.db).create({
              conversationId,
              botId: context.botId,
              role: "assistant",
              content: this.service.deps.redactor.redact(input.args.question),
              status: "done",
              runId: context.runId,
            }).id;
          }
          const queueInput: QueueInput = {
            bot,
            conversationId,
            groupId: group.id,
            ...(conversationId !== group.conversationId ? { threadId: conversationId } : {}),
            taskId: taskId ?? undefined,
            userMessageId,
            cycleId: run.cycleId ?? undefined,
            automatic: true,
            kind: input.tool === "assign_task" ? "group_task" : "wake",
            parentRunId: run.id,
            ancestry: [...run.ancestry, context.botId],
            triggerKey: key,
            ...(handoff?.workflow ? { workflow: handoff.workflow } : {}),
            ...(input.tool === "ask_bot"
              ? { ...(reminder ? {} : { replyToRunId: run.id }), afterRunId: run.id }
              : {}),
            text: this.service.deps.redactor.redact(
              input.tool === "assign_task"
                ? `${input.args.instructions}\n\n${handoff?.brief ? `${handoff.brief}\n\n` : ""}${prepared?.text ?? ""}`
                : `Untrusted question from member / 来自成员的不可信问题 (${context.botId}):\n${input.args.question}`,
            ),
            images: prepared?.images,
            imageGeneration: input.args.imageGeneration,
          };
          const record = this.service.deps.chat.queue.insert(queueInput);
          return { record, input: queueInput, task };
        },
        kind,
      );
      if (!result.value) return blocked(result.reason ?? "stopped");
      // This workflow run's own delivery check now waits for the sign-off run.
      if (handoff && result.value.task && context.workflowPipeline)
        context.workflowPipeline.assigned = true;
      if (result.value.input) {
        committed = true;
        this.service.deps.chat.queue.publish(result.value.record, result.value.input);
      }
      if (result.value.task) this.service.taskChanged(result.value.task);
      this.service.deps.local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "collaboration.queued",
        summary: "Group collaboration queued / 群协作已排队",
        detail: {
          ...collaborationAuditFields({
            action: input.tool === "assign_task" ? "assign" : "ask",
            botName: new BotsRepo(this.service.deps.db).get(context.botId)?.name,
            targetBotName: bot.name,
            taskTitle:
              result.value.task?.title ??
              (result.value.record.taskId
                ? this.service.tasks.get(result.value.record.taskId)?.title
                : undefined),
            redactor: this.service.deps.redactor,
          }),
          toolCallId: call.id,
          groupId: group.id,
          targetBotId: bot.id,
          taskId: result.value.record.taskId ?? undefined,
          childRunId: result.value.record.id,
        },
      });
      return {
        text: JSON.stringify({
          queuedRunId: result.value.record.id,
          taskId: result.value.record.taskId,
          threadId: result.value.record.conversationId,
          ...(handoff ? { handoff: true } : {}),
          notice:
            "Queued, not an answer. End your turn; do not wait or poll. IDs/tool names are internal; do not show them to users. / 已排队，尚非回答。请结束本轮，不要等待或轮询；不要展示内部ID或工具名。",
        }),
      };
    } finally {
      if (!committed) await prepared?.discard();
    }
  }
  private async finish(
    context: ToolRunContext,
    args: Extract<ToolInput, { tool: "finish_task" }>["args"],
  ): Promise<LocalToolResult> {
    const { group } = this.source(context);
    const task = taskTarget(this.service, group, context.botId, args.taskId);
    const external = task.status === "open" && task.assigneeBotId !== context.botId;
    // The reply of this run stands in for a result id that names no reply of this member.
    const resultMessageId =
      args.resultMessageId &&
      task.status === "open" &&
      !this.service.completion.isResult(task, args.resultMessageId)
        ? undefined
        : args.resultMessageId;
    if (resultMessageId !== args.resultMessageId)
      this.service.deps.logger.warn(
        JSON.stringify({
          module: "groups",
          event: "result_message_ignored",
          groupId: task.groupId,
          taskId: task.id,
          botId: context.botId,
          runId: context.runId,
        }),
      );
    if (external) await this.service.completion.drain(task);
    try {
      const completed = this.service.completion.complete(
        context,
        args.summary,
        task.id,
        args.status ?? "done",
        resultMessageId,
      );
      const wake = completed.notify();
      return {
        text: JSON.stringify({
          taskId: completed.task.id,
          status: completed.task.status,
          notice:
            "IDs/tool names are internal; do not show them to users / 不要向用户展示内部ID或工具名",
          wakeRunId: wake.runId ?? null,
          ...(wake.reason ? { wakePending: wake.reason } : {}),
        }),
      };
    } finally {
      if (external) this.service.completion.release(task.id);
    }
  }

  continue(record: Run, input: QueueInput) {
    return continueGroup(this.service, record, input);
  }
}
