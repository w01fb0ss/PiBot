export const teamsZh = {
  "group.plan.statusLine.progress": "计划「{name}」进度 {done}/{total}",
  "group.plan.statusLine.completed": "计划「{name}」进度 {done}/{total} · 已完成",
  "group.plan.statusLine.stepsEnded": "计划「{name}」进度 {done}/{total} · 步骤已结束",
  "group.plan.summary.ended": "计划「{name}」已结束 · {count} 步：{counts}",
  "group.plan.summary.ended.one": "计划「{name}」已结束 · 1 步：{counts}",
  "group.plan.summary.completed": "{count} 步完成",
  "group.plan.summary.skipped": "{count} 步你跳过",
  "group.plan.summary.autoSkipped": "{count} 步未执行",
  "group.plan.summary.steps": "步骤",
  "group.plan.summary.outputs": "产出",
  "group.plan.summary.files": "（{count} 个文件）",
  "group.plan.summary.files.one": "（1 个文件）",
  "group.plan.summary.outputUnavailable": "未能附上",
  "group.plan.summary.coverage": "需求覆盖：见下方",
  "group.plan.summary.coverageMissing": "需求覆盖：没有逐条核对（统筹的总结里没有逐条对照）",
  "group.plan.summary.covered": "统筹判为覆盖：{requirement} → {output}",
  "group.plan.summary.uncovered": "未覆盖：{requirement}",
  "group.plan.summary.supplement":
    "补做程序检查：通过 {passed}/{total} 项。需求覆盖以上方逐条对照为准。",
  "group.plan.summary.supplementMissing": "补做：没有程序检查结果",
  "group.plan.repair.fix": "修复不通过项",
  "group.plan.repair.recheck": "修复后复验",
  "group.plan.step.untitled": "未命名步骤",
  "group.plan.stepLine.passed": "已通过",
  "group.plan.stepLine.skipped": "你跳过了",
  "group.plan.stepLine.autoSkipped": "未执行",
  "group.plan.stepLine.skippedRecheck": "你跳过了复验",
  "group.plan.stepLine.repaired": "已修复，复验通过（{step}）",
  "group.plan.stepLine.accepted": "你接受了现状",
  "group.plan.stepLine.failed": "不通过",
  "group.plan.stepLine.failedCount": "不通过（{count} 项）",
  "group.plan.stepLine.failedCount.one": "不通过（1 项）",
  "group.plan.stepLine.blocked": "等待统筹处理",
  "group.plan.stepLine.needsYou": "等你处理",
  "group.plan.stepLine.mergeConflict": "合并冲突，等待统筹处理",
  "group.plan.stepLine.paused": "已暂停，等你继续",
  "group.plan.stepLine.running": "进行中",
  "group.plan.stepLine.waiting": "等待中",
  "group.plan.stepLine.merged": "已合并",
  "group.plan.stepLine.merging": "等待合并",

  "teams.localOmitted": "未包含：{name}（本地导入、超过导出上限）。请取得原文件后重新导入。",
  "teams.sourceRequired": "{name}：这个技能需要从来源重新导入；模板未包含技能文件。",
  "teams.sourcePrepare": "确认从来源下载并预览",
  "teams.sourceReview":
    "来源内容不可信。将导入 {files} 个文件、{bytes} 字节；请检查正文。不会自动运行脚本，也不恢复任何权限。",
  "teams.sourceConfirm": "确认导入这个技能",
  "teams.sourceImported": "技能已导入。",
  "teams.sourceUnavailable": "链接导入能力尚不可用。来源已保留，请在链接导入可用后重试。",
  "teams.sourceFailed": "未完成来源导入。请检查来源，重新预览后再试。",

  "teams.moreMenu": "更多",
  "teams.backMenu": "返回菜单",
  "teams.saveCancelled": "已取消保存。",
  "teams.exportBotNote":
    "只导出 Bot 的资料、头像、权限设置和技能；不包含聊天、记忆、密钥或工作文件。",
  "teams.exportNote":
    "分享成员 Bot 的人设、工作规范、头像、模型偏好、权限收紧项和技能（含脚本），以及群规则；不含密钥、聊天、记忆、保存的账号密码或文件夹路径。",
  "teams.exportFailed": "模板未保存。请检查模板或保存位置后重试。",
  "teams.choose": "选择 .pibot 文件",
  "teams.professionsNote": "没有文件也行：按职业挑一组现成的 Bot 和群聊",
  "teams.chooseAgain": "重新选文件",
  "teams.confirm": "确认导入",
  "teams.empty": "选择同事分享的模板，预览后再创建 Bot 和群聊。",
  "teams.picking": "正在等待选文件并读取预览…",
  "teams.provenanceOfficial": "官方已验证：文件匹配已签名角色库。",
  "teams.provenanceUnverified": "未验证来源：文件不在已签名角色库中。请检查权限、技能和命令策略。",
  "teams.review": "请完整查看人设。导入后它会成为 Bot 的系统提示词；现在不会运行其中的指令。",
  "teams.permissions":
    "导入的 Bot 从本机的全局默认权限开始，只接受比默认更严的设置（下面列出了没采用的项）。不导入密钥、聊天、记忆、文件夹或已记住的授权，工作区与系统边界仍适用。",
  "teams.count": "将创建 {bots} 个 Bot、{groups} 个群聊",
  "teams.preferred": "模板模型偏好",
  "teams.resolved": "导入时使用",
  "teams.noPreference": "未指定",
  "teams.fallback": "偏好模型在本机不可用，已映射到默认可用模型。",
  "teams.noModel": "尚无可用模型",
  "teams.noModelNote": "仍可导入；聊天前请在资料面板选择一个已配置模型。",
  "teams.noDescription": "没有工作描述",
  "teams.emptyPersona": "空人设",
  "teams.noAnnouncement": "没有群公告",
  "teams.members": "成员",
  "teams.rounds": "自动来回上限：{count} 次",
  "teams.expired": "预览已过期或已使用，请重新选择文件。",
  "teams.readFailed": "无法预览。请确认文件是有效的 .pibot 文件且不超过 20 MB，再重新选择。",
  "teams.importFailed": "导入未完成，数据已回滚。有效期内可重试这份预览。",
  "teams.uncertain": "导入结果尚未确认。请关闭预览并查看会话列表，避免重复导入。",
  "teams.busy": "另一个文件操作尚未结束，请关闭系统文件框后重试。",
  "teams.importedPartly": "导入完成，但下面这些技能没导入：",
  "teams.skippedSkill": "「{skill}」（{bot}）",
  "teams.skippedHint": "可以之后在 Bot 的资料面板里重新添加这些技能。",
  "teams.done": "知道了",
} as const;
export const teamsEn: Record<keyof typeof teamsZh, string> = {
  "group.plan.statusLine.progress": "Plan “{name}” progress {done}/{total}",
  "group.plan.statusLine.completed": "Plan “{name}” progress {done}/{total} · completed",
  "group.plan.statusLine.stepsEnded": "Plan “{name}” progress {done}/{total} · steps ended",
  "group.plan.summary.ended": "Plan “{name}” ended · {count} steps: {counts}",
  "group.plan.summary.ended.one": "Plan “{name}” ended · 1 step: {counts}",
  "group.plan.summary.completed": "{count} completed",
  "group.plan.summary.skipped": "{count} skipped by you",
  "group.plan.summary.autoSkipped": "{count} skipped automatically",
  "group.plan.summary.steps": "Steps",
  "group.plan.summary.outputs": "Outputs",
  "group.plan.summary.files": " ({count} files)",
  "group.plan.summary.files.one": " (1 file)",
  "group.plan.summary.outputUnavailable": "Could not attach",
  "group.plan.summary.coverage": "Requirement coverage: see below",
  "group.plan.summary.coverageMissing":
    "Requirement coverage: no item-by-item check (the coordinator’s summary had no item-by-item comparison)",
  "group.plan.summary.covered": "Coordinator marked covered: {requirement} → {output}",
  "group.plan.summary.uncovered": "Uncovered: {requirement}",
  "group.plan.summary.supplement":
    "Supplement checks: {passed}/{total} passed. See the item-by-item review for requirement coverage.",
  "group.plan.summary.supplementMissing": "Supplement: no program check results",
  "group.plan.repair.fix": "Repair failed checks",
  "group.plan.repair.recheck": "Recheck the repair",
  "group.plan.step.untitled": "Untitled step",
  "group.plan.stepLine.passed": "Passed",
  "group.plan.stepLine.skipped": "You skipped this",
  "group.plan.stepLine.autoSkipped": "Skipped automatically",
  "group.plan.stepLine.skippedRecheck": "You skipped the recheck",
  "group.plan.stepLine.repaired": "Fixed, recheck passed ({step})",
  "group.plan.stepLine.accepted": "You accepted the result as is",
  "group.plan.stepLine.failed": "Failed",
  "group.plan.stepLine.failedCount": "Failed ({count} items)",
  "group.plan.stepLine.failedCount.one": "Failed (1 item)",
  "group.plan.stepLine.blocked": "Waiting for the coordinator",
  "group.plan.stepLine.needsYou": "Waiting for you",
  "group.plan.stepLine.mergeConflict": "Merge conflict, waiting for the coordinator",
  "group.plan.stepLine.paused": "Paused, waiting for you to resume",
  "group.plan.stepLine.running": "Running",
  "group.plan.stepLine.waiting": "Waiting",
  "group.plan.stepLine.merged": "Merged",
  "group.plan.stepLine.merging": "Waiting to merge",

  "teams.localOmitted":
    "Not included: {name} (local import, exceeds the export limit). Obtain the original files and import them again.",
  "teams.sourceRequired":
    "{name}: this skill needs to be imported again from its source. The template contains no skill files.",
  "teams.sourcePrepare": "Confirm source download and preview",
  "teams.sourceReview":
    "Source content is untrusted. Importing {files} files, {bytes} bytes. Review the text. Scripts will not run automatically and no permissions are restored.",
  "teams.sourceConfirm": "Confirm skill import",
  "teams.sourceImported": "Skill imported.",
  "teams.sourceUnavailable":
    "Link import is not available yet. The source is retained; retry when link import is available.",
  "teams.sourceFailed":
    "Source import did not finish. Check the source and preview it again before retrying.",

  "teams.moreMenu": "More",
  "teams.backMenu": "Back to menu",
  "teams.saveCancelled": "Save cancelled.",
  "teams.exportBotNote":
    "Exports the Bot profile, avatar, permissions and skills; excludes chats, memories, secrets and working files.",
  "teams.exportNote":
    "Shares the member Bots’ personas, working norms, avatars, model preferences, tightened permissions and skills (scripts included), plus group rules. Keys, chats, memories, saved passwords and folder paths are excluded.",
  "teams.exportFailed": "The template was not saved. Check the template or destination and retry.",
  "teams.choose": "Choose a .pibot file",
  "teams.professionsNote": "No file? Pick a ready-made set of Bots and groups by profession",
  "teams.chooseAgain": "Choose another file",
  "teams.confirm": "Confirm import",
  "teams.empty": "Choose a shared template and review it before creating Bots and groups.",
  "teams.picking": "Waiting for file selection and loading the preview…",
  "teams.provenanceOfficial": "Officially verified: this file matches the signed role library.",
  "teams.provenanceUnverified":
    "Unverified source: this file is not in the signed role library. Review permissions, skills and command policy.",
  "teams.review":
    "Read the entire persona. It becomes the Bot’s system prompt after import; its instructions will not run during this preview.",
  "teams.permissions":
    "Imported Bots start from this computer’s global default permissions and only take settings stricter than them (items not applied are listed below). Keys, chats, memories, folders and remembered grants are excluded; workspace and system boundaries still apply.",
  "teams.count": "Creates {bots} Bots and {groups} groups",
  "teams.preferred": "Preferred model",
  "teams.resolved": "Model used on import",
  "teams.noPreference": "Unspecified",
  "teams.fallback":
    "The preferred model is unavailable here and has been mapped to the default available model.",
  "teams.noModel": "No available model",
  "teams.noModelNote":
    "You can still import. Choose a configured model in the profile panel before chatting.",
  "teams.noDescription": "No job description",
  "teams.emptyPersona": "Empty persona",
  "teams.noAnnouncement": "No announcement",
  "teams.members": "Members",
  "teams.rounds": "Automatic round limit: {count}",
  "teams.expired": "This preview expired or was already used. Choose the file again.",
  "teams.readFailed": "Unable to preview. Choose a valid .pibot file no larger than 20 MB.",
  "teams.importFailed":
    "Import failed and the changes were rolled back. You can retry this preview before it expires.",
  "teams.uncertain":
    "The import result is unconfirmed. Close the preview and check your chat list before importing again.",
  "teams.busy": "Another file operation is still active. Close the system dialog and retry.",
  "teams.importedPartly": "Imported, but these skills were not added:",
  "teams.skippedSkill": "“{skill}” ({bot})",
  "teams.skippedHint": "You can add them again later from the Bot’s profile panel.",
  "teams.done": "Got it",
};

type PlanTextKey = Extract<keyof typeof teamsZh, `group.plan.${string}`>;

export function groupPlanText(
  language: "zh" | "en",
  key: PlanTextKey,
  values: Readonly<Record<string, string | number>> = {},
) {
  const table = language === "zh" ? teamsZh : teamsEn;
  const singular = `${key}.one`;
  const template =
    values.count === 1 && Object.hasOwn(table, singular)
      ? table[singular as PlanTextKey]
      : table[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}

export function localizedPlanStepTitle(title: string | undefined, language: "zh" | "en") {
  if (!title) return groupPlanText(language, "group.plan.step.untitled");
  for (const key of ["group.plan.repair.fix", "group.plan.repair.recheck"] as const) {
    if (
      title === teamsZh[key] ||
      title === teamsEn[key] ||
      title === `${teamsZh[key]} / ${teamsEn[key]}`
    )
      return groupPlanText(language, key);
  }
  return title;
}
