// Deterministic fake ChatGPT data-export ZIP for the Pi Bot v0.1.0 launch video.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDeterministicZip } from "./zip.ts";

interface Turn {
  user: string;
  assistant: string;
}

interface SeedConversation {
  title: string;
  dayOffset: number;
  hour: number;
  project?: boolean;
  turns: Turn[];
}

const SHOP_PROJECT_GIZMO = "g-p-shop-indie-2026";
// Anchor: 2026-09-10 09:00:00 UTC (deterministic timestamps spanning Sept–Nov 2026).
const BASE_EPOCH_SECONDS = Math.floor(Date.parse("2026-09-10T09:00:00.000Z") / 1000);

const CUSTOM_INSTRUCTIONS = {
  about_user:
    "我是独立开发者，正在维护一个面向创作者和独立团队的轻量数字商品小店项目 shop（TypeScript + pnpm + SQLite）。平时自己负责产品、代码、定价和发布文案。",
  about_model:
    "请优先用简洁的中文回答，代码标识符、技术名词和命令保持英文原样。先给结论和可执行清单，少说客套话；涉及破坏性改动或上线步骤时提醒做回归检查。",
};

const MEMORIES = {
  memories: [
    {
      memory:
        "用户正在独立开发轻量数字商品小店 shop，核心技术栈为 TypeScript (strict ESM)、pnpm 和 SQLite (WAL 模式)。",
    },
    {
      memory: "用户偏好单机可部署、依赖尽量少的架构，不轻易引入微服务或复杂消息队列。",
    },
    {
      memory:
        "shop 定价倾向“基础免费 + Pro 年付折扣 + 一次性买断可选”，避免按抽成模式吓跑小体量创作者。",
    },
    {
      memory:
        "用户写发布文章和更新日志偏好克制、平实的口吻，多放真实数据和踩坑复盘，不写夸张营销词。",
    },
    {
      memory:
        "支付通道需要同时照顾国内微信支付和海外 Stripe，账单导出要默认带 UTF-8 BOM 方便 Excel 打开。",
    },
    {
      memory:
        "订单状态流转必须由单一状态机维护（draft -> pending -> paid -> fulfilled / refunded），禁止散落手改字段。",
    },
    {
      memory: "用户习惯在动代码前先列改动边界和回滚方式，每次提交前跑 typecheck 和单元测试。",
    },
    {
      memory:
        "优惠券逻辑曾踩过时区和重复核销的坑，要求所有时间比较统一用 UTC ISO 字符串并在事务内扣减。",
    },
    {
      memory:
        "对外发帖（即刻、V2EX、Product Hunt）习惯先出中文主稿，再改写成自然英文版而不是直译。",
    },
    {
      memory:
        "每周日晚上做一次 shop 数据复盘：新增订单、退款率、工单高频问题和下周 3 个最高优先级改动。",
    },
  ],
};

// 40 plausible conversations around indie project `shop`:
// 12 refactor plans, 10 pricing ideas, 10 article/launch drafts, 8 dev/ops & support discussions.
const CONVERSATIONS: readonly SeedConversation[] = [
  // --- Refactor plans (1–12) ---
  {
    title: "shop 订单状态机 OrderStateMachine 重构方案",
    dayOffset: 1,
    hour: 10,
    project: true,
    turns: [
      {
        user: "shop 现在的订单状态散在路由和 webhook 里各自 UPDATE，准备收拢成一个 OrderStateMachine。怎么设计最轻？",
        assistant:
          "建议用纯函数转移表 + SQLite 乐观条件更新，先不引入重型状态机库：\n1. 定义合法迁移表 `TRANSITIONS`: `draft -> pending -> paid -> fulfilled`，以及 `paid -> refunded`、`pending -> expired`。\n2. 封装 `transitionOrder(order, next, ctx)`，不合法直接返回显式错误码 `INVALID_ORDER_TRANSITION`。\n3. 落库时用 `WHERE id = ? AND status = ?`，防止 webhook 重试并发把已退款订单又改回 paid。",
      },
      {
        user: "要不要顺手把状态变更审计表也加上？",
        assistant:
          "强烈建议加一张轻量 `order_events(id, order_id, from_status, to_status, actor, reason, created_at)`，和主表更新放在同一个事务里。后面排查客诉或自动对账会省掉 80% 翻日志的时间。",
      },
    ],
  },
  {
    title: "SQLite WAL 模式与迁移脚本拆分计划",
    dayOffset: 3,
    hour: 14,
    project: true,
    turns: [
      {
        user: "shop 的 schema.sql 已经堆到 400 行了，想拆成按编号递增的 migrations，注意哪些点？",
        assistant:
          "按 append-only + 幂等原则拆：\n- 建一张 `_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TEXT)`。\n- 启动时开启 `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;`。\n- 每个迁移文件在一个事务里执行，旧迁移发版后永不回头修改，只追加新编号。",
      },
      {
        user: "备份的话直接拷贝 .db 文件安全吗？",
        assistant:
          "WAL 模式下直接 `cp` 可能会丢未 checkpoint 的 `-wal` 页。用 SQLite 的 `VACUUM INTO` 或 online backup API 生成独立快照，再上传到对象存储最稳妥。",
      },
    ],
  },
  {
    title: "清理 API 鉴权中间件与 Session Cookie 校验",
    dayOffset: 5,
    hour: 11,
    project: true,
    turns: [
      {
        user: "后台管理路由和买家下载路由混用了一套 auth middleware，想拆干净。",
        assistant:
          "把鉴权拆成两个显式 guard：`requireOwnerSession`（后台管理，校验 HttpOnly + SameSite=Lax Cookie 与 CSRF Origin）和 `requireDownloadToken`（买家下载，使用带过期时间的 HMAC 签名 token，不依赖 Cookie）。这样不会出现下载链接误越权到管理接口的风险。",
      },
    ],
  },
  {
    title: "限量数字商品库存扣减与并发防超卖",
    dayOffset: 7,
    hour: 16,
    project: true,
    turns: [
      {
        user: "有创作者想在 shop 上架限量 50 份的早鸟课程包，单机 SQLite 怎么防超卖？",
        assistant:
          "单机 SQLite 反而很简单：在 `BEGIN IMMEDIATE` 事务里执行 `UPDATE products SET stock = stock - 1 WHERE id = ? AND stock > 0`，检查 `changes === 1` 才创建 `pending` 订单并设置 15 分钟过期时间。超时未支付的订单由定时任务统一回补库存。",
      },
    ],
  },
  {
    title: "Stripe 与微信支付 Webhook 幂等队列重构",
    dayOffset: 9,
    hour: 9,
    project: true,
    turns: [
      {
        user: "支付回调偶尔重发 2–3 次，导致重复发发货邮件，怎么把幂等做彻底？",
        assistant:
          "用两层幂等：\n1. 新增 `webhook_receipts(provider, event_id PRIMARY KEY, received_at, status)`，先验签再 `INSERT OR IGNORE`，冲突直接返回 200。\n2. 业务层把“状态流转到 paid”和“写入 outbox 发货任务”放进同一事务，发邮件 worker 消费 outbox 并记录 `sent_at`。",
      },
    ],
  },
  {
    title: "结账页 Checkout 状态精简与表单校验",
    dayOffset: 11,
    hour: 15,
    project: true,
    turns: [
      {
        user: "结账页有 7 个 useState，优惠券一改金额偶尔不同步，准备重构。",
        assistant:
          "把优惠券预览、税费、实付金额收敛成一个纯计算函数 `calculateCheckoutTotal(items, coupon, currency)`，前端只保留 `email`、`couponCode`、`paymentMethod` 三个输入状态，最终下单金额以服务端重新计算为准，前后端共享同一份 TypeScript 规则模块。",
      },
    ],
  },
  {
    title: "shop 开启 TypeScript strict 与 noUncheckedIndexedAccess",
    dayOffset: 13,
    hour: 20,
    project: true,
    turns: [
      {
        user: "给 shop 开了 noUncheckedIndexedAccess，一下子冒出 34 个报错，按什么顺序修最快？",
        assistant:
          "按模块从底层往上修：先修 `src/pricing.ts` 和 `src/orders.ts` 等核心域（通常 5–10 处数组下标），再修 `src/coupons.ts` 和 CSV 导出，最后修测试文件。别用 `!` 非空断言敷衍，优先用 `for...of` 或显式 `if (!item) continue`。",
      },
    ],
  },
  {
    title: "结构化 JSON 日志与敏感字段脱敏重构",
    dayOffset: 15,
    hour: 10,
    project: true,
    turns: [
      {
        user: "现在 console.log 满天飞，怕不小心把 webhook secret 或买家邮箱打进日志。",
        assistant:
          "抽一个薄的 `logger.ts`，统一输出 JSON 行（`ts`, `level`, `module`, `orderId`, `code`），在序列化边界对 `authorization`、`cookie`、`apiKey`、`secret` 和邮箱中段做固定脱敏，业务代码禁止直接 `console.log(req.headers)`。",
      },
    ],
  },
  {
    title: "解耦邮件模板：下单确认与交付链接",
    dayOffset: 18,
    hour: 13,
    project: true,
    turns: [
      {
        user: "发邮件逻辑直接拼 HTML 字符串写在 webhook handler 里，太难维护了。",
        assistant:
          "拆成 `templates/order-receipt.ts` 与 `mail/sender.ts` 两层：模板只接收类型化的只读 view model，返回 `{ subject, text, html }`，并且单独写快照单测验证中英文变量转义（避免商品名里的 `<`、`&` 破坏 HTML）。",
      },
    ],
  },
  {
    title: "数字商品下载包 CDN 签名 URL 策略",
    dayOffset: 20,
    hour: 17,
    project: true,
    turns: [
      {
        user: "有些创作者上传 200MB 的设计素材包，走应用服务器转发带宽扛不住。",
        assistant:
          "文件直传到 R2/OSS 私有桶，下载接口只做 token 鉴权与下载次数计数，然后 302 跳转到有效期 5 分钟的预签名 URL，并设置 `Content-Disposition: attachment`。应用服务器带宽立刻降到几乎为零。",
      },
    ],
  },
  {
    title: "为 shop 补齐 Vitest 核心链路测试骨架",
    dayOffset: 22,
    hour: 11,
    project: true,
    turns: [
      {
        user: "一个人维护项目不敢大改，想用最小成本搭一套跑得快的 Vitest 测试。",
        assistant:
          "先守住三条钱和交付的主链路，全走内存 SQLite（`:memory:`）+ 假支付适配器，整套控制在 2 秒内：\n1. 价格与优惠券组合计算（边界/过期/满减/币种取整）。\n2. 订单状态机非法跳转与 webhook 重复回调幂等。\n3. 退款后下载链接立即失效。",
      },
    ],
  },
  {
    title: "统一后端 ErrorCode 与前端错误提示文案",
    dayOffset: 25,
    hour: 15,
    project: true,
    turns: [
      {
        user: "前端现在直接把后端的英文 error.message 弹给用户看，体验很割裂。",
        assistant:
          "后端只返回稳定的枚举错误码（如 `COUPON_EXPIRED`、`COUPON_MIN_AMOUNT`、`ORDER_ALREADY_PAID`），内部异常一律映射为 `INTERNAL_ERROR`；前端按错误码查字典展示友好中文提示，同时附带可复制的 requestId 方便联系客服。",
      },
    ],
  },

  // --- Pricing ideas (13–22) ---
  {
    title: "shop 商业化定价：抽成制 vs 固定月费对比",
    dayOffset: 2,
    hour: 21,
    project: true,
    turns: [
      {
        user: "在纠结 shop 用 Gumroad 那种 10% 抽成，还是 SaaS 固定月费 + 0% 平台抽成。",
        assistant:
          "对独立小店定位来说，**0% 平台抽成 + 阶梯订阅**更有差异化记忆点：\n- 创作者做到月销 ¥5,000 以上时，10% 抽成就是 ¥500/月，痛感极强。\n- 建议 Free 版限 3 个商品（0% 抽成，只付支付渠道费），Pro 版 ¥49/月或 ¥399/年解锁无限商品、自定义域名、优惠券和 Webhook。",
      },
      {
        user: "如果加一个一次性买断（自部署许可证）会不会蚕食订阅？",
        assistant:
          "两类客群几乎不重叠：想要省心托管的买 Pro 订阅，极客和工作室才愿意自己买服务器自部署。把自部署版定在 ¥699 买断（含 1 年大版本更新），既能提前回流现金，也能作为定价页的锚点衬托年付划算。",
      },
    ],
  },
  {
    title: "Pro 年付折扣与早鸟价梯度测算",
    dayOffset: 6,
    hour: 19,
    turns: [
      {
        user: "Pro 月付 ¥49、年付 ¥399，上线首月想给前 100 名一个早鸟优惠，怎么设不伤品牌？",
        assistant:
          "建议用**限量名额 + 锁定续费价**而不是打折促销感太重的“全场五折”：前 100 名创始会员年付 ¥299（约 6 折），明确写清“售完恢复 ¥399，创始会员次年续费保留原价”。转化率通常比限时倒计时更稳，也更符合独立产品调性。",
      },
    ],
  },
  {
    title: "优惠券规则与防滥用设计思路",
    dayOffset: 10,
    hour: 14,
    project: true,
    turns: [
      {
        user: "创作者希望支持百分比折扣和满减券，顺便问下要不要支持多张优惠券叠加？",
        assistant:
          "v1 强烈建议**单笔订单只允许使用 1 张优惠券**。叠加会带来“先满减还是先打折”、部分退款按比例分摊等一堆边界问题。同时给每张券加上 `maxRedemptions`、`expiresAt`（UTC）和 `minAmountCents`，已经能覆盖 95% 的真实场景。",
      },
    ],
  },
  {
    title: "微信支付与 Stripe 双通道费率与结算周期笔记",
    dayOffset: 14,
    hour: 16,
    turns: [
      {
        user: "帮我理一下国内微信支付和海外 Stripe 的实际扣点，定价页想透明写出来。",
        assistant:
          "定价页建议直接用“平台 0% 抽成，仅支付通道收取标准费率”的口径：\n- 微信支付商户：常规约 0.6%，T+1 结算。\n- Stripe 国际卡：通常 2.9% + $0.30（跨境卡和币种转换另有附加费）。\n透明列出渠道费反而能建立信任，减少上线后的工单追问。",
      },
    ],
  },
  {
    title: "免费版额度与自然升级触发点设计",
    dayOffset: 19,
    hour: 20,
    turns: [
      {
        user: "Free 版给多少功能合适？既想让别人零门槛跑通第一单，又想让有销量的用户自然升级。",
        assistant:
          "遵循“**赚钱链路不卡人，品牌与效率能力收费**”：\n- Free 版保留完整收款、自动发货和最多 3 个商品，确保创作者真能赚到第一笔钱。\n- 升级触发点放在：第 4 个商品、绑定自定义域名、去除页脚 Powered by shop、批量导出对账 CSV 与 Webhook 自动化。",
      },
    ],
  },
  {
    title: "Studio 团队席位附加包值不值得在早期做",
    dayOffset: 24,
    hour: 18,
    turns: [
      {
        user: "有两个小型设计工作室问能不能加多成员后台权限，要不要现在就做 Team 套餐？",
        assistant:
          "先别做复杂 RBAC。先在 Pro 上提供一个轻量的“协作者席位”（只读订单与导出权限，最多 3 人，+¥29/月），等至少 10 家付费工作室提出细粒度权限需求再拆独立的 Studio 套餐。",
      },
    ],
  },
  {
    title: "数字商品退款政策与 7 天冷静期文案",
    dayOffset: 28,
    hour: 11,
    turns: [
      {
        user: "数字商品下载完就没法退货，退款条款怎么写才合理又不显得太强硬？",
        assistant:
          "建议分两种情况写清楚：\n1. 未触发下载或商品文件损坏/与描述严重不符：7 天内支持全额原路退。\n2. 已下载完成且内容完整：原则上不支持无理由退款，但遇到重复下单或误购随时发邮件人工协助处理。\n这种写法兼顾防白嫖和好口碑。",
      },
    ],
  },
  {
    title: "定价页 FAQ 与三栏对比表结构草稿",
    dayOffset: 33,
    hour: 21,
    turns: [
      {
        user: "帮我起草 shop 定价页的 FAQ，重点打消“跑路怎么办”和“数据能不能导出”的顾虑。",
        assistant:
          "放 5 个最直击顾虑的问题：\n1. **真的 0% 平台抽成吗？** 是的，交易资金直接进入你自己的支付商户账户。\n2. **不用了数据能带走吗？** 随时一键导出完整商品、订单与客户 CSV/JSON。\n3. **支持自部署吗？** 支持，买断版提供完整 Docker 镜像与 SQLite 数据目录。\n4. **可以随时取消订阅吗？** 可以，当前周期结束后自动降回 Free，已发布链接不会立刻 404。\n5. **支持开发票吗？** Pro 年付和买断版均可在后台自助申请电子发票。",
      },
    ],
  },
  {
    title: "美元区与人民币区双币种心理定价",
    dayOffset: 37,
    hour: 10,
    turns: [
      {
        user: "海外用户用美元付款，直接按汇率换算成 $6.83/月看着好奇怪，怎么定心理价位？",
        assistant:
          "按本地消费习惯取整，不要机械折算：人民币 ¥49/月（¥399/年），美元 $9/月（$79/年），自部署买断 ¥699 / $99。两组价格都好记、好在落地页排版，且覆盖 Stripe 更高的固定单笔手续费。",
      },
    ],
  },
  {
    title: "独立小店季度促销节奏：黑五与双十一",
    dayOffset: 42,
    hour: 19,
    turns: [
      {
        user: "平时不想老发折扣码，一年做几次公开促销比较合适？",
        assistant:
          "一年最多两次公开节点（例如双十一/黑五合并为年度 75 折，以及大版本发布早鸟），其余时间保持原价稳定。高频打折会让老用户觉得吃亏，也会让潜在用户养成“等打折再买”的习惯。",
      },
    ],
  },

  // --- Article drafts & launch writing (23–32) ---
  {
    title: "复盘文章初稿：《一个人做 shop 三个月，我踩过的 5 个坑》",
    dayOffset: 16,
    hour: 22,
    project: true,
    turns: [
      {
        user: "想写一篇给独立开发者看的复盘长文，聊聊做 shop 这三个月，帮我拟个不装腔作势的大纲。",
        assistant:
          "建议用“时间线 + 真问题 + 真数据”结构：\n1. **为什么还要再做一个小店工具**：从自己卖电子书被抽成 10% 说起。\n2. **第一个月过度设计**：差点上消息队列，后来全部删掉回到单机 SQLite。\n3. **支付和退款才是真正的业务核心**：Webhook 幂等、UTF-8 BOM、时区优惠券三个实踩的坑。\n4. **定价犹豫期**：为什么最终选了 0% 抽成 + 买断锚点。\n5. **现状与下个版本**：附上真实页面截图、测试覆盖率和未来 30 天路线图。",
      },
      {
        user: "帮我把开头第一段写出来，口吻像跟朋友聊天。",
        assistant:
          "“三个月前，我本来只是想顺手卖一份自己整理的 TypeScript 实践手册。结果在几个平台转了一圈：有的抽成 10%，有的后台配置项多到像 ERP，还有的连导出中文订单 CSV 都会乱码。一气之下，我花了一个周末写了个能收款、能发货的小页面——这就是 shop 的第一行代码。”",
      },
    ],
  },
  {
    title: "即刻与 V2EX 发布帖中文草稿打磨",
    dayOffset: 27,
    hour: 20,
    project: true,
    turns: [
      {
        user: "准备下周发即刻和 V2EX 分享创造节点，帮我把 shop 的介绍压缩到 250 字以内。",
        assistant:
          "草稿：\n> 做了一个给独立开发者和创作者用的极简数字商品小店 **shop**。\n> 解决我自己卖模板、电子书和软件许可证时的三个痛点：\n> 1. 0% 平台抽成，收款直连自己的微信支付 / Stripe；\n> 2. 单机 TypeScript + SQLite 就能跑，支持云托管也支持自部署；\n> 3. 内置防重放 Webhook、带期限下载链接和一键对账 CSV 导出。\n> 现在刚打磨完 v0.4，欢迎大家试用拍砖，也附上了这 3 个月的技术复盘和架构笔记。",
      },
    ],
  },
  {
    title: "Product Hunt 英文 Launch Post 与 First Comment 草稿",
    dayOffset: 31,
    hour: 21,
    project: true,
    turns: [
      {
        user: "帮我把 shop 的介绍改写成自然的英文 Product Hunt tagline 和 maker comment。",
        assistant:
          "- **Tagline**: `Zero-commission digital storefront for indie makers, backed by SQLite.`\n- **Maker Comment**: `Hey PH! I built shop after losing 10% on every ebook sale and fighting bloated checkout dashboards. It focuses on three things: 0% platform cut, clean checkout with Stripe & WeChat Pay, and full data ownership (hosted or self-hosted single-node SQLite). Happy to answer any questions about the stack, pricing, or checkout edge cases!`",
      },
    ],
  },
  {
    title: "技术博客草稿：《为什么我放弃微服务回到单机 SQLite》",
    dayOffset: 35,
    hour: 22,
    turns: [
      {
        user: "想写一篇偏工程向的技术博客引流，主题是 shop 从拆服务回退到单机 SQLite WAL。",
        assistant:
          "可以围绕三个可验证指标写：\n1. **部署复杂度**：从 4 个容器降到 1 个进程 + 1 个数据文件，冷启动 < 300ms。\n2. **一致性收益**：库存扣减、订单状态流转、outbox 写入天然在同一个本地事务里，不再需要分布式锁。\n3. **什么时候真的需要迁走**：明确写出单机 SQLite 的天花板（写入并发 > 数百 TPS、多区域同时写），文章越坦诚越容易被转发。",
      },
    ],
  },
  {
    title: "shop v0.4 Release Notes 更新日志草稿",
    dayOffset: 40,
    hour: 15,
    turns: [
      {
        user: "整理一下 v0.4 的更新日志：新订单状态机、优惠券最低门槛、CSV UTF-8 BOM、下载链接限次。",
        assistant:
          "## shop v0.4 更新日志\n- **更稳的订单流转**：收拢订单状态机并加入 Webhook 幂等回执，避免重复回调导致重复发信。\n- **优惠券支持门槛与过期校验**：新增最低消费金额与 UTC 过期时间检查。\n- **对账导出不再乱码**：订单 CSV 导出默认附带 UTF-8 BOM，Excel 双击直接正常显示中文。\n- **下载链接更可控**：支持为每个订单设置下载有效期与最大下载次数。",
      },
    ],
  },
  {
    title: "落地页 Hero 文案三版 A/B 对比",
    dayOffset: 44,
    hour: 11,
    turns: [
      {
        user: "shop 首页首屏标题写了好几个版本，帮我挑一个最直白的。",
        assistant:
          "对比三版：\n- A（偏感性）：“让每一份创作体面变现” —— 太泛，看不出是做什么的。\n- B（偏技术）：“基于 SQLite 的轻量无抽成电商引擎” —— 只对程序员友好。\n- C（推荐）：“**零抽成的极简数字小店，5 分钟上线收款与自动发货**” + 副标题“支持电子书、模板与软件许可证，数据完全归你，可云托管也可自部署”。兼顾创作者和独立开发者。",
      },
    ],
  },
  {
    title: "新用户注册后 3 封 Onboarding 欢迎邮件草稿",
    dayOffset: 47,
    hour: 16,
    turns: [
      {
        user: "不想发垃圾营销邮件，只在新用户注册后发 3 封真正有用的上手邮件，怎么安排？",
        assistant:
          "- **Day 0（注册即发）**：3 分钟跑通测试订单的 checklist（建商品 -> 测支付沙箱 -> 预览收据邮件）。\n- **Day 3**：如果还没绑定收款通道，附一篇图文排障指南（最常见的是 Webhook 签名密钥填错）。\n- **Day 10**：分享 2 个独立创作者的定价页结构参考，并留一个“直接回复这封邮件告诉我哪里卡住了”的入口。",
      },
    ],
  },
  {
    title: "隐私与数据归属承诺页文案",
    dayOffset: 50,
    hour: 14,
    turns: [
      {
        user: "shop 想放一个很短的隐私承诺页，用人话写清楚我们收什么、不收什么。",
        assistant:
          "用四条短句就能写透：\n1. **不卖数据、不插广告追踪器**：结账页零第三方广告脚本。\n2. **敏感凭据不落明文日志**：支付密钥加密存放，日志自动脱敏。\n3. **随时一键完整导出**：商品、订单、客户邮箱全部开放标准 CSV/JSON 导出。\n4. **删号即真删**：注销店铺后 7 天冷静期结束彻底清除数据与备份。",
      },
    ],
  },
  {
    title: "播客嘉宾访谈提纲：独立开发者如何兼顾写代码与卖产品",
    dayOffset: 54,
    hour: 21,
    turns: [
      {
        user: "有个独立开发播客约我聊做 shop 的经历，帮我准备 4 个有故事感的要点。",
        assistant:
          "1. **从“自用脚本”到第一个陌生付费用户**：第一单 ¥399 进账时居然在修 CSV 乱码。\n2. **技术克制**：为什么坚持单人可控的小栈（TypeScript + SQLite），拒绝为假想的百万并发写代码。\n3. **用 AI 团队协作做发布**：把重构、测试审查、文案润色拆成清晰步骤，自己只做拍板和验收。\n4. **给想做副业产品的建议**：先卖 10 份再搭后台，把 50% 时间留给文档和第一眼体验。",
      },
    ],
  },
  {
    title: "是否开源 shop 核心定价与状态机模块的权衡",
    dayOffset: 58,
    hour: 19,
    turns: [
      {
        user: "在想要不要把 shop 的订单状态机和优惠券计算拆成一个 MIT 开源小包，给主项目带流量。",
        assistant:
          "很值得，且边界清晰：把纯计算逻辑（`order-state-machine`、`coupon-pricing`）MIT 开源，能给技术博客和 GitHub 带来真实星标与信任背书；托管控制台、支付对账与多渠道通知继续留在商业版，既不泄核心护城河又能反哺社区。",
      },
    ],
  },

  // --- Dev/ops & support Q&A (33–40) ---
  {
    title: "SQLite 定时备份到 Cloudflare R2 脚本设计",
    dayOffset: 4,
    hour: 18,
    turns: [
      {
        user: "写个每晚 3 点跑的备份脚本，把 shop.db 备份到 R2，顺便保留最近 14 天。",
        assistant:
          "流程控制在 20 行内：\n1. 调用 `sqlite3 shop.db \"VACUUM INTO '/tmp/shop-YYYYMMDD.db'\"`。\n2. 用 `zstd` 压缩并计算 sha256。\n3. 上传到私有 R2 bucket，并在 R2 生命周期规则里配 14 天自动过期。\n4. 每周日自动拉一份最新备份到本地跑 `PRAGMA integrity_check`，确保备份真的能还原。",
      },
    ],
  },
  {
    title: "Nginx 反向代理配置与 Brotli 压缩检查",
    dayOffset: 8,
    hour: 13,
    turns: [
      {
        user: "结账页静态 JS 有 180KB，想确认 Nginx 反代时 webhook 请求体不会被截断或改写。",
        assistant:
          "关键两处：\n- 对 `/api/webhooks/*` 关闭缓冲改写并保持原始 body（Stripe 验签强依赖 raw bytes），`client_max_body_size 2m` 足够。\n- 静态资源路径 `/assets/` 开启 `brotli on` + `Cache-Control: public, max-age=31536000, immutable`。",
      },
    ],
  },
  {
    title: "排查移动端 Safari 结账按钮被键盘遮挡问题",
    dayOffset: 12,
    hour: 17,
    turns: [
      {
        user: "有买家反馈 iOS Safari 输完邮箱和优惠券码后，底部固定支付按钮被软键盘顶歪了。",
        assistant:
          "避免在表单页用 `position: fixed; bottom: 0` 贴底放提交按钮。改成普通文档流里紧跟表单底部的按钮，或用 `100dvh` 搭配 `env(safe-area-inset-bottom)`；测试时重点看 iOS Safari 缩放和自动填充邮箱后的视口回弹。",
      },
    ],
  },
  {
    title: "订单导出 CSV 在 Excel 打开中文乱码修复",
    dayOffset: 17,
    hour: 12,
    turns: [
      {
        user: "导出的 UTF-8 CSV 在 macOS Numbers 里正常，在 Windows Excel 里中文全乱码。",
        assistant:
          "在响应体最前面写入 UTF-8 BOM (`\\uFEFF`)，响应头设为 `Content-Type: text/csv; charset=utf-8`，同时对包含逗号、双引号或换行的单元格做 RFC 4180 转义，并对 `=`、`+`、`-`、`@` 开头的用户输入加前导单引号防止 CSV 公式注入。",
      },
    ],
  },
  {
    title: "买家收货邮件与下载链接过期提醒文案",
    dayOffset: 23,
    hour: 15,
    turns: [
      {
        user: "给买家的发货邮件里除了下载按钮，还应该放哪些信息减少售后工单？",
        assistant:
          "放齐 5 项就够了：订单号、实付金额与币种、下载按钮（注明有效期和剩余次数）、“链接过期如何自助重发”的一句话说明，以及创作者自己的联系邮箱。",
      },
    ],
  },
  {
    title: "每日自动对账脚本：比对本地订单与 Stripe 流水",
    dayOffset: 30,
    hour: 10,
    turns: [
      {
        user: "想写个每天早上跑的只读对账脚本，核对前一天本地 paid 订单和 Stripe balance transactions。",
        assistant:
          "按三类差异输出摘要：1) Stripe 已入账但本地仍是 pending（漏 webhook）；2) 本地已 paid 但 Stripe 显示 refunded/disputed；3) 金额或币种不一致。零差异时静默记录一行日志，有差异才发告警通知。",
      },
    ],
  },
  {
    title: "旧域名迁移到新主域名时的 301 重定向清单",
    dayOffset: 38,
    hour: 16,
    turns: [
      {
        user: "要把测试域名迁到正式域名，老分享出去的商品链接不能失效，怎么平滑过渡？",
        assistant:
          "把旧域名的所有 `/p/*` 商品页和 `/dl/*` 下载页做 301 永久重定向并保留 path 与 query；Webhook 回调 URL 在 Stripe/微信后台先并行配置新地址，观察 48 小时旧地址请求归零后再下线旧路由。",
      },
    ],
  },
  {
    title: "单机部署的基础健康检查与告警阈值设置",
    dayOffset: 49,
    hour: 14,
    turns: [
      {
        user: "一个人运营不想被告警轰炸，只留最关键的 4 个监控指标应该选哪几个？",
        assistant:
          "只盯真正影响收款和可用性的 4 个：\n1. `/healthz` 连续 2 次探测失败（含 SQLite 轻量 `SELECT 1`）。\n2. 支付 Webhook 5xx 任意 1 次立即告警。\n3. 磁盘可用空间 < 15%（防 WAL/日志写满）。\n4. 每日凌晨备份任务连续 24 小时未产生新快照。",
      },
    ],
  },
];

function deterministicUuid(seed: number, part: number): string {
  const a = seed.toString(16).padStart(8, "0");
  const b = (part & 0xffff).toString(16).padStart(4, "0");
  const c = (0x4000 | ((seed * 17 + part) & 0x0fff)).toString(16).padStart(4, "0");
  const d = (0x8000 | ((seed * 31 + part) & 0x3fff)).toString(16).padStart(4, "0");
  const e = (seed * 1000 + part).toString(16).padStart(12, "0");
  return `${a}-${b}-${c}-${d}-${e}`;
}

function buildChatGptConversation(seed: SeedConversation, index: number) {
  const convNumber = index + 1;
  const created = BASE_EPOCH_SECONDS + seed.dayOffset * 86_400 + seed.hour * 3_600 + index * 37;
  const rootId = deterministicUuid(convNumber, 1);
  const mapping: Record<string, unknown> = {
    [rootId]: {
      id: rootId,
      parent: null,
      children: [] as string[],
      message: null,
    },
  };

  let parentId = rootId;
  let seq = 2;
  const linkChild = (parent: string, child: string) => {
    const node = mapping[parent] as { children: string[] };
    node.children.push(child);
  };

  // Include hidden ChatGPT custom-instructions context node on the first 5 conversations as in real exports.
  if (index < 5) {
    const sysId = deterministicUuid(convNumber, seq++);
    linkChild(parentId, sysId);
    mapping[sysId] = {
      id: sysId,
      parent: parentId,
      children: [] as string[],
      message: {
        id: sysId,
        author: { role: "system", name: null },
        create_time: created,
        content: { content_type: "text", parts: [""] },
        metadata: {
          is_visually_hidden_from_conversation: true,
          user_context_message_data: {
            about_user: CUSTOM_INSTRUCTIONS.about_user,
            about_model: CUSTOM_INSTRUCTIONS.about_model,
          },
        },
      },
    };
    parentId = sysId;
  }

  let cursorTime = created + 12;
  for (const turn of seed.turns) {
    const userId = deterministicUuid(convNumber, seq++);
    linkChild(parentId, userId);
    mapping[userId] = {
      id: userId,
      parent: parentId,
      children: [] as string[],
      message: {
        id: userId,
        author: { role: "user", name: null },
        create_time: cursorTime,
        content: { content_type: "text", parts: [turn.user] },
        metadata: {},
      },
    };
    parentId = userId;
    cursorTime += 35;

    const assistantId = deterministicUuid(convNumber, seq++);
    linkChild(parentId, assistantId);
    mapping[assistantId] = {
      id: assistantId,
      parent: parentId,
      children: [] as string[],
      message: {
        id: assistantId,
        author: { role: "assistant", name: null },
        recipient: "all",
        create_time: cursorTime,
        content: { content_type: "text", parts: [turn.assistant] },
        metadata: {},
      },
    };
    parentId = assistantId;
    cursorTime += 90;
  }

  return {
    id: deterministicUuid(convNumber, 999),
    title: seed.title,
    create_time: created,
    update_time: cursorTime,
    current_node: parentId,
    mapping,
    ...(seed.project ? { gizmo_id: SHOP_PROJECT_GIZMO } : {}),
  };
}

export interface ChatGptExportStats {
  zipPath: string;
  conversations: number;
  messages: number;
  memories: number;
  customInstructions: number;
}

export async function generateChatGptExport(outputRoot: string): Promise<ChatGptExportStats> {
  const dir = join(outputRoot, "chatgpt-export");
  await mkdir(dir, { recursive: true });
  const zipPath = join(dir, "chatgpt-export.zip");

  const conversations = CONVERSATIONS.map((seed, index) => buildChatGptConversation(seed, index));
  const messages = CONVERSATIONS.reduce((sum, item) => sum + item.turns.length * 2, 0);

  const zipBuffer = buildDeterministicZip([
    {
      name: "conversations.json",
      content: `${JSON.stringify(conversations, null, 2)}\n`,
    },
    {
      name: "memories.json",
      content: `${JSON.stringify(MEMORIES, null, 2)}\n`,
    },
    {
      name: "custom_instructions.json",
      content: `${JSON.stringify(CUSTOM_INSTRUCTIONS, null, 2)}\n`,
    },
  ]);

  await writeFile(zipPath, zipBuffer);
  return {
    zipPath,
    conversations: conversations.length,
    messages,
    memories: MEMORIES.memories.length,
    customInstructions: 2,
  };
}
