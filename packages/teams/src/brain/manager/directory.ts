import {
  type CapabilityContext,
  dispatchThinkingLevel,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { isRetiredModel } from "@pibot/protocol";
import { GroupTopicsRepo, SettingsRepo } from "@pibot/storage";
import { piManagerTools } from "@pibot/teams-contract";
import { BuiltinBaselinesRepo } from "../../store/baselines.ts";
import { PiDispatchesRepo } from "../../store/pi-dispatches.ts";
import type { RoutingCatalog } from "./catalog.ts";
import { allBots, allGroups, botName, firstLine, oneLine, say } from "./lookup.ts";

export async function teamDirectory(
  ctx: CapabilityContext,
  catalog: RoutingCatalog,
  context: ToolRunContext,
  input: unknown,
) {
  const args = piManagerTools.team_directory.schema.parse(input);
  const { language } = context;
  const [entries, modelRows] = await Promise.all([
    catalog.entries(),
    ctx.local.models?.dispatchModels?.(context.signal) ?? [],
  ]);
  const line = (value: string, max = 120) => oneLine(ctx.redactor.redact(value), max);
  const metadata = (value: string) => firstLine(ctx.redactor.redact(value), 120);
  const busy = new PiDispatchesRepo(ctx.db).busy();
  const defaults = new SettingsRepo(ctx.db).get().defaultModel;
  const videoProviders = ctx.local.models?.videoProviders() ?? [];
  const computer = !!ctx.local.computerUse && !!ctx.host.computer;
  const bots = allBots(ctx.db, args.includeArchived === true).filter((bot) => !bot.isMain);
  const groups = allGroups(ctx.db, args.includeArchived === true);
  const roleDescriptions = new Map(
    entries.filter(({ kind }) => kind === "role").map((entry) => [entry.id, entry.description]),
  );
  const baselines = new BuiltinBaselinesRepo(ctx.db);
  const groupTopics = new GroupTopicsRepo(ctx.db);
  const displayName = (id: string) => line(botName(ctx.db, id), 200);
  const modelKey = (provider: string, id: string) => JSON.stringify([provider, id]);
  const availability = new Map(
    modelRows.map((model) => [modelKey(model.provider, model.id), model]),
  );
  const rows = bots.slice(0, 60).map((bot) => {
    const levels = ctx.local.permissions.effective(bot.id).levels;
    const external = bot.kind === "agent";
    const chat = bot.category === "chat" && !external;
    const selected =
      bot.modelProvider && bot.modelId
        ? { provider: bot.modelProvider, id: bot.modelId }
        : chat
          ? defaults
          : undefined;
    const model = selected
      ? `${selected.provider}/${selected.id}`
      : external
        ? "external_agent"
        : "default";
    const listed = selected && availability.get(modelKey(selected.provider, selected.id));
    const video = chat ? bot.defaultVideoModel : undefined;
    const canGenerateVideo = chat && levels.web !== "never" && videoProviders.length > 0;
    return {
      id: bot.id,
      name: line(bot.name, 200),
      ...(video
        ? {
            defaultVideoModel: {
              provider: line(video.provider, 300),
              id: line(video.id, 300),
              available:
                canGenerateVideo &&
                videoProviders.some(
                  ({ id, videoModels }) =>
                    id === video.provider && videoModels.some((model) => model.id === video.id),
                ),
            },
          }
        : {}),
      ...(bot.role ? { roleId: bot.role.id } : {}),
      kind: external ? "external_agent" : bot.category,
      role: metadata(
        bot.description?.trim() ||
          (bot.role && roleDescriptions.get(bot.role.id)?.[language]) ||
          bot.systemPrompt,
      ),
      model: line(model, 300),
      ...(selected && listed
        ? { thinkingLevel: dispatchThinkingLevel(bot, selected, listed) }
        : {}),
      ...(external
        ? {}
        : {
            modelAvailability: listed
              ? { available: listed.available, reason: listed.reason }
              : {
                  available: false,
                  reason:
                    selected && isRetiredModel(selected.provider, selected.id)
                      ? "retired"
                      : "model_not_found",
                },
          }),
      abilities: {
        image: bot.category === "image",
        video: canGenerateVideo,
        computer: chat && levels.computer !== "never" && computer,
        externalAgent: external
          ? line(ctx.local.externalAgentProvider?.kind?.(bot.id) ?? "agent")
          : null,
      },
      state: bot.archivedAt ? "archived" : busy.bots.has(bot.id) ? "busy" : "idle",
    };
  });
  const groupRows = groups.slice(0, 30).map((group) => {
    const source = baselines.group(group.id);
    return {
      id: group.id,
      name: line(group.name, 200),
      purpose: metadata(group.announcement),
      ...(source ? { templateId: source.sourceId } : {}),
      coordinator: displayName(group.coordinatorBotId),
      members: group.members.map((member) => displayName(member.botId)),
      state: group.archivedAt
        ? "archived"
        : group.paused
          ? "paused"
          : busy.groups.has(group.id) || groupTopics.busy(group.id)
            ? "busy"
            : "idle",
    };
  });
  return {
    text: JSON.stringify({
      bots: rows,
      groups: groupRows,
      models: modelRows.map((model) => ({
        ...model,
        provider: ctx.redactor.redact(model.provider),
        id: ctx.redactor.redact(model.id),
        name: line(model.name, 200),
      })),
      catalog: entries.slice(0, 80).map((entry) => ({
        kind: entry.kind,
        id: entry.id,
        name: metadata(entry.name[language]),
        description: metadata(entry.description[language]),
        installed: !entry.download,
      })),
      truncated: {
        bots: bots.length > 60,
        groups: groups.length > 30,
        catalog: entries.length > 80,
      },
    }),
    summary: say(
      language,
      `${rows.length} 个 Bot、${groupRows.length} 个群组`,
      `${rows.length} Bots, ${groupRows.length} groups`,
    ),
  };
}
