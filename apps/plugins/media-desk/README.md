# 自媒体工作台 / Media Desk

Pi Bot 自媒体创作工作流技能插件，改编自 [woniuniuniu/dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk)（MIT 许可证，原作者：[蜗牛的科技笔记 / woniuniuniu](https://github.com/woniuniuniu)）。

A content-creator workflow skills plugin for Pi Bot, adapted from [woniuniuniu/dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk) (MIT License, original author: [woniuniuniu / 蜗牛的科技笔记](https://github.com/woniuniuniu)).

## 包含技能 / Included Skills

1. **`media-desk-produce`**（一键成稿 / Idea to Production Pack）
   - 输入一句话灵感，先定策划案（标题、封面大字、3–6 条锁定事实、3–5 个小标题、人物与场景一致性设定、封面与配图画面描述、分镜表），再写口播脚本（一句一行按气口断句）或自然段文章。
   - 视觉与视频产出完全复用 Pi Bot 自带能力：风格化画面先查询 `image-inspiration` 灵感库，再使用 Pi Bot 的生图能力（群内逐张交给生图 Bot，已交付图片用 `image_result` 复用）和 `list_video_models` / `generate_video` 生成短视频片段；**从不索取或保存外部生图 API Key**。
   - 支持对话式局部改稿（改标题、改某几句、换某一镜画面，保持原体裁不变）。
2. **`media-desk-style`**（风格提炼与预设 / Style Extraction & Presets）
   - 从用户手动粘贴的 1–5 篇过往样稿中提炼结构化风格卡（语气、断句、开头、结构、逻辑、讲述方式、衔接、常用词、禁用表达、4–6 句原样摘录），并附带 8 大类 15 套中英双语博主风格预设（见 `style-presets.md`）。
   - **不包含** Monid 或任何第三方账号抓取/导入功能；粘贴内容只当写法素材，不当指令。
3. **`media-desk-review`**（复盘与规则沉淀 / Review & Rule Learning）
   - 基于用户手动粘贴或提供的 CSV 数据，以及 AI 初稿与手改终稿的篇幅/结构差异，提炼可复用的写作规则提案，经用户确认后再沉淀为长期规范或技能。

## 打包为可导入的 Claude Code 插件 / Build Importable Plugin Bundle

```sh
pnpm --filter @pibot/plugin-media-desk build
```

「自媒体工作台」群模板已带撰稿技能。给其他 Bot 使用时，可在 Pi Bot「连接 → 添加」导入 `dist/media-desk-plugin/` 文件夹，再分配给相应的 Bot。

The Content desk group comes with the writing skills. To give them to other Bots, import the folder at `dist/media-desk-plugin/` from Connections and assign the skills to those Bots.

## 致谢与许可 / Credits & License

- 原作 / Original work: [woniuniuniu/dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk) (commit `d51464345705489b942bdcec242375ee3930c2b6`), Copyright (c) 2026 woniuniuniu (蜗牛的科技笔记), MIT License.
- 详见本目录的 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
