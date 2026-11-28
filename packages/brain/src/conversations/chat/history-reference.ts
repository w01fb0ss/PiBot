import { formatImportedHistoryReference } from "@pibot/agent";
import { READ_MESSAGES_REFERENCE } from "@pibot/protocol-base";

const sourceNames: ReadonlyMap<string, string> = new Map([
  ["chatgpt", "ChatGPT"],
  ["claude", "Claude"],
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
  ["antigravity", "Antigravity"],
  ["gemini", "Gemini"],
]);

export function historyImport(source: unknown, createdAt: unknown) {
  if (typeof source !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(source)) return undefined;
  const name = sourceNames.get(source);
  const label = name ? `Imported from ${name} / 导入自 ${name}` : "Imported history / 导入的会话";
  const date =
    typeof createdAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(createdAt)
      ? ` · ${createdAt.slice(0, 10)}`
      : "";
  return { source, label: `${label}${date}` };
}

export function historyReferenceText(payload: string, imported: boolean) {
  return `${READ_MESSAGES_REFERENCE}\n${imported ? formatImportedHistoryReference(payload) : payload}`;
}
