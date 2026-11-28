import { createHash, randomUUID } from "node:crypto";
import { AgentError, mapAgentError } from "@pibot/agent";
import { DISPATCH_MODEL_CONFIRM, explainPolicyResult } from "@pibot/policy";
import {
  type Bot,
  type DispatchModel,
  type DispatchModelNeeds,
  type DispatchModelReason,
  type DispatchModelRoute,
  DispatchModelRouteSchema,
  IMPORTED_MAGPIE_PREFIX,
  isRetiredModel,
  type ModelOverride,
  messageDispatch,
  RpcError,
  RpcErrorCodes,
  resolveThinkingLevel,
} from "@pibot/protocol-base";
import {
  AuditRepo,
  BotsRepo,
  ChatNoticesRepo,
  ConversationsRepo,
  DispatchModelRoutesRepo,
  GroupTasksRepo,
  GroupWorkflowsRepo,
  MessagesRepo,
  RunEventsRepo,
  RunsRepo,
  SettingsRepo,
  ToolCallsRepo,
  transaction,
} from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { ChatRun, RunDependencies } from "../queue/chat-run.ts";
import { runModelOverride, withModelOverride } from "./run-model.ts";

const cooldownFailures = [
  "auth_failed",
  "billing",
  "quota_exhausted",
  "provider_overloaded",
  "rate_limited",
] as const;
const isCooldownFailure = (reason?: string): reason is (typeof cooldownFailures)[number] =>
  cooldownFailures.some((code) => code === reason);
const rank = { fast: 0, balanced: 1, strong: 2 };
const sameModel = (a?: { provider: string; id: string }, b?: { provider: string; id: string }) =>
  a?.provider === b?.provider && a?.id === b?.id;
const sameOverride = (a?: ModelOverride, b?: ModelOverride) =>
  sameModel(a, b) && a?.thinkingLevel === b?.thinkingLevel;

/** Prepared card data from the runtime, never accepted as Pi tool input. */
export interface DispatchRecoveryCard {
  dispatchRecovery: true;
  title: string;
  step?: string;
  bot: string;
  from: ModelOverride;
  to: DispatchModel;
  reason: DispatchModelReason;
}

export function dispatchThinkingLevel(bot: Bot, selection: ModelOverride, model: DispatchModel) {
  const levels = model.abilities.reasoning;
  return bot.category === "image"
    ? "off"
    : resolveThinkingLevel(
        { reasoning: levels.length > 0, thinkingLevels: levels },
        selection.thinkingLevel ??
          (bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference),
      );
}

export function dispatchModelProblem(
  bot: Bot,
  selection: ModelOverride,
  needs: DispatchModelNeeds,
  model: DispatchModel | undefined,
): DispatchModelReason | undefined {
  if (!model)
    return isRetiredModel(selection.provider, selection.id) ? "retired" : "model_not_found";
  if (!model.available) return model.reason;
  const ability = model.abilities;
  if (
    bot.kind === "agent" ||
    (bot.category === "image" ? !ability.imageOutput : !ability.text) ||
    (bot.category === "image" &&
      !model.imageModes?.includes(needs.imageInput ? "image-to-image" : "text-to-image")) ||
    (needs.imageInput && bot.category !== "image" && !ability.imageInput) ||
    (needs.imageOutput && (bot.category !== "image" || !ability.imageOutput)) ||
    (needs.video && !ability.video) ||
    (needs.reasoning && dispatchThinkingLevel(bot, selection, model) === "off") ||
    (selection.thinkingLevel &&
      selection.thinkingLevel !== dispatchThinkingLevel(bot, selection, model))
  )
    return "capability_mismatch";
}

export function dispatchStartupFailure(
  error: unknown,
  provider: string,
): DispatchModelReason | undefined {
  const code = mapAgentError(error);
  if (code === "no_model") return "model_not_found";
  if (
    code === "chatgpt_reconnect_required" ||
    code === "chatgpt_plan_denied" ||
    code === "chatgpt_plan_not_eligible" ||
    code === "claude_subscription_unsupported"
  )
    return "sign_in_required";
  if (
    code === "network" &&
    (provider === "ollama" || provider === "magpie" || provider.startsWith(IMPORTED_MAGPIE_PREFIX))
  )
    return "local_unreachable";
  if (isCooldownFailure(code)) return code;
}

/** A dispatch may change its scoped model before its first output. User overrides take precedence. */
export class DispatchRunModel {
  private readonly routes: DispatchModelRoutesRepo;
  private readonly conversations: ConversationsRepo;
  private readonly tasks: GroupTasksRepo;
  private readonly conversationId: string;
  private readonly scope: string;
  private route: DispatchModelRoute | undefined;
  private stored: DispatchModelRoute | undefined;
  private override: ModelOverride | undefined;
  private implicit = false;
  private recipient?: { provider: string; destination?: string };
  private retried = false;

  constructor(
    private readonly deps: RunDependencies,
    private readonly run: ChatRun,
    private readonly bot: Bot,
    override: ModelOverride | undefined,
    private readonly incomingHasImages: boolean,
  ) {
    this.routes = new DispatchModelRoutesRepo(deps.db);
    this.conversations = new ConversationsRepo(deps.db);
    this.tasks = new GroupTasksRepo(deps.db, (text) => deps.redactor.redact(text));
    const task = run.groupId && run.taskId ? this.tasks.get(run.taskId) : undefined;
    this.conversationId = task?.threadConversationId ?? run.conversationId;
    this.scope = task ? `task:${task.id}` : "topic";
    this.override = override;
    if (
      !deps.local?.models?.dispatchModels ||
      run.executionTaskId ||
      run.routine ||
      bot.kind === "agent"
    )
      return;
    const stored = this.routes.get(this.conversationId, this.scope);
    if (stored?.botId === bot.id && sameOverride(stored.model, override)) {
      this.route = this.stored = stored;
      return;
    }
    if (override || (run.groupId && !task)) return;

    // The Pi marker comes from a kernel-created source message or its inherited group plan.
    const workflows = new GroupWorkflowsRepo(deps.db);
    const step = task && workflows.byTask(task.id);
    const workflow = step && workflows.get(step.workflowRunId);
    const inherited = workflow?.workflow;
    const sourceId = task
      ? (workflow?.sourceMessageId ?? task.source?.messageId)
      : new RunsRepo(deps.db).get(run.runId)?.userMessageId;
    const source = sourceId && new MessagesRepo(deps.db).get(sourceId);
    const dispatch = source ? messageDispatch(source) : undefined;
    const dispatchId =
      inherited &&
      typeof inherited === "object" &&
      "piDispatchId" in inherited &&
      typeof inherited.piDispatchId === "string"
        ? inherited.piDispatchId
        : dispatch?.dispatchId;
    if (!dispatchId || !this.routes.origin(dispatchId, this.rootConversationId())) return;
    const model =
      bot.modelProvider && bot.modelId
        ? { provider: bot.modelProvider, id: bot.modelId }
        : bot.category === "chat"
          ? new SettingsRepo(deps.db).get().defaultModel
          : undefined;
    if (!model) return;
    this.implicit = true;
    this.route = {
      dispatchId,
      botId: bot.id,
      model,
      needs: dispatch?.modelNeeds ?? {},
      destination: deps.local.models.dispatchDestination?.(model.provider),
    };
  }

  get active() {
    return !!this.route;
  }

  assertRecipient = (provider: string, baseUrl?: string) => {
    const destination =
      baseUrl && createHash("sha256").update(new URL(baseUrl).origin).digest("hex");
    if (provider !== this.recipient?.provider || destination !== this.recipient?.destination)
      throw new AgentError("no_model");
  };

  private rootConversationId() {
    return this.conversations.get(this.conversationId)?.threadOf ?? this.conversationId;
  }

  private isCurrent() {
    const { db } = this.deps;
    const topic = this.conversations.get(this.conversationId);
    const bot = new BotsRepo(db).get(this.bot.id);
    return (
      !!topic &&
      !topic.archivedAt &&
      !!bot &&
      !bot.archivedAt &&
      bot.modelProvider === this.bot.modelProvider &&
      bot.modelId === this.bot.modelId &&
      bot.thinkingPreference === this.bot.thinkingPreference &&
      bot.thinkingLevel === this.bot.thinkingLevel &&
      bot.category === this.bot.category &&
      bot.kind === this.bot.kind &&
      (!this.run.taskId || this.tasks.get(this.run.taskId)?.status === "open") &&
      sameOverride(runModelOverride(db, this.bot, this.run), this.override) &&
      JSON.stringify(this.routes.get(this.conversationId, this.scope)) ===
        JSON.stringify(this.stored)
    );
  }

  private async approveReplacement(
    route: DispatchModelRoute,
    candidate: DispatchModel,
    reason: DispatchModelReason,
    recheck: () => Promise<boolean>,
    executionClock: ToolRunContext["executionClock"],
  ) {
    const origin = this.routes.origin(route.dispatchId, this.rootConversationId());
    const local = this.deps.local;
    const tool = this.run.groupId ? "send_to_group" : "send_to_bot";
    const describe = local?.toolCards.get(tool);
    if (!origin || !local || !describe || !this.isCurrent()) return false;
    const result = explainPolicyResult(
      {
        decision: "ask",
        category: "work_dispatch",
        reason: DISPATCH_MODEL_CONFIRM,
        risk: "normal",
        canRemember: false,
        facts: [],
      },
      "boundary",
      DISPATCH_MODEL_CONFIRM,
    );
    const { title, ...address } = origin;
    const step = this.run.taskId ? this.tasks.get(this.run.taskId)?.title : undefined;
    const language = this.deps.language();
    const call = {
      id: `dispatch-model:${route.dispatchId}:${randomUUID()}`,
      tool,
      input: { model: { provider: candidate.provider, id: candidate.id } },
    };
    const context = { ...address, signal: this.run.signal, language, executionClock };
    const prepared: DispatchRecoveryCard = {
      dispatchRecovery: true,
      title,
      step,
      bot: this.bot.name,
      from: route.model,
      to: candidate,
      reason,
    };
    const text = (language: "zh" | "en") => describe(context, call.input, language, prepared);
    const calls = new ToolCallsRepo(this.deps.db);
    const record = calls.create({
      messageId: address.messageId,
      toolCallId: call.id,
      tool: call.tool,
      summary: text(language).title,
    });
    let allowed = false;
    try {
      const status = await local.approvals.request(
        context,
        call,
        result,
        { available: true, reason: "command_isolation_not_applicable" },
        async () =>
          (await recheck())
            ? result
            : explainPolicyResult(
                { ...result, decision: "deny", reason: "changed" },
                "boundary",
                "changed",
              ),
        undefined,
        undefined,
        undefined,
        { text, lifetimeRunId: this.run.runId },
      );
      allowed = status === "allowed" && (await recheck());
      return allowed;
    } finally {
      calls.update(record.id, {
        status: allowed ? "done" : this.run.signal.aborted ? "aborted" : "blocked",
        finishedAt: new Date().toISOString(),
      });
    }
  }

  async resolve(
    failure?: DispatchModelReason,
    hasImages = this.incomingHasImages || this.conversations.hasImages(this.run.conversationId),
    executionClock?: ToolRunContext["executionClock"],
  ) {
    const original = this.route;
    const providers = this.deps.local?.models;
    if (!original || !providers) return undefined;
    const { signal } = this.run;
    signal.throwIfAborted();
    if (failure) {
      new RunEventsRepo(this.deps.db).append({
        runId: this.run.runId,
        conversationId: this.run.conversationId,
        kind: "model.startup_failed",
        payload: { provider: original.model.provider, model: original.model.id, error: failure },
      });
      if (this.retried) return undefined;
      this.retried = true;
    }
    const list = (deadline: AbortSignal) =>
      abortable(providers.dispatchModels?.(deadline) ?? Promise.resolve([]), deadline);
    const deadline = () => AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    const initial = deadline();
    const models = await list(initial);
    initial.throwIfAborted();
    const needs = { ...original.needs, ...(hasImages ? { imageInput: true } : {}) };
    const destination = (provider: string) => providers.dispatchDestination?.(provider);
    const workflowModel = this.implicit ? this.run.workflow?.contract.model : undefined;
    const thinking = workflowModel?.thinking;
    const bot = thinking
      ? { ...this.bot, thinkingLevel: thinking, thinkingPreference: thinking }
      : this.bot;
    const credentials = async (provider: string, checkSignal: AbortSignal) => {
      try {
        await abortable(providers.credentials(provider), checkSignal);
        return true;
      } catch {
        checkSignal.throwIfAborted();
        // The credential check can reject after the catalog snapshot was taken.
        return false;
      }
    };
    const requiresPrice = !!(
      this.run.budgetWorkflow?.contract.budget?.costUsd ??
      this.run.workflow?.contract.budget?.costUsd
    );
    const hasPrice = (model: DispatchModel) =>
      !requiresPrice ||
      [model.pricePerMillion.input, model.pricePerMillion.output].some((n) => n !== null && n > 0);
    // Preserve the member skill's configured auxiliary tier and bind the actual first recipient.
    const auxiliary =
      !failure && bot.category === "chat" && workflowModel?.tier === "cheap"
        ? new SettingsRepo(this.deps.db).get().auxiliaryModel
        : undefined;
    const auxiliaryModel = auxiliary && models.find((model) => sameModel(model, auxiliary));
    const useAuxiliary =
      auxiliary &&
      auxiliaryModel &&
      hasPrice(auxiliaryModel) &&
      !dispatchModelProblem(bot, auxiliary, needs, auxiliaryModel) &&
      (await credentials(auxiliary.provider, initial));
    const route: DispatchModelRoute = useAuxiliary
      ? { ...original, model: auxiliary, destination: destination(auxiliary.provider) }
      : original;
    this.route = route;
    const selected = models.find((model) => sameModel(model, route.model));
    const providerChanged = route.destination !== destination(route.model.provider);
    let problem: DispatchModelReason | undefined = providerChanged
      ? "provider_changed"
      : (failure ?? dispatchModelProblem(bot, route.model, needs, selected));
    if (!problem && !useAuxiliary && !(await credentials(route.model.provider, initial)))
      problem = "credentials_missing";
    const overrideFor = (model: DispatchModel): ModelOverride => ({
      provider: model.provider,
      id: model.id,
      ...(route.model.thinkingLevel ? { thinkingLevel: route.model.thinkingLevel } : {}),
    });
    const canUse = (model: DispatchModel) =>
      !dispatchModelProblem(bot, overrideFor(model), needs, model) && hasPrice(model);
    let model = selected;
    let nextOverride = this.override;
    let nextDestination = route.destination;
    if (problem) {
      const target = rank[selected?.tier ?? "balanced"];
      const candidates = models
        .filter((candidate) => !sameModel(candidate, route.model) && canUse(candidate))
        .sort(
          (a, b) =>
            Math.abs(rank[a.tier] - target) - Math.abs(rank[b.tier] - target) ||
            a.provider.localeCompare(b.provider, "en") ||
            a.id.localeCompare(b.id, "en"),
        );
      const sameProvider =
        !providerChanged && problem !== "credentials_missing"
          ? candidates.find((candidate) => candidate.provider === route.model.provider)
          : undefined;
      let approved = false;
      model = sameProvider;
      if (model && !(await credentials(model.provider, initial))) model = undefined;
      if (!model) {
        const checkedProviders = new Set([route.model.provider]);
        for (const proposal of candidates) {
          if (checkedProviders.has(proposal.provider)) continue;
          checkedProviders.add(proposal.provider);
          if (!(await credentials(proposal.provider, initial))) continue;
          const proposedDestination = destination(proposal.provider);
          const recheck = async () => {
            const checkSignal = deadline();
            const current = (await list(checkSignal)).find((entry) => sameModel(entry, proposal));
            return (
              !!current &&
              canUse(current) &&
              (await credentials(proposal.provider, checkSignal)) &&
              destination(proposal.provider) === proposedDestination &&
              this.isCurrent()
            );
          };
          approved = await this.approveReplacement(
            route,
            proposal,
            problem,
            recheck,
            executionClock,
          );
          if (approved) {
            model = proposal;
            nextDestination = proposedDestination;
          }
          // A denial applies to this recovery; do not open a second card.
          break;
        }
      }
      if (!model) {
        if (failure) return undefined;
        throw new AgentError(isCooldownFailure(problem) ? problem : "no_model");
      }
      const replacement = overrideFor(model);
      const { provider, id, name } = model;
      const label = (value: string) => this.deps.redactor.redact(value).slice(0, 300) || "—";
      const notice = {
        dispatchId: route.dispatchId,
        botId: this.bot.id,
        from: label(`${route.model.provider}/${route.model.id}`),
        to: label(`${name} (${provider}/${id})`),
        reason: problem,
      };
      const next = DispatchModelRouteSchema.parse({
        ...route,
        model: replacement,
        destination: nextDestination,
      });
      const notices = transaction(this.deps.db, () => {
        signal.throwIfAborted();
        if (!this.isCurrent() || destination(provider) !== nextDestination)
          throw new RpcError(RpcErrorCodes.busy, "model_override_changed");
        if (this.run.groupId && this.run.taskId)
          this.tasks.setTaskModel(this.run.taskId, replacement);
        else this.conversations.setTopicModel(this.conversationId, replacement);
        this.routes.set(this.conversationId, this.scope, next);
        new AuditRepo(this.deps.db, this.deps.redactor).append({
          botId: this.bot.id,
          runId: this.run.runId,
          kind: "pi.dispatch_model",
          summary: "Dispatch model switched / 派发模型已切换",
          detail: {
            actor: approved ? "user" : "system",
            reasonCode: notice.reason,
            conversationId: this.conversationId,
            ...(this.run.taskId ? { taskId: this.run.taskId } : {}),
            ...(this.run.groupId ? { groupId: this.run.groupId } : {}),
            providerId: provider,
            modelId: id,
            dispatchModelSwitch: { from: notice.from, to: notice.to, reason: notice.reason },
          },
        });
        const repo = new ChatNoticesRepo(this.deps.db);
        const root = this.conversations.get(this.conversationId)?.threadOf;
        return [...new Set([this.conversationId, ...(root ? [root] : [])])].map((conversationId) =>
          repo.addDispatchModelSwitch({ ...notice, conversationId }),
        );
      });
      this.route = this.stored = next;
      this.override = nextOverride = replacement;
      for (const item of notices) this.deps.peer.emit("chat.notice", item);
      this.deps.peer.emit("sidebar.changed", {
        conversationKey: this.run.groupId ? `group:${this.run.groupId}` : `dm:${this.bot.id}`,
      });
      if (this.run.taskId) {
        const task = this.tasks.get(this.run.taskId);
        if (task) this.deps.peer.emit("group.task", { task });
      }
    } else if (!this.isCurrent()) {
      throw new RpcError(RpcErrorCodes.busy, "model_override_changed");
    }
    if (!model) throw new AgentError("no_model");
    this.run.selectedModel = { provider: model.provider, id: model.id };
    this.recipient = { provider: model.provider, destination: nextDestination };
    return {
      override: nextOverride,
      bot: {
        ...withModelOverride(bot, nextOverride ?? route.model),
        thinkingLevel: dispatchThinkingLevel(bot, nextOverride ?? route.model, model),
      },
    };
  }
}
