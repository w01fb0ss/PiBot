# 生图灵感库 / Image Inspiration

选择「连接 → 添加 → 生图灵感库」，并给需要查库的 Bot 开放权限。服务在本机读取随应用打包的目录。「自媒体工作台」的撰稿 Bot 会在准备风格化画面时查库。

In Connections, add Image Inspiration and grant access to the Bots that should search it. The service reads its bundled catalog locally. The Content desk writer searches it while preparing stylised visuals.

- `inspiration_search` 按英文关键词 `query` 检索。Pi Bot 会在检索前尝试用模型将非拉丁文字的关键词译成英文。可用 `style`、`layout`、`theme` 缩小范围，`limit` 为 1–25，默认为 8。Search by English keywords. Pi Bot tries to translate keywords written in non-Latin scripts before searching. Narrow by style, layout or theme, and choose a limit of 1–25 (default 8).
- `inspiration_get` 用搜索结果里的 `id` 查看完整配方与出处。Use an ID from search to get the recipe, guidance and provenance.

## 构建 / Build

```sh
pnpm --filter @pibot/plugin-image-inspiration build:refresh
pnpm --filter @pibot/plugin-image-inspiration build
```

`build:refresh` 用 curl 检查固定提交的 MIT 许可证并刷新 `data/inspirations.json`。`build` 使用已保存的目录，离线生成可导入的 Claude Code 插件文件夹 `dist/image-inspiration-plugin/`，其中含 MCP 服务与双语查库技能。

`build:refresh` uses curl to check the pinned revision's MIT license and regenerate `data/inspirations.json`. `build` uses the checked-in catalog offline and creates the importable Claude Code folder `dist/image-inspiration-plugin/` with the MCP server and bilingual search skill.

## 来源 / Source

模板配方来自 freestylefly 的 MIT 风格库。每条记录都附有来源路径、提交和许可证。收录范围限于风格配方文字。

The catalog uses the MIT-licensed style recipes by freestylefly. Each entry records its source URL, commit and license. See the [upstream style library](https://github.com/freestylefly/awesome-gpt-image-2/blob/0999cbfa1f860086db384602ee5ee5485671cb58/data/style-library.json), [NOTICE](./NOTICE) and [LICENSE](./LICENSE).
