// Deterministic fake TypeScript project repo (~shop) for Pi's project-folder dispatch.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PACKAGE_JSON = `{
  "name": "indie-shop",
  "version": "0.4.0",
  "private": true,
  "type": "module",
  "description": "轻量零抽成数字商品小店（TypeScript + SQLite）",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "demo": "node src/index.ts"
  }
}
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
`;

const GITIGNORE = `node_modules/
dist/
.pibot/
*.db
*.db-wal
*.db-shm
.env
`;

const README_MD = `# shop — 独立数字商品小店

轻量、零平台抽成的数字商品小店（电子书、模板、软件许可证），基于 TypeScript (strict ESM) 与单机 SQLite WAL。

## 核心特点

- **0% 平台抽成**：支持微信支付与 Stripe，收款直连创作者自己的账户。
- **清晰状态机**：订单状态流转集中由 \`src/orders.ts\` 管理，防止重复 Webhook 覆盖状态。
- **确定性计价**：\`src/pricing.ts\` 与 \`src/coupons.ts\` 全部采用整数分（cents）计算，支持满减与百分比折扣。
- **数据归属自己**：支持云托管，也支持单机自部署与一键导出 UTF-8 BOM CSV。

## 目录结构

- \`src/orders.ts\` — 订单状态机（\`OrderStateMachine\`）与合法迁移表
- \`src/pricing.ts\` — 订阅/买断档位定义与结账总额计算
- \`src/coupons.ts\` — 优惠券校验（UTC 过期时间、最低门槛、核销上限）
- \`src/index.ts\` — 本地演示入口，输出模拟结账与订单状态流转结果
- \`docs/launch-draft.md\` — v0.4 发布文章草稿

## 运行

\`\`\`sh
node src/index.ts
\`\`\`
`;

const AGENTS_MD = `# AGENTS.md (shop)

本文件约定在 \`shop\` 仓库中协作的 AI Agent 与开发者共同遵守的规则。

## 硬约束

1. **金额只用整数分（cents）**：禁止使用浮点元（如 \`49.9\`）直接参与加减乘除，折扣取整统一用 \`Math.round\`，最终实付金额不得小于 \`0\`。
2. **订单状态只走状态机**：所有状态变更必须经过 \`src/orders.ts\` 的 \`transitionOrder()\`，禁止在业务代码中直接覆盖 \`order.status\`。
3. **时间统一 UTC ISO-8601**：优惠券过期与订单超时判定统一使用 UTC ISO 字符串比较，不依赖宿主机本地时区。
4. **隐私与日志**：严禁把支付密钥、买家完整邮箱或 Webhook Secret 写入日志或测试快照。

## 沟通与改动习惯

- 默认使用简洁中文说明结论，代码符号、文件名和命令保持英文原样。
- 改动代码前先确认影响范围；改动完成后运行 \`node src/index.ts\`（以及仓库有依赖时运行 \`npm run typecheck\`）验证。
- 润色 \`docs/launch-draft.md\` 等对外文案时保持克制真实，不用“颠覆”“神器”等夸张营销词。
`;

const CLAUDE_MD = `# CLAUDE.md (shop)

请先阅读同目录下的 \`AGENTS.md\`，并遵守其中的全部约定：

- 金额计算统一使用整数分（cents），结果下限为 \`0\`。
- 订单状态变更只允许调用 \`src/orders.ts\` 的 \`transitionOrder()\`。
- 优惠券过期判断严格按 UTC ISO 时间比较。
- 回复尽量简洁，中文为主，保留英文技术术语与代码标识。
`;

const ORDERS_TS = `export type OrderStatus = "draft" | "pending" | "paid" | "fulfilled" | "refunded" | "expired";

export interface OrderEvent {
  from: OrderStatus;
  to: OrderStatus;
  at: string;
  reason: string;
}

export interface Order {
  id: string;
  productSlug: string;
  amountCents: number;
  currency: "CNY" | "USD";
  status: OrderStatus;
  events: OrderEvent[];
}

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ["pending"],
  pending: ["paid", "expired"],
  paid: ["fulfilled", "refunded"],
  fulfilled: ["refunded"],
  refunded: [],
  expired: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function transitionOrder(
  order: Order,
  next: OrderStatus,
  reason: string,
  at: string,
): Order {
  if (!canTransitionOrder(order.status, next)) {
    throw new Error(\`INVALID_ORDER_TRANSITION:\${order.status}->\${next}\`);
  }
  return {
    ...order,
    status: next,
    events: [...order.events, { from: order.status, to: next, at, reason }],
  };
}
`;

const COUPONS_TS = `export interface Coupon {
  code: string;
  kind: "percent" | "fixed";
  /** Percentage (1..100) for kind="percent", or cents for kind="fixed". */
  value: number;
  minAmountCents: number;
  maxRedemptions: number;
  redeemedCount: number;
  /** UTC ISO-8601 timestamp. */
  expiresAt: string;
}

export type CouponCheck =
  | { ok: true; discountCents: number }
  | { ok: false; code: "COUPON_EXPIRED" | "COUPON_LIMIT_REACHED" | "COUPON_MIN_AMOUNT" };

export function evaluateCoupon(
  coupon: Coupon,
  subtotalCents: number,
  nowIso: string,
): CouponCheck {
  if (Date.parse(coupon.expiresAt) <= Date.parse(nowIso)) {
    return { ok: false, code: "COUPON_EXPIRED" };
  }
  if (coupon.redeemedCount >= coupon.maxRedemptions) {
    return { ok: false, code: "COUPON_LIMIT_REACHED" };
  }
  if (subtotalCents < coupon.minAmountCents) {
    return { ok: false, code: "COUPON_MIN_AMOUNT" };
  }
  if (subtotalCents <= 0) {
    return { ok: true, discountCents: 0 };
  }
  const rawDiscount =
    coupon.kind === "percent"
      ? Math.round((subtotalCents * coupon.value) / 100)
      : coupon.value;
  return {
    ok: true,
    discountCents: Math.min(subtotalCents, Math.max(0, rawDiscount)),
  };
}
`;

const PRICING_TS = `import { type Coupon, evaluateCoupon } from "./coupons.ts";

export interface PlanTier {
  id: "free" | "pro-monthly" | "pro-yearly" | "self-hosted";
  label: string;
  priceCentsCny: number;
  priceCentsUsd: number;
  commissionBps: 0;
}

export const PLANS: readonly PlanTier[] = [
  { id: "free", label: "Free（最多 3 个商品）", priceCentsCny: 0, priceCentsUsd: 0, commissionBps: 0 },
  {
    id: "pro-monthly",
    label: "Pro 月付",
    priceCentsCny: 4900,
    priceCentsUsd: 900,
    commissionBps: 0,
  },
  {
    id: "pro-yearly",
    label: "Pro 年付（省 32%）",
    priceCentsCny: 39900,
    priceCentsUsd: 7900,
    commissionBps: 0,
  },
  {
    id: "self-hosted",
    label: "Self-Hosted 自部署买断",
    priceCentsCny: 69900,
    priceCentsUsd: 9900,
    commissionBps: 0,
  },
];

export interface CheckoutSummary {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponError?: string;
}

export function calculateCheckoutTotal(
  subtotalCents: number,
  coupon: Coupon | undefined,
  nowIso: string,
): CheckoutSummary {
  const safeSubtotal = Math.max(0, Math.trunc(subtotalCents));
  if (!coupon) {
    return { subtotalCents: safeSubtotal, discountCents: 0, totalCents: safeSubtotal };
  }
  const check = evaluateCoupon(coupon, safeSubtotal, nowIso);
  if (!check.ok) {
    return {
      subtotalCents: safeSubtotal,
      discountCents: 0,
      totalCents: safeSubtotal,
      couponError: check.code,
    };
  }
  return {
    subtotalCents: safeSubtotal,
    discountCents: check.discountCents,
    totalCents: Math.max(0, safeSubtotal - check.discountCents),
  };
}
`;

const INDEX_TS = `import { type Order, transitionOrder } from "./orders.ts";
import { calculateCheckoutTotal, PLANS } from "./pricing.ts";

const now = "2026-11-18T10:00:00.000Z";
const checkout = calculateCheckoutTotal(
  39900,
  {
    code: "EARLYBIRD",
    kind: "fixed",
    value: 10000,
    minAmountCents: 20000,
    maxRedemptions: 100,
    redeemedCount: 18,
    expiresAt: "2026-12-31T23:59:59.000Z",
  },
  now,
);

let order: Order = {
  id: "ord_20261118_001",
  productSlug: "ts-handbook",
  amountCents: checkout.totalCents,
  currency: "CNY",
  status: "draft",
  events: [],
};
order = transitionOrder(order, "pending", "checkout_created", now);
order = transitionOrder(order, "paid", "webhook_verified", "2026-11-18T10:01:00.000Z");
order = transitionOrder(order, "fulfilled", "download_link_sent", "2026-11-18T10:01:05.000Z");

console.log(JSON.stringify({ plans: PLANS.length, checkout, order }, null, 2));
`;

const LAUNCH_DRAFT_MD = `# 一个人做 shop 三个月：为什么我回到单机 SQLite（v0.4 草稿）

三个月前，我本来只是想顺手卖一份自己整理的 TypeScript 实践手册。试了一圈常见平台，不是 10% 抽成，就是后台复杂得像 ERP，连导出中文订单 CSV 在 Excel 里都会乱码。

于是我写了一个给自己用的小店工具 **shop**，现在刚好打磨到 v0.4：

1. **0% 平台抽成**：收款直连自己的微信支付 / Stripe，定价只有 Free、Pro（¥49/月或 ¥399/年）和自部署买断（¥699）。
2. **单机 SQLite WAL 架构**：订单状态流转、限量库存扣减和 Webhook 幂等回执都在同一个本地事务里完成，不用维护额外消息队列。
3. **细节不凑合**：CSV 导出默认带 UTF-8 BOM、优惠券严格按 UTC 校验、下载链接支持限次和有效期。

> 待补充：上线前再核对一次双通道费率说明与 7 天退款政策条款。
`;

function git(cwd: string, args: string[], dateIso: string, isolatedHome: string) {
  execFileSync(
    "git",
    [
      "-c",
      "init.defaultBranch=main",
      "-c",
      "user.name=Shop Demo Maker",
      "-c",
      "user.email=maker@shop-demo.invalid",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    {
      cwd,
      stdio: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: isolatedHome,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Shop Demo Maker",
        GIT_AUTHOR_EMAIL: "maker@shop-demo.invalid",
        GIT_COMMITTER_NAME: "Shop Demo Maker",
        GIT_COMMITTER_EMAIL: "maker@shop-demo.invalid",
        GIT_AUTHOR_DATE: dateIso,
        GIT_COMMITTER_DATE: dateIso,
      },
    },
  );
}

export interface ShopRepoStats {
  shopPath: string;
  headCommit: string;
  files: number;
}

export async function generateShopRepo(outputRoot: string): Promise<ShopRepoStats> {
  const shopPath = join(outputRoot, "shop");
  await mkdir(join(shopPath, "src"), { recursive: true });
  await mkdir(join(shopPath, "docs"), { recursive: true });

  // Commit 1: initial repo scaffold + orders state machine + AGENTS.md / README.md.
  await Promise.all([
    writeFile(join(shopPath, "package.json"), PACKAGE_JSON, "utf8"),
    writeFile(join(shopPath, "tsconfig.json"), TSCONFIG_JSON, "utf8"),
    writeFile(join(shopPath, ".gitignore"), GITIGNORE, "utf8"),
    writeFile(join(shopPath, "README.md"), README_MD, "utf8"),
    writeFile(join(shopPath, "AGENTS.md"), AGENTS_MD, "utf8"),
    writeFile(join(shopPath, "CLAUDE.md"), CLAUDE_MD, "utf8"),
    writeFile(join(shopPath, "src", "orders.ts"), ORDERS_TS, "utf8"),
  ]);

  git(shopPath, ["init", "-q"], "2026-10-10T09:00:00Z", outputRoot);
  git(shopPath, ["add", "-A"], "2026-10-10T09:00:00Z", outputRoot);
  git(
    shopPath,
    ["commit", "-q", "-m", "chore: bootstrap shop TypeScript repo and OrderStateMachine"],
    "2026-10-10T09:00:00Z",
    outputRoot,
  );

  // Commit 2: pricing tiers, coupon UTC evaluation, demo entry and v0.4 launch draft.
  await Promise.all([
    writeFile(join(shopPath, "src", "coupons.ts"), COUPONS_TS, "utf8"),
    writeFile(join(shopPath, "src", "pricing.ts"), PRICING_TS, "utf8"),
    writeFile(join(shopPath, "src", "index.ts"), INDEX_TS, "utf8"),
    writeFile(join(shopPath, "docs", "launch-draft.md"), LAUNCH_DRAFT_MD, "utf8"),
  ]);

  git(shopPath, ["add", "-A"], "2026-11-15T10:30:00Z", outputRoot);
  git(
    shopPath,
    ["commit", "-q", "-m", "feat: add pricing tiers, UTC coupon checks and v0.4 launch draft"],
    "2026-11-15T10:30:00Z",
    outputRoot,
  );

  const headCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: shopPath,
    stdio: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: outputRoot,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  })
    .toString("utf8")
    .trim();

  return {
    shopPath,
    headCommit,
    files: 11,
  };
}
