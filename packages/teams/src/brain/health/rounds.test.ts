import { randomUUID } from "node:crypto";
import type { CapabilityContext, ToolRunContext } from "@pibot/brain/kit";
import type { MethodParams } from "@pibot/protocol";
import {
  AuditRepo,
  BotsRepo,
  ConversationsRepo,
  GroupCyclesRepo,
  GroupsRepo,
  MessagesRepo,
  openDatabase,
  runMigrations,
} from "@pibot/storage";
import { expect, it, vi } from "vitest";
import { PiHealthReportsRepo } from "../../store/pi-health.ts";
import { repairCard, repairMustAsk } from "./cards.ts";
import { healthPage } from "./detect.ts";
import { piRepair } from "./repair.ts";

it("offers confirmed reset or raise for a round stop and rejects the old repair after it continues", async () => {
  const db = openDatabase(":memory:");
  try {
    runMigrations(db);
    const redact = (value: string) => value;
    const bots = new BotsRepo(db);
    const lead = bots.ensureMainBot();
    const member = bots.create({ ...lead, name: "Helper", isMain: false });
    const groups = new GroupsRepo(db);
    const group = groups.create({ name: "Round limit fixture", botIds: [lead.id, member.id] });
    const cycles = new GroupCyclesRepo(db);
    const cycleId = cycles.reset(group.id);
    const dm = new ConversationsRepo(db).ensureDm(lead.id);
    const message = new MessagesRepo(db).create({
      conversationId: dm.id,
      role: "assistant",
      status: "done",
      content: "Health check",
    });
    const continueRounds = vi.fn(async (params: MethodParams["groups.rounds.continue"]) => {
      expect(cycles.continueRounds(params.groupId, params.roundLimitId)).toBe(true);
      groups.update(params.groupId, { autoRoundLimit: params.autoRoundLimit });
      return { ok: true as const };
    });
    const ctx = {
      db,
      groups: { continueRounds },
      chat: { queue: { resources: () => ({ contexts: [] }) } },
      ports: { get: () => undefined },
      redactor: { redact },
      peer: { emit: vi.fn() },
      logger: { error: vi.fn(), warn: vi.fn() },
      local: {
        approvals: { waitingIn: () => [], audit: new AuditRepo(db, { redact }) },
        background: { owns: () => false },
      },
    } as unknown as CapabilityContext;
    const context = {
      runId: randomUUID(),
      botId: lead.id,
      conversationId: dm.id,
      language: "en",
    } as ToolRunContext;
    const scope = { kind: "group" as const, groupId: group.id, name: group.name };
    for (let n = 0; n < 8; n++) expect(cycles.consume(group.id, cycleId)).toBe("ok");
    expect(cycles.consume(group.id, cycleId)).toBe("limit");
    const page = healthPage(ctx, scope);
    const item = page.items[0];
    expect(item).toMatchObject({
      reason: "round_limit_reached",
      roundLimit: 8,
      actions: ["rounds_reset", "rounds_raise"],
    });
    if (!item) throw new Error("missing health item");
    const check = randomUUID();
    new PiHealthReportsRepo(db).create({
      id: check,
      piBotId: lead.id,
      piRunId: context.runId,
      scopeTargetId: group.id,
      report: {
        toolCallId: "check",
        messageId: message.id,
        scope: { kind: "group" },
        items: page.items,
        more: 0,
      },
    });
    const input = { check, item: item.id, action: "rounds_raise" };
    expect(repairMustAsk(ctx)(context, input)).toBe(true);
    expect(repairMustAsk(ctx)(context, { ...input, action: "rounds_reset" })).toBe(true);
    expect(repairCard(ctx)(context, input, "en").title).toContain(
      "raise the limit to 9 and continue",
    );
    expect(repairCard(ctx)(context, input, "zh").title).toContain("调高上限到 9 并继续");
    const signal = AbortSignal.timeout(30_000);
    expect(await piRepair(ctx, context, input, signal)).toMatchObject({
      text: "Fixed [rounds_continued]",
    });
    expect(continueRounds).toHaveBeenCalledExactlyOnceWith({
      groupId: group.id,
      roundLimitId: item.id.split(":")[2],
      expectedLimit: 8,
      autoRoundLimit: 9,
    });
    expect(healthPage(ctx, scope).items).toEqual([]);
    expect(await piRepair(ctx, context, input, signal)).toMatchObject({
      isError: true,
      text: expect.stringContaining("state changed"),
    });
    expect(continueRounds).toHaveBeenCalledOnce();
    groups.update(group.id, { autoRoundLimit: 10 });
    for (let n = 0; n <= 10; n++) cycles.consume(group.id, cycleId);
    expect(healthPage(ctx, scope).items[0]).toMatchObject({
      roundLimit: 10,
      actions: ["rounds_reset"],
    });
    cycles.limit(group.id, cycleId);
    expect(healthPage(ctx, scope).items).toEqual([]);
  } finally {
    db.close();
  }
}, 60_000);
