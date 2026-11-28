import type { Bot, CapabilityToolRegistry, ModelInfo } from "@pibot/protocol-base";
import { type CapabilityFacts, capabilityPrompt } from "./capabilities.ts";
import { piPersonas, piSystemPrompt } from "./pi.ts";
import { historicalPiPersonas } from "./pi-history.ts";
import { botPrompts } from "./prompts/bot.ts";
import { userDecisionRule } from "./user-decisions.ts";
import { workQualityPrompt } from "./work-quality.ts";

export function memoryRule(language: "zh" | "en") {
  return botPrompts.memoryRule[language];
}
/**
 * A translator Bot answers pasted text instead of translating it because the generic
 * reply-language rule (piSystemPrompt) tells every Bot to reply in the user's language, and the
 * translator persona never says the inbound text is the source. The role id is only a mark;
 * it selects this wording and nothing else.
 */
export function translatorRule(language: "zh" | "en") {
  return botPrompts.translatorRule[language];
}
export function groupResultRule(language: "zh" | "en") {
  return botPrompts.groupResultRule[language];
}
export function botSystemPrompt(
  bot: Bot,
  language: "zh" | "en",
  model: ModelInfo,
  providerName: string,
  capabilities: CapabilityFacts,
  capabilityTools: CapabilityToolRegistry,
  /** Knowledge libraries assigned to this Bot or group; empty when none are. */
  knowledge: readonly { name: string; kind: string; writable?: boolean }[] = [],
) {
  const base =
    bot.isMain &&
    [...Object.values(piPersonas), ...historicalPiPersonas].some((p) => p === bot.systemPrompt)
      ? piPersonas[language]
      : bot.systemPrompt;
  // Working norms are stored apart from the persona and always follow it.
  const norms = bot.norms?.trim();
  const persona = norms
    ? `${base}\n\n${language === "zh" ? "工作规范：" : "Working norms:"}\n${norms}`
    : base;
  const available = new Set(capabilities.definitions.map((tool) => tool.name));
  const direct = new Set(
    capabilities.definitions.filter((tool) => !tool.loadGroup).map((tool) => tool.name),
  );
  return [
    piSystemPrompt(
      language,
      model,
      providerName,
      persona,
      bot.name,
      capabilityPrompt(language, capabilities),
    ),
    // Goes after the persona because piSystemPrompt carries the generic reply-language rule this
    // one has to override.
    bot.role?.id === "translator" ? translatorRule(language) : "",
    direct.has("ask_user") ? userDecisionRule(language) : "",
    direct.has("personal_todo") ? botPrompts.personalTodo[language] : "",
    workQualityPrompt(bot, language, available.has("write_file") || available.has("edit_file")),
    [...direct].some((name) => name.startsWith("memory_")) ? memoryRule(language) : "",
    capabilities.group ? groupResultRule(language) : "",
    knowledge.length > 0 ? knowledgeRule(language, knowledge) : "",
    // Capability tool groups bring their own rule, e.g. routines' proposal etiquette.
    ...Object.entries(capabilityTools.specs).map(([name, spec]) =>
      spec.rule && !spec.group && direct.has(name) ? spec.rule[language] : "",
    ),
    ...capabilityTools.groups.map((group) =>
      Object.entries(capabilityTools.specs).some(
        ([name, spec]) => spec.group === group.id && direct.has(name),
      )
        ? group.rule[language]
        : "",
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}
/**
 * Only the names and kinds go in the prompt: the model learns that a library exists and what to
 * call, while the tools decide per run what may actually be read.
 */
export function knowledgeRule(
  language: "zh" | "en",
  knowledge: readonly { name: string; kind: string; writable?: boolean }[],
) {
  const list = knowledge
    .slice(0, 20)
    .map((entry) =>
      language === "zh"
        ? `${entry.name}（${knowledgeKind(entry.kind, language)}${entry.writable ? "，Bot 可修改" : ""}）`
        : `${entry.name} (${knowledgeKind(entry.kind, language)}${entry.writable ? ", Bots can edit" : ""})`,
    );
  return language === "zh"
    ? botPrompts.knowledgeRule.zh({ list: list.join("、") })
    : botPrompts.knowledgeRule.en({ list: list.join(", ") });
}
function knowledgeKind(kind: string, language: "zh" | "en") {
  if (kind === "obsidian") return "Obsidian";
  if (kind === "notion") return "Notion";
  if (kind === "folder") return language === "zh" ? "本地文档文件夹" : "Local folder";
  return kind;
}
export function fallbackPersona(description: string, language: "zh" | "en") {
  return language === "zh"
    ? {
        name: "新 Bot",
        systemPrompt: botPrompts.fallbackPersona.zh({
          description: JSON.stringify(description),
          memoryRule: memoryRule(language),
        }),
      }
    : {
        name: "New Bot",
        systemPrompt: botPrompts.fallbackPersona.en({
          description: JSON.stringify(description),
          memoryRule: memoryRule(language),
        }),
      };
}
