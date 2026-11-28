// Drives a running Pi Bot test copy through its existing background RPC client + tools/fake-llm
// to produce historical v0.1.0 demo states via normal app actions (never writes SQLite directly):
//   1. dream      — finished Memory Dream run with reviewable merge proposals
//   2. stuck-task — open idle group task (assigned, assignee run failed, no active worker)
//   3. held-plan  — dynamic group plan held at replan_limit (waiting for user's choice on the card)
//
// Usage:
//   node tools/demo-data/drive.ts <demo-dir-or-pibot-data-dir> [--only dream,stuck-task,held-plan] [--keep-fake-provider]
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type BackgroundWire,
  createPeer,
  Events,
  type GroupPlan,
  type GroupPlanCard,
  type MethodResults,
  Methods,
  type Peer,
  type Port,
} from "../../packages/protocol/src/index.ts";
import { connectBackground, readDescriptor } from "../../packages/sdk/src/node/index.ts";
import { startFakeLlm } from "../fake-llm/index.ts";
import type { Reply, Scenario } from "../fake-llm/scenario.ts";

type DemoStateKind = "dream" | "stuck-task" | "held-plan";
type ProductPeer = Peer<typeof Methods, typeof Events>;

const ALL_STATES: readonly DemoStateKind[] = ["dream", "stuck-task", "held-plan"];
const FAKE_PROVIDER_NAME = "Demo Fake LLM (v0.1.0)";

const ROUTE_DREAM = "demo-dream";
const ROUTE_STUCK_COORD = "demo-stuck-coord";
const ROUTE_STUCK_ASSIGNEE = "demo-stuck-assignee";
const ROUTE_PLAN_COORD = "demo-plan-coord";
const ROUTE_WRITER = "demo-writer";
const ROUTE_REVIEWER = "demo-reviewer";

const USER_MEMORY_SEEDS = [
  "用户正在独立开发轻量数字商品小店项目 shop，目前使用 TypeScript 和 SQLite。",
  "用户独自维护数字商品小店 shop，核心栈为 TypeScript (strict ESM)、pnpm 与单机 SQLite WAL。",
  "与用户沟通优先用简洁中文，代码标识符、文件路径和命令保留英文原样。",
] as const;

const BOT_MEMORY_SEEDS = [
  "改动 shop 代码前先读仓库根目录的 AGENTS.md 和 README.md。",
  "接手 shop 仓库任务时务必先查阅 AGENTS.md 的硬约束，所有金额按整数分计算并跑 typecheck。",
] as const;

function usage(): string {
  return [
    "Usage: node tools/demo-data/drive.ts <demo-dir-or-pibot-data-dir> [options]",
    "",
    "Options:",
    "  --only <list>          Comma-separated subset of: dream,stuck-task,held-plan",
    "  --keep-fake-provider   Keep the temporary fake-llm custom provider registered after exit",
    "  -h, --help             Show this help message",
  ].join("\n");
}

async function resolveDataDir(rawTarget: string): Promise<{ dataDir: string; logDir: string }> {
  const target = await realpath(resolve(rawTarget));
  const nested = join(target, "pibot-data");
  const nestedOwner = join(nested, "background-runtime", "owner.json");
  const directOwner = join(target, "background-runtime", "owner.json");

  for (const [dataDir, owner] of [
    [nested, nestedOwner],
    [target, directOwner],
  ] as const) {
    try {
      await access(owner);
      return { dataDir, logDir: join(tmpdir(), "pibot-demo-drive-logs") };
    } catch {
      // Try next candidate path.
    }
  }
  throw new Error(
    `No running Pi Bot background owner found under ${target} (missing background-runtime/owner.json). Launch the test copy first with PIBOT_DATA_DIR set.`,
  );
}

async function connectRpc(dataDir: string, signal: AbortSignal) {
  const descriptor = await readDescriptor(dataDir, undefined, signal);
  const businessListeners = new Set<(message: unknown) => void>();
  let connection: Awaited<ReturnType<typeof connectBackground>> | undefined;

  connection = await connectBackground(
    dataDir,
    descriptor.version,
    (message: BackgroundWire) => {
      if (message.kind === "business") {
        for (const listener of businessListeners) listener(message.message);
        return;
      }
      // Answer lightweight host pings (e.g. gui.updates.proxy) so headless background owners stay clean.
      if (
        message.kind === "gui" &&
        message.message &&
        typeof message.message === "object" &&
        "id" in message.message &&
        "method" in message.message
      ) {
        const req = message.message as { id: string | number | null; method: string };
        if (req.method === "gui.updates.proxy") {
          try {
            connection?.send({
              kind: "gui",
              message: { jsonrpc: "2.0", id: req.id, result: null },
            });
          } catch {
            // Connection already closing; safe to ignore.
          }
        }
      }
    },
    () => {
      // Disconnect handled by caller lifecycle.
    },
    signal,
  );

  await connection.control({ type: "attach" }, signal);

  const port: Port = {
    post(message) {
      connection?.send({ kind: "business", message });
    },
    onMessage(listener) {
      businessListeners.add(listener);
      return () => {
        businessListeners.delete(listener);
      };
    },
  };

  const peer = createPeer(port, { methods: Methods, events: Events, timeoutMs: 120_000 });
  const close = async () => {
    peer.dispose();
    try {
      await connection?.control({ type: "detach" }, AbortSignal.timeout(3_000));
    } catch {
      // Best-effort detach before closing socket.
    }
    connection?.close();
  };

  return { peer, descriptor, close };
}

async function until<T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  signal: AbortSignal,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  while (!deadline.aborted) {
    const value = await read();
    if (ready(value)) return value;
    await delay(120, undefined, { signal: deadline }).catch(() => undefined);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function collectPromptStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectPromptStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectPromptStrings(child, out);
  }
  return out;
}

function parseDreamNotes(
  body: Record<string, unknown>,
): Array<{ id: string; text: string; category: string | null }> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (msg?.role !== "user") continue;
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .map((part) =>
                part &&
                typeof part === "object" &&
                typeof (part as { text?: unknown }).text === "string"
                  ? (part as { text: string }).text
                  : "",
              )
              .join("\n")
          : "";
    try {
      const parsed = JSON.parse(content) as { notes?: unknown };
      if (Array.isArray(parsed.notes)) {
        return parsed.notes.filter(
          (item): item is { id: string; text: string; category: string | null } =>
            !!item &&
            typeof item === "object" &&
            typeof (item as { id?: unknown }).id === "string" &&
            typeof (item as { text?: unknown }).text === "string",
        );
      }
    } catch {
      // Non-JSON user prompt; keep searching.
    }
  }
  return [];
}

function buildDreamProposals(
  notes: readonly { id: string; text: string; category: string | null }[],
) {
  const userStack = notes.filter(
    (note) => note.text.includes("shop") && note.text.includes("SQLite"),
  );
  if (userStack.length >= 2 && userStack[0] && userStack[1]) {
    return {
      proposals: [
        {
          action: "merge",
          ids: [userStack[0].id, userStack[1].id],
          text: "用户正在独立开发轻量数字商品小店 shop，核心栈为 TypeScript (strict ESM)、pnpm 与单机 SQLite WAL。",
          category: "work",
          why: "合并两条关于 shop 技术栈的重复偏好记录",
        },
      ],
    };
  }

  const botWorkflow = notes.filter(
    (note) => note.text.includes("AGENTS.md") && note.text.includes("shop"),
  );
  if (botWorkflow.length >= 2 && botWorkflow[0] && botWorkflow[1]) {
    return {
      proposals: [
        {
          action: "merge",
          ids: [botWorkflow[0].id, botWorkflow[1].id],
          text: "处理 shop 仓库任务前先读 AGENTS.md 与 README.md，金额按整数分计算并在提交前跑 typecheck。",
          category: "work",
          why: "合并两条重叠的 shop 协作规范笔记",
        },
      ],
    };
  }

  return { proposals: [] };
}

async function approvePendingForBots(peer: ProductPeer, botIds: ReadonlySet<string>) {
  const pending = await peer.call("approvals.pending", {});
  for (const card of pending) {
    if (!botIds.has(card.botId)) continue;
    await peer
      .call("approvals.resolve", { id: card.id, decision: "allow", remember: false })
      .catch(() => undefined);
  }
}

async function waitGroupSettled(peer: ProductPeer, groupId: string, signal: AbortSignal) {
  await until(
    `group ${groupId} runs settled`,
    () => peer.call("chat.runs", { groupId }),
    (runs) => runs.every((run) => run.status !== "queued" && run.status !== "running"),
    signal,
  );
}

function makeHeldPlan(writerBotId: string, reviewerBotId: string): GroupPlan {
  return {
    name: "shop v0.4 发布页文案与上线审查",
    estimatedCostUsd: 0,
    steps: [
      {
        id: "draft",
        title: "起草发布页文案与定价表",
        owner: { botId: writerBotId },
        task: "起草 shop v0.4 发布页文案、三档定价表与退款说明，写入 launch-copy.md。",
        dependsOn: [],
        inputs: [],
        deliverables: [{ id: "copy", path: "launch-copy.md", kind: "md" }],
        acceptance: [{ id: "exists", check: "exists", deliverable: "copy" }],
        maxFixRounds: 0,
      },
      {
        id: "review",
        title: "独立审查定价与退款口径",
        owner: { botId: reviewerBotId },
        task: "独立核对 launch-copy.md 中的费率口径、折扣规则和 7 天退款政策，输出 Verdict: PASS 或 FAIL。",
        dependsOn: ["draft"],
        inputs: [{ stepId: "draft", deliverableId: "copy" }],
        deliverables: [{ id: "report", path: "review.md", kind: "md" }],
        acceptance: [{ id: "verdict", check: "verdict", deliverable: "report" }],
        maxFixRounds: 0,
      },
      {
        id: "publish",
        title: "整理多渠道发布分发清单",
        owner: { botId: writerBotId },
        task: "根据审查结论整理即刻、V2EX 与 Product Hunt 分发清单，写入 release-checklist.md。",
        dependsOn: ["review"],
        inputs: [{ stepId: "review", deliverableId: "report" }],
        deliverables: [{ id: "checklist", path: "release-checklist.md", kind: "md" }],
        acceptance: [{ id: "exists", check: "exists", deliverable: "checklist" }],
        maxFixRounds: 0,
      },
    ],
  };
}

export async function driveDemoStates(options: {
  target: string;
  states: ReadonlySet<DemoStateKind>;
  keepFakeProvider: boolean;
  signal: AbortSignal;
}) {
  const { dataDir, logDir } = await resolveDataDir(options.target);

  // Dynamic state shared between the driver and startFakeLlm's observe hook.
  let pendingPlan: GroupPlan | undefined;
  let stuckAssigneeName = "小测";

  const scenario: Scenario = {
    replies: [{ text: "演示剧本已执行完毕。" }],
    routes: {
      [ROUTE_DREAM]: Array.from({ length: 16 }, (): Reply => ({ text: '{"proposals":[]}' })),
      [ROUTE_STUCK_COORD]: [
        {
          delayMs: 0,
          toolCalls: [
            {
              name: "assign_task",
              arguments: {
                bot: "__STUCK_BOT__",
                title: "核对 shop 结账页错误码与退款说明",
                instructions:
                  "检查 shop 结账页在优惠券过期、余额不足、重复回调三种情况下的中文错误提示是否与 ErrorCode 字典一致。",
              },
            },
          ],
        },
        { text: "已将「核对 shop 结账页错误码与退款说明」分派出去，等待反馈。", delayMs: 0 },
      ],
      [ROUTE_STUCK_ASSIGNEE]: Array.from(
        { length: 8 },
        (): Reply => ({ text: "unused", httpError: "provider_error" }),
      ),
      [ROUTE_PLAN_COORD]: [
        {
          delayMs: 0,
          toolCalls: [{ name: "group_plan", arguments: { plan: {} } }],
        },
        { text: "已提交「shop v0.4 发布页文案与上线审查」动态计划，开始按步骤推进。", delayMs: 0 },
      ],
      [ROUTE_WRITER]: [
        // Initial draft
        {
          delayMs: 0,
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: "__DELIVERABLE__",
                content:
                  "# shop v0.4 发布页文案初稿\n\n零平台抽成的独立数字商品小店，支持 Free / Pro / Self-Hosted 三档方案。\n",
              },
            },
          ],
        },
        { text: "已完成 launch-copy.md 初稿，交由小审核对。", delayMs: 0 },
        // Auto-repair round 1
        {
          delayMs: 0,
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: "__DELIVERABLE__",
                content:
                  "# shop v0.4 发布页文案（修订 1）\n\n已补充 Pro 年付 ¥399（省 32%）示例与 7 天冷静期说明。\n",
              },
            },
          ],
        },
        { text: "已补充年付折扣示例和退款说明，请复验。", delayMs: 0 },
        // Auto-repair round 2
        {
          delayMs: 0,
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: "__DELIVERABLE__",
                content:
                  "# shop v0.4 发布页文案（修订 2）\n\n已统一微信支付（0.6%）与 Stripe（2.9% + $0.30）费率说明。\n",
              },
            },
          ],
        },
        { text: "已对齐双通道费率口径，请再次复验。", delayMs: 0 },
      ],
      [ROUTE_REVIEWER]: [
        // Initial review -> FAIL (triggers auto-repair #1)
        {
          delayMs: 0,
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: "__DELIVERABLE__",
                content:
                  "# 审查结论\n\nVerdict: FAIL\n- 缺少 Pro 年付折扣计算示例与 7 天退款政策条款\n",
              },
            },
          ],
        },
        { text: "审查未通过：缺少退款条款与年付折扣示例，等待修复。", delayMs: 0 },
        // Recheck #1 -> FAIL (triggers auto-repair #2)
        {
          delayMs: 0,
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: "__DELIVERABLE__",
                content:
                  "# 复验结论（第 1 轮）\n\nVerdict: FAIL\n- 微信支付与 Stripe 双通道费率口径尚未对齐\n",
              },
            },
          ],
        },
        { text: "第 1 轮复验仍未通过：双通道费率口径不一致。", delayMs: 0 },
        // Recheck #2 -> FAIL (hits replan_limit 2/2 -> holdForReplanLimit!)
        {
          delayMs: 0,
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: "__DELIVERABLE__",
                content:
                  "# 复验结论（第 2 轮）\n\nVerdict: FAIL\n- 自部署买断版的电子发票开具说明仍需产品负责人拍板\n",
              },
            },
          ],
        },
        { text: "第 2 轮复验仍存在待拍板项：自部署买断版发票口径。", delayMs: 0 },
      ],
    },
  };

  let lastFolder: string | undefined;
  let lastContract: string | undefined;

  const llm = await startFakeLlm({
    port: 0,
    scenario,
    logDirectory: logDir,
    observe(body, route, index) {
      if (route === ROUTE_DREAM) {
        const notes = parseDreamNotes(body);
        const draft = buildDreamProposals(notes);
        const replies = scenario.routes?.[ROUTE_DREAM];
        if (replies) {
          replies[index] = { text: JSON.stringify(draft), delayMs: 0 };
        }
        return;
      }

      const text = collectPromptStrings(body.messages ?? body.input).join("\n");
      const lastMatch = (pattern: RegExp) => [...text.matchAll(pattern)].at(-1)?.[1];
      const folder = lastMatch(/产物目录 \/ Output folder:\n([^\n]+)/g) ?? lastFolder;
      const contract = lastMatch(/交付合同 \/ Delivery contract:\n([^\n]+)/g) ?? lastContract;
      lastFolder = folder;
      lastContract = contract;

      const reply = scenario.routes?.[route]?.[index];
      for (const call of reply?.toolCalls ?? []) {
        if (call.name === "assign_task" && call.arguments.bot === "__STUCK_BOT__") {
          call.arguments.bot = stuckAssigneeName;
        }
        if (call.name === "group_plan" && pendingPlan) {
          call.arguments.plan = structuredClone(pendingPlan);
        }
        if (call.name === "write_file" && call.arguments.path === "__DELIVERABLE__") {
          if (folder && contract) {
            const parsed = JSON.parse(contract) as { deliverables: { path: string }[] };
            const relPath = parsed.deliverables[0]?.path;
            if (relPath) call.arguments.path = join(folder, relPath);
          }
        }
      }
    },
  });

  const rpc = await connectRpc(dataDir, options.signal);
  const { peer } = rpc;
  let fakeProviderId: string | undefined;
  let originalDefaultModel: MethodResults["settings.get"]["defaultModel"];
  let originalAuxiliaryModel: MethodResults["settings.get"]["auxiliaryModel"];
  let originalLanguage: MethodResults["settings.get"]["language"] | undefined;
  const createdBotIds: string[] = [];

  const summary: Record<string, unknown> = {
    ok: true,
    dataDir,
    fakeLlmUrl: llm.url,
  };

  try {
    const initialSettings = await peer.call("settings.get", {});
    originalDefaultModel = initialSettings.defaultModel ?? null;
    originalAuxiliaryModel = initialSettings.auxiliaryModel ?? null;
    originalLanguage = initialSettings.language;

    const upserted = await peer.call("customProviders.upsert", {
      name: FAKE_PROVIDER_NAME,
      baseUrl: `${llm.url}/v1`,
      api: "openai-completions",
      apiKey: "demo-synthetic-key-only",
      models: [
        ROUTE_DREAM,
        ROUTE_STUCK_COORD,
        ROUTE_STUCK_ASSIGNEE,
        ROUTE_PLAN_COORD,
        ROUTE_WRITER,
        ROUTE_REVIEWER,
      ].map((id) => ({
        id,
        contextWindow: 65_536,
        maxTokens: 2_048,
      })),
    });
    fakeProviderId = upserted.id;

    // Ensure Chinese UI language and point Dream's model route at ROUTE_DREAM.
    await peer.call("settings.set", {
      language: "zh",
      defaultModel: { provider: fakeProviderId, id: ROUTE_DREAM, thinkingLevel: "off" },
      auxiliaryModel: null,
    });

    const bots = await peer.call("bots.list", {});
    const mainBot = bots.find((bot) => bot.isMain);
    if (!mainBot) throw new Error("Main Pi Bot not found in running test copy.");

    // --- 1. Finished Dream run with reviewable merge proposals ---
    if (options.states.has("dream")) {
      const existingDream = await peer.call("memory.dream.last", {});
      if (existingDream && existingDream.status === "done" && existingDream.proposed > 0) {
        summary.dream = {
          skipped: true,
          reason: "dream_already_finished_today",
          id: existingDream.id,
          proposed: existingDream.proposed,
          merged: existingDream.merged,
          retired: existingDream.retired,
        };
      } else {
        for (const text of USER_MEMORY_SEEDS) {
          await peer
            .call("memory.manage", {
              scope: "user",
              ownerId: "user",
              confirmed: true,
              change: { action: "import", text, category: "work" },
            })
            .catch(() => undefined);
        }
        for (const text of BOT_MEMORY_SEEDS) {
          await peer
            .call("memory.manage", {
              scope: "bot",
              ownerId: mainBot.id,
              confirmed: true,
              change: { action: "import", text, category: "work" },
            })
            .catch(() => undefined);
        }

        const dreamResult = await peer.call(
          "memory.dream.run",
          { ownerInitiated: true },
          { signal: options.signal, timeoutMs: 180_000 },
        );
        const userBrowse = await peer.call("memory.browse", {
          scope: "user",
          ownerId: "user",
          state: "active",
        });
        const botBrowse = await peer.call("memory.browse", {
          scope: "bot",
          ownerId: mainBot.id,
          state: "active",
        });
        summary.dream = {
          id: dreamResult.id,
          status: dreamResult.status,
          ...(dreamResult.failureReason ? { failureReason: dreamResult.failureReason } : {}),
          proposed: dreamResult.proposed,
          merged: dreamResult.merged,
          retired: dreamResult.retired,
          pendingUserProposals: userBrowse.proposals.filter((p) => p.status === "pending").length,
          pendingBotProposals: botBrowse.proposals.filter((p) => p.status === "pending").length,
        };
      }
    }

    // Helper to create a clean demo Bot through normal RPC (explicit name + systemPrompt avoids persona LLM calls).
    const createDemoBot = async (
      name: string,
      description: string,
      systemPrompt: string,
      routeModelId: string,
    ) => {
      const bot = await peer.call("bots.create", {
        name,
        description,
        systemPrompt,
        model: { provider: fakeProviderId as string, id: routeModelId },
        thinkingLevel: "off",
      });
      await peer.call("bots.update", {
        botId: bot.id,
        memoryExtraction: false,
      });
      createdBotIds.push(bot.id);
      return bot;
    };

    // --- 2. Stuck idle group task ---
    if (options.states.has("stuck-task")) {
      const coord = await createDemoBot(
        "小统筹",
        "负责拆解 shop 日常巡检与发布前核对任务并跟进进度。",
        "你是 shop 小店的日常统筹，收到需求后使用 assign_task 分派给合适成员。",
        ROUTE_STUCK_COORD,
      );
      const qa = await createDemoBot(
        "小测",
        "负责核对 shop 结账页错误码、优惠券边界与退款流程。",
        "你是 shop 质量检查员，负责核对边界条件并汇报结果。",
        ROUTE_STUCK_ASSIGNEE,
      );
      stuckAssigneeName = qa.name;

      const group = await peer.call("groups.create", {
        name: "shop 日常巡检群",
        botIds: [coord.id, qa.id],
        coordinatorBotId: coord.id,
        announcement: "负责 shop 结账链路、错误码与回归清单的日常核对。",
        autoRoundLimit: 6,
      });

      await peer.call("chat.send", {
        groupId: group.id,
        text: "请先安排小测核对一遍 shop 结账页的错误码与退款说明。",
      });

      const tasks = await until(
        "stuck idle group task created",
        async () => {
          await approvePendingForBots(peer, new Set([coord.id, qa.id]));
          const runs = await peer.call("chat.runs", { groupId: group.id });
          if (runs.some((run) => run.status === "queued" || run.status === "running")) {
            return [];
          }
          return peer.call("groups.tasks", { groupId: group.id, status: "open" });
        },
        (rows) => rows.some((task) => task.status === "open" && task.activity?.state === "error"),
        options.signal,
      );

      await waitGroupSettled(peer, group.id, options.signal);
      const stuckTask = tasks.find((task) => task.status === "open");
      summary.stuckTask = {
        groupId: group.id,
        groupName: group.name,
        taskId: stuckTask?.id ?? null,
        title: stuckTask?.title ?? null,
        status: stuckTask?.status ?? null,
        activityState: stuckTask?.activity?.state ?? null,
        note: "Open task with no active run (visible in Group Tasks & recovery UI; qualifies for pi_health_check task_idle_open after 24h inactivity).",
      };
    }

    // --- 3. Held plan (replan_limit 2/2 waiting for user choice) ---
    if (options.states.has("held-plan")) {
      const lead = await createDemoBot(
        "发布统筹",
        "负责统筹 shop v0.4 发布页文案、独立审查和分发清单的动态计划。",
        "你是 shop v0.4 发布群统筹，收到发布需求后使用 group_plan 提交结构化步骤计划。",
        ROUTE_PLAN_COORD,
      );
      const writer = await createDemoBot(
        "小文",
        "负责起草与修订 shop 发布文案、定价说明和多渠道分发清单。",
        "你是 shop 文案写手，负责按步骤交付物要求撰写和修订 Markdown 文件。",
        ROUTE_WRITER,
      );
      const reviewer = await createDemoBot(
        "小审",
        "负责独立审查发布稿件中的定价口径、费率与退款条款，输出 PASS/FAIL 结论。",
        "你是独立审查员，严格核对交付内容并在报告中给出明确的 Verdict: PASS 或 Verdict: FAIL。",
        ROUTE_REVIEWER,
      );

      const group = await peer.call("groups.create", {
        name: "shop v0.4 发布小组",
        botIds: [lead.id, writer.id, reviewer.id],
        coordinatorBotId: lead.id,
        announcement: "协同完成 shop v0.4 发布文案、定价与退款审查及渠道分发清单。",
        autoRoundLimit: 10,
      });

      pendingPlan = makeHeldPlan(writer.id, reviewer.id);
      const memberIds = new Set([lead.id, writer.id, reviewer.id]);

      await peer.call("chat.send", {
        groupId: group.id,
        text: "按发布小组流程推进 shop v0.4 发布页文案、独立审查和分发清单，先提交动态计划。",
      });

      const currentCard = await until(
        "held plan card created",
        async () => {
          await approvePendingForBots(peer, memberIds);
          const current = await peer.call("groups.plan.current", { groupId: group.id });
          if (current) return current;
          const history = await peer.call("chat.history", { groupId: group.id, limit: 50 });
          const found = history
            .map((msg) => ({
              messageId: msg.id,
              card: (msg.usage as { groupPlan?: GroupPlanCard } | null)?.groupPlan,
            }))
            .find((item) => item.card);
          return found?.card ? { messageId: found.messageId, card: found.card } : null;
        },
        Boolean,
        options.signal,
      );

      if (!currentCard) throw new Error("Expected group plan card to be created.");

      const progress = await until(
        "plan reaches replan_limit hold",
        async () => {
          await approvePendingForBots(peer, memberIds);
          return peer.call("groups.plan.progress", {
            groupId: group.id,
            workflowRunId: currentCard.card.id,
          });
        },
        (state) => state.status === "waiting" && state.choice?.kind === "replan_limit",
        options.signal,
        180_000,
      );

      await waitGroupSettled(peer, group.id, options.signal);
      summary.heldPlan = {
        groupId: group.id,
        groupName: group.name,
        workflowRunId: progress.workflowRunId,
        status: progress.status,
        choice: progress.choice ?? null,
        passed: progress.passed,
        total: progress.total,
      };
    }

    // Restore original model settings when the test copy already had a real model configured.
    if (originalDefaultModel) {
      for (const botId of createdBotIds) {
        await peer
          .call("bots.update", {
            botId,
            modelProvider: originalDefaultModel.provider,
            modelId: originalDefaultModel.id,
            thinkingLevel: originalDefaultModel.thinkingLevel,
          })
          .catch(() => undefined);
      }
      await peer.call("settings.set", {
        ...(originalLanguage ? { language: originalLanguage } : {}),
        defaultModel: originalDefaultModel,
        auxiliaryModel: originalAuxiliaryModel ?? null,
      });
      if (!options.keepFakeProvider && fakeProviderId) {
        await peer.call("providers.remove", { providerId: fakeProviderId }).catch(() => undefined);
      }
      summary.fakeProviderCleanedUp = !options.keepFakeProvider;
    } else {
      summary.fakeProviderCleanedUp = false;
      summary.modelNote =
        "No prior real defaultModel was configured; configure your real model in Settings before filming live turns.";
    }

    summary.fakeLlmRequests = llm.counts();
    return summary;
  } finally {
    await rpc.close();
    await llm.stop();
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      only: { type: "string" },
      "keep-fake-provider": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length !== 1 || !positionals[0]) {
    console.log(usage());
    process.exit(values.help ? 0 : 1);
  }

  const states = new Set<DemoStateKind>(ALL_STATES);
  if (values.only) {
    states.clear();
    for (const part of values.only
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!ALL_STATES.includes(part as DemoStateKind)) {
        throw new Error(`Unknown --only state "${part}". Expected: ${ALL_STATES.join(", ")}`);
      }
      states.add(part as DemoStateKind);
    }
    if (!states.size) throw new Error("--only requires at least one state.");
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const result = await driveDemoStates({
      target: positionals[0],
      states,
      keepFakeProvider: values["keep-fake-provider"] ?? false,
      signal: controller.signal,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
