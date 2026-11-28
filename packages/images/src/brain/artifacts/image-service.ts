import { randomUUID } from "node:crypto";
import { AgentError, type AgentRuntime, type LocalToolCall } from "@pibot/agent";
import type { LocalService, ToolRunContext } from "@pibot/brain/kit";
import {
  ApprovalChangedError,
  activeGroup,
  allowedByYolo,
  auditAutoAllow,
  auditYolo,
  authorizationSnapshot,
  authorizationUnchanged,
  resolveRunWorkplace,
  runPermissionScope,
  runPermissionSources,
  runPermissions,
  runYolo,
  ToolTimer,
} from "@pibot/brain/kit";
import {
  type Bot,
  canonicalImageModelId,
  type ImageGenerationOptions,
  type ImageMode,
  type ImageModelInfo,
  RpcError,
} from "@pibot/images-contract/full";
import type { PolicyResult } from "@pibot/policy";
import { explainPolicyResult, matchesRoutinePreauth } from "@pibot/policy";
import { BotsRepo, ConversationsRepo, MessagesRepo, RunsRepo, ToolCallsRepo } from "@pibot/storage";
import { imageCostCard } from "./image-cost-card.ts";

export class ImageApprovalDeclined extends AgentError {
  constructor(readonly model: Pick<ImageModelInfo, "provider" | "id">) {
    super("permission_denied");
  }
}

/**
 * The approved identity still holds: the same model, mode and provider configuration, and the
 * same authorization except for grants added since (the paid "don't ask again" this card stored).
 */
function sameIdentity(approved: string, current: string) {
  if (approved === current) return true;
  const [before, ...restBefore] = JSON.parse(approved) as [string, ...unknown[]];
  const [after, ...restAfter] = JSON.parse(current) as [string, ...unknown[]];
  return (
    JSON.stringify(restBefore) === JSON.stringify(restAfter) &&
    authorizationUnchanged(before, after)
  );
}

/** Image calls share policy/approval services, without pretending to be pi chat tools. */
export class ImageAuthorization {
  readonly timing = new ToolTimer();
  private snapshot?: string;
  private models: ImageModelInfo[] = [];
  private recordId?: string;
  private readonly previousTiming: ToolRunContext["toolTiming"];
  private readonly observeTiming: NonNullable<ToolRunContext["toolTiming"]>;
  constructor(
    private readonly local: LocalService,
    private readonly agent: AgentRuntime,
    private readonly bot: Bot,
    private readonly context: ToolRunContext,
    private readonly mode: ImageMode,
    private readonly referenceCount: number,
    private readonly options?: ImageGenerationOptions,
  ) {
    this.previousTiming = context.toolTiming;
    this.observeTiming = (id) => (id === this.callId ? this.timing : this.previousTiming?.(id));
    context.toolTiming = this.observeTiming;
  }

  private callId?: string;

  private identity() {
    const { local, bot, context } = this;
    context.signal.throwIfAborted();
    if (!local.execution.allows(context, "image_generation"))
      throw new AgentError("permission_denied");
    const current = new BotsRepo(local.deps.db).get(bot.id);
    const conversations = new ConversationsRepo(local.deps.db);
    const override = conversations.runModelOverride({
      botId: bot.id,
      conversationId: context.conversationId as string,
      groupId: context.groupId,
      taskId: context.taskId,
    });
    const provider = override?.provider ?? current?.modelProvider;
    const id = override?.id ?? current?.modelId;
    if (
      !current ||
      current.archivedAt ||
      current.category !== "image" ||
      id !== bot.modelId ||
      provider !== bot.modelProvider
    )
      throw new AgentError("no_model");
    const conversation = conversations.get(context.conversationId as string);
    if (context.groupId) {
      const group = activeGroup(local.deps.db, context.groupId, bot.id, context.conversationId);
      if (group.coordinatorBotId === bot.id) throw new AgentError("image_unsupported");
    } else if (
      conversation?.kind !== "dm" ||
      conversation.botId !== bot.id ||
      conversation.archivedAt
    )
      throw new AgentError("permission_denied");
    const run = new RunsRepo(local.deps.db).get(context.runId);
    const message = new MessagesRepo(local.deps.db).get(context.messageId);
    if (
      run?.status !== "running" ||
      run.botId !== bot.id ||
      run.messageId !== context.messageId ||
      run.conversationId !== context.conversationId ||
      message?.role !== "assistant" ||
      message.status !== "streaming" ||
      message.botId !== bot.id ||
      message.runId !== context.runId ||
      message.conversationId !== context.conversationId
    )
      throw new AgentError("permission_denied");
    if (context.routineRunId) local.unattendedAuthorization.record(context);
    const models = local.models;
    if (!models) throw new AgentError("no_model");
    const providerKeys = this.selections().map(({ provider }) => models.configurationKey(provider));
    return JSON.stringify([
      authorizationSnapshot(local, bot.id, context),
      [current.category, this.mode, provider, id],
      providerKeys,
    ]);
  }

  assertCurrent() {
    if (!this.snapshot || !sameIdentity(this.snapshot, this.identity()))
      throw new AgentError("permission_denied");
  }

  private selections() {
    if (this.options?.kind === "compare") return this.options.models;
    return [
      this.options?.model ?? { provider: this.bot.modelProvider ?? "", id: this.bot.modelId ?? "" },
    ];
  }

  private async currentModels() {
    if (!this.agent.listImageModels) throw new AgentError("no_model");
    const models = await this.agent.listImageModels({
      availableOnly: true,
      signal: AbortSignal.any([this.context.signal, AbortSignal.timeout(10_000)]),
    });
    return this.selections().map(({ provider, id }) => {
      const model = models.find(
        (item) => item.provider === provider && item.id === canonicalImageModelId(provider, id),
      );
      if (!model?.configured || !model.output.includes("image")) throw new AgentError("no_model");
      if (
        !model.modes.includes(this.mode) ||
        (model.maxReferences !== undefined && this.referenceCount > model.maxReferences)
      )
        throw new AgentError("image_mode_mismatch");
      return model;
    });
  }

  private async evaluate(): Promise<PolicyResult> {
    const end = this.timing.enter("policy");
    try {
      return await this.evaluateCurrent();
    } catch (error) {
      this.context.signal.throwIfAborted();
      if (
        (error instanceof AgentError &&
          ["permission_denied", "no_model", "image_unsupported"].includes(error.code)) ||
        (error instanceof RpcError && error.code === -32602)
      )
        return explainPolicyResult(
          {
            decision: "deny",
            reason: "changed",
            risk: "normal",
            facts: [],
            canRemember: false,
          },
          "boundary",
          "changed",
        );
      throw error;
    } finally {
      end();
    }
  }

  private async evaluateCurrent(): Promise<PolicyResult> {
    this.assertCurrent();
    const { local, context, bot } = this;
    const workplace = await resolveRunWorkplace(local, context, context.signal);
    const policy = await local.getPolicy(context.signal);
    const results = await Promise.all(
      this.models.map((model) =>
        policy.evaluate({
          botId: bot.id,
          request: {
            category: "image_generation",
            recipient: model.recipient,
            provider: model.provider,
            model: model.id,
          },
          grants: local.grants(bot.id, context),
          settings: runPermissions(local, context),
          permissionSources: runPermissionSources(local, context),
          workplace: workplace.value,
          yolo: runYolo(local, context),
          signal: context.signal,
        }),
      ),
    );
    this.assertCurrent();
    const denied = results.find(({ decision }) => decision === "deny");
    const result = denied ?? results[0];
    if (!result) throw new AgentError("no_model");
    if (!this.options || denied) return result;
    // The existing per-model grant covers the ordinary single request. The combined
    // confirmation binds every selected model and the number of requests in this run.
    const combined = {
      ...result,
      decision: "ask" as const,
      reason: "paid_generation_confirmation",
      canRemember: false,
    };
    delete combined.grantScope;
    return explainPolicyResult(combined, "boundary", "paid_generation_confirmation");
  }

  authorize() {
    return this.timing.measure("policy", () => this.authorizeCurrent());
  }

  private async authorizeCurrent() {
    this.context.permissionGroupId = runPermissionScope(this.local, this.context);
    const initial = this.identity();
    const models = await this.currentModels();
    const model = models[0];
    if (!model) throw new AgentError("no_model");
    this.models = models;
    if (this.identity() !== initial) throw new AgentError("permission_denied");
    this.snapshot = initial;
    const price = this.mode === "image-to-image" ? model.editPrice : model.generationPrice;
    const requestCount =
      this.options?.kind === "batch"
        ? (this.options.prompts?.length ?? this.options.count ?? 1)
        : models.length;
    const call: LocalToolCall = {
      id: randomUUID(),
      tool: "image_generation",
      input: {
        provider: model.provider,
        model: model.id,
        mode: this.mode,
        recipient: model.recipient,
        ...(this.options
          ? {
              kind: this.options.kind,
              count: requestCount,
              selections: models.map(({ provider, id, recipient }) => ({
                provider,
                id,
                recipient,
              })),
              size: this.options.size ?? "auto",
              ratio: this.options.ratio ?? "auto",
            }
          : {
              size: model.size ?? "auto",
              ...(model.aspectRatio ? { aspectRatio: model.aspectRatio } : {}),
              count: model.workflowOutput ? "workflow" : 1,
              ...(price ? { price: { ...price, references: this.referenceCount } } : {}),
            }),
      },
    };
    this.callId = call.id;
    this.local.budgets.beforeTool(this.context, call);
    // Approval persistence references a real operation record. This is an image
    // dispatch operation, not a fabricated pi tool invocation or chat session.
    this.recordId = new ToolCallsRepo(this.local.deps.db).create({
      messageId: this.context.messageId,
      toolCallId: call.id,
      tool: call.tool,
      summary: "Image generation / 图片生成",
      status: "running",
    }).id;
    await this.local.approvals.serial(
      this.context.runId,
      this.context.signal,
      async () => {
        const endPolicy = this.timing.enter("policy");
        try {
          const result = await this.evaluate();
          if (result.decision === "deny") {
            this.local.approvals.audit.append({
              botId: this.bot.id,
              runId: this.context.runId,
              kind: "policy.denied",
              summary: "Image generation denied / 图片生成被拒绝",
              detail: {
                toolName: "image_generation",
                category: "web",
                decision: "deny",
                target: model.recipient,
                reasonCode: result.reason,
                policySteps: result.explanation.map((step) => step.code),
              },
            });
            throw new AgentError("permission_denied");
          }
          const preauthId =
            !this.options && result.decision === "ask" ? this.routinePaidPreauth(model) : undefined;
          if (preauthId) {
            // Owner decision 2026-10-23: the routine's paid pre-approval stands in for the card, so a
            // scheduled run never waits up to a day for a generation the user already agreed to.
            auditAutoAllow(
              this.local,
              this.context,
              call,
              explainPolicyResult(
                { ...result, decision: "allow", reason: "routine_paid_preapproved" },
                "grant",
                "routine_paid_preapproved",
              ),
            );
            this.local.unattendedAuthorization.audit(this.context, "routine.preauth.allowed", {
              preauthId,
              reasonCode: "routine_paid_preapproved",
              policySteps: [
                ...result.explanation.map((step) => step.code),
                "routine_paid_preapproved",
              ],
            });
          } else if (result.decision === "ask") {
            let declined = false;
            const status = await this.local.approvals.request(
              this.context,
              call,
              result,
              { available: true },
              () => this.evaluate(),
              () => {
                try {
                  this.assertCurrent();
                } catch {
                  throw new ApprovalChangedError();
                }
              },
              {
                requested() {},
                resolved(approval) {
                  declined =
                    approval.explanation?.some((step) => step.code === "approval_user_denied") ??
                    false;
                },
              },
              undefined,
              this.options
                ? {
                    text: imageCostCard(
                      this.options,
                      requestCount,
                      models,
                      this.mode,
                      this.referenceCount,
                    ),
                  }
                : undefined,
            );
            if (status !== "allowed") {
              this.context.signal.throwIfAborted();
              if (declined)
                throw new ImageApprovalDeclined({ provider: model.provider, id: model.id });
              throw new AgentError("permission_denied");
            }
          }
          if (result.decision === "allow" && result.reason === "paid_grant_matched")
            auditAutoAllow(this.local, this.context, call, result);
          if (allowedByYolo(result)) {
            auditYolo(this.local, this.context, call, result);
            if (this.recordId)
              new ToolCallsRepo(this.local.deps.db).markYolo(this.recordId, result.risk);
          }
          // An approval authorizes the bound model/service, not a subsequently edited provider.
          await this.revalidate();
          const current = await this.evaluate();
          if (current.decision === "deny") throw new AgentError("permission_denied");
        } finally {
          endPolicy();
        }
      },
      this.timing,
    );
    return models;
  }

  /**
   * The routine pre-approval covering this exact Bot + model, or undefined. Only a saved,
   * enabled routine of this Bot (never a trial or chat run); the policy decision before it
   * already applied the web "never" level and the network allowlist.
   */
  private routinePaidPreauth(model: ImageModelInfo): string | undefined {
    const { local, context, bot } = this;
    if (!context.routineRunId || context.routineSource !== "routine") return undefined;
    const record = local.unattendedAuthorization.record(context);
    if (!record?.routineId || record.reason === "trial") return undefined;
    const routine = local.unattended?.definition(record.routineId);
    if (!routine || routine.deletedAt || !routine.enabled || routine.botId !== bot.id)
      return undefined;
    const wanted = {
      category: "web" as const,
      scope: { kind: "paid_image" as const, provider: model.provider, model: model.id },
    };
    return routine.preauth.find(
      (p) => !p.revokedAt && matchesRoutinePreauth(p.operation, wanted, local.deps.platform),
    )?.id;
  }

  async revalidate() {
    this.assertCurrent();
    const current = await this.currentModels();
    if (JSON.stringify(current) !== JSON.stringify(this.models))
      throw new AgentError("permission_denied");
    this.assertCurrent();
  }

  finish(status: "done" | "error" | "aborted") {
    try {
      if (this.recordId)
        new ToolCallsRepo(this.local.deps.db).update(this.recordId, {
          status,
          performance: this.timing.finish(),
          finishedAt: new Date().toISOString(),
        });
    } finally {
      if (this.context.toolTiming === this.observeTiming)
        this.context.toolTiming = this.previousTiming;
    }
  }
}
