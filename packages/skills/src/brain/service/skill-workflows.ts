import type { DatabaseSync } from "node:sqlite";
import type { CapabilityContext, RegisterRpc, WorkflowSkill } from "@pibot/brain/kit";
import { parseSkillFile, prepareWorkflow, skillContract } from "@pibot/brain/kit";
import {
  RpcError,
  RpcErrorCodes,
  type SavedPlanSummary,
  SkillContractSchema,
  type SkillDocument,
  WORKFLOW_ESTIMATE_SAMPLES,
  WORKFLOW_LIST_MAX,
  type WorkflowEstimate,
  type WorkflowSummary,
} from "@pibot/skills-contract/full";
import { BotsRepo, GroupsRepo, GroupWorkflowsRepo, RunRecoveryRepo } from "@pibot/storage";
import { savedPlanState } from "./saved-plan-state.ts";
import { readSkillFile, skillFolder } from "./skill-files.ts";
import { skillProvenance } from "./skill-provenance.ts";
import type { SkillService } from "./skill-service.ts";
import { canonicalWorkflowContract } from "./skill-service.ts";

/** Pre-checks stat a few user-chosen paths; the whole request stays well under a chat send's. */
const RUN_PREPARE_MS = 20_000;

function resolveStepOwners(
  db: DatabaseSync,
  groupId: string,
  contract: NonNullable<WorkflowSummary["contract"]>,
  overrides: Record<string, string> | undefined,
) {
  const group = new GroupsRepo(db).get(groupId);
  if (!group) throw new RpcError(RpcErrorCodes.invalidParams, "workflow_group_unavailable");
  const bots = new BotsRepo(db);
  const members = group.members.flatMap((member) => {
    const bot = bots.get(member.botId);
    return bot && !bot.archivedAt ? [bot] : [];
  });
  const owners: { stepId: string; botId: string }[] = [];
  const required = new Map<string, { botId: string; name: string }[]>();
  for (const step of contract.steps ?? []) {
    const owner = step.owner;
    if ("botId" in owner) {
      if (!members.some((bot) => bot.id === owner.botId))
        throw new RpcError(RpcErrorCodes.invalidParams, "workflow_step_owner_unavailable");
      owners.push({ stepId: step.id, botId: owner.botId });
      continue;
    }
    const matches = members.filter((bot) => bot.role?.id === owner.role);
    if (matches.length === 1 && matches[0]) {
      owners.push({ stepId: step.id, botId: matches[0].id });
      continue;
    }
    const override = overrides?.[owner.role];
    const selected = override ? members.find((bot) => bot.id === override) : undefined;
    if (selected) owners.push({ stepId: step.id, botId: selected.id });
    else
      required.set(
        owner.role,
        members.map((bot) => ({ botId: bot.id, name: bot.name.slice(0, 200) })),
      );
  }
  return {
    owners,
    required: [...required].map(([role, candidates]) => ({ role, candidates })),
  };
}

/**
 * The Bot's skills that carry a work contract, read from their files (bounded, no model).
 * An invalid contract is listed with `contract: null` and its warning, never dropped silently.
 */
export async function listWorkflows(
  service: SkillService,
  botId: string,
  signal: AbortSignal,
): Promise<WorkflowSummary[]> {
  service.activeBot(botId);
  const items: WorkflowSummary[] = [];
  // Built-in methods are own rows: each workflow is listed once, as the Bot has it.
  for (const record of service.repo.forExport(botId).slice(0, WORKFLOW_LIST_MAX)) {
    signal.throwIfAborted();
    if (items.length >= WORKFLOW_LIST_MAX) break;
    let parsed: ReturnType<typeof parseSkillFile>;
    let document: SkillDocument;
    try {
      parsed = parseSkillFile(
        await readSkillFile(
          service.deps.dataDir,
          botId,
          await service.readLocation(record, signal),
          signal,
        ),
      );
      document = await service.document(record, signal);
    } catch {
      signal.throwIfAborted();
      // An unreadable file is not offered as a workflow; the skills panel reports it.
      continue;
    }
    if (!document.contract) continue;
    const { contract, verified, warnings } = skillContract(
      document,
      document.version === undefined ? parsed.metadata["pibot-version"] : String(document.version),
    );
    items.push({
      skillId: record.id,
      name: record.name,
      description: record.description,
      enabled: record.enabled,
      version: document.version ?? null,
      ...(verified ? { verified } : {}),
      contract,
      params: document.params,
      warnings,
    });
  }
  return items;
}

/**
 * The provenance of a 「常用计划」 is recorded only for a passed dynamic plan of this group
 * whose draft is saved as a plan template; nothing in a document or an import can claim it.
 */
function verifyPlanSource(
  db: DatabaseSync,
  groupId: string | undefined,
  workflowRunId: string,
  canonicalContract: string,
) {
  const record = groupId ? new GroupWorkflowsRepo(db).get(workflowRunId) : undefined;
  const source = (record?.workflow as { source?: { kind?: unknown } } | undefined)?.source;
  if (
    !record ||
    record.groupId !== groupId ||
    record.status !== "passed" ||
    (groupId && savedPlanState(db, groupId, workflowRunId).state === "rerun") ||
    source?.kind !== "dynamic" ||
    !SkillContractSchema.parse(JSON.parse(canonicalContract)).planTemplate
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "workflow_plan_source_invalid");
}

/**
 * The group's saved plans. They are always a member's own group skills (saving a plan
 * goes through `skills.createWorkflow` with the group), so members without any are skipped.
 */
async function savedPlans(
  service: SkillService,
  db: DatabaseSync,
  groupId: string,
  signal: AbortSignal,
): Promise<SavedPlanSummary[]> {
  const group = new GroupsRepo(db).get(groupId);
  if (!group) throw new RpcError(RpcErrorCodes.invalidParams, "workflow_group_unavailable");
  const items: SavedPlanSummary[] = [];
  for (const { botId } of group.members) {
    if (items.length >= WORKFLOW_LIST_MAX) break;
    if (!service.builtins.repo.hasOwn(botId)) continue;
    let listed: WorkflowSummary[];
    try {
      listed = await listWorkflows(service, botId, signal);
    } catch (error) {
      // An archived or unavailable member's skills are not offered; the others still are.
      if (error instanceof RpcError) continue;
      throw error;
    }
    for (const item of listed) {
      const contract = item.contract;
      // Provenance decides membership; a contract that merely declares planTemplate does not.
      if (!service.repo.get(item.skillId)?.savedFromPlan) continue;
      if (!contract?.planTemplate || !contract.steps?.length) continue;
      items.push({
        botId,
        skillId: item.skillId,
        name: item.name,
        description: item.description,
        enabled: item.enabled,
        version: item.version,
        stepCount: contract.steps.length,
        estimatedCostUsd: contract.planTemplate.estimatedCostUsd,
      });
    }
  }
  return items.slice(0, WORKFLOW_LIST_MAX);
}

/**
 * The member's one enabled contract skill whose deliverables include a file the coordinator
 * expects back (matched by file name), so a hand-off runs under that contract, budget and model
 * tier even when the coordinator did not name the workflow. Ambiguous or no
 * match: undefined, and the hand-off stays a plain task.
 */
export async function workflowForFiles(
  service: SkillService,
  botId: string,
  files: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const wanted = new Set(files.map((file) => file.split(/[\\/]/).at(-1)?.toLowerCase() ?? ""));
  const matches = (await listWorkflows(service, botId, signal)).filter(
    (item) =>
      item.enabled &&
      item.contract?.deliverables.some((d) =>
        wanted.has(d.path.split("/").at(-1)?.toLowerCase() ?? ""),
      ),
  );
  return matches.length === 1 ? matches[0]?.skillId : undefined;
}

/** One of this Bot's skills as a workflow run needs it (body, contract, folder). */
export async function workflowSkill(
  service: SkillService,
  botId: string,
  skillId: string,
): Promise<WorkflowSkill> {
  const record = service.require(skillId);
  if (record.botId !== botId) throw new RpcError(RpcErrorCodes.invalidParams, "skill_not_found");
  service.activeBot(botId);
  return {
    id: record.id,
    document: await service.document(record),
    baseDir: skillFolder(service.deps.dataDir, botId, service.location(record)),
    provenance: skillProvenance(record),
  };
}

/**
 * The enabled contract skill a coordinator names for a member (`assign_task.workflow`).
 * Matches the id, the display name (case and width folded) or the folder name; only skills that
 * carry a contract count, so a plain skill of the same name is never run as a workflow.
 */
export async function findWorkflow(
  service: SkillService,
  botId: string,
  name: string,
): Promise<WorkflowSkill | undefined> {
  service.activeBot(botId);
  const wanted = name.normalize("NFKC").trim().toLowerCase();
  // A built-in method is found by its key first, whatever the row is called now.
  const enabled = service.repo.enabledForPrompt(botId);
  const record =
    enabled.find((item) => item.builtinKey === wanted) ??
    enabled.find(
      (item) =>
        item.id === name ||
        item.name.normalize("NFKC").trim().toLowerCase() === wanted ||
        item.path.split("/").at(-1)?.toLowerCase() === wanted,
    );
  if (!record) return undefined;
  const skill = await workflowSkill(service, botId, record.id);
  return skill.document.contract ? skill : undefined;
}

/**
 * What the run form shows before a run (no model call). The median of the last few priced
 * runs of the same skill and version here (`RunRecoveryRepo.workflowCosts`); with no history only
 * the contract's cap, which the form labels as a cap, not an estimate.
 */
export function workflowEstimate(
  db: DatabaseSync,
  skill: WorkflowSkill,
  scope: { botId: string; groupId?: string },
): WorkflowEstimate {
  const { contract } = skillContract(skill.document);
  if (!contract) throw new RpcError(RpcErrorCodes.invalidParams, "workflow_contract_invalid");
  const costs = new RunRecoveryRepo(db).workflowCosts(
    skill.id,
    skill.document.version ?? null,
    scope,
    WORKFLOW_ESTIMATE_SAMPLES,
  );
  return {
    estimateUsd: median(costs),
    samples: costs.length,
    capUsd: contract.budget?.costUsd ?? null,
  };
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.round(value * 10_000) / 10_000;
}

/**
 * A new private or group topic for one workflow run; a group that is busy (or cannot open a topic
 * right now) keeps the current one rather than failing the run.
 */
async function freshWorkflowTopic(
  ctx: Pick<CapabilityContext, "groups" | "bots">,
  botId: string,
  groupId: string | undefined,
  current: string | undefined,
): Promise<string | undefined> {
  if (!groupId) return (await ctx.bots.newTopic(botId)).id;
  try {
    return (await ctx.groups.newTopic(groupId)).conversationId;
  } catch (error) {
    if (error instanceof RpcError) return current;
    throw error;
  }
}

/**
 * `skills.workflows` and `skills.runWorkflow`. A run reads the member's effective skills (the
 * same set its runs use), runs the program's pre-checks and only then sends the visible
 * workflow message through the ordinary chat or group admission. Blocked runs start nothing.
 */
export function registerWorkflowRpc(
  handle: RegisterRpc,
  owner: {
    effectiveFor(botId: string, groupId?: string): SkillService;
    skillsFor(groupId?: string): SkillService;
    idempotentWrite<T>(
      requestId: string,
      input: unknown,
      signal: AbortSignal,
      action: (queueSignal: AbortSignal) => Promise<T>,
    ): Promise<T>;
  },
  ctx: Pick<
    CapabilityContext,
    "chat" | "groups" | "host" | "bots" | "db" | "agent" | "credentials" | "redactor" | "logger"
  >,
  signal: AbortSignal,
) {
  handle(
    "skills.createWorkflow",
    async ({ botId, groupId, requestId, document, fromPlan }, context) => {
      const input = {
        ...document,
        contract: canonicalWorkflowContract(document.contract, "document.contract", {
          db: ctx.db,
          groupId,
        }),
        version: 1,
      };
      if (fromPlan) verifyPlanSource(ctx.db, groupId, fromPlan.workflowRunId, input.contract);
      return owner.idempotentWrite(
        requestId,
        { method: "skills.createWorkflow", botId, groupId, input, fromPlan },
        context.signal,
        (queueSignal) =>
          owner.skillsFor(groupId).create(botId, input, "taught", {
            queueSignal,
            ...(fromPlan ? { savedFromPlan: fromPlan } : {}),
          }),
      );
    },
  );
  handle("skills.workflows", async ({ botId, groupId }) => ({
    items: await listWorkflows(owner.effectiveFor(botId, groupId), botId, signal),
  }));
  handle("skills.savedPlans", async ({ groupId }) => ({
    items: await savedPlans(owner.skillsFor(groupId), ctx.db, groupId, signal),
  }));
  handle("skills.planSaveState", async ({ groupId, workflowRunId }) =>
    savedPlanState(ctx.db, groupId, workflowRunId),
  );
  handle("skills.pickWorkflowInput", async ({ botId, groupId, kind, defaultPath }) => {
    owner.effectiveFor(botId, groupId).activeBot(botId);
    const pickSignal = AbortSignal.any([signal, AbortSignal.timeout(660_000)]);
    if (kind === "folder") {
      if (!ctx.host.pickFolder)
        throw new RpcError(RpcErrorCodes.unsupported, "workflow_picker_unavailable");
      return ctx.host.pickFolder(pickSignal);
    }
    if (!ctx.host.pickFile)
      throw new RpcError(RpcErrorCodes.unsupported, "workflow_picker_unavailable");
    return ctx.host.pickFile(pickSignal, defaultPath ? { defaultPath } : undefined);
  });
  handle("skills.workflowEstimate", async ({ botId, groupId, skillId }) =>
    workflowEstimate(
      ctx.db,
      await workflowSkill(owner.effectiveFor(botId, groupId), botId, skillId),
      { botId, ...(groupId ? { groupId } : {}) },
    ),
  );
  handle("skills.runWorkflow", async ({ botId, groupId, skillId, freshTopic, ...request }) => {
    const skill = await workflowSkill(owner.effectiveFor(botId, groupId), botId, skillId);
    const prepared = await prepareWorkflow(
      skill,
      {
        params: request.params ?? {},
        inputs: request.inputs ?? {},
        ...(request.costCapUsd === undefined ? {} : { costCapUsd: request.costCapUsd }),
      },
      AbortSignal.any([signal, AbortSignal.timeout(RUN_PREPARE_MS)]),
      undefined,
      ctx.logger,
    );
    if (!prepared.ok)
      return {
        status: "blocked" as const,
        code: "workflow_precheck_failed" as const,
        failures: prepared.failures,
      };
    if (!groupId && prepared.workflow.contract.steps?.length)
      throw new RpcError(RpcErrorCodes.invalidParams, "workflow_group_required");
    // A saved plan's owners are judged by the plan validation at submission, where a
    // member who left is reported like in any invalid plan, never resolved here.
    if (
      groupId &&
      prepared.workflow.contract.steps?.length &&
      !prepared.workflow.contract.planTemplate
    ) {
      const resolved = resolveStepOwners(
        ctx.db,
        groupId,
        prepared.workflow.contract,
        request.ownerOverrides,
      );
      if (resolved.required.length)
        return { status: "owners_required" as const, roles: resolved.required };
      prepared.workflow.stepOwners = resolved.owners;
    }
    // A new topic only after the pre-checks passed, so a blocked run leaves none behind.
    const conversationId = freshTopic
      ? await freshWorkflowTopic(ctx, botId, groupId, request.conversationId)
      : request.conversationId;
    const sent = groupId
      ? await ctx.groups.sendWorkflow(groupId, botId, prepared.workflow, conversationId)
      : await ctx.chat.sendWorkflow(botId, prepared.workflow, conversationId);
    // Both senders always name the topic they used; the shared result type leaves it optional.
    if (!sent.conversationId) throw new RpcError(RpcErrorCodes.internal, "workflow_topic_missing");
    // A workflow run hands the body over directly, so the read_file path that records "last
    // used" never fires; without this the profile kept saying "never used" (sweep 2026-10-28 B10).
    const used = owner.effectiveFor(botId, groupId);
    used.markUsed(used.require(skillId));
    return {
      status: "started" as const,
      runId: sent.runId,
      conversationId: sent.conversationId,
      userMessageId: sent.userMessageId,
      assistantMessageId: sent.assistantMessageId,
      ...(groupId ? { groupId } : {}),
    };
  });
}
