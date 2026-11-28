import type { Bot, ConnectorCommand, ConnectorTool, ExecutionMode } from "@pibot/protocol-base";
import type { LocalService } from "../../local-service.ts";
import { connectionCommandTools } from "../../runtime/tools/connectors/connection-commands.ts";

type Entry = {
  kind: "skill" | ConnectorCommand["kind"];
  token: string;
  description?: string;
  owner: Bot;
  connection?: ConnectorCommand;
};

type Scope = {
  bots: readonly Bot[];
  defaultBotId: string;
  groupId?: string;
  conversationId?: string;
  initialMode?: ExecutionMode;
};

const safeLine = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
const plain = (value: string) => safeLine(value).replace(/[\\`*_{}[\]()<>#!|~]/gu, "\\$&");
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function slashHelpText(
  local: LocalService,
  scope: Scope,
  request: { command?: string },
  language: "zh" | "en",
  signal: AbortSignal,
) {
  const { bots, defaultBotId, groupId, conversationId, initialMode } = scope;
  const zh = language === "zh";
  const active = bots.filter(
    (bot) => bot.kind !== "agent" && bot.category !== "image" && !bot.archivedAt,
  );
  const readOnly = (botId: string) =>
    (conversationId ? local.execution.mode({ botId, groupId, conversationId }) : initialMode) ===
    "plan";
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const bot of active) {
    signal.throwIfAborted();
    for (const skill of local.skills?.commandEntries?.(bot.id, groupId, signal) ?? []) {
      if (/^help$|^帮助$/iu.test(skill.name) || safeLine(skill.name) !== skill.name) continue;
      entries.push({
        kind: "skill",
        token: skill.name,
        description: skill.description,
        owner: bot,
      });
    }
    for (const connection of local.connectionCommands(bot.id, groupId, readOnly(bot.id), signal)) {
      if (seen.has(connection.id) || /^help$|^帮助$/iu.test(connection.token)) continue;
      seen.add(connection.id);
      entries.push({ kind: connection.kind, token: connection.token, owner: bot, connection });
    }
  }
  const command = ({ token, owner }: Entry) =>
    `/${token}${groupId && owner.id !== defaultBotId ? ` @${owner.name}` : ""}`;
  const heading = zh ? "斜杠命令帮助" : "Slash command help";
  const empty = zh ? "当前对话没有可用的命令。" : "No commands are available in this chat.";
  const labels = {
    skill: { title: zh ? "技能" : "Skills", summary: zh ? "使用此技能" : "Use this skill" },
    app: { title: zh ? "应用" : "Apps", summary: zh ? "使用此应用" : "Use this app" },
    mcp: { title: "MCP", summary: zh ? "使用此 MCP 连接" : "Use this MCP connection" },
  };
  const clipped = (value: string) =>
    plain(safeLine(local.deps.redactor.redact(value)).slice(0, 200));
  const toolsFor = ({ connection, owner }: Entry, maxTools: number) =>
    connection
      ? connectionCommandTools(local, connection, {
          botId: owner.id,
          groupId,
          readOnly: readOnly(owner.id),
          signal,
          selections: local.capabilities.resolve({ botId: owner.id, groupId }),
          maxTools,
        })
      : [];
  const about = (entry: Entry, tool?: ConnectorTool) =>
    clipped(entry.description ?? tool?.displayDescription?.[language] ?? tool?.description ?? "") ||
    labels[entry.kind].summary;
  const usage = zh ? "发送 `/<命令> 帮助` 查看具体用法。" : "Send `/<command> help` for examples.";
  const commandText = (entry: Entry) => plain(local.deps.redactor.redact(command(entry)));

  if (!request.command) {
    const body = (["skill", "app", "mcp"] as const).flatMap((kind) => {
      const rows = entries.filter((entry) => entry.kind === kind);
      return rows.length
        ? [
            `**${labels[kind].title}**`,
            rows
              .map((entry) => `- ${commandText(entry)} · ${about(entry, toolsFor(entry, 1)[0])}`)
              .join("\n"),
          ]
        : [];
    });
    return [`**${heading}**`, ...(body.length ? [...body, usage] : [empty])].join("\n\n");
  }

  const requested = `/${request.command}`;
  const unqualified = entries.filter((entry) => equal(`/${entry.token}`, requested));
  const entry =
    entries.find((entry) => entry.connection && equal(command(entry), requested)) ??
    entries.find((entry) => equal(command(entry), requested)) ??
    (unqualified.length === 1 ? unqualified[0] : undefined);
  if (!entry) return undefined;
  const { connection, owner } = entry;
  const tools = toolsFor(entry, 3);
  const connectorMode = connection && local.connectors?.get(connection.id)?.confirmationMode;
  const permission =
    connectorMode === "always_ask"
      ? zh
        ? "每次调用都会要求你确认。"
        : "Every use asks for confirmation."
      : connectorMode === "read_only" || (connection && readOnly(owner.id))
        ? zh
          ? "此处只允许读取。具体操作按权限设置处理。"
          : "Only reads are available here. Access follows your permission settings."
        : connection
          ? zh
            ? "读取或向外部服务写入时，Pi Bot 会按权限设置请求确认。"
            : "Pi Bot may ask before reading or changing data in the connected service."
          : zh
            ? "访问文件、使用网络或运行命令时，Pi Bot 会按权限设置请求确认。"
            : "Pi Bot may ask before using files, the network, or commands.";
  const path = `${zh ? "连接" : "Connections"} › ${labels[entry.kind].title}`;
  const toolName = (tool: ConnectorTool) => clipped(tool.title || tool.tool);
  const prefix = commandText(entry);
  const examples = tools.map((tool) =>
    zh
      ? `${prefix} 请使用 ${toolName(tool)} 处理我的请求`
      : `${prefix} Use ${toolName(tool)} for my request`,
  );
  if (!examples.length) {
    const aboutSkill = entry.description ? clipped(entry.description) : undefined;
    examples.push(
      zh
        ? `${prefix} ${aboutSkill ? `请根据「${aboutSkill}」处理我的材料` : "请把这份材料处理成我能直接使用的结果"}`
        : `${prefix} ${aboutSkill ? `Apply “${aboutSkill}” to this material` : "Turn this material into a result I can use"}`,
    );
  }
  if (examples.length < 2) {
    examples.push(
      zh
        ? `${prefix} 先告诉我需要提供哪些信息`
        : `${prefix} Tell me what information you need first`,
    );
  }
  return [
    `**${prefix}**`,
    about(entry, tools[0]),
    `**${zh ? "试着这样说" : "Try saying"}**\n${examples.map((example) => `- ${example}`).join("\n")}`,
    `**${zh ? "权限" : "Permissions"}** · ${permission}`,
    `**${zh ? "管理位置" : "Manage in"}** · ${path}`,
  ].join("\n\n");
}
