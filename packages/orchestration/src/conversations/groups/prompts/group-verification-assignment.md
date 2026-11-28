# group-verification-assignment

Prompt text used by `group-verification-assignment.ts`. Each `## \`key\`` block is sent to the model exactly as written (blank lines around a block are ignored); `{{name}}` is filled in by the code. After editing, run `pnpm gen:prompts`. Changing a block changes the cached prompt prefix (see docs/prompt-cache.md).

## `verifyZh`

请用 group_plan 指定另一位成员独立核对这些成果，步骤使用 verdict 验收；你是作者，不能自行核对，也不要重新实现。

## `verifyEn`

Use group_plan to assign another member an independent verdict check. You authored the work: do not check it yourself or implement it again.
