import {
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  type GroupWorkflowsRepo,
  MessagesRepo,
} from "@pibot/storage";
import { groupPlanText } from "@pibot/teams-contract/i18n";
import { stepWorkspaces } from "./group-plan-progress.ts";
import { planMarkdownText, planStepLines, planStepNames } from "./group-plan-summary.ts";
import type { GroupService } from "./group-service.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

const MERGE_MS = 2_000;

function progressLine(
  language: "zh" | "en",
  state: "progress" | "completed" | "stepsEnded",
  values: { name: string; done: number; total: number },
) {
  return groupPlanText(language, `group.plan.statusLine.${state}`, {
    ...values,
    name: planMarkdownText(values.name),
  });
}

/**
 * The group hears progress from the program, not from a model turn. Every line is built
 * from the step rows the scheduler already persisted, so nothing here can leak a member's prose.
 */
export function workflowStatusText(
  record: GroupWorkflowRunRecord,
  steps: readonly GroupWorkflowStepRecord[],
  names: Map<string, string>,
  language: "zh" | "en",
  /** Maintainers 2026-11-14: where each writing step's work is, so merges show as they happen. */
  workspaces: ReadonlyMap<string, string | undefined> = new Map(),
) {
  const workflow = workflowOf(record);
  const done = steps.filter((step) => step.status === "passed" || step.status === "skipped").length;
  return [
    progressLine(language, "progress", { name: workflow.name, done, total: steps.length }),
    "",
    ...planStepLines(
      workflow.contract.steps,
      steps,
      names,
      progressOf(record),
      language,
      workspaces,
    ),
  ].join("\n");
}

/**
 * One message per burst: a step transition can settle several steps at once (a failed step blocks
 * the rest), and the user should read one summary, not one line per row.
 */
export class GroupWorkflowStatus {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly last = new Map<string, string>();

  constructor(
    private readonly service: GroupService,
    private readonly repo: GroupWorkflowsRepo,
  ) {}

  announce(record: GroupWorkflowRunRecord) {
    if (this.service.signal.aborted || this.timers.has(record.id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(record.id);
      try {
        this.flush(record.id);
      } catch {
        // A status line is decoration: a failure here must never break the workflow transition.
      }
    }, MERGE_MS);
    timer.unref();
    this.timers.set(record.id, timer);
  }

  postFinished(
    record: GroupWorkflowRunRecord,
    conversationId: string,
    name: string,
    total: number,
    deliveryComplete: boolean,
  ) {
    this.post(
      record,
      conversationId,
      progressLine(
        this.service.deps.chat.currentLanguage(),
        deliveryComplete ? "completed" : "stepsEnded",
        { name, done: total, total },
      ),
    );
  }

  /**
   * The user just decided on a step's card. The progress line posted after that card (2 s after
   * the block) still reads 「卡住…等待你决定」 under the resolved card; it is rewritten in place to
   * the current state rather than left stale or followed by another line.
   */
  refreshAfter(record: GroupWorkflowRunRecord, decisionMessageId: string) {
    if (this.service.signal.aborted) return;
    const latest = this.repo.get(record.id);
    const group = latest && this.service.groups.get(latest.groupId);
    if (!latest || !group || !["running", "waiting"].includes(latest.status)) return;
    const messageId = this.repo.statusLineAfter(group.conversationId, latest.id, decisionMessageId);
    if (!messageId) return;
    const text = this.text(latest);
    new MessagesRepo(this.service.deps.db).update(messageId, {
      content: this.service.deps.redactor.redact(text),
    });
    this.last.set(latest.id, text);
    this.service.changed(latest.groupId, "updated");
  }

  private text(record: GroupWorkflowRunRecord) {
    const steps = this.repo.steps(record.id);
    const workspaces = stepWorkspaces(this.service, record, steps);
    const visible = steps.map((step) => {
      const waiting =
        step.status === "running" &&
        workspaces.get(step.stepId) === "shared" &&
        step.taskId &&
        this.service.memberWorktrees.waitingTurn(step.taskId);
      return waiting ? { ...step, status: "ready" as const } : step;
    });
    return workflowStatusText(
      record,
      visible,
      planStepNames(this.service, steps),
      this.service.deps.chat.currentLanguage(),
      workspaces,
    );
  }

  private flush(workflowRunId: string) {
    if (this.service.signal.aborted) return;
    const record = this.repo.get(workflowRunId);
    if (!record || !["running", "waiting"].includes(record.status)) {
      this.last.delete(workflowRunId);
      return;
    }
    const group = this.service.groups.get(record.groupId);
    if (!group) return;
    const text = this.text(record);
    // Nothing moved since the last line (a replay or a coalesced duplicate): stay quiet.
    if (this.last.get(workflowRunId) === text) return;
    this.post(record, group.conversationId, text);
    this.last.set(workflowRunId, text);
    this.service.changed(record.groupId, "updated");
  }

  private post(record: GroupWorkflowRunRecord, conversationId: string, text: string) {
    new MessagesRepo(this.service.deps.db).create({
      conversationId,
      botId: record.coordinatorBotId,
      role: "assistant",
      content: this.service.deps.redactor.redact(text),
      status: "done",
      // Decision updates use the workflow ID to find their own progress line.
      usage: { groupWorkflowStatus: { workflowRunId: record.id } },
    });
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.last.clear();
  }
}
