import { randomUUID } from "node:crypto";
import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import {
  abortable,
  GroupToolError,
  groupPlanStartFailure,
  groupWorkplace,
  redactValue,
  skillContract,
  type ToolRunContext,
  workspaceFiles,
} from "@pibot/brain/orchestration-kit";
import {
  type GroupPlan,
  type GroupPlanCard,
  GroupPlanCardSchema,
  type GroupVerification,
  groupPlanNeedsConfirmation,
  hasAcceptanceRelaxation,
  type KernelMethodParams,
  RpcError,
  RpcErrorCodes,
  type Run,
  type SkillContract,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  GroupExecutionLimitsRepo,
  GroupPlansRepo,
  GroupVerificationRulesRepo,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import { planConfirmationRequired } from "./group-plan-confirmation.ts";
import { needsDelegation } from "./group-plan-delegation.ts";
import { preparePlanDelivery } from "./group-plan-delivery.ts";
import { planFilenameIssues, planFilenameRequest } from "./group-plan-filenames.ts";
import { originalPlanIssues } from "./group-plan-issue-origins.ts";
import { expandPlanMethods } from "./group-plan-methods.ts";
import { planRelaxations } from "./group-plan-relaxations.ts";
import { retainCompletedPlan } from "./group-plan-retained.ts";
import { templatePlan, templateRequest } from "./group-plan-template.ts";
import { type PlanIssue, validateGroupPlan } from "./group-plan-validation.ts";
import type { GroupService } from "./group-service.ts";
import { verificationCard } from "./group-verification-admission.ts";
import { changedDeliverableFiles, implementationAuthors } from "./group-verification-facts.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";
import { repairableVerdicts } from "./group-workflow-verdicts.ts";

/** The engine must durably admit by card.id, under the original budget root, before returning. */
export interface GroupPlanEngine {
  start(input: { card: GroupPlanCard; conversationId: string }, signal: AbortSignal): Promise<void>;
  admitted(planId: string, signal: AbortSignal): Promise<boolean>;
}

export class GroupDynamicPlans {
  readonly repo: GroupPlansRepo;
  private engine?: GroupPlanEngine;
  private closed = false;
  private readonly jobs = new Map<string, Promise<GroupPlanCard>>();
  /** Runs already told, with a group line, that their plan submission changed nothing. */
  private readonly unchangedNotices = new Set<string>();
  constructor(private readonly service: GroupService) {
    this.repo = new GroupPlansRepo(service.deps.db);
  }
  provide(engine: GroupPlanEngine) {
    if (this.engine || this.closed) throw new Error("group_plan_engine_already_provided");
    this.engine = engine;
    return () => {
      if (this.engine === engine) this.engine = undefined;
    };
  }
  private members(groupId: string) {
    const group = this.service.active(groupId);
    const bots = new BotsRepo(this.service.deps.db);
    return group.members.flatMap(({ botId }) => {
      const bot = bots.get(botId);
      return bot ? [bot] : [];
    });
  }
  private scope(context: ToolRunContext) {
    if (
      this.closed ||
      !context.groupId ||
      !context.conversationId ||
      context.threadId ||
      context.executionTaskId
    )
      throw new RpcError(-32602, "group_plan_scope_invalid");
    const group = this.service.active(context.groupId, context.botId, context.conversationId);
    const run = this.service.runs.get(context.runId);
    if (
      group.coordinatorBotId !== context.botId ||
      run?.status !== "running" ||
      run.botId !== context.botId ||
      run.groupId !== group.id ||
      run.conversationId !== context.conversationId ||
      run.messageId !== context.messageId ||
      run.cycleId !== this.service.cycles.get(group.id).cycleId ||
      !run.cycleId
    )
      throw new RpcError(-32602, "group_plan_scope_invalid");
    return { group, run, cycleId: run.cycleId };
  }
  validate(context: ToolRunContext) {
    this.scope(context);
    // Pause test 2026-11-20: a plan sent while the group was paused validated, then failed as
    // 「已过期」 with no word about the pause. Say it up front so the coordinator can tell the user.
    if (context.groupId && this.service.pausedFor(context.groupId))
      throw new GroupToolError(
        "group_paused：群已暂停，新计划不会开始。请告诉用户先点输入框上方的「继续」或说「继续」；用户这条消息已明确要开始新工作时，可以先用 group_pause 继续再提交 / The group is paused, so a new plan will not start. Ask the user to tap Continue above the input or say continue; if this message clearly asks to start new work, resume with group_pause first, then submit.",
      );
  }
  guardDispatch(context: ToolRunContext) {
    if (!context.groupId || !context.conversationId) return;
    const cycle = this.service.cycles.get(context.groupId).cycleId;
    const entry = cycle ? this.repo.forCycle(context.conversationId, cycle) : undefined;
    this.service.planAttempts.guard(context, "assign_task");
    if (entry)
      throw new GroupToolError(
        "group_plan_controls_dispatch：计划交给程序执行或等待用户；不要另行分派 / Plan dispatch belongs to the engine or is waiting for the user; do not assign independently.",
      );
  }
  private budget(groupId: string, root: string) {
    const ledger = this.service.deps.local.budgets.repo.get(root);
    if (!ledger || ledger.exhaustedReason)
      throw new RpcError(-32602, "group_plan_budget_unavailable");
    const group = new GroupExecutionLimitsRepo(this.service.deps.db).get(groupId);
    if (group.mode !== "execute") throw new RpcError(-32602, "group_plan_execute_required");
    const caps = [ledger.limits.costUsd, group.limits.costUsd].filter(
      (value): value is number => value !== null,
    );
    return caps.length ? Math.min(...caps) : null;
  }
  async submit(context: ToolRunContext, call: LocalToolCall, signal: AbortSignal) {
    const { disposition, ...plan } = call.input.plan as Record<string, unknown>;
    const { run } = this.scope(context);
    if (
      run.kind === "wake" &&
      run.automatic &&
      run.parentRunId &&
      run.triggerKey === `group-verification-owner:${run.parentRunId}`
    ) {
      const facts = new GroupVerificationRulesRepo(this.service.deps.db).assignment(
        run.groupId ?? "",
        run.parentRunId,
      );
      const source = this.service.runs.get(run.parentRunId);
      if (!facts || !source || source.groupId !== run.groupId || source.cycleId !== run.cycleId)
        throw new RpcError(-32602, "group_plan_scope_invalid");
      const checked = validateGroupPlan(
        plan,
        this.members(run.groupId ?? ""),
        undefined,
        implementationAuthors(facts),
      );
      if (!checked.ok)
        return this.service.planAttempts.failure(
          context,
          call,
          this.invalid(checked.issues, this.service.planAttempts.remaining(context)),
        );
      if (
        !checked.plan.steps.every((step) =>
          step.acceptance.some((item) => item.check === "verdict"),
        )
      )
        return this.service.planAttempts.failure(
          context,
          call,
          this.invalid(
            [{ code: "verdict_owner_invalid", path: ["steps"] }],
            this.service.planAttempts.remaining(context),
          ),
        );
      await this.verify(source, checked.plan, facts, signal);
      return { text: JSON.stringify({ status: "verification_submitted" }) };
    }
    return this.propose(context, plan, signal, "automatic", call.id, disposition);
  }
  /**
   * The coordinator run started by a saved-plan request submits that plan before the
   * model is called, through exactly the coordinator's path (validation, confirmation, budget
   * root, engine admission). An invalid template creates nothing; the coordinator then sees the
   * issues in its prompt facts and may rewrite like any rejected plan.
   */
  async submitTemplate(context: ToolRunContext, signal: AbortSignal) {
    if (this.closed || !context.groupId || !context.conversationId) return;
    const group = this.service.groups.get(context.groupId);
    const run = this.service.runs.get(context.runId);
    if (!group || !run?.cycleId) return;
    const template = templateRequest(this.service.deps.db, group, context, run.userMessageId);
    const prior = this.repo.forCycle(group.conversationId, run.cycleId);
    if (!template || (prior && !(prior.card.status === "modify" && prior.card.startFailure)))
      return;
    try {
      await this.propose(context, templatePlan(template), signal, "user");
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      // The prompt facts report what durable state shows (no card, or a card still starting).
      this.service.deps.logger.warn(
        JSON.stringify({
          module: "group-plan",
          event: "template_submit_failed",
          groupId: group.id,
          runId: context.runId,
          error: /^[a-z_]+$/.test(error.message) ? error.message : "rpc_error",
        }),
      );
    }
  }
  private async propose(
    context: ToolRunContext,
    input: unknown,
    signal: AbortSignal,
    actor: "user" | "automatic",
    callId = `template:${context.runId}`,
    disposition?: unknown,
  ): Promise<LocalToolResult> {
    const { group: currentGroup, run, cycleId } = this.scope(context);
    const group = this.service.workplaceGroup(context) ?? currentGroup;
    signal.throwIfAborted();
    const existing = this.repo.forCycle(group.conversationId, cycleId);
    const replacing = this.service.workflows.repo.replanning(context.runId);
    const failed = existing?.card.status === "modify" && !!existing.card.startFailure;
    if (existing?.card.status === "starting") {
      const recovered = await this.start(existing.message.id, signal);
      return { text: JSON.stringify({ status: recovered.status, planId: recovered.id }) };
    }
    if (existing && !failed && (!replacing || existing.card.originRunId === context.runId)) {
      if (existing.card.originRunId !== context.runId) return this.unchanged(run, existing.card);
      return {
        text: JSON.stringify({
          status: existing.card.status,
          planId: existing.card.id,
          ...this.deliveryNote(existing.card),
        }),
      };
    }
    this.service.planAttempts.guard(context, "group_plan");
    if (this.service.planAttempts.remaining(context) === 0) {
      this.service.planAttempts.hold(context);
      return this.invalid([{ code: "plan_rewrite_limit", path: [] }], 0);
    }
    const reject = (issues: Parameters<GroupDynamicPlans["invalid"]>[0]) =>
      this.service.planAttempts.failure(
        context,
        { id: callId, tool: "group_plan", input: {} },
        this.invalid(issues, this.service.planAttempts.remaining(context)),
      );

    const retained = retainCompletedPlan(
      input,
      replacing,
      replacing ? this.service.workflows.repo.steps(replacing.id) : [],
      { keepWaiting: !!replacing && repairableVerdicts(progressOf(replacing)).length > 0 },
    );
    input = retained.value;
    const members = this.members(group.id);
    const completed = new Set(
      replacing
        ? this.service.workflows.repo
            .steps(replacing.id)
            .filter((step) => step.status === "passed" || step.status === "skipped")
            .map((step) => step.stepId)
        : [],
    );
    const expanded = await expandPlanMethods(
      input,
      members,
      (botId, method) => this.methodContract(botId, group.id, method, signal),
      async (botId) => {
        const keys = await this.service.deps.local.skills?.planMethodKeys(botId, group.id, signal);
        return (keys ?? []).filter((key) => this.service.deps.redactor.redact(key) === key);
      },
      !!replacing,
      completed,
    );
    if (!expanded.ok) return reject(expanded.issues);
    const workplace = await groupWorkplace(this.service.deps.local, context.botId, group, signal);
    const access = workspaceFiles(this.service.deps.local, workplace.boundary);
    const primary = workplace.cwd;
    const previous = replacing ? workflowOf(replacing) : undefined;
    const normalized = await preparePlanDelivery(
      expanded.value,
      primary,
      signal,
      previous
        ? (previous.delivery ?? {
            workspaceRoot: primary,
            folder: previous.folder,
            rewrites: [],
          })
        : undefined,
      access,
      completed,
    );
    if (normalized.issues) return reject(normalized.issues);
    const agentReady = this.service.deps.local.externalAgentProvider?.stepReadiness;
    const recordedCode = changedDeliverableFiles(
      this.service.deps.local.workspaceServices?.changes.turn.repo.summarize(context.runId) ?? [],
      access.paths,
      primary,
    );
    const implementation = replacing ? progressOf(replacing).implementation : undefined;
    const author = implementation
      ? implementationAuthors(implementation)
      : recordedCode.length
        ? context.botId
        : undefined;
    const raw = validateGroupPlan(normalized.value, members, agentReady, author);
    if (!raw.ok) return reject(originalPlanIssues(raw.issues, input, normalized.value));
    const attempt = this.repo.attemptState(group.id, cycleId);
    // A saved template the user starts is theirs as written; only the coordinator's own plans are
    // sent back to share the work out.
    if (
      actor !== "user" &&
      !replacing &&
      !attempt?.delegationRequested &&
      needsDelegation(raw.plan, members, group.coordinatorBotId)
    ) {
      this.repo.saveAttemptState(group.id, {
        cycleId,
        errors: 0,
        extensions: 0,
        status: "open",
        messageId: null,
        sourceRunId: run.id,
        lastCall: null,
        ...attempt,
        delegationRequested: true,
      });
      return this.invalid(
        [
          {
            code: "plan_delegation_required",
            path: ["steps"],
            message:
              "请按成员专长重新分工，统筹不应承担过半交付步骤；本提示只退回一次 / Redistribute artifact steps by member expertise; the coordinator should not own a majority. This request is made once.",
          },
        ],
        this.service.planAttempts.remaining(context),
      );
    }
    const checked = validateGroupPlan(
      redactValue(raw.plan, this.service.deps.redactor),
      members,
      agentReady,
      author,
    );
    if (!checked.ok) return reject(originalPlanIssues(checked.issues, input, normalized.value));
    // Tell the coordinator what the program fixed, so the next submission is already valid.
    const corrections = [...retained.notes, ...raw.corrections].map((note) =>
      this.service.deps.redactor.redact(note),
    );
    if (planConfirmationRequired(this.service, context.runId, context.currentReplyText?.()))
      checked.plan.requiresConfirmation = true;
    const filenames = planFilenameIssues(
      checked.plan,
      this.service.deps.redactor.redact(planFilenameRequest(this.service, context.runId)),
    );
    if (filenames.length) return reject(filenames);
    const root = this.service.deps.local.budgets.root(context);
    if (failed && existing.card.budgetRootRunId !== root)
      throw new RpcError(-32602, "group_plan_stale");
    const budgetUsd = this.budget(group.id, root);
    const parsedCard = GroupPlanCardSchema.safeParse({
      schemaVersion: 1,
      id: randomUUID(),
      groupId: group.id,
      originRunId: run.id,
      cycleId,
      budgetRootRunId: root,
      ...(replacing ? { replacesWorkflowRunId: replacing.id } : {}),
      ...(replacing && progressOf(replacing).implementation
        ? { verification: progressOf(replacing).implementation }
        : {}),
      budgetUsd,
      ...(disposition === undefined
        ? {}
        : { disposition: redactValue(disposition, this.service.deps.redactor) }),
      ...(normalized.delivery
        ? { delivery: redactValue(normalized.delivery, this.service.deps.redactor) }
        : {}),
      plan: checked.plan,
      owners: checked.owners,
      // Revalidation sees already repaired edges; retain both passes' actual removals.
      ...(raw.droppedDependencies + checked.droppedDependencies
        ? { droppedDependencies: raw.droppedDependencies + checked.droppedDependencies }
        : {}),
      ...(replacing ? { relaxations: planRelaxations(replacing, checked.plan) } : {}),
      status: "ready",
    });
    if (!parsedCard.success)
      return reject([{ code: "group_plan_disposition_invalid", path: ["disposition"] }]);
    const card = parsedCard.data;
    if (
      card.relaxations?.length ||
      card.disposition?.action === "split_step" ||
      groupPlanNeedsConfirmation(card.plan, budgetUsd)
    )
      card.status = "pending";
    try {
      this.service.workflows.progress.replacement(card);
    } catch (error) {
      if (error instanceof RpcError) return reject([{ code: error.message, path: ["steps"] }]);
      throw error;
    }
    const message = transaction(this.service.deps.db, () => {
      this.scope(context);
      signal.throwIfAborted();
      this.service.planAttempts.guard(context, "group_plan");
      const latest = this.repo.forCycle(group.conversationId, cycleId);
      if (latest?.message.id !== existing?.message.id)
        throw new RpcError(RpcErrorCodes.busy, "group_plan_busy");
      const saved = this.repo.create(group.conversationId, context.botId, card);
      this.audit(card, actor === "user" ? "proposed_from_template" : "proposed", actor);
      return saved;
    });
    this.changed(message.id, card);
    const pause = () => {
      if (context.todoRun)
        context.todoRun.paused = {
          reason: "checkpoint",
          groupPlanId: card.id,
          summary: "Group plan handed to the program / 群计划已交给程序",
        };
    };
    if (card.status === "pending") {
      pause();
      return {
        text: JSON.stringify({
          status: "pending",
          planId: card.id,
          ...this.deliveryNote(card),
          ...this.correctionNote(corrections),
        }),
      };
    }
    if (!this.engine)
      return {
        isError: true,
        text: "group_plan_engine_unavailable / 计划已校验，执行引擎不可用，尚未开始；请停止 / Plan validated; engine unavailable, not started. Stop.",
      };
    const admitted = await this.start(message.id, signal);
    pause();
    return {
      text: JSON.stringify({
        status: admitted.status,
        planId: card.id,
        ...this.deliveryNote(admitted),
        ...this.correctionNote(corrections),
      }),
    };
  }
  async verify(source: Run, plan: GroupPlan, facts: GroupVerification, signal: AbortSignal) {
    if (this.closed || !source.groupId || !source.cycleId)
      throw new RpcError(-32602, "group_plan_stopped");
    const group = this.service.active(source.groupId, source.botId);
    const previous = this.repo.forVerification(group.conversationId, source.cycleId, source.id);
    if (previous) {
      if (previous.card.status === "ready" || previous.card.status === "starting")
        await this.start(previous.message.id, signal);
      return;
    }
    const root = this.service.deps.local.tasks.budgetRoot(source);
    const card = await verificationCard(
      this.service,
      source,
      plan,
      facts,
      this.budget(group.id, root),
      signal,
    );
    const saved = transaction(this.service.deps.db, () => {
      signal.throwIfAborted();
      const current = this.service.active(group.id, source.botId);
      this.assertCardGate(card);
      if (this.service.workflows.repo.activePlan(group.id, card.cycleId))
        throw new RpcError(-32602, "group_plan_busy");
      if (
        (current.workspaceRevision ?? 0) !== facts.workspaceRevision ||
        this.service.cycles.get(group.id).cycleId !== card.cycleId ||
        this.service.runs.get(source.id)?.status !== "done"
      )
        throw new RpcError(-32602, "group_plan_stale");
      if (this.repo.forVerification(group.conversationId, card.cycleId, source.id)) return;
      if (!this.service.auto(group.id, card.cycleId, () => true).value)
        return "round_limit" as const;
      const message = this.repo.create(group.conversationId, current.coordinatorBotId, card);
      this.audit(card, "proposed", "automatic");
      return message;
    });
    if (saved === "round_limit") throw new RpcError(-32602, "group_plan_round_limit");
    if (!saved) return;
    this.changed(saved.id, card);
    await this.start(saved.id, signal);
  }
  /**
   * Windows acceptance 2026-11-21: the user asked to re-plan a running plan's test and review as
   * sequential steps; the coordinator called group_plan, got this cycle's running card back as
   * {status:"started"} with "registered and scheduling steps", and told the user 「已按你的要求修改
   * 并启动」 while nothing had changed. A later run's submission never replaces the cycle's plan, so
   * the result says so as a failure, and a run answering the user's own message also gets a fixed
   * program line, so the user learns the truth even if the reply claims otherwise.
   */
  private unchanged(run: Run, card: GroupPlanCard): LocalToolResult {
    const waiting = card.status === "pending" || card.status === "ready";
    if (run.kind === "chat" && !this.unchangedNotices.has(run.id)) {
      if (this.unchangedNotices.size >= 200) this.unchangedNotices.clear();
      this.unchangedNotices.add(run.id);
      const group = this.service.groups.get(card.groupId);
      const zh = this.service.deps.chat.currentLanguage() === "zh";
      if (group) {
        new MessagesRepo(this.service.deps.db).create({
          conversationId: group.conversationId,
          botId: group.coordinatorBotId,
          role: "assistant",
          content: waiting
            ? zh
              ? "计划没有改动：计划卡还在等你点「开始」或「修改」。要改计划，请点卡片上的「修改」。"
              : "The plan was not changed: its card is still waiting for Start or Modify. To change the plan, tap Modify on the card."
            : zh
              ? "计划没有改动：正在进行的计划不会被新提交替换。要改步骤，请先在计划卡上或「任务」里点「停止计划」，再说要怎么改。"
              : "The plan was not changed: a running plan is never replaced by a new submission. To change its steps, tap Stop plan on the plan card or under Tasks first, then say how to change it.",
          status: "done",
          usage: { groupProgramNotice: { kind: "plan_unchanged" } },
        });
        this.service.changed(group.id, "updated");
      }
    }
    return {
      isError: true,
      text: JSON.stringify({
        code: "group_plan_unchanged",
        changed: false,
        status: card.status,
        planId: card.id,
        instruction: waiting
          ? "本次提交没有生效：本轮的计划卡仍在等用户点「开始 / 修改」，程序没有改它。不要说已修改或已开始；如实告诉用户计划没变，要改请点卡片上的「修改」。 / This submission did not take effect: this round's plan card still awaits the user's Start / Modify and the program did not change it. Do not claim it was changed or started; tell the user the plan is unchanged and that Modify on the card changes it."
          : "本次提交没有生效：本轮已有计划在执行（或已登记），程序没有修改、替换或重新开始它，原计划照旧进行。不要说已修改或已重新启动；如实告诉用户计划没变，要改步骤须先在计划卡上或「任务」里点「停止计划」，再提出新要求。 / This submission did not take effect: this round's plan is already running (or registered) and the program did not change, replace or restart it; the original plan continues. Do not claim it was changed or restarted; tell the user the plan is unchanged and that changing its steps needs Stop plan on the plan card or under Tasks first, then a new request.",
      }),
    };
  }
  /** Repairs are already applied to the saved plan; repeating them only wastes attempts. */
  private correctionNote(corrections: string[]) {
    return corrections.length
      ? {
          corrections,
          notes: corrections,
          correctionNote:
            "程序已自动修正这些格式问题，计划已按修正后的内容保存；下次直接按修正后的写法提交 / The program fixed these format mistakes and saved the plan as corrected; write them this way next time.",
        }
      : {};
  }
  private deliveryNote(card: GroupPlanCard) {
    return {
      instruction:
        card.status === "started"
          ? "计划已登记并开始安排步骤，不再等待开始确认；完成后若有人工项会另出核对卡 / Registered and scheduling steps; no Start confirmation is pending. Human checks, if any, come at the end."
          : card.status === "pending"
            ? "等待用户在计划卡点击开始或修改，尚未执行 / Await the user's Start or Modify on the plan card; not executing yet."
            : "仅按当前卡片状态报告；未确认登记前不要声称已开始 / Report only the current card state; do not claim it started before admission is confirmed.",
      ...(card.delivery?.rewrites.length
        ? {
            deliveryPaths: "已改为相对产物目录 / Paths made relative to the artifact folder",
            rewrites: card.delivery.rewrites,
          }
        : {}),
    };
  }

  /**
   * The step owner's method (built-in key first, then its own skill names) as the
   * group's runs see it. An unreadable skill is reported as unavailable, not as a crash.
   */
  private async methodContract(
    botId: string,
    groupId: string,
    method: string,
    signal: AbortSignal,
  ): Promise<SkillContract | undefined> {
    const skills = this.service.deps.local.skills;
    if (!skills) return undefined;
    try {
      const skill = await abortable(skills.findWorkflow(botId, method, groupId), signal);
      return skill ? (skillContract(skill.document).contract ?? undefined) : undefined;
    } catch (error) {
      if (signal.aborted) throw error;
      return undefined;
    }
  }
  private invalid(issues: PlanIssue[], remaining: number): LocalToolResult {
    return {
      isError: true,
      text: JSON.stringify({
        code: remaining ? "plan_invalid" : "plan_rewrite_limit",
        issues,
        rewritesRemaining: remaining,
        instruction: remaining
          ? "修正后重写 / Correct and resubmit"
          : "停止并说明阻塞 / Stop and explain the block",
      }),
    };
  }
  async resolve(params: KernelMethodParams["groups.plan.resolve"], signal: AbortSignal) {
    const entry = this.repo.get(params.messageId);
    const group = this.service.active(params.groupId);
    if (
      !entry ||
      entry.card.groupId !== group.id ||
      entry.message.conversationId !== group.conversationId ||
      entry.message.botId !== group.coordinatorBotId ||
      entry.card.cycleId !== this.service.cycles.get(group.id).cycleId
    )
      throw new RpcError(-32602, "group_plan_stale");
    this.assertCardGate(entry.card);
    if (params.decision === "check")
      return entry.card.status === "starting" ? this.start(entry.message.id, signal) : entry.card;
    if (params.decision === "start" || params.decision === "start_relaxed") {
      if (entry.card.relaxations?.length && params.decision !== "start_relaxed")
        throw new RpcError(-32602, "group_plan_relaxation_confirmation_required");
      return this.start(entry.message.id, signal, entry.card.status === "pending");
    }
    signal.throwIfAborted();
    if (entry.card.status === "modify") return entry.card;
    if (entry.card.status !== "pending" && entry.card.status !== "ready")
      throw new RpcError(-32602, "group_plan_already_started");
    const card = transaction(this.service.deps.db, () => {
      const next = this.repo.update(entry.message.id, { ...entry.card, status: "modify" });
      this.audit(next, "modify", "user");
      return next;
    });
    this.changed(entry.message.id, card);
    return card;
  }
  private assertCardGate(card: GroupPlanCard) {
    const state = this.repo.attemptState(card.groupId, card.cycleId);
    if (state && state.status !== "open") throw new RpcError(-32602, "group_plan_waits_for_user");
  }
  private start(messageId: string, signal: AbortSignal, confirm = false): Promise<GroupPlanCard> {
    const previous = this.jobs.get(messageId);
    if (previous) return previous;
    const job = this.startNow(messageId, signal, confirm).catch((error: unknown) =>
      this.failedStart(messageId, error),
    );
    this.jobs.set(messageId, job);
    void job
      .finally(() => this.jobs.delete(messageId))
      .catch(() => {
        // The RPC/tool caller owns the error; this branch only observes cleanup.
      });
    return job;
  }
  private async startNow(messageId: string, signal: AbortSignal, confirm: boolean) {
    const entry = this.repo.get(messageId);
    if (!entry) throw new RpcError(-32602, "group_plan_missing");
    this.assertCardGate(entry.card);
    if (entry.card.status === "started") return entry.card;
    if (this.closed || !this.engine)
      throw new RpcError(RpcErrorCodes.unsupported, "group_plan_engine_unavailable");
    const activeSignal = AbortSignal.any([
      signal,
      this.service.signal,
      AbortSignal.timeout(30_000),
    ]);
    activeSignal.throwIfAborted();
    if (
      entry.card.status === "starting" &&
      (await this.engine.admitted(entry.card.id, activeSignal))
    )
      return this.started(messageId, entry.card);
    activeSignal.throwIfAborted();
    if (entry.card.status === "modify") throw new RpcError(-32602, "group_plan_stale");
    const group = this.service.active(
      entry.card.groupId,
      entry.message.botId ?? undefined,
      entry.message.conversationId,
    );
    if (
      group.coordinatorBotId !== entry.message.botId ||
      group.paused ||
      this.service.cycles.get(group.id).limited ||
      this.service.cycles.get(group.id).cycleId !== entry.card.cycleId
    )
      throw new RpcError(-32602, "group_plan_stale");
    const checked = validateGroupPlan(
      entry.card.plan,
      this.members(group.id),
      undefined,
      implementationAuthors(entry.card.verification),
    );
    if (!checked.ok || JSON.stringify(checked.owners) !== JSON.stringify(entry.card.owners))
      throw new RpcError(-32602, "group_plan_owners_changed");
    const budgetUsd = this.budget(group.id, entry.card.budgetRootRunId);
    const confirmedByUser = entry.card.confirmedByUser || confirm;
    // Checking an uncertain admission is not a new confirmation, even after a budget change.
    if (
      !confirmedByUser &&
      (entry.card.relaxations?.length ||
        entry.card.disposition?.action === "split_step" ||
        groupPlanNeedsConfirmation(entry.card.plan, budgetUsd) ||
        // The program's own change check is a quality gate, not the coordinator's proposal: a
        // coordinator reply such as 「等小审确认」 held it at 「等你确认」 (video dry run 2026-11-20).
        (!entry.card.verification &&
          planConfirmationRequired(this.service, entry.card.originRunId)))
    ) {
      const pending = this.repo.update(messageId, { ...entry.card, budgetUsd, status: "pending" });
      this.changed(messageId, pending);
      return pending;
    }
    activeSignal.throwIfAborted();
    const card = this.repo.update(messageId, {
      ...entry.card,
      budgetUsd,
      confirmedByUser,
      status: "starting",
    });
    this.changed(messageId, card);
    // The engine owns idempotency and current authority revalidation after asynchronous admission waits.
    await this.engine.start({ card, conversationId: group.conversationId }, activeSignal);
    return this.started(messageId, card);
  }
  private async failedStart(messageId: string, error: unknown): Promise<GroupPlanCard> {
    const entry = this.repo.get(messageId);
    if (entry?.card.status !== "starting" || !this.engine) throw error;
    // A cancelled caller cannot cancel this reconciliation: stop() owns the job until it settles.
    let admitted: boolean;
    try {
      admitted = await this.engine.admitted(entry.card.id, AbortSignal.timeout(5_000));
    } catch {
      // Unknown admission stays fenced by starting; never invite a second execution.
      this.service.deps.logger.warn(
        JSON.stringify({ module: "group-plan", event: "admission_unknown", planId: entry.card.id }),
      );
      throw new RpcError(RpcErrorCodes.internal, "group_plan_admission_unknown");
    }
    if (admitted) return this.started(messageId, entry.card);
    const failure = groupPlanStartFailure(error, (value) =>
      this.service.deps.redactor.redact(value),
    );
    const card = transaction(this.service.deps.db, () => {
      const current = this.repo.get(messageId);
      if (current?.card.status !== "starting") throw error;
      const next = this.repo.update(messageId, {
        ...current.card,
        status: "modify",
        confirmedByUser: false,
        startFailure: failure,
      });
      this.audit(next, failure.code, "automatic");
      return next;
    });
    this.changed(messageId, card);
    throw error instanceof RpcError ? error : new RpcError(RpcErrorCodes.internal, failure.code);
  }
  private started(messageId: string, card: GroupPlanCard) {
    const result = transaction(this.service.deps.db, () => {
      const { startFailure: _failure, ...clean } = card;
      const started = this.repo.update(messageId, { ...clean, status: "started" });
      this.audit(started, "started", card.confirmedByUser ? "user" : "automatic");
      if (card.relaxations?.length)
        this.audit(
          started,
          hasAcceptanceRelaxation(card.relaxations)
            ? "acceptance_relaxed"
            : "delivery_requirements_changed",
          "user",
        );
      return started;
    });
    this.changed(messageId, result);
    return result;
  }
  changed(messageId: string, card: GroupPlanCard) {
    const entry = this.repo.get(messageId);
    if (entry)
      this.service.deps.peer.emit("groups.plan.changed", {
        groupId: card.groupId,
        conversationId: entry.message.conversationId,
        messageId,
        card: entry.card,
        updatedAt: entry.message.updatedAt,
      });
    this.service.changed(card.groupId, "updated");
  }
  private audit(card: GroupPlanCard, reasonCode: string, actor: "user" | "automatic") {
    const origin = this.service.runs.get(card.originRunId);
    if (!origin || origin.groupId !== card.groupId || origin.cycleId !== card.cycleId)
      throw new RpcError(-32602, "group_plan_source_unavailable");
    this.service.deps.local.approvals.audit.append({
      botId: origin.botId,
      runId: card.originRunId,
      kind: "execution.todo.changed",
      summary: "Group plan state changed / 群计划状态变更",
      detail: { groupId: card.groupId, target: card.id, reasonCode, actor },
    });
  }
  async stop() {
    this.closed = true;
    await Promise.allSettled([...this.jobs.values()]);
    this.engine = undefined;
  }
}
