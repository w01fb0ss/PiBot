import type { LocalToolDefinition } from "@pibot/agent";
import type { PermissionLevels, SearchConfig } from "@pibot/protocol-base";
import { capabilitiesPrompts } from "./prompts/capabilities.ts";

export interface CapabilityFacts {
  /** Trusted run route, never derived from a persona or model output. */
  group?: boolean;
  definitions: readonly Pick<LocalToolDefinition, "name" | "loadGroup">[];
  levels?: PermissionLevels;
  /**
   * Provider only. Whether the first query was already confirmed is not here: the search tool
   * asks with its own card, and the flag flipping once rewrote the system prompt, so the next
   * run re-sent its whole prefix uncached (sweep 2026-10-28).
   */
  search?: Pick<SearchConfig, "provider"> | null;
  memoryMode?: "auto" | "ask";
  /** Scratch-file advice helps only where a workplace exists and file tools can write. */
  workplace?: boolean;
}

/** Tool schemas carry calling details; this section adds only scope and permission context. */
export function capabilityPrompt(language: "zh" | "en", facts: CapabilityFacts): string {
  const zh = language === "zh";
  const available = new Set(facts.definitions.map((tool) => tool.name));
  const deferred = new Set(
    facts.definitions.filter((tool) => tool.loadGroup).map((tool) => tool.name),
  );
  const describe = (
    names: readonly string[],
    label: string,
    level: "never" | "ask" | "always" | undefined,
    detail = "",
  ) => {
    if (!names.some((name) => available.has(name))) return "";
    const status =
      level === "always"
        ? zh
          ? "允许"
          : "allowed"
        : level === "ask"
          ? zh
            ? "询问"
            : "ask"
          : zh
            ? "禁止"
            : "disabled";
    return `${label}: ${status}${detail ? `${zh ? "；" : "; "}${detail}` : ""}`;
  };
  const searchServices: Record<SearchConfig["provider"], string> = {
    keyless: "DuckDuckGo → Bing",
    duckduckgo: "DuckDuckGo",
    bing: "Bing",
    brave: "Brave Search",
    tavily: "Tavily",
    keenable: "Keenable",
    searxng: "SearXNG",
  };
  const search = facts.search
    ? `${searchServices[facts.search.provider]}${zh ? "，查询发给该服务" : "; queries sent there"}`
    : zh
      ? "无搜索服务"
      : "no search service";
  return [
    zh ? capabilitiesPrompts.boundaries.zh : capabilitiesPrompts.boundaries.en,
    facts.workplace &&
    ["write_file", "edit_file", "apply_patch", "run_command"].some((name) => available.has(name))
      ? zh
        ? capabilitiesPrompts.workplaceFiles.zh
        : capabilitiesPrompts.workplaceFiles.en
      : "",
    // Maintainers 2026-10-31: Bots invented 「设置 › 连接」; give them the real places to point to.
    zh ? capabilitiesPrompts.appLocations.zh : capabilitiesPrompts.appLocations.en,
    zh ? capabilitiesPrompts.contactsCalendar.zh : capabilitiesPrompts.contactsCalendar.en,
    available.has("tool_discover")
      ? zh
        ? capabilitiesPrompts.toolDiscover.zh
        : capabilitiesPrompts.toolDiscover.en
      : "",
    describe(
      ["list_dir", "find_files"],
      zh ? "列目录/找文件" : "List/find",
      facts.levels?.list_dir,
    ),
    describe(
      ["read_file", "search_text"],
      zh ? "读取/搜索正文" : "Read/search contents",
      facts.levels?.read_file,
    ),
    describe(
      ["write_file", "edit_file", "apply_patch"],
      zh ? "写入/编辑" : "Write/edit",
      facts.levels?.write_file,
    ),
    describe(["run_command"], zh ? "命令" : "Commands", facts.levels?.run_command),
    describe(["send_file"], zh ? "发文件" : "Attach files", facts.levels?.read_file),
    describe(
      ["reveal_in_folder"],
      zh ? "在文件夹中显示" : "Show in folder",
      facts.levels?.read_file,
      zh ? capabilitiesPrompts.revealInFolder.zh : capabilitiesPrompts.revealInFolder.en,
    ),
    describe(
      ["read_messages"],
      zh ? "查询历史" : "Query history",
      facts.levels?.read_messages,
      zh ? capabilitiesPrompts.readMessages.zh : capabilitiesPrompts.readMessages.en,
    ),
    describe(["web_fetch"], zh ? "访问网页" : "Fetch webpages", facts.levels?.web),
    describe(
      ["web_search"],
      zh ? "搜索" : "Search",
      facts.search ? facts.levels?.web : "never",
      search,
    ),
    available.has("todo_list")
      ? zh
        ? "计划不能改变用户控制的执行/只读模式。"
        : "Plans cannot change the user's execution/readonly mode."
      : "",
    describe(
      ["assign_task", "ask_bot", "finish_task"],
      zh ? "群协作" : "Group collaboration",
      "always",
      zh
        ? "按本轮群角色与群权限协作，不继承其他成员权限"
        : "Use this run's group role/permissions, never another member's authority",
    ),
    describe(
      ["memory_add", "memory_update", "memory_remove", "memory_search", "memory_read"],
      zh ? "记忆" : "Memory",
      !facts.group && facts.memoryMode === "ask" ? "ask" : "always",
      facts.group
        ? zh
          ? capabilitiesPrompts.memoryScopes.group.zh
          : capabilitiesPrompts.memoryScopes.group.en
        : zh
          ? capabilitiesPrompts.memoryScopes.direct.zh
          : capabilitiesPrompts.memoryScopes.direct.en,
    ),
    // A Bot with nothing mounted is the one people ask about their own notes, so point at
    // where they connect a source instead of implying notes are already readable.
    available.has("knowledge_search")
      ? ""
      : zh
        ? capabilitiesPrompts.noKnowledge.zh
        : capabilitiesPrompts.noKnowledge.en,
    describe(
      ["skill_propose"],
      zh ? "保存技能" : "Save skills",
      "ask",
      zh
        ? "仅应用户要求；普通模式等确认，YOLO可立即保存有效技能"
        : "Only at the user's request; await confirmation normally, valid YOLO saves may be immediate",
    ),
    describe(
      ["ui_tree"],
      zh ? "操作电脑" : "Computer",
      facts.levels?.computer,
      deferred.has("ui_tree")
        ? zh
          ? "按需加载computer组；应用/时限/截图点击仍以用户授权卡为准；网页不用它，用 Bot 浏览器"
          : "Load computer as needed; app/time/screenshot-click grants still apply; not for web pages, which go to the Bot browser"
        : zh
          ? capabilitiesPrompts.computerDirect.zh
          : capabilitiesPrompts.computerDirect.en,
    ),
    // Fixed sentences (prompt cache: no per-run text). Maintainers 2026-11-14: "open the router admin
    // page" went to Safari through computer tools; web pages belong to the Bot browser, router
    // pages included (the user allows each local-network address on a card).
    describe(
      ["browser_open"],
      zh ? "Bot浏览器" : "Bot browser",
      facts.levels?.web,
      zh ? capabilitiesPrompts.botBrowser.zh : capabilitiesPrompts.botBrowser.en,
    ),
    zh
      ? `${available.has("ui_tree") ? "" : "未提供电脑工具，不能操作电脑界面；"}不能读取其他应用聊天、其他AI工具配置或主动对外发消息。`
      : `${available.has("ui_tree") ? "" : "No computer tools: cannot operate computer interfaces. "}Cannot read other apps' chats/AI configurations or proactively send external messages.`,
  ]
    .filter(Boolean)
    .join("\n");
}
