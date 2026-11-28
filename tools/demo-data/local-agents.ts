// Deterministic fake Codex home (CODEX_HOME) and Claude Code config (CLAUDE_CONFIG_DIR).
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface LocalTurn {
  user: string;
  assistant: string;
  toolName?: string;
}

interface CodexSeedSession {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  title: string;
  turns: LocalTurn[];
}

interface ClaudeSeedSession {
  uuid: string;
  isoStart: string;
  turns: LocalTurn[];
}

// 8 deterministic Codex sessions matching packages/import/src/brain/local/{locations,agent-list,transcript}.ts.
const CODEX_SESSIONS: readonly CodexSeedSession[] = [
  {
    id: "019a7c10-0001-7000-8000-000000000001",
    date: "2026-10-12",
    time: "09:15:00",
    title: "重构 shop 订单状态机 OrderStateMachine",
    turns: [
      {
        user: "帮我把 src/orders.ts 里的订单状态切换抽成显式状态机，禁止从 refunded 再切回 paid。",
        toolName: "apply_patch",
        assistant:
          "已经重构 `src/orders.ts`：引入 `ORDER_TRANSITIONS` 合法迁移表和 `transitionOrder()`，遇到非法迁移统一抛出带 `INVALID_ORDER_TRANSITION` 的错误对象，并保留了每次迁移的 `reason` 记录。",
      },
      {
        user: "补一下 expired 状态，超时未支付订单应该能自动过期。",
        assistant:
          "已补充 `pending -> expired` 迁移路径，同时禁止 `expired` 再回到 `paid`；如果是晚到的支付回调，应触发人工核查或自动原路退回。",
      },
    ],
  },
  {
    id: "019a7c10-0002-7000-8000-000000000002",
    date: "2026-10-16",
    time: "14:20:00",
    title: "修复优惠券 UTC 过期校验与最低消费门槛",
    turns: [
      {
        user: "检查一下 src/coupons.ts，之前有用户在零点附近用过期优惠券成功下单了。",
        toolName: "read_file",
        assistant:
          "定位到问题：`expiresAt` 比较时混用了本地时间。已统一改为 `Date.parse(coupon.expiresAt) <= Date.parse(nowIso)` 的严格 UTC 比较，并补上了 `minAmountCents` 门槛校验。",
      },
    ],
  },
  {
    id: "019a7c10-0003-7000-8000-000000000003",
    date: "2026-10-21",
    time: "11:05:00",
    title: "实现 shop 分级定价与年付折扣计算",
    turns: [
      {
        user: "在 src/pricing.ts 里加上 Free / Pro / Self-Hosted 三档定价常量，并支持月付与年付价格计算。",
        toolName: "apply_patch",
        assistant:
          "已在 `src/pricing.ts` 定义 `PLANS`（Free ¥0、Pro ¥49/月或 ¥399/年、Self-Hosted ¥699 买断）及 `calculateCheckoutTotal()`，所有金额均以整数分（cents）计算避免浮点误差。",
      },
    ],
  },
  {
    id: "019a7c10-0004-7000-8000-000000000004",
    date: "2026-10-26",
    time: "16:40:00",
    title: "给订单导出 CSV 补上 UTF-8 BOM 与公式注入防护",
    turns: [
      {
        user: "Windows Excel 打开导出的订单表中文乱码，顺便防一下单元格以 = 开头的公式注入。",
        toolName: "shell",
        assistant:
          "导出输出头已加上 `\\uFEFF` UTF-8 BOM，单元格以 `=`, `+`, `-`, `@` 开头时自动前缀单引号并按 RFC 4180 转义双引号。",
      },
    ],
  },
  {
    id: "019a7c10-0005-7000-8000-000000000005",
    date: "2026-11-01",
    time: "10:30:00",
    title: "整理 Webhook 幂等回执与重放保护",
    turns: [
      {
        user: "帮我检查 Stripe 和微信支付回调处理，确保同一 event_id 重复投递不会重发交付邮件。",
        toolName: "read_file",
        assistant:
          "建议把 `webhook_receipts(provider, event_id)` 唯一键插入和订单 `transitionOrder(..., 'paid')` 合并在同一个 `BEGIN IMMEDIATE` 事务中，并在外层把发货邮件写入 `mail_outbox`。",
      },
    ],
  },
  {
    id: "019a7c10-0006-7000-8000-000000000006",
    date: "2026-11-05",
    time: "19:10:00",
    title: "完善 shop README 与 AGENTS.md 协作规范",
    turns: [
      {
        user: "把 shop 的目录结构、定价原则、金额用整数分这些硬约束写进 AGENTS.md，方便以后让不同 Agent 接手。",
        toolName: "apply_patch",
        assistant:
          "已更新 `AGENTS.md` 和 `README.md`，写明了架构约束（TypeScript strict ESM + 整数分 + 单一订单状态机）以及改动后的本地验证命令。",
      },
    ],
  },
  {
    id: "019a7c10-0007-7000-8000-000000000007",
    date: "2026-11-10",
    time: "15:00:00",
    title: "核对 v0.4 发布前 Checklist 与回滚预案",
    turns: [
      {
        user: "帮我列一份 shop v0.4 上线前 10 分钟内能跑完的发布检查清单。",
        assistant:
          "已整理 6 项发布前必检：\n1. `npm run typecheck` 零报错；\n2. 跑通优惠券与状态机单元测试；\n3. 先执行 `VACUUM INTO` 热备线上 SQLite；\n4. 校验 Stripe/微信 Webhook 密钥环境变量非空；\n5. 发版后用测试券跑一笔 ¥0.01 真单并验证退款；\n6. 观察 15 分钟错误日志与 `/healthz`。",
      },
    ],
  },
  {
    id: "019a7c10-0008-7000-8000-000000000008",
    date: "2026-11-14",
    time: "13:25:00",
    title: "打磨 docs/launch-draft.md 发布文章数据与措辞",
    turns: [
      {
        user: "帮我审一下 docs/launch-draft.md，把太像营销广告的句子改成更克制的独立开发者口吻。",
        toolName: "read_file",
        assistant:
          "已润色 `docs/launch-draft.md`：删掉了“颠覆”“一站式神器”这类空词，替换成了具体的 0% 平台抽成、单机 SQLite 热备耗时和真实踩坑细节。",
      },
    ],
  },
];

// 6 deterministic Claude Code sessions matching packages/import/src/brain/local/{locations,agent-list,transcript}.ts.
const CLAUDE_SESSIONS: readonly ClaudeSeedSession[] = [
  {
    uuid: "11111111-2222-4333-8444-000000000001",
    isoStart: "2026-10-14T10:00:00.000Z",
    turns: [
      {
        user: "帮我审查一下 shop 的 pricing.ts，确认折扣和满减在低价商品上不会算出负数。",
        assistant:
          "检查了 `calculateCheckoutTotal`：当满减金额大于商品小计时，需要用 `Math.max(0, subtotalCents - discountCents)` 兜底，并且建议对百分比折扣使用 `Math.round` 统一取整，避免不同语言端差 1 分钱。",
      },
      {
        user: "如果商品本身是免费的（0 元试用包），输入优惠券怎么处理？",
        assistant:
          "免费商品跳过优惠券核销，不消耗 `maxRedemptions` 次数，直接返回 `discountCents: 0` 并在提示里说明“免费商品无需使用优惠券”。",
      },
    ],
  },
  {
    uuid: "11111111-2222-4333-8444-000000000002",
    isoStart: "2026-10-19T13:30:00.000Z",
    turns: [
      {
        user: "给 shop 写一版面向创作者的首页文案草稿，突出 0% 抽成和数据自持。",
        assistant:
          "主标题建议：“**卖你的数字作品，收入 100% 进自己的账户**”。\n三条卖点卡片：\n1. 零平台抽成，支持微信支付与 Stripe；\n2. 自动交付电子书、模板与许可证密钥；\n3. 随时导出全部订单数据，也支持单机 SQLite 自部署。",
      },
    ],
  },
  {
    uuid: "11111111-2222-4333-8444-000000000003",
    isoStart: "2026-10-25T16:15:00.000Z",
    turns: [
      {
        user: "设计一下 shop 的订单退款流程：退款成功后要联动做哪些收尾动作？",
        assistant:
          "建议把退款收尾收敛成一个确定性动作序列：\n1. 订单状态经 `OrderStateMachine` 切到 `refunded`；\n2. 立即吊销该订单关联的下载 token；\n3. 如果使用了限量优惠券，按策略决定是否释放核销计数（默认不回补防刷）；\n4. 写入审计事件并发送退款确认邮件。",
      },
    ],
  },
  {
    uuid: "11111111-2222-4333-8444-000000000004",
    isoStart: "2026-11-02T09:45:00.000Z",
    turns: [
      {
        user: "帮我把 v0.4 的中英文 Release Notes 对照着核对一遍，确保英文版自然不机翻。",
        assistant:
          "已对照核对完毕：把“zero-commission”统一为“0% platform fee”，把“防止重复发货”翻成“idempotent webhook receipts so duplicate retries never double-send delivery emails”，更符合海外独立开发者习惯。",
      },
    ],
  },
  {
    uuid: "11111111-2222-4333-8444-000000000005",
    isoStart: "2026-11-08T18:20:00.000Z",
    turns: [
      {
        user: "整理下 shop 下个季度最值得做的 3 个小功能，不要铺太大。",
        assistant:
          "按投入产出比排序：\n1. **Webhook 自动化通知**：付款/退款后推给创作者自己的 Discord / 飞书群；\n2. **买断版一键升级脚本**：拉新镜像前自动 `VACUUM INTO` 备份 SQLite；\n3. **限时组合包（Bundle）**：允许创作者把 2–3 个现有数字商品打包卖，客单价提升最明显。",
      },
    ],
  },
  {
    uuid: "11111111-2222-4333-8444-000000000006",
    isoStart: "2026-11-15T11:10:00.000Z",
    turns: [
      {
        user: "检查一下 AGENTS.md 和 CLAUDE.md 有没有互相冲突的规范。",
        assistant:
          "通读了两份规则文件：两者在“整数分计价、UTC ISO 时间、先跑 typecheck、禁止手改订单状态”四条硬约束上完全一致，没有冲突。",
      },
    ],
  },
];

const CODEX_MEMORY_MD = `# Codex Memories

## 关于你 / 偏好
- 独立开发者，主力维护数字商品小店项目 shop，沟通偏好简洁中文，技术名词与标识符保留英文。
- 偏爱轻量单机架构（TypeScript + pnpm + SQLite WAL），反感为了假想高并发引入多余中间件。
- 写对外文章和更新日志偏好克制真实，用具体数字和踩坑过程说话，不用浮夸营销词。

## 工作方式与项目规范
- 修改 shop 金额、折扣或税费逻辑时，全部使用整数分（cents）计算，禁止浮点数直接加减。
- 所有订单状态流转必须通过 src/orders.ts 的 transitionOrder 状态机，禁止绕过校验直接改写状态。
- 所有优惠券过期与活动时间比较一律使用 UTC ISO-8601 字符串。
- 每次改动代码后，先跑 npm run typecheck 并补充对应边界用例再汇总结果。
`;

const CLAUDE_MEMORY_INDEX_MD = `# Project Memory Index

- [user_profile.md](user_profile.md) — 独立开发者偏好与沟通习惯
- [project_shop.md](project_shop.md) — shop 项目架构与定价共识
- [feedback_style.md](feedback_style.md) — 代码审查与发布文案风格约束
`;

const CLAUDE_MEMORY_USER_MD = `---
name: 独立开发者沟通偏好
description: 中文简洁回答、代码标识符保留英文、先给结论
type: user
---

- 回复优先使用简洁中文，代码标识符、文件路径和命令保留英文原样。
- 先给结论和明确步骤，再展开细节；涉及数据迁移或线上发布必须提醒先做备份。
`;

const CLAUDE_MEMORY_PROJECT_MD = `---
name: shop 核心架构与定价约束
description: shop 独立数字商品小店的技术栈、定价档位与数据边界
type: project
---

- shop 采用 TypeScript strict ESM + 单机 SQLite WAL，支持云托管与自部署买断。
- 定价方案为 Free（最多 3 个商品、0% 抽成）、Pro（¥49/月或 ¥399/年）与 Self-Hosted（¥699 买断）。
- 支付回调必须走幂等回执表，订单 CSV 导出必须带 UTF-8 BOM 并防公式注入。
`;

const CLAUDE_MEMORY_FEEDBACK_MD = `---
name: 文案与代码审查习惯
description: 对外发布文章避免夸张营销词，代码改动保持小步可验证
type: feedback
---

- 对外发帖与 Release Notes 禁止使用“颠覆”“神器”“史上最强”等夸张词，尽量给出实测数据和真实权衡。
- 优惠券和结账逻辑修改必须覆盖 0 元商品、满减超额、刚好过期三类边界条件。
`;

function encodeClaudeProjectDir(shopPath: string): string {
  // Claude Code encodes `/Users/alice/shop` as `-Users-alice-shop`.
  return shopPath.replace(/[\\/]+/g, "-");
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export interface LocalAgentsStats {
  codexHome: string;
  codexSessions: number;
  codexMemoryFile: string;
  claudeConfigDir: string;
  claudeSessions: number;
  claudeMemoryDir: string;
}

export async function generateLocalAgentFixtures(
  outputRoot: string,
  shopPath: string,
): Promise<LocalAgentsStats> {
  // --- 1. Fake Codex home dir (CODEX_HOME) ---
  const codexHome = join(outputRoot, "codex-home");
  const codexMemDir = join(codexHome, "memories");
  await mkdir(codexMemDir, { recursive: true });

  const indexLines: string[] = [];
  for (const session of CODEX_SESSIONS) {
    const [year, month, day] = session.date.split("-") as [string, string, string];
    const dayDir = join(codexHome, "sessions", year, month, day);
    await mkdir(dayDir, { recursive: true });

    const startIso = `${session.date}T${session.time}.000Z`;
    const fileStamp = `${session.date}T${session.time.replaceAll(":", "-")}`;
    const rolloutPath = join(dayDir, `rollout-${fileStamp}-${session.id}.jsonl`);

    const rows: Record<string, unknown>[] = [
      {
        timestamp: startIso,
        type: "session_meta",
        payload: {
          id: session.id,
          timestamp: startIso,
          cwd: shopPath,
          originator: "codex_cli_rs",
          cli_version: "0.30.0",
        },
      },
    ];

    let offsetSec = 10;
    let callSeq = 1;
    for (const turn of session.turns) {
      rows.push({
        timestamp: addSeconds(startIso, offsetSec),
        type: "event_msg",
        payload: { type: "user_message", message: turn.user },
      });
      offsetSec += 15;

      if (turn.toolName) {
        const callId = `call_${session.id.slice(-4)}_${callSeq++}`;
        rows.push({
          timestamp: addSeconds(startIso, offsetSec),
          type: "response_item",
          payload: {
            type: "function_call",
            name: turn.toolName,
            call_id: callId,
            arguments: "{}",
          },
        });
        offsetSec += 5;
        rows.push({
          timestamp: addSeconds(startIso, offsetSec),
          type: "response_item",
          payload: {
            type: "function_call_output",
            name: turn.toolName,
            call_id: callId,
            output: "ok",
          },
        });
        offsetSec += 10;
      }

      rows.push({
        timestamp: addSeconds(startIso, offsetSec),
        type: "event_msg",
        payload: { type: "agent_message", message: turn.assistant },
      });
      offsetSec += 45;
    }

    const updatedAt = addSeconds(startIso, offsetSec);
    const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writeFile(rolloutPath, jsonl, "utf8");
    // Historical mtime (> 2 min old) so Pi Bot's IN_PROGRESS_MS check never flags source_in_use.
    const mtime = new Date(updatedAt);
    await utimes(rolloutPath, mtime, mtime);

    indexLines.push(
      JSON.stringify({
        id: session.id,
        thread_name: session.title,
        updated_at: updatedAt,
      }),
    );
  }

  const indexPath = join(codexHome, "session_index.jsonl");
  await writeFile(indexPath, `${indexLines.join("\n")}\n`, "utf8");
  const codexMemoryFile = join(codexMemDir, "MEMORY.md");
  await writeFile(codexMemoryFile, CODEX_MEMORY_MD, "utf8");

  // --- 2. Fake Claude Code config dir (CLAUDE_CONFIG_DIR) ---
  const claudeConfigDir = join(outputRoot, "claude-config");
  const encodedProject = encodeClaudeProjectDir(shopPath);
  const claudeProjectDir = join(claudeConfigDir, "projects", encodedProject);
  const claudeMemoryDir = join(claudeProjectDir, "memory");
  await mkdir(claudeMemoryDir, { recursive: true });

  for (const session of CLAUDE_SESSIONS) {
    const filePath = join(claudeProjectDir, `${session.uuid}.jsonl`);
    const rows: Record<string, unknown>[] = [];
    let offsetSec = 0;

    for (const turn of session.turns) {
      rows.push({
        type: "user",
        cwd: shopPath,
        sessionId: session.uuid,
        timestamp: addSeconds(session.isoStart, offsetSec),
        message: { role: "user", content: turn.user },
      });
      offsetSec += 25;
      rows.push({
        type: "assistant",
        cwd: shopPath,
        sessionId: session.uuid,
        timestamp: addSeconds(session.isoStart, offsetSec),
        message: {
          role: "assistant",
          content: [{ type: "text", text: turn.assistant }],
        },
      });
      offsetSec += 60;
    }

    const updatedAt = addSeconds(session.isoStart, offsetSec);
    await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    // Historical mtime (> 2 min old) so Pi Bot lists these as completed sessions ready to import.
    const mtime = new Date(updatedAt);
    await utimes(filePath, mtime, mtime);
  }

  await Promise.all([
    writeFile(join(claudeMemoryDir, "MEMORY.md"), CLAUDE_MEMORY_INDEX_MD, "utf8"),
    writeFile(join(claudeMemoryDir, "user_profile.md"), CLAUDE_MEMORY_USER_MD, "utf8"),
    writeFile(join(claudeMemoryDir, "project_shop.md"), CLAUDE_MEMORY_PROJECT_MD, "utf8"),
    writeFile(join(claudeMemoryDir, "feedback_style.md"), CLAUDE_MEMORY_FEEDBACK_MD, "utf8"),
  ]);

  return {
    codexHome,
    codexSessions: CODEX_SESSIONS.length,
    codexMemoryFile,
    claudeConfigDir,
    claudeSessions: CLAUDE_SESSIONS.length,
    claudeMemoryDir,
  };
}
