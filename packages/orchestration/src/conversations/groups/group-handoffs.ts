import type { ToolInput, ToolRunContext } from "@pibot/brain/orchestration-kit";
import {
  GroupToolError,
  pipelineWorkflow,
  prepareWorkflow,
  redactValue,
  resolvePersonaLanguage,
  resolveWorkflowFolder,
  skillContract,
  type WorkflowRun,
  type WorkspaceFileAccess,
  workspaceFiles,
} from "@pibot/brain/orchestration-kit";
import {
  type Bot,
  type Group,
  type GroupTask,
  type HandoffPipeline,
  type HandoffResult,
  type HandoffSpec,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { GroupHandoffsRepo, type HandoffRecord, SettingsRepo } from "@pibot/storage";
import { groupDeliveryRun } from "./group-delivery-run.ts";
import { GroupHandoffCheckCache } from "./group-handoff-cache.ts";
import { handoffUnmet } from "./group-handoff-check.ts";
import { prepareHandoffCheck } from "./group-handoff-context.ts";
import { inputsFromText } from "./group-handoff-inputs.ts";
import { handoffBrief, signOffText } from "./group-handoff-text.ts";
import type { GroupService } from "./group-service.ts";
import { boundedReportItems } from "./group-verdict-results.ts";

type AssignArgs = Extract<ToolInput, { tool: "assign_task" }>["args"];
/** Local stats and small reads; a stuck drive must not hold the wake. */
const CHECK_MS = 30_000;
const PREPARE_MS = 20_000;
const SIGN_OFF_CACHE = 200;

export interface PlannedHandoff {
  spec: HandoffSpec;
  pipeline: HandoffPipeline | null;
  baseFolder: string | null;
  /** The member's contract skill as a workflow run (body injected, delivery checked). */
  workflow?: WorkflowRun;
  /** Appended to the member's task prompt. */
  brief: string;
}

export type HandoffGate =
  | { kind: "plain" }
  | { kind: "wait" }
  | { kind: "wake"; record: HandoffRecord; text: string; workflow?: WorkflowRun }
  | { kind: "return" | "stop"; record: HandoffRecord };

/**
 * Structured hand-offs. At assignment the program resolves the member's
 * workflow, runs its pre-checks and fixes the folder results are judged in. When the member
 * finishes, the program checks files and acceptance items (local, no model) and either wakes the
 * coordinator with the facts, sends the result back once, or stops for the user. The send-back
 * and stop themselves live in `group-handoff-actions.ts`; this class plans and gates.
 */
export class GroupHandoffs {
  readonly repo: GroupHandoffsRepo;
  private readonly checks: GroupHandoffCheckCache;
  private readonly preparing = new Map<string, Promise<void>>();
  /** The coordinator's workflow for each sign-off wake (null: continue without it). */
  private readonly signOff = new Map<string, WorkflowRun | null>();
  constructor(private readonly service: GroupService) {
    this.repo = new GroupHandoffsRepo(service.deps.db);
    this.checks = new GroupHandoffCheckCache(() => service.deps.local.officeProvider);
  }

  deliveryRun(context: ToolRunContext, workflow?: WorkflowRun) {
    return groupDeliveryRun(this.service, context, workflow, this.checks);
  }

  language(): "zh" | "en" {
    return resolvePersonaLanguage(
      new SettingsRepo(this.service.deps.db).get().language,
      Intl.DateTimeFormat().resolvedOptions().locale,
    );
  }

  /**
   * Structured when the coordinator says what must come back, or when it assigns from inside a
   * workflow (its own workflow run, or the sign-off run of an earlier hand-off of that workflow).
   * Plain assignments from free discussion return undefined and keep spending automatic rounds.
   */
  async plan(
    context: ToolRunContext,
    group: Group,
    target: Bot,
    args: AssignArgs,
    signal: AbortSignal,
  ): Promise<PlannedHandoff | undefined> {
    const pipeline =
      context.workflowPipeline?.pipeline ?? this.repo.byWakeRun(context.runId)?.pipeline ?? null;
    if (!args.workflow && !args.expectedOutput && !args.doneWhen && !pipeline) return undefined;
    const access = context.runWorkplace
      ? workspaceFiles(this.service.deps.local, context.runWorkplace.boundary)
      : undefined;
    // A workflow's sign-off reads the real period folder at once, before any merge, so it stays
    // serial. Expected files are judged inside the member's workspace (maintainers 2026-11-14).
    if (args.executionMode === "parallel" && args.workflow)
      throw new GroupToolError("handoff_serial_required");
    if (args.doneWhen?.acceptance && !args.workflow)
      throw new GroupToolError("handoff_workflow_required");
    const primary = context.runWorkplace?.boundary.primaryPath ?? null;
    // A member whose contract skill delivers the expected file runs that
    // workflow even when the coordinator did not name it (its budget, cheap tier, checks) —
    // inside a workflow, and in free-form group work too (maintainers 2026-10-23).
    const auto =
      !args.workflow && args.expectedOutput?.files?.length && args.executionMode !== "parallel"
        ? await this.service.deps.local.skills
            ?.workflowForFiles(target.id, args.expectedOutput.files, group.id, signal)
            .catch(() => {
              signal.throwIfAborted();
              // A skill that cannot be read is no reason to fail the hand-off; it stays plain.
              return undefined;
            })
        : undefined;
    const workflow = args.workflow
      ? await this.memberWorkflow(target, group, args.workflow, pipeline, primary, signal, access)
      : auto
        ? await this.autoWorkflow(target, group, auto, args, pipeline, primary, signal, access)
        : undefined;
    const acceptance = workflow ? this.acceptance(workflow, args.doneWhen?.acceptance) : [];
    const used = new Set(
      acceptance.flatMap((item) => (item.deliverable ? [item.deliverable] : [])),
    );
    const spec: HandoffSpec = {
      ...(primary
        ? {
            deliveryLocation: {
              workspaceRoot: primary,
              location: access?.location,
              workspaceRevision: access?.revision,
              originals: [],
            },
          }
        : {}),
      workflow: workflow
        ? {
            skillId: workflow.skillId,
            name: workflow.name.slice(0, 200),
            version: workflow.version,
          }
        : null,
      files: args.expectedOutput?.files ?? [],
      form: args.expectedOutput?.form ?? null,
      condition: args.doneWhen?.condition ?? null,
      deliverables: workflow ? workflow.contract.deliverables.filter((d) => used.has(d.id)) : [],
      acceptance,
    };
    const baseFolder = workflow?.folder ?? pipeline?.folder ?? primary;
    return {
      spec,
      pipeline,
      baseFolder,
      ...(workflow ? { workflow } : {}),
      brief: this.service.deps.redactor.redact(
        handoffBrief(spec, baseFolder, context.language ?? this.language()),
      ),
    };
  }

  /**
   * An automatic match is a speed-up, never a new way to fail: outside a workflow its inputs come
   * from paths the assignment mentions, and if the skill still cannot start (pre-checks, missing
   * input) the hand-off goes ahead as a plain task.
   */
  private async autoWorkflow(
    target: Bot,
    group: Group,
    skillId: string,
    args: AssignArgs,
    pipeline: HandoffPipeline | null,
    primary: string | null,
    signal: AbortSignal,
    access?: WorkspaceFileAccess,
  ): Promise<WorkflowRun | undefined> {
    try {
      let inputs: Record<string, string> = {};
      if (!pipeline) {
        const skill = await this.service.deps.local.skills?.findWorkflow(
          target.id,
          skillId,
          group.id,
        );
        const contract = skill ? skillContract(skill.document).contract : undefined;
        if (!contract) return undefined;
        inputs = await inputsFromText(
          contract,
          `${args.title}\n${args.instructions}`,
          signal,
          access,
        );
      }
      return await this.memberWorkflow(
        target,
        group,
        { skill: skillId, ...(Object.keys(inputs).length ? { inputs } : {}) },
        pipeline,
        primary,
        signal,
        access,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof GroupToolError)) throw error;
      this.service.deps.logger.info(
        JSON.stringify({
          module: "groups",
          event: "handoff_auto_workflow_skipped",
          groupId: group.id,
        }),
      );
      return undefined;
    }
  }

  /** The member's contract skill, pre-checked; inputs it does not name come from the pipeline. */
  private async memberWorkflow(
    target: Bot,
    group: Group,
    request: NonNullable<AssignArgs["workflow"]>,
    pipeline: HandoffPipeline | null,
    primary: string | null,
    parent: AbortSignal,
    access?: WorkspaceFileAccess,
  ): Promise<WorkflowRun> {
    const skills = this.service.deps.local.skills;
    if (!skills) throw new RpcError(RpcErrorCodes.unsupported, "skills_unavailable");
    const signal = AbortSignal.any([parent, AbortSignal.timeout(PREPARE_MS)]);
    const skill = await skills.findWorkflow(target.id, request.skill, group.id);
    if (!skill) throw new GroupToolError("handoff_method_unavailable");
    const { contract } = skillContract(skill.document);
    if (!contract) throw new GroupToolError("handoff_contract_invalid");
    const declared = new Set(
      contract.inputs.filter((input) => input.kind !== "previous").map((input) => input.name),
    );
    const inherited = Object.fromEntries(
      (pipeline?.inputs ?? [])
        .filter((input) => declared.has(input.name))
        .map((input) => [input.name, input.value]),
    );
    let prepared: Awaited<ReturnType<typeof prepareWorkflow>>;
    try {
      prepared = await prepareWorkflow(
        skill,
        { params: request.params ?? {}, inputs: { ...inherited, ...(request.inputs ?? {}) } },
        signal,
        access,
        this.service.deps.logger,
      );
    } catch (error) {
      parent.throwIfAborted();
      if (error instanceof RpcError && error.code === RpcErrorCodes.invalidParams)
        throw new GroupToolError("handoff_arguments_invalid");
      throw error;
    }
    if (!prepared.ok) {
      throw new GroupToolError("handoff_precheck_failed");
    }
    if (pipeline)
      // One period folder for the whole pipeline: the member's file lands next to the brief.
      return { ...prepared.workflow, folder: pipeline.folder };
    if (!primary) throw new RpcError(RpcErrorCodes.internal, "handoff_folder_unavailable");
    const place = await resolveWorkflowFolder(
      primary,
      prepared.workflow,
      signal,
      undefined,
      access,
    );
    return {
      ...prepared.workflow,
      folder: place.folder,
      ...(place.previous ? { previous: place.previous } : {}),
    };
  }

  private acceptance(workflow: WorkflowRun, ids: string[] | undefined) {
    const all = workflow.contract.acceptance;
    if (!ids) return all.filter((item) => item.check !== "manual").slice(0, 10);
    const known = new Map(all.map((item) => [item.id, item]));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new GroupToolError("handoff_acceptance_unavailable");
    return [...new Set(ids)].flatMap((id) => {
      const item = known.get(id);
      return item ? [item] : [];
    });
  }

  /**
   * Called by the completion wake before it claims anything. The check (and reading the
   * coordinator's skill for its sign-off run) is asynchronous: the first call starts it and
   * returns `wait`; when it lands the wake scan runs again and gets the decision.
   */
  gate(task: GroupTask, finishedRunId: string): HandoffGate {
    const record = this.repo.get(task.id);
    if (!record) return { kind: "plain" };
    if (!record.result || (record.pipeline && !this.signOff.has(task.id))) {
      this.prepare(task, record, finishedRunId);
      return { kind: "wait" };
    }
    if (handoffUnmet(record.result)) return { kind: record.returnOf ? "stop" : "return", record };
    const workflow = this.signOff.get(task.id);
    return {
      kind: "wake",
      record,
      text: this.service.deps.redactor.redact(signOffText(record, this.language())),
      ...(workflow ? { workflow } : {}),
    };
  }

  /** The wake, send-back or stop is committed: the cached sign-off workflow is no longer needed. */
  settled(taskId: string) {
    this.signOff.delete(taskId);
  }

  /** A user who settles a hand-off by hand is not second-guessed by the program. */
  userResolved(taskId: string) {
    if (this.repo.get(taskId)?.result) return;
    this.repo.setResult(taskId, { items: [], artifacts: [], durationMs: 0, userResolved: true });
  }

  private prepare(task: GroupTask, record: HandoffRecord, finishedRunId: string) {
    if (this.preparing.has(task.id)) return;
    const work = this.run(task, record, finishedRunId)
      .catch(() => {
        // Only shutdown reaches here (each step records its own failure); nothing to retain.
      })
      .finally(() => {
        this.preparing.delete(task.id);
        this.service.wakes.schedule();
      });
    this.preparing.set(task.id, work);
  }

  private async run(task: GroupTask, record: HandoffRecord, finishedRunId: string) {
    const signal = AbortSignal.any([this.service.signal, AbortSignal.timeout(CHECK_MS)]);
    if (!record.result) {
      const started = performance.now();
      let result: HandoffResult;
      // Which part could not be read, for the log only (codes, never paths or content).
      let stage: "workplace" | "sources" | "check" | "artifacts" = "workplace";
      let unavailableCode: string | undefined;
      try {
        const prepared = await prepareHandoffCheck(
          this.service,
          task,
          record,
          finishedRunId,
          signal,
          (value) => {
            stage = value;
          },
        );
        stage = "check";
        const items = await this.checks.check(finishedRunId, prepared, signal);
        this.checks.delete(finishedRunId);
        stage = "artifacts";
        result = {
          items: boundedReportItems(redactValue(items, this.service.deps.redactor) as typeof items),
          artifacts: await this.artifacts(finishedRunId, signal),
          durationMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        this.service.signal.throwIfAborted();
        unavailableCode = `${stage}:${errorCode(error)}`;
        // Unreadable folder or timeout: the coordinator judges it, the pipeline does not stall.
        result = {
          items: [],
          artifacts: [],
          durationMs: Math.round(performance.now() - started),
          unavailable: true,
        };
      }
      this.repo.setResult(task.id, result);
      // Codes and counts only: no paths, section names or content in logs.
      this.service.deps.logger.info(
        JSON.stringify({
          module: "group",
          event: "handoff_checked",
          groupId: task.groupId,
          taskId: task.id,
          runId: finishedRunId,
          unmet: handoffUnmet(result),
          failed: result.items.filter((item) => item.status === "fail").length,
          // Which kind of check failed and why, as fixed codes (missing_file, verdict_missing, …):
          // enough to tell a wrong path from a format slip without reading the report.
          failures: result.items
            .filter((item) => item.status === "fail")
            .slice(0, 10)
            .map((item) => ({ check: item.check, reason: item.reason ?? "unknown" })),
          unavailable: !!result.unavailable,
          ...(unavailableCode ? { unavailableCode } : {}),
          durationMs: result.durationMs,
        }),
      );
    }
    if (record.pipeline && !this.signOff.has(task.id)) {
      this.signOff.set(task.id, await this.coordinatorWorkflow(task, record.pipeline, signal));
      if (this.signOff.size > SIGN_OFF_CACHE)
        this.signOff.delete(this.signOff.keys().next().value as string);
    }
  }

  /** Reads the coordinator's skill again; without it the sign-off run continues as plain chat. */
  private async coordinatorWorkflow(
    task: GroupTask,
    pipeline: HandoffPipeline,
    signal: AbortSignal,
  ): Promise<WorkflowRun | null> {
    const group = this.service.groups.get(task.groupId);
    const skills = this.service.deps.local.skills;
    if (!group || !skills) return null;
    try {
      signal.throwIfAborted();
      const skill = await skills.workflowSkill(group.coordinatorBotId, pipeline.skillId, group.id);
      return pipelineWorkflow(skill, pipeline) ?? null;
    } catch {
      this.service.signal.throwIfAborted();
      this.service.deps.logger.warn(
        JSON.stringify({ module: "group", event: "handoff_workflow_unavailable", taskId: task.id }),
      );
      return null;
    }
  }

  /** Files the member's finishing run wrote, from the app's own change records (paths only). */
  private async artifacts(runId: string, signal: AbortSignal): Promise<string[]> {
    const changes = this.service.deps.local.workspaceServices?.changes;
    if (!changes) return [];
    try {
      const turn = await changes.turnFiles(runId, signal);
      return turn.runId === runId
        ? turn.files
            .filter((file) => file.kind === "add" || file.kind === "modify")
            .slice(0, 10)
            .map((file) => file.displayPath.slice(0, 500))
        : [];
    } catch {
      signal.throwIfAborted();
      return [];
    }
  }

  async stop() {
    this.checks.stop();
    await Promise.allSettled([...this.preparing.values()]);
    this.signOff.clear();
  }
}

/** A log-safe code for an unreadable hand-off: fixed error codes only, never paths or content. */
function errorCode(error: unknown): string {
  if (error instanceof RpcError)
    return /^[a-z0-9_.-]{1,80}$/i.test(error.message) ? error.message : `rpc${error.code}`;
  if (!(error instanceof Error)) return "unknown";
  // Execution errors carry a fixed code (outside_workplace, file_failed, ...).
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z0-9_]{1,60}$/.test(code)
    ? `${error.name}.${code}`
    : error.name;
}
