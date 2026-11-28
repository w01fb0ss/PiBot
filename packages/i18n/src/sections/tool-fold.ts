export const toolFoldZh = {
  "tool.fold.completed": "已完成步骤",
  "tool.fold.summary": "{count} 个工具步骤 · {types}",
  "tool.fold.summaryOne": "{count} 个工具步骤 · {types}",
  "tool.fold.approvals": "审批结果 {count} 项",
  "tool.fold.failed": "失败 {count} 项",
  "tool.fold.denied": "拒绝 {count} 项",
  "tool.fold.blocked": "程序拦截 {count} 项",
  "tool.fold.aborted": "中止 {count} 项",
  "tool.fold.summaryShort": "{count} 步 · {types}",
  "tool.fold.summaryShortOne": "{count} 步 · {types}",
  "tool.fold.typeShort": "{tool} {count}",
} as const;

export const toolFoldEn: { [K in keyof typeof toolFoldZh]: string } = {
  "tool.fold.completed": "Completed steps",
  "tool.fold.summary": "{count} tool steps · {types}",
  "tool.fold.summaryOne": "{count} tool step · {types}",
  "tool.fold.approvals": "Approval results: {count}",
  "tool.fold.failed": "Failed: {count}",
  "tool.fold.denied": "Denied: {count}",
  "tool.fold.blocked": "Blocked: {count}",
  "tool.fold.aborted": "Stopped: {count}",
  "tool.fold.summaryShort": "{count} steps · {types}",
  "tool.fold.summaryShortOne": "{count} step · {types}",
  "tool.fold.typeShort": "{tool} ×{count}",
};
