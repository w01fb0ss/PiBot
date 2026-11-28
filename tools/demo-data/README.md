# Pi Bot v0.1.0 Launch Video Demo Data (`tools/demo-data`)

私有演练与录屏数据生成工具（不随安装包发布）。所有内容均为虚构的中文为主（含少量英文术语）示例，围绕独立数字商品小店项目 **`shop`** 构建，全程确定性生成，**不读取用户真实目录，也不直接写 SQLite 数据库**。

---

## 1. 生成假输入与隔离数据目录

在工作树根目录运行（使用 `.nvmrc` 指定的 Node 版本）：

```sh
node tools/demo-data/make.ts /tmp/pibot-0.1.0-demo
```

目录必须不存在或为空。生成内容如下：

| 路径 | 内容 | 对应演示环节 |
|---|---|---|
| `chatgpt-export/chatgpt-export.zip` | 40 段关于 `shop`（重构计划、定价思路、发布文章草稿、运维问答）的 ChatGPT 对话 + `memories.json`（10 条）+ `custom_instructions.json` | 聊天记录与记忆导入（ChatGPT ZIP 适配器） |
| `codex-home/` | `session_index.jsonl` + `sessions/YYYY/MM/DD/rollout-*.jsonl`（8 段 `shop` 开发会话）+ `memories/MEMORY.md` | 本地 Agent 导入（通过 `CODEX_HOME` 覆盖） |
| `claude-config/` | `projects/<encoded-shop>/` 下 6 段 `<uuid>.jsonl` 会话 + `memory/*.md`（含 YAML frontmatter） | 本地 Agent 导入（通过 `CLAUDE_CONFIG_DIR` 覆盖） |
| `shop/` | 独立 TypeScript Git 仓库（`git init`、2 次确定性提交、`README.md`、`AGENTS.md`、`CLAUDE.md`、`src/*.ts`、`docs/launch-draft.md`） | Pi 项目文件夹派活与上下文读取 |
| `pibot-data/` | 空的隔离 `PIBOT_DATA_DIR`（权限 `0700`，不手写数据库） | 测试副本运行目录 |
| `manifest.json` | 生成结果汇总、环境变量与可直接复制的命令 | 编排脚本 / 录屏核对 |

> **安全边界**：切勿指向真实 `~/Library/Application Support/Pi Bot`、`~/.codex` 或 `~/.claude`。每次录屏前用全新的空目录重新生成即可。

---

## 2. 启动隔离的 Pi Bot 测试副本

退出正在运行的正式版 Pi Bot（或确保不共享数据目录），带上三个环境变量启动测试副本：

```sh
PIBOT_DATA_DIR=/tmp/pibot-0.1.0-demo/pibot-data \
CODEX_HOME=/tmp/pibot-0.1.0-demo/codex-home \
CLAUDE_CONFIG_DIR=/tmp/pibot-0.1.0-demo/claude-config \
pnpm dev
```

（若使用已打包的测试副本，将 `pnpm dev` 替换为对应可执行文件，保持上述三个环境变量不变。）

---

## 3. 编排器通过 Pi Bot 自身 UI / RPC 完成初始化（禁止直写数据库）

按以下顺序在运行中的测试副本里操作：

### Step A：首次引导与模型配置
1. 打开 Pi Bot 测试副本，语言选择 **简体中文**（或跟随系统）。
2. 在 **设置 → 模型与服务商** 中配置你用于录屏真实对话的模型并设为默认模型（若仅跑离线假模型演练，可跳过此步，由 `drive.ts` 临时注册本地假服务）。

### Step B：导入历史对话与记忆（ChatGPT / Codex / Claude Code）
1. 打开 **应用菜单 → 设置 → 导入**（或欢迎页导入入口）。
2. **导入 ChatGPT 数据包**：
   - 选择来源 **ChatGPT**，在文件选择器中选中 `/tmp/pibot-0.1.0-demo/chatgpt-export/chatgpt-export.zip`。
   - 预览确认显示 40 段对话、记忆条目与自定义指令，按需勾选并完成导入。
3. **导入 Codex 本地会话与记忆**：
   - 选择来源 **Codex**，点击 **列出对话**（因为启动时设置了 `CODEX_HOME`，只会列出假的 8 段 `shop` 会话）。
   - 勾选全部或部分会话，勾选 **同时导入记忆** 与 **项目规范**，完成导入。
4. **导入 Claude Code 本地会话与记忆**：
   - 选择来源 **Claude Code**，点击 **列出对话**（通过 `CLAUDE_CONFIG_DIR` 读取假的 6 段会话与 `memory/*.md`）。
   - 勾选所需会话与记忆，完成导入。

### Step C：通过 UI / RPC 创建项目 Bot 与协作群，并绑定 `~shop`
> 不要手改数据库；全部通过界面按钮或对应 RPC（`bots.create` / `groups.create` / `workplaces.add`）完成。

1. **绑定项目文件夹 `shop` 给默认 Pi（用于项目文件夹派活）**：
   - 在与 **Pi** 的对话中点击 **工作目录 / 添加文件夹**，选中 `/tmp/pibot-0.1.0-demo/shop`。
   - 确认工作区芯片显示 `shop`，即可演示在 Pi 对话里直接围绕 `shop` 的 `README.md`、`AGENTS.md` 和 `src/` 派活。
2. **创建核心演示 Bot**（可选用内置角色模板或「新建 Bot」）：
   - **代码助手 / 全栈开发**：绑定 `/tmp/pibot-0.1.0-demo/shop`，负责 `src/orders.ts`、`src/pricing.ts`、`src/coupons.ts` 重构与检查。
   - **产品文案**：负责 `docs/launch-draft.md` 与定价值文案润色。
   - **质量审查**：负责独立核对定价口径、测试与发布前清单。
3. **创建常规演示群**（如「shop 独立小店小组」）：
   - 点击 **新建群聊**，拉入上述成员并指定统筹，群公告写明目标与约束，并添加 `/tmp/pibot-0.1.0-demo/shop` 为群主目录。

---

## 4. 用 `drive.ts` 通过真实 RPC 制造需要历史的状态

在测试副本**正在运行**时，另开一个终端执行：

```sh
node tools/demo-data/drive.ts /tmp/pibot-0.1.0-demo
```

也可以只跑其中某几项（逗号分隔）：

```sh
node tools/demo-data/drive.ts /tmp/pibot-0.1.0-demo --only dream,stuck-task,held-plan
```

### `drive.ts` 做了什么
1. 通过 Pi Bot 现有的后台连接器（`packages/sdk/src/node` 的 `readDescriptor` + `connectBackground`）连上运行中的测试副本，并用 `@pibot/protocol` 的 `createPeer` 发送标准业务 RPC。
2. 在本机 `127.0.0.1` 随机端口（`port: 0`）启动 `tools/fake-llm`，通过 `customProviders.upsert` 临时挂载假模型服务，并在结束后恢复原有默认模型设置（如原本已配真实模型，则自动清理临时假服务；若希望保留可加 `--keep-fake-provider`）。
3. 通过正常应用动作依次制造三个状态：
   - **已完成且带待确认提案的 Dream（睡眠整理）**：通过 `memory.manage` 写入围绕 `shop` 的几条重叠记忆，再调用 `memory.dream.run({ ownerInitiated: true })`，生成状态为 `done` 且包含合并提案的 Dream 记录。
     - UI 核对：**设置 → 记忆** 可看到最新 Dream 总结卡片；「关于你」与 Pi 的记忆列表可见待确认的合并提案。
     - 已知基线问题提示：在 `v004/rc2`（提交 `f00dfb39`）中，`packages/storage/src/bots/memory-dream.ts` 第 154、182 行存在 `AND sr${visibleImportedRows("c.import_id")}` 的 SQL 拼写错误，会导致 `memory.dream.run` 返回 `status: "failed"`（`ERR_SQLITE_ERROR`）；修复该两行为 `AND ${visibleImportedRows("src.import_id")}` 后即可正常生成 `status: "done"` 与合并提案。
   - **卡住/闲置的群任务（Stuck idle group task）**：通过 `bots.create` + `groups.create` 建立「shop 日常巡检群」，发消息触发统筹 `assign_task`，被分派成员在假模型返回 `provider_error` 后停止，留下 `status = "open"` 且无活跃运行的任务。
     - UI 核对：进入「shop 日常巡检群」→ **任务** 面板可见未完成且已停滞的任务与恢复/取消操作。
     - 说明：默认 Pi 的 `pi_health_check` 中 `task_idle_open` 规则要求任务超过 24 小时无活动（`PI_HEALTH_IDLE_TASK_MS`）；由于本工具严禁直写数据库，若录屏需要该任务直接被 `task_idle_open` 检出，请提前一天运行 `drive.ts`。
   - **停在等待用户选择的动态计划（Held plan）**：通过 `bots.create` + `groups.create` 建立「shop v0.4 发布小组」，触发统筹提交 3 步动态计划（`draft -> review -> publish`）。`review` 连续两次 `Verdict: FAIL` 触发程序自动修复与复验（`2/2`），第三次仍不通过后自然进入 `holdForReplanLimit`（`status = "waiting"`、`choice.kind = "replan_limit"`）。
     - UI 核对：进入「shop v0.4 发布小组」，计划卡片直接停在「重新规划次数已用完（2/2）」等待选择状态（**按剩下的步骤继续** / **新开计划**）；同时在默认 **Pi** 对话中让 Pi 体检（`pi_health_check`），该计划会**立即**被检出为 `plan_hold_replan_limit`，并可直接演示一键修复。

---

## 5. 清理

录屏结束后，退出测试副本，直接删除临时目录即可：

```sh
rm -rf /tmp/pibot-0.1.0-demo
```
