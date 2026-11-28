import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentHost } from "../../../packages/brain/src/conversations/attachments/attachment-types.ts";
import {
  type Approval,
  type EventPayloads,
  type Message,
  messageFailureCode,
} from "../../../packages/protocol/src/index.ts";
import { fixture, until } from "../chat/harness.ts";

const MARK = "IMAGE-NORMS-PROBE-PROMPT";
const REQUEST = `${MARK} 1:1 应用图标草稿：一片绿色叶子，扁平矢量风格。叶子居中，轮廓简洁，用单一色块表现叶脉。背景纯白，四周留出均匀的空白，图案在小尺寸下也要清晰。整张图使用同一套线条风格，保留轮廓内的空白。`;
const NORM = "保持边缘清晰。";
// IMAGE-RUN-UX: the brain's image cap, shortened for the probe (production: 300 s).
const IMAGE_TIMEOUT_MS = 3_000;
// The fifth and seventh image requests are held past the cap (timeout, then a user stop).
const TIMEOUT_REQUEST = 4;
const STOP_REQUEST = TIMEOUT_REQUEST + 2;
const PAID = "paid_generation_confirmation";
const paid = (approval: Approval) =>
  approval.explanation?.some((step) => step.code === PAID) === true;

/**
 * On the real brain: an image Bot from the built-in image-designer role, an OpenAI-style
 * image service on the fake server, and "visit websites: always" so the old auto-spend path is
 * the one being closed. Owner decisions 2026-10-23: YOLO still shows the paid card; "don't ask
 * again" remembers this Bot + model only; a routine's paid pre-approval generates without a card.
 * IMAGE-RUN-UX (2026-10-23): with the cap shortened to 3 s, a held request ends as a timeout error
 * with Retry, a progress line and audit "timeout"; Retry asks again; a user stop stays "aborted";
 * each request writes one length-only diagnostic log line.
 */
export async function runImageNormsProbe(root: string) {
  const bodies: Array<Record<string, unknown>> = [];
  // The desktop host normalizes images with Electron; this probe's only image is the 1x1 PNG
  // the fake service returns, passed through unchanged.
  const attachments: AttachmentHost = {
    image: async (image) => ({ image, width: 1, height: 1 }),
    pdf: async () => {
      throw new Error("PDF 不在本演练范围");
    },
    open: async () => {},
  };
  const f = await fixture(
    { replies: [{ text: "unused" }] },
    root,
    { attachments },
    { imageGenerationTimeoutMs: IMAGE_TIMEOUT_MS },
    {
      onRequest: (body, route) => {
        if (route === "images") bodies.push(body);
      },
      imageDelayMs: (index) =>
        index === TIMEOUT_REQUEST || index === STOP_REQUEST ? IMAGE_TIMEOUT_MS * 5 : 0,
    },
  );
  const activity: EventPayloads["chat.activity"][] = [];
  const stopActivity = f.client.on("chat.activity", (event) => {
    activity.push(event);
  });
  try {
    const { id: provider } = await f.client.call("customProviders.upsert", {
      name: "fake image service",
      baseUrl: `${f.serverUrl}/v1`,
      api: "openai-completions",
      apiKey: "synthetic-image-norms-key-only",
      models: [],
      imageApi: "openai-images",
      imageModels: [
        { id: "fake-image", modes: ["text-to-image"] },
        { id: "fake-image-2", modes: ["text-to-image"] },
      ],
    });
    const { bot } = await f.client.call("builtin.createBot", { roleId: "image-designer" });
    assert.equal(bot.category, "image");
    assert(bot.norms?.trim(), "角色规范复制到了 Bot");
    await f.client.call("bots.update", {
      botId: bot.id,
      modelProvider: provider,
      modelId: "fake-image",
      norms: NORM,
    });
    await f.client.call("permissions.set", { levels: { web: "always" } });

    const seen: Approval[] = [];
    const send = async (decide: "allow" | "deny" | "none", topic?: string, remember = false) => {
      const sent = await f.client.call("chat.send", {
        botId: bot.id,
        text: REQUEST,
        ...(topic ? { topicId: topic } : { newTopic: true }),
      });
      let asked = 0;
      const reply = await until(
        "图片回复终态",
        async () => {
          for (const approval of await f.client.call("approvals.pending", {})) {
            if (approval.botId !== bot.id) continue;
            seen.push(approval);
            const isPaid = paid(approval);
            if (isPaid) asked++;
            await f.client.call("approvals.resolve", {
              id: approval.id,
              // Only the paid card is under test; the later workspace save is allowed.
              decision: isPaid && decide === "deny" ? "deny" : "allow",
              remember: isPaid && remember,
            });
          }
          const rows = await f.client.call("chat.history", {
            botId: bot.id,
            topicId: sent.conversationId,
          });
          return rows.find((row) => row.id === sent.assistantMessageId);
        },
        (row) => !!row && row.status !== "streaming",
      );
      return { reply, asked, conversationId: sent.conversationId };
    };

    // 1. Denied: the card appears even at web "always", and the service is never called.
    const denied = await send("deny");
    assert.equal(denied.asked, 1, "付费生成先弹审批卡");
    assert.equal(denied.reply?.status, "error");
    assert.equal(bodies.length, 0, "拒绝后没有向图片服务发请求");
    const card = seen.find(paid);
    assert(card, "有付费确认卡");
    const zhFacts = card.localized?.zh.facts.map((fact) => fact.value).join("\n") ?? "";
    const enFacts = card.localized?.en.facts.map((fact) => fact.value).join("\n") ?? "";
    // The card names a custom provider by the name it was given; its id is a UUID.
    for (const expected of ["fake image service", "fake-image", "尺寸", "数量 1 张", "预计费用", "收费"])
      assert(zhFacts.includes(expected), `中文卡片含 ${expected}`);
    for (const expected of [
      "fake image service",
      "fake-image",
      "Size",
      "1 image",
      "Estimated cost",
      "bills",
    ])
      assert(enFacts.includes(expected), `英文卡片含 ${expected}`);
    assert(!zhFacts.includes(provider) && !enFacts.includes(provider), "卡片不显示服务商 id");
    assert.equal(card.grantScopeProviderName, "fake image service");
    // Owner decision 2026-10-23 (was canRemember=false before): the card offers this Bot + model.
    assert.equal(card.canRemember, true, "付费确认可以按 Bot + 模型记住");
    assert.deepEqual(
      card.grantScope,
      { kind: "paid_image", provider, model: "fake-image" },
      "记住的范围是这个 Bot 的这个模型",
    );

    // 2. Allowed: exactly one request, with the exact request first and compact guidance after it.
    const allowed = await send("allow");
    assert.equal(allowed.asked, 1);
    assert.equal(
      allowed.reply?.status,
      "done",
      `允许后生成完成（${allowed.reply?.errorCode ?? ""} / 请求 ${bodies.length}）`,
    );
    assert.equal(bodies.length, 1, "允许后只发一次请求");
    const prompt = String(bodies[0]?.prompt ?? "");
    const sections = {
      request: prompt.indexOf(REQUEST),
      guidance: prompt.indexOf("以请求为准。", REQUEST.length),
      norms: prompt.indexOf(NORM, REQUEST.length),
    };
    assert(prompt.startsWith(`${REQUEST}\n\n`), "用户请求原样放在最前面");
    assert(
      sections.guidance > REQUEST.length && sections.norms > sections.guidance,
      "请求后附简短指导和规范",
    );
    assert(prompt.length - REQUEST.length < REQUEST.length, "用户请求长于附加指导");
    assert.equal(bodies[0]?.n, 1);
    assert.equal(bodies[0]?.size, "auto");

    // 3. YOLO no longer spends money (owner decision 2026-10-23; no card was expected here before).
    // The denied topic has no earlier image, so this stays text-to-image. The card is answered
    // with "don't ask again for this Bot with this model".
    assert(denied.conversationId, "拒绝的话题有会话 ID");
    await f.client.call("conversations.yolo.set", {
      conversationId: denied.conversationId,
      enabled: true,
    });
    const yolo = await send("none", denied.conversationId, true);
    assert.equal(yolo.asked, 1, "YOLO 下付费生成仍弹卡");
    assert.equal(yolo.reply?.status, "done");
    assert.equal(bodies.length, 2);
    const grants = await f.client.call("grants.list", { botId: bot.id });
    assert(
      grants.some(
        (grant) =>
          grant.category === "web" &&
          grant.scope.kind === "paid_image" &&
          grant.scope.provider === provider &&
          grant.scope.model === "fake-image",
      ),
      "「不再问」记住了 paid_image 授权",
    );

    // 4. Same Bot + model in a new topic (YOLO off there): no card, one request.
    const remembered = await send("none");
    assert.equal(remembered.asked, 0, "记住后同一模型不再弹卡");
    assert.equal(remembered.reply?.status, "done");
    assert.equal(bodies.length, 3);

    // 5. Another model of the same Bot asks again; denying it sends nothing.
    await f.client.call("bots.update", { botId: bot.id, modelId: "fake-image-2" });
    const otherModel = await send("deny");
    assert.equal(otherModel.asked, 1, "换模型后重新询问");
    assert.equal(otherModel.reply?.status, "error");
    assert.equal(bodies.length, 3, "拒绝后没有请求");
    await f.client.call("bots.update", { botId: bot.id, modelId: "fake-image" });

    // 6. A routine of this Bot with a paid pre-approval for the model: no card. The remembered
    // chat grant is revoked first so only the routine pre-approval can let it through.
    for (const grant of grants.filter((item) => item.scope.kind === "paid_image"))
      await f.client.call("grants.revoke", { id: grant.id });
    const routine = await f.client.call("routines.create", {
      botId: bot.id,
      name: "付费预授权出图",
      instructions: `${MARK} 每周封面草稿：一片绿色叶子`,
      triggers: [{ kind: "cron", expr: "30 8 * * 1", timezone: "Asia/Shanghai" }],
      preauth: [{ category: "web", scope: { kind: "paid_image", provider, model: "fake-image" } }],
    });
    const before = seen.length;
    const run = await f.client.call("routines.runNow", { id: routine.id });
    let routineCards = 0;
    const routineRun = await until(
      "例行任务终态",
      async () => {
        for (const approval of await f.client.call("approvals.pending", {})) {
          if (approval.botId !== bot.id) continue;
          seen.push(approval);
          if (paid(approval)) routineCards++;
          // A paid card here is a failure; deny it so the run ends instead of waiting a day.
          await f.client.call("approvals.resolve", {
            id: approval.id,
            decision: paid(approval) ? "deny" : "allow",
            remember: false,
          });
        }
        const runs = await f.client.call("routines.runs", { id: routine.id, limit: 10 });
        return runs.find((row) => row.id === run.runId);
      },
      (row) => !!row && ["done", "failed", "cancelled", "timeout"].includes(row.status),
    );
    assert.equal(routineCards, 0, "有付费预授权的例行任务不弹付费卡");
    assert.equal(routineRun?.status, "done", `例行任务完成（${routineRun?.errorCode ?? ""}）`);
    assert.equal(bodies.length, 4, "例行任务生成了一次");

    // 7. IMAGE-RUN-UX: the service holds request #5 past the probe's cap. The reply is a
    // timeout error (not a stop) that offers Retry, the activity line runs and clears, and the
    // audit says "timeout". No paid grant is left, so the retry must show the paid card again.
    assert.equal(bodies.length, TIMEOUT_REQUEST, "超时请求是第 5 次图片请求");
    const timedOut = await send("allow");
    assert.equal(timedOut.asked, 1);
    assert.equal(bodies.length, TIMEOUT_REQUEST + 1, "超时那次请求确实发出");
    assert.equal(timedOut.reply?.status, "error", "超时不算用户停止");
    assert.equal(timedOut.reply?.errorCode, "image_timeout");
    // ChatMessage shows Retry for any failure except output_limit on a reply without a paid image;
    // the phone shows it for any status "error".
    assert.equal(timedOut.reply && messageFailureCode(timedOut.reply), "image_timeout");
    const timedOutUsage = timedOut.reply?.usage as Record<string, unknown> | null | undefined;
    assert.notEqual(timedOutUsage?.imageGeneration, true, "没有已付费图片，界面显示重试");
    const timeoutRunId = timedOut.reply?.runId;
    assert(timeoutRunId);
    const timeoutActivity = activity.filter((event) => event.runId === timeoutRunId);
    assert.deepEqual(
      timeoutActivity.map((event) =>
        event.phase === "executing_tool" ? `${event.phase}:${event.tool}` : event.phase,
      ),
      ["executing_tool:image_generation", "clear"],
      "生成期间有进度行，结束时清除",
    );
    // Retry (the desktop resends the same request in the same topic).
    const retried = await send("allow", timedOut.conversationId);
    assert.equal(retried.asked, 1, "重试仍弹付费确认");
    assert.equal(retried.reply?.status, "done");
    assert.equal(bodies.length, TIMEOUT_REQUEST + 2);

    // 8. A real user stop during generation stays "aborted".
    const stopReceipt = await f.client.call("chat.send", {
      botId: bot.id,
      text: `${MARK} 停止测试`,
      newTopic: true,
    });
    let stopAsked = 0;
    let abortSent = false;
    const stopped = await until(
      "停止的图片回复",
      async () => {
        for (const approval of await f.client.call("approvals.pending", {})) {
          if (approval.botId !== bot.id) continue;
          if (paid(approval)) stopAsked++;
          await f.client.call("approvals.resolve", {
            id: approval.id,
            decision: "allow",
            remember: false,
          });
        }
        const started = activity.find(
          (event) =>
            event.messageId === stopReceipt.assistantMessageId && event.phase === "executing_tool",
        );
        // Stop once the request is at the service, so this is a stop mid-generation.
        if (started && bodies.length > STOP_REQUEST && !abortSent) {
          abortSent = true;
          await f.client.call("chat.abort", { runId: started.runId });
        }
        const rows = await f.client.call("chat.history", {
          botId: bot.id,
          topicId: stopReceipt.conversationId,
        });
        return rows.find((row) => row.id === stopReceipt.assistantMessageId);
      },
      (row) => !!row && row.status !== "streaming",
    );
    assert.equal(stopAsked, 1);
    assert.equal(stopped?.status, "aborted", "用户停止仍是 aborted");
    assert.equal(bodies.length, TIMEOUT_REQUEST + 3);

    // 9. One diagnostic line per provider request: lengths, never prompt or norms text.
    const logs = (
      await Promise.all(
        (
          await readdir(join(f.root, "data", "logs"))
        )
          .filter((name) => name.endsWith(".log"))
          .map((name) => readFile(join(f.root, "data", "logs", name), "utf8")),
      )
    ).join("\n");
    assert(!logs.includes(MARK), "日志不含提示词");
    assert(!logs.includes(NORM), "日志不含规范正文");
    const generationLines = logs
      .split("\n")
      .filter(Boolean)
      .map((line) => String(JSON.parse(line).message))
      .filter((message) => message.startsWith("image.generation "));
    assert.equal(generationLines.length, bodies.length, "每次图片请求一行诊断日志");
    const fields = (message: string) =>
      Object.fromEntries(
        message.split(" ").flatMap((part) => (part.includes("=") ? [part.split("=")] : [])),
      );
    const timeoutLine = generationLines.map(fields).find((line) => line.run === timeoutRunId);
    assert(timeoutLine, "超时那次有诊断日志");
    assert.equal(timeoutLine.outcome, "image_timeout");
    assert.equal(timeoutLine.mode, "text-to-image");
    for (const key of ["promptChars", "requestChars", "guidanceChars", "durationMs"])
      assert(Number(timeoutLine[key]) > 0, `诊断日志含 ${key}`);
    assert(Number(timeoutLine.normsChars) >= 0, "诊断日志含 normsChars");
    assert(Number(timeoutLine.durationMs) >= IMAGE_TIMEOUT_MS - 50, "耗时到达上限");
    const stopLine = generationLines.map(fields).find((line) => line.run === stopped?.runId);
    assert.equal(stopLine?.outcome, "aborted");

    // 4. No prompt text in the audit, approval cards or stored card facts.
    const audit = await f.client.call("audit.list", { botId: bot.id, limit: 200 });
    const finishedReason = (runId: string | null | undefined) =>
      audit.find((entry) => entry.kind === "image.finished" && entry.runId === runId)?.detail
        .reasonCode;
    assert.equal(finishedReason(timeoutRunId), "timeout", "超时审计 reasonCode=timeout");
    assert.equal(finishedReason(stopped?.runId), "aborted", "用户停止审计 reasonCode=aborted");
    assert(
      (audit.find((entry) => entry.kind === "image.finished" && entry.runId === timeoutRunId)
        ?.detail.durationMs ?? 0) >=
        IMAGE_TIMEOUT_MS - 50,
    );
    const auditText = JSON.stringify(audit);
    assert(!auditText.includes(MARK), "审计不含提示词");
    assert(!auditText.includes(NORM), "审计不含规范正文");
    assert(!JSON.stringify(seen).includes(MARK), "审批卡不含提示词");
    const kinds = audit.map((entry) => entry.kind);
    const reasons = audit
      .filter((entry) => entry.kind === "approval.resolved" && entry.detail.actor === "automatic")
      .map((entry) => entry.detail.reasonCode);
    assert(reasons.includes("paid_grant_matched"), "记住的付费授权写自动允许审计");
    assert(reasons.includes("routine_paid_preapproved"), "例行付费预授权写自动允许审计");
    const yoloAllowed = audit.filter(
      (entry) => entry.kind === "approval.resolved" || entry.detail.reasonCode === "yolo",
    ).length;

    return {
      scenario: "图片 Bot 付费确认与出图规范",
      status: "脚本化通过",
      denied: { cardShown: denied.asked, providerRequests: 0, reply: denied.reply?.status },
      allowed: { cardShown: allowed.asked, providerRequests: 1, reply: allowed.reply?.status },
      yolo: { cardShown: yolo.asked, providerRequests: 1, reply: yolo.reply?.status },
      rememberedSameModel: {
        cardShown: remembered.asked,
        providerRequests: 1,
        reply: remembered.reply?.status,
      },
      otherModel: {
        cardShown: otherModel.asked,
        providerRequests: 0,
        reply: otherModel.reply?.status,
      },
      routinePreapproved: {
        paidCardsShown: routineCards,
        otherCardsShown: seen.length - before - routineCards,
        providerRequests: 1,
        status: routineRun?.status,
      },
      card: {
        factsZh: card.localized?.zh.facts.length,
        canRemember: card.canRemember,
        policySteps: card.explanation?.map((step) => step.code),
      },
      prompt: { chars: prompt.length, sectionOrder: Object.keys(sections) },
      audit: {
        entries: audit.length,
        approvalRequested: kinds.filter((kind) => kind === "approval.requested").length,
        imageFinished: kinds.filter((kind) => kind === "image.finished").length,
        resolvedOrYolo: yoloAllowed,
        automaticReasons: reasons,
        promptInAudit: false,
      },
      timeout: {
        capMs: IMAGE_TIMEOUT_MS,
        reply: timedOut.reply?.status,
        errorCode: timedOut.reply?.errorCode,
        retryOffered: messageFailureCode(timedOut.reply as Message) === "image_timeout",
        activity: timeoutActivity.map((event) => event.phase),
        auditReason: finishedReason(timeoutRunId),
        retry: { paidCardShown: retried.asked, reply: retried.reply?.status },
      },
      userStop: { reply: stopped?.status, auditReason: finishedReason(stopped?.runId) },
      diagnostics: {
        lines: generationLines.length,
        timeoutLine: Object.fromEntries(
          Object.entries(timeoutLine).filter(([key]) => key !== "run"),
        ),
        promptInLogs: false,
      },
      nonFixtureNetworkAttempts: f.blocked(),
    };
  } finally {
    stopActivity();
    await f.cleanup();
  }
}
