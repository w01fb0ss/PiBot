import { randomUUID } from "node:crypto";
import type { KernelRegisterRpc } from "@pibot/brain/orchestration-kit";
import {
  HANDOFF_LIMIT,
  type KernelMethodParams,
  type KernelMethodResults,
} from "@pibot/protocol-base";
import {
  AuditRepo,
  BotsRepo,
  GroupCyclesRepo,
  GroupsRepo,
  GroupTasksRepo,
  GroupWorkflowsRepo,
  MessagesRepo,
  openDatabase,
  RunsRepo,
  runMigrations,
} from "@pibot/storage";
import { describe, expect, it, vi } from "vitest";
import { continueGroupRounds } from "./group-rounds.ts";
import { registerGroupRpc } from "./group-rpc.ts";
import { GroupService } from "./group-service.ts";
import { GroupWorkflowProgress, progressOf } from "./group-workflow-progress.ts";

function fixture(limit?: number) {
  const db = openDatabase(":memory:");
  runMigrations(db);
  const redact = (text: string) => text;
  const bots = new BotsRepo(db);
  const leader = bots.ensureMainBot();
  const member = bots.create({ ...leader, name: "Member", isMain: false });
  const groups = new GroupsRepo(db);
  const group = groups.create({
    name: "Test group",
    botIds: [leader.id, member.id],
    autoRoundLimit: limit,
  });
  const cycles = new GroupCyclesRepo(db);
  const cycleId = cycles.reset(group.id);
  const repo = new GroupWorkflowsRepo(db);
  const tasks = new GroupTasksRepo(db, redact);
  const schedule = vi.fn();
  const wakes = vi.fn();
  const resume = vi.fn();
  const changed = vi.fn();
  const preparing = new Map<string, AbortController>();
  const service = {
    active: () => groups.get(group.id),
    changing: () => false,
    pausedFor: () => groups.get(group.id)?.paused === true,
    sender: { preparing },
    continueRounds: GroupService.prototype.continueRounds,
    groups,
    cycles,
    runs: new RunsRepo(db),
    workflows: { repo, schedule },
    wakes: { schedule: wakes },
    changed,
    deps: {
      db,
      local: { approvals: { audit: new AuditRepo(db, { redact }) } },
      chat: { queue: { resume } },
    },
  };
  const owner = service as unknown as GroupService;
  const progress = new GroupWorkflowProgress(owner, repo);
  Object.assign(service.workflows, { progress });
  type RoundAction = (
    params: KernelMethodParams["groups.rounds.continue"],
    context: { signal: AbortSignal },
  ) => Promise<KernelMethodResults["groups.rounds.continue"]>;
  const registered: { action?: RoundAction } = {};
  const handle: KernelRegisterRpc = (method, action) => {
    // Generic RPC parameters stay tied to the method even though TypeScript cannot narrow K here.
    if (method === "groups.rounds.continue") registered.action = action as unknown as RoundAction;
  };
  registerGroupRpc(handle, owner, service.runs);
  const action = registered.action;
  if (!action) throw new Error("round continuation RPC was not registered");
  const call = (params: KernelMethodParams["groups.rounds.continue"]) =>
    action(params, { signal: AbortSignal.timeout(10_000) });
  const exhaust = () => {
    const current = groups.get(group.id)?.autoRoundLimit ?? 0;
    Array.from({ length: current }, () => expect(cycles.consume(group.id, cycleId)).toBe("ok"));
    expect(cycles.consume(group.id, cycleId)).toBe("limit");
    const id = cycles.get(group.id).roundLimitId;
    if (!id) throw new Error("missing durable stop");
    return id;
  };
  return {
    db,
    leader,
    member,
    group,
    groups,
    cycles,
    cycleId,
    repo,
    tasks,
    schedule,
    wakes,
    resume,
    progress,
    owner,
    preparing,
    call,
    exhaust,
  };
}

describe("resuming a group after its automatic round limit", () => {
  it("raises the limit and schedules the same plan with original tasks and completed deliveries", async () => {
    const f = fixture();
    try {
      const { db, leader, member, group, cycles, cycleId, repo, tasks } = f;
      expect(group.autoRoundLimit).toBe(8);
      const original = new MessagesRepo(db).create({
        conversationId: group.conversationId,
        role: "user",
        content: "Continue this plan",
        status: "done",
      });
      const plan = repo.create({
        id: randomUUID(),
        groupId: group.id,
        skillId: "local-fixture",
        contractVersion: null,
        status: "running",
        initiatorBotId: leader.id,
        coordinatorBotId: leader.id,
        cycleId,
        sourceMessageId: original.id,
        budgetRootRunId: null,
        workflow: {},
      });
      const task = tasks.create({
        groupId: group.id,
        assigneeBotId: member.id,
        title: "Remaining task",
        instructions: "Write the rest",
        createdByBotId: leader.id,
        executionMode: "serial",
      });
      for (const [stepId, status, taskId, deliverables] of [
        ["first", "passed", null, [{ path: "brief.md" }]],
        ["next", "ready", task.id, []],
      ] as const) {
        repo.createStep({
          workflowRunId: plan.id,
          stepId,
          status,
          attempt: 1,
          taskId,
          executionRunId: null,
          deliverables: [...deliverables],
          ownerBotId: member.id,
          decisionMessageId: null,
        });
      }
      const steps = repo.steps(plan.id);
      for (let n = 0; n < HANDOFF_LIMIT; n++)
        expect(cycles.consume(group.id, cycleId, "handoff")).toBe("ok");
      const roundLimitId = f.exhaust();
      expect(f.progress.hardLimit(plan)).toBe("round_limit");
      f.progress.stop(plan, "round_limit");
      const held = repo.get(plan.id);
      expect(held?.status).toBe("waiting");
      expect(held && progressOf(held)).toMatchObject({
        stoppedReason: "round_limit",
        roundHold: { limitId: roundLimitId, status: "running" },
      });
      expect(repo.steps(plan.id)).toEqual(steps);
      const repair = { groupId: group.id, roundLimitId, expectedLimit: 8, autoRoundLimit: 9 };
      await expect(f.call({ ...repair, expectedLimit: 7 })).rejects.toThrow("group_rounds_stale");
      f.preparing.set(group.id, new AbortController());
      await expect(f.call(repair)).rejects.toThrow("group_rounds_stale");
      f.preparing.delete(group.id);
      await expect(f.call(repair)).resolves.toEqual({ ok: true });
      expect(f.groups.get(group.id)?.autoRoundLimit).toBe(9);
      expect(cycles.get(group.id)).toEqual({
        cycleId,
        rounds: 0,
        limited: false,
        handoffs: HANDOFF_LIMIT,
        roundLimitId: undefined,
      });
      const resumed = repo.get(plan.id);
      expect(resumed?.status).toBe("running");
      expect(resumed && progressOf(resumed).stoppedReason).toBeUndefined();
      expect(repo.steps(plan.id)).toEqual(steps);
      expect(tasks.get(task.id)?.status).toBe("open");
      expect(f.schedule).toHaveBeenCalledExactlyOnceWith(plan.id);
      expect(f.wakes).toHaveBeenCalledOnce();
      expect(f.resume).toHaveBeenCalledOnce();
      await expect(f.call(repair)).rejects.toThrow("group_rounds_stale");
      expect(f.schedule).toHaveBeenCalledOnce();
      const audit = db
        .prepare("SELECT detail FROM audit_log WHERE kind='group.workflow.disposition'")
        .all();
      expect(audit).toHaveLength(1);
      expect(JSON.parse(String(audit[0]?.detail))).toMatchObject({
        actor: "user",
        reasonCode: "round_limit_raise",
        groupRoundLimit: { before: 8, after: 9 },
      });
    } finally {
      f.db.close();
    }
  });

  it("allows a reset at 10 but never interprets a cancellation at the same count as recoverable", () => {
    const f = fixture(10);
    try {
      const old = { groupId: f.group.id, roundLimitId: f.exhaust(), expectedLimit: 10 };
      expect(() => continueGroupRounds(f.owner, { ...old, autoRoundLimit: 11 })).toThrow(
        "group_rounds_stale",
      );
      expect(continueGroupRounds(f.owner, old)).toEqual({ ok: true });
      const next = { ...old, roundLimitId: f.exhaust() };
      expect(next.roundLimitId).not.toBe(old.roundLimitId);
      expect(() => continueGroupRounds(f.owner, old)).toThrow("group_rounds_stale");
      f.cycles.limit(f.group.id, f.cycleId);
      expect(f.cycles.get(f.group.id)).toMatchObject({
        rounds: 10,
        limited: true,
        roundLimitId: undefined,
      });
      expect(() => continueGroupRounds(f.owner, next)).toThrow("group_rounds_stale");
      expect(f.wakes).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });
});
