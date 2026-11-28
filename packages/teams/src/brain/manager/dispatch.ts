// The default Pi hands a message or task to another Bot (a new topic of its own) or to a group (a
// new group topic, planned by its coordinator as usual). The receiver works under its own
// permissions. Pi gets the topic immediately; the receipt follows the work independently.
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import {
  type CapabilityContext,
  mainDirectRun,
  type ToolExecutor,
  type ToolRunContext,
} from "@pibot/brain/kit";
import type { DispatchModelNeeds } from "@pibot/protocol";
import { BotsRepo, SettingsRepo } from "@pibot/storage";
import {
  PI_DISPATCHES_PER_TURN,
  type PiDispatchStatus,
  piManagerTools,
} from "@pibot/teams-contract";
import { type FollowedDispatch, PiDispatchesRepo } from "../../store/pi-dispatches.ts";
import { dispatchModelError, recordDispatchModels } from "./dispatch-models.ts";
import type { DispatchApproval } from "./dispatch-policy.ts";
import { managerFailure } from "./errors.ts";
import { findBot, findGroup, oneLine, say, shortDispatchTitle } from "./lookup.ts";

const refusal = (text: string): LocalToolResult => ({ text, isError: true });
const FOLLOW_MS = 5_000;
interface Observation {
  status: PiDispatchStatus;
  summary: string;
  outputs: string[];
}

/**
 * Reads a hand-off's state from the receiver's own records. A run that just ended can be followed
 * by the next one (a group plan's next step), so callers treat "finished" as final only when two
 * readings in a row agree.
 */
export class DispatchFollower {
  private readonly repo: PiDispatchesRepo;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly settling = new Map<string, PiDispatchStatus>();
  private readonly switchReads = new Map<string, string>();
  private readonly changedGroups = new Set<string | null>();
  private stopped = false;
  constructor(private readonly ctx: CapabilityContext) {
    this.repo = new PiDispatchesRepo(ctx.db);
  }

  observe(
    dispatch: Pick<FollowedDispatch, "id" | "kind" | "targetId" | "conversationId" | "createdAt">,
  ): Observation {
    const since = dispatch.createdAt;
    const runs = this.repo.topicRuns(dispatch.conversationId, since);
    const groupId = dispatch.kind === "group" ? dispatch.targetId : null;
    const plan = groupId ? this.repo.groupPlan(groupId, dispatch.conversationId, since) : undefined;
    const summary = oneLine(
      // A one-line excerpt: markdown marks would show as raw symbols on the receipt.
      this.ctx.redactor
        .redact(this.repo.lastReply(dispatch.conversationId, since, !!groupId, plan?.id))
        .replace(/(\*\*|__|`+|^#+\s*|^>\s*)/gmu, ""),
      300,
    );
    const outputs = this.repo
      .outputNames(dispatch.conversationId, since)
      .map((name) => this.ctx.redactor.redact(name) || "—");
    if (
      plan?.status === "waiting" ||
      runs.some((run) => run.status === "waiting") ||
      this.repo.waitingForPerson(dispatch.conversationId, since, dispatch.id)
    )
      return { status: "waiting", summary, outputs };
    const last = runs[0];
    if (
      plan?.status === "running" ||
      runs.some((run) => ["queued", "running", "stopping"].includes(run.status)) ||
      !last
    )
      return { status: "working", summary, outputs };
    return {
      status:
        plan?.status === "passed"
          ? "done"
          : plan?.status === "cancelled"
            ? "stopped"
            : plan?.status === "failed"
              ? "failed"
              : last.status === "done"
                ? "done"
                : last.status === "aborted"
                  ? "stopped"
                  : "failed",
      summary,
      outputs,
    };
  }

  /** One reading for a stored hand-off; writes and announces a change. */
  check(dispatch: FollowedDispatch): PiDispatchStatus {
    const seen = this.observe(dispatch);
    let status = seen.status;
    if (
      (dispatch.status === "working" || dispatch.status === "waiting") &&
      (status === "done" || status === "failed" || status === "stopped")
    ) {
      // Final only when the previous reading said the same.
      if (this.settling.get(dispatch.id) !== status) {
        this.settling.set(dispatch.id, status);
        status = dispatch.status;
      } else this.settling.delete(dispatch.id);
    } else this.settling.delete(dispatch.id);
    const current = this.repo.get(dispatch.id);
    const switches = JSON.stringify(current?.modelSwitches ?? []);
    const switchesChanged = switches !== (this.switchReads.get(dispatch.id) ?? "[]");
    if (status === "working" || status === "waiting") this.switchReads.set(dispatch.id, switches);
    else this.switchReads.delete(dispatch.id);
    if (
      current &&
      (current.status !== status ||
        current.summary !== seen.summary ||
        current.outputs.join("\n") !== seen.outputs.join("\n"))
    ) {
      this.repo.settle(dispatch.id, status, seen.summary, seen.outputs);
      this.ctx.peer.emit("teams.dispatch.changed", { messageId: dispatch.messageId });
      if (current.status !== status && status !== "working" && status !== "waiting")
        this.ctx.local.approvals.audit.append({
          botId: new BotsRepo(this.ctx.db).getMain()?.id ?? "",
          kind: "pi.dispatched",
          summary: "Assigned work ended / 派出的工作有结果了",
          detail: {
            actor: "system",
            reasonCode: `dispatch_${status}`,
            target: current.targetName,
            taskTitle: current.title,
            ...(dispatch.conversationId ? { conversationId: dispatch.conversationId } : {}),
          },
        });
    } else if (switchesChanged) {
      this.ctx.peer.emit("teams.dispatch.changed", { messageId: dispatch.messageId });
    }
    return status;
  }

  recover() {
    this.changedGroups.add(null);
    this.start();
  }

  groupChanged(groupId: string) {
    this.changedGroups.add(groupId);
    this.start();
  }

  /** Keeps receipts current after Pi's turn stopped waiting (and after a restart). */
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      try {
        const open = this.repo.open();
        for (const dispatch of open) this.check(dispatch);
        for (const groupId of this.changedGroups) {
          let after = "";
          for (;;) {
            const page = this.repo.changedGroups(groupId, after);
            for (const dispatch of page) this.check(dispatch);
            const last = page.at(-1);
            if (!last || page.length < 50) break;
            after = last.id;
          }
          this.changedGroups.delete(groupId);
        }
        if (!open.length && !this.repo.open(1).length) this.pause();
      } catch (error) {
        // A failed reading is retried on the next tick; the receipt only lags behind.
        this.ctx.logger.warn(
          JSON.stringify({
            module: "pi_manager",
            event: "follow_failed",
            reason: error instanceof Error ? error.name : typeof error,
          }),
        );
      }
    }, FOLLOW_MS);
    this.timer.unref?.();
  }

  private pause() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  stop() {
    this.stopped = true;
    this.pause();
  }
}

type SendArgs = {
  target: string;
  title: string;
  task: string;
  folder?: string;
  modelRequested?: boolean;
  needs?: DispatchModelNeeds;
  imageGeneration?: ReturnType<typeof piManagerTools.send_to_bot.schema.parse>["imageGeneration"];
};

function parse(kind: "bot" | "group", input: unknown): SendArgs {
  if (kind === "bot") {
    const args = piManagerTools.send_to_bot.schema.parse(input);
    return {
      target: args.bot,
      title: args.title,
      task: args.task,
      folder: args.folder,
      modelRequested: !!args.model,
      needs: args.needs,
      imageGeneration: args.imageGeneration,
    };
  }
  const args = piManagerTools.send_to_group.schema.parse(input);
  return {
    target: args.group,
    title: args.title,
    task: args.task,
    folder: args.folder,
    modelRequested: !!args.steps?.length,
  };
}

export async function dispatchWork(
  ctx: CapabilityContext,
  follower: DispatchFollower,
  kind: "bot" | "group",
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
  authorization: Parameters<ToolExecutor>[3],
): Promise<LocalToolResult> {
  const language = context.language;
  let args: SendArgs;
  try {
    args = parse(kind, call.input);
  } catch (error) {
    return managerFailure(ctx, language, error, kind === "bot" ? "send_to_bot" : "send_to_group");
  }
  // Policy refused any other caller already; checked again where the work actually leaves.
  if (!mainDirectRun(ctx.local, context))
    return refusal(
      say(
        language,
        "只有默认 Pi 在私聊里能派活",
        "Only the default Pi can assign work, in its own chat",
      ),
    );
  const repo = new PiDispatchesRepo(ctx.db);
  if (repo.countForRun(context.runId) >= PI_DISPATCHES_PER_TURN)
    return refusal(
      say(
        language,
        `这一轮已经派了 ${PI_DISPATCHES_PER_TURN} 次活；先把结果告诉用户，需要的话让用户再开一轮`,
        `This turn already assigned ${PI_DISPATCHES_PER_TURN} tasks; report back first, the person can ask again`,
      ),
    );
  const pi = new BotsRepo(ctx.db).get(context.botId);
  if (!pi) return refusal("Pi unavailable");
  const bot = kind === "bot" ? findBot(ctx.db, args.target) : undefined;
  const group = kind === "group" ? findGroup(ctx.db, args.target) : undefined;
  const target = bot ?? group;
  if (!target || target.archivedAt)
    return refusal(
      say(
        language,
        `找不到「${args.target}」（或已归档）；先用 team_list 看名字`,
        `No active ${kind === "bot" ? "Bot" : "group"} "${args.target}"; use team_list for names`,
      ),
    );
  if (args.imageGeneration && bot?.category !== "image")
    return refusal(say(language, "请选择图片 Bot。", "Choose an image Bot."));
  // Loop guard: Pi never hands work to itself, so nothing it sends can come back as its own turn.
  if (bot?.isMain)
    return refusal(say(language, "不能派活给你自己", "You cannot assign work to yourself"));
  if (group?.paused)
    return refusal(
      say(
        language,
        "这个群组暂停着；请用户先继续",
        "That group is paused; ask the person to resume it",
      ),
    );
  const approved = authorization?.data as DispatchApproval | undefined;
  const destinationBotId = bot?.id ?? group?.coordinatorBotId;
  const folder = approved?.folder;
  if (
    folder &&
    (!authorization?.confirmedNow ||
      approved.kind !== kind ||
      approved.targetId !== target.id ||
      approved.botId !== destinationBotId)
  )
    return refusal(
      say(
        language,
        "用户指定的路径需在派发卡确认。用户没给路径时，省略 folder 并使用接手方的工作目录。",
        "Confirm a person-supplied path on the dispatch card. If the person gave no path, omit folder to use the recipient's workplace.",
      ),
    );
  if (args.folder !== undefined && !folder)
    ctx.logger.info(
      JSON.stringify({
        module: "pi_manager",
        event: "dispatch_folder_ignored",
        reason: "not_person_supplied",
        botId: context.botId,
        runId: context.runId,
      }),
    );
  const models = approved?.models;
  if (args.modelRequested) {
    const problem = dispatchModelError(models, language);
    if (
      !models ||
      approved?.targetId !== target.id ||
      approved.botId !== destinationBotId ||
      (models.needsConfirmation && !authorization?.confirmedNow) ||
      models.error ||
      (problem && !authorization?.approvalId && !authorization?.confirmedNow)
    )
      return refusal(
        ctx.redactor.redact(
          problem ??
            say(
              language,
              "请在派发卡上确认所选模型。",
              "Confirm the model selection on the dispatch card.",
            ),
        ),
      );
  }
  const id = randomUUID();
  const folderName = folder ? oneLine(ctx.redactor.redact(folder.name), 255) || "—" : undefined;
  const title = shortDispatchTitle(ctx.redactor.redact(args.title));
  const topicTitle = say(language, `${title} · 来自 Pi`, `${title} · From Pi`);
  const targetName = oneLine(ctx.redactor.redact(target.name), 200) || "—";
  const dispatchTopic = {
    title: topicTitle,
    ...(folder ? { folder } : {}),
    model: bot ? models?.choices[0]?.model : undefined,
    recordModels: (conversationId: string) => {
      repo.opened(id, conversationId, folderName);
      if (models?.choices.length)
        recordDispatchModels(ctx, models, id, conversationId, context.runId, group?.id);
    },
    assertCurrent: () => authorization?.assertCurrent(),
    recordWorkplace:
      folderName && destinationBotId
        ? (conversationId: string) => {
            ctx.local.approvals.audit.append({
              botId: destinationBotId,
              kind: group ? "group.folder.added" : "topic.folder.added",
              summary: "Dispatch topic workplace selected / 派发话题已选择工作目录",
              detail: {
                actor: "user",
                reasonCode: "dispatch_folder_confirmation",
                target: folderName,
                conversationId,
                ...(group ? { groupId: group.id } : {}),
              },
            });
          }
        : undefined,
    signal: AbortSignal.any([signal, context.signal]),
  };
  dispatchTopic.signal.throwIfAborted();
  repo.create({
    id,
    piBotId: pi.id,
    piRunId: context.runId,
    piMessageId: context.messageId,
    toolCallId: call.id,
    targetKind: kind,
    targetId: target.id,
    targetName,
    title,
  });
  const display = {
    dispatch: {
      from: ctx.redactor.redact(pi.name).slice(0, 200),
      dispatchId: id,
      ...(args.needs ? { modelNeeds: args.needs } : {}),
    },
  };
  const planSteps = group
    ? models?.choices.map(({ stepId, bot }) => ({ stepId, botId: bot.id }))
    : undefined;
  const planHint = planSteps?.length
    ? `\n\n${say(
        language,
        "派发已指定以下计划步骤 ID 和接手 Bot，请在群计划中沿用这些配对。",
        "The dispatch specifies these plan step IDs and owners. Use these pairs in the group plan.",
      )}\n${JSON.stringify(planSteps)}`
    : "";
  const text = ctx.redactor.redact(`${title}\n\n${args.task}${planHint}`);
  let sent: { runId: string; conversationId?: string };
  try {
    if (bot)
      sent = await ctx.chat.send(
        bot.id,
        text,
        [],
        [],
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        display,
        args.imageGeneration,
        dispatchTopic,
      );
    else {
      const topic = await ctx.groups.newTopic(target.id, dispatchTopic);
      ctx.peer.emit("teams.dispatch.changed", { messageId: context.messageId });
      sent = {
        ...(await ctx.groups.send(target.id, topic.conversationId, text, display, {
          signal: dispatchTopic.signal,
          beforeCommit: async () => dispatchTopic.assertCurrent(),
          commit: dispatchTopic.assertCurrent,
        })),
        conversationId: topic.conversationId,
      };
    }
  } catch (error) {
    repo.abandon(id);
    ctx.peer.emit("teams.dispatch.changed", { messageId: context.messageId });
    return managerFailure(ctx, language, error, kind === "bot" ? "send_to_bot" : "send_to_group");
  }
  const conversationId = sent.conversationId;
  if (!conversationId) {
    repo.abandon(id);
    return refusal(say(language, "对方没有开出新话题", "No topic was opened"));
  }
  repo.started(id, conversationId, sent.runId, folderName);
  ctx.peer.emit("teams.dispatch.changed", { messageId: context.messageId });
  follower.start();
  // The work has left: a failed audit write is logged, never reported as a failed hand-off.
  try {
    ctx.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "pi.dispatched",
      summary: "Pi assigned work / Pi 派了活",
      detail: {
        actor: "automatic",
        reasonCode: kind === "bot" ? "dispatch_bot" : "dispatch_group",
        target: targetName,
        taskTitle: title,
        conversationId,
        ...(group ? { groupId: group.id } : {}),
      },
    });
  } catch (error) {
    ctx.logger.warn(
      JSON.stringify({
        module: "pi_manager",
        event: "audit_failed",
        code: "dispatch",
        reason: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
  // Give fast failures a chance to reach the same receipt Pi reads before its next reply.
  // Longer work still runs independently, and the tool returns a point-in-time status.
  const grace = Date.now() + 750;
  try {
    for (let receipt = repo.get(id); receipt?.status === "working"; receipt = repo.get(id)) {
      const status = follower.check({
        id,
        messageId: context.messageId,
        kind,
        targetId: target.id,
        conversationId,
        createdAt: receipt.createdAt,
        status: receipt.status,
      });
      if (status !== "working" || Date.now() >= grace || dispatchTopic.signal.aborted) break;
      await delay(125, undefined, { signal: dispatchTopic.signal });
    }
  } catch (error) {
    if (!dispatchTopic.signal.aborted)
      ctx.logger.warn(
        JSON.stringify({
          module: "pi_manager",
          event: "receipt_snapshot_failed",
          reason: error instanceof Error ? error.name : typeof error,
        }),
      );
  }
  const receipt = repo.get(id);
  const action = receipt?.open_topic;
  if (!action) return refusal("dispatch_missing");
  const place = [targetName, title, folderName].filter(Boolean).join(" · ");
  const state = {
    working: say(language, "已排入接手方的话题。", "Queued in the recipient's topic."),
    waiting: say(
      language,
      "接手方需要你确认或回答。",
      "The recipient needs your input or approval.",
    ),
    done: say(language, "接手方已完成。", "The recipient finished."),
    failed: say(language, "接手方运行失败。", "The recipient's run failed."),
    stopped: say(language, "接手方运行已停止。", "The recipient's run stopped."),
  }[receipt.status];
  const settings = new SettingsRepo(ctx.db).get();
  const island =
    settings.liveIsland !== false &&
    (settings.liveIslandKinds?.includes(kind === "group" ? "group" : "chat") ?? true);
  return {
    text: say(
      language,
      `已派发给 ${place}。${state} 可在该话题和回执卡查看详情。${island ? " 实时岛显示运行进度。" : ""}`,
      `Assigned to ${place}. ${state} See the topic and receipt for details.${island ? " The live island shows progress." : ""}`,
    ),
    details: { open_topic: action },
  };
}
