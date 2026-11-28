// A failing independent review must schedule a repair and same-owner recheck without a planning wake.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GroupPlan } from "../../../packages/protocol/src/index.ts";
import type { Reply, Scenario } from "../../../tools/fake-llm/scenario.ts";
import { fixture, until } from "../chat/harness.ts";

const done = (): Reply => ({ text: "合成步骤完成" });
const write = (verdict = "PASS"): Reply => ({ toolCalls: [{ name: "write_file", arguments: {
  path: "__REPORT__", content: `# 来源\n合成证据 [1]\n[1] Fixture\nVerdict: ${verdict}\n${verdict === "FAIL" ? "- 原成果需要修订" : ""}`,
} }] });

export async function verdictRepairScenario(root: string) {
  let plan: GroupPlan = { name: "程序修复验收", estimatedCostUsd: 0, steps: [] };
  let proposals = 0;
  const source: Scenario = { replies: [done()], routes: {
    coordinator: [{ toolCalls: [{ name: "group_plan", arguments: { plan: {} } }] }, done(), write(), done(), write(), done()],
    researcher: [write(), done()], writer: [write("FAIL"), done(), write(), done()],
  } };
  const f = await fixture(source, root, {}, {}, { onRequest(body, route, index) {
    const strings: string[] = [];
    const visit = (value: unknown) => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(body.messages ?? body.input);
    const text = strings.join("\n");
    const last = (pattern: RegExp) => [...text.matchAll(pattern)].at(-1)?.[1];
    for (const call of source.routes?.[route]?.[index]?.toolCalls ?? []) {
      if (call.name === "group_plan") { proposals++; call.arguments.plan = plan; }
      if (call.name === "write_file" && call.arguments.path === "__REPORT__") {
        const folder = last(/产物目录 \/ Output folder:\n([^\n]+)/g);
        const raw = last(/交付合同 \/ Delivery contract:\n([^\n]+)/g);
        assert(folder && raw);
        const contract = JSON.parse(raw) as { deliverables: { path: string }[] };
        assert(contract.deliverables[0]);
        call.arguments.path = join(folder, contract.deliverables[0].path);
      }
    }
  } });
  const read = <T>(query: (db: DatabaseSync) => T) => {
    const db = new DatabaseSync(join(f.root, "data", "pibot.db"), { readOnly: true });
    try { return query(db); } finally { db.close(); }
  };
  try {
    const created = await f.client.call("builtin.create", { groups: ["dev-lite"], source: "template" });
    const groupId = created.groupIds[0]; assert(groupId);
    const group = await f.client.call("groups.get", { groupId });
    const bots = await f.client.call("bots.list", {});
    const provider = bots.find((bot) => bot.id === f.main.id)?.modelProvider; assert(provider);
    const member = (role: string) => { const bot = bots.find((bot) => group.members.some((m) => m.botId === bot.id) && bot.role?.id === role); assert(bot); return bot; };
    const author = member("fullstack-dev"), qa = member("qa-engineer"), reviewer = member("code-reviewer");
    for (const [bot, modelId] of [[author, "coordinator"], [qa, "researcher"], [reviewer, "writer"]] as const)
      await f.client.call("bots.update", { botId: bot.id, modelProvider: provider, modelId, thinkingLevel: "off" });
    f.pickFolderNext(f.root);
    const withFolder = await f.client.call("groups.folders.add", { groupId });
    const folder = withFolder.folders?.find((item) => item.path === f.root); assert(folder);
    await f.client.call("groups.folders.setPrimary", { groupId, folderId: folder.id });
    const step = (id: string, botId: string, dependsOn: string[], verdict = false): GroupPlan["steps"][number] => ({
      id, title: id, owner: { botId }, task: "交付合成报告并核对来源；需要核对时写结论。", dependsOn,
      inputs: dependsOn.map((stepId) => ({ stepId, deliverableId: "report" })), maxFixRounds: 0,
      deliverables: [{ id: "report", kind: "md", path: `${id}.md` }],
      acceptance: [{ id: "check", check: verdict ? "verdict" : "exists", deliverable: "report" }],
    });
    plan = { name: "程序修复验收", estimatedCostUsd: 0, steps: [step("implementation", author.id, []), step("test", qa.id, ["implementation"], true), step("review", reviewer.id, ["test"], true)] };
    await f.client.call("chat.send", { groupId, text: "按分工实现、测试和审查，不通过自动修复复验。" });
    const result = await until("program repair and recheck passed", async () => {
      for (const card of await f.client.call("approvals.pending", {}))
        await f.client.call("approvals.resolve", { id: card.id, decision: "allow", remember: false });
      return read((db) => db.prepare("SELECT id,status,workflow_json FROM group_workflow_runs WHERE group_id=? ORDER BY rowid").all(groupId));
    }, (rows) => rows.length === 1 && rows[0]?.status === "passed");
    const progress = JSON.parse(String(result[0]?.workflow_json)).progress as { verdicts: Record<string, { verdict: string }>; verdictRepairs: Record<string, string>; replans: number };
    assert.equal(progress.verdicts.review?.verdict, "fail");
    const recheck = progress.verdictRepairs.review; assert(recheck);
    assert.equal(progress.verdicts[recheck]?.verdict, "pass");
    assert.equal(progress.replans, 1); assert.equal(proposals, 1);
    const wakes = read((db) => db.prepare("SELECT COUNT(*) n FROM runs WHERE group_id=? AND trigger_key LIKE 'group-replan:%'").get(groupId));
    assert.equal(wakes?.n, 0, "program repair must not call the coordinator model");
    const owner = read((db) => db.prepare("SELECT owner_bot_id FROM group_workflow_steps WHERE step_id=?").get(recheck));
    assert.equal(owner?.owner_bot_id, reviewer.id);
    const history = await f.client.call("chat.history", { groupId, limit: 100 });
    const summaries = history.filter(({ usage }) =>
      usage && typeof usage === "object" && !Array.isArray(usage) && usage.groupPlanConclusion,
    );
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert(summary);
    assert.match(summary.content, /\*\*(?:Steps|步骤)\*\*\n\n- ✅/u);
    assert.match(summary.content, /Repair failed checks|修复不通过项/u);
    assert.match(summary.content, /Recheck the repair|修复后复验/u);
    assert.match(summary.content, /no item-by-item check|没有逐条核对/u);
    assert.doesNotMatch(summary.content, /repair\d+_\d+_check|修复不通过项 \/ Repair failed checks|\.pibot\/out/u);
    const outputs = summary.attachments ?? [];
    const reviews = outputs.filter((item) => item.name === "review.md");
    assert.equal(reviews.length, 1, "declared and observed copies share one file card");
    const reviewFile = reviews[0];
    assert(reviewFile);
    const preview = await f.client.call("preview.read", {
      attachmentId: reviewFile.id, messageId: summary.id, requestId: randomUUID(),
    });
    assert.match(preview.text ?? "", /Verdict: FAIL/u);
    assert.equal(history.filter((item) => /(?:progress|进度) 5\/5 ·/u.test(item.content)).length, 1);
    return { passed: true, proposals, repairs: progress.replans };
  } finally { await f.cleanup(); }
}
