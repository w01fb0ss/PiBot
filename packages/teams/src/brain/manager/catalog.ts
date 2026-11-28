import type { LocalToolResult } from "@pibot/agent";
import type { CapabilityContext, ToolCardDescriber, ToolRunContext } from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { GroupsRepo } from "@pibot/storage";
import { piManagerTools } from "@pibot/teams-contract";
import type { BuiltinService } from "../builtin/service.ts";
import type { RoleCatalogService } from "../cloud/role-catalog.ts";
import { managerFailure } from "./errors.ts";
import { firstLine, say } from "./lookup.ts";
import { auditManaged } from "./manage.ts";

type Selection = ReturnType<typeof piManagerTools.catalog_install.schema.parse>;
type Localized = { en: string; zh: string };
type Entry = Selection & {
  version: number;
  name: Localized;
  description: Localized;
  download: boolean;
};

type InstallPack = (
  kind: Selection["kind"],
  id: string,
  routing?: Parameters<RoleCatalogService["install"]>[2],
) => Promise<{ ok: true; version: number }>;

export class RoutingCatalog {
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly builtin: BuiltinService,
    private readonly cloud: RoleCatalogService,
    private readonly installPack: InstallPack,
  ) {}

  async entries(): Promise<Entry[]> {
    const [content, cloud] = await Promise.all([this.builtin.content(), this.cloud.state()]);
    const entries = new Map<string, Entry>();
    // Prefer usable local packs, including shipped templates, over a newer download.
    for (const [id, pack] of content.groups) {
      const zh = pack.zh.template.groups[0];
      const en = pack.en.template.groups[0];
      if (!zh?.template || !en) continue;
      entries.set(`group:${id}`, {
        id,
        kind: "group",
        version: zh.template.version,
        name: { zh: zh.name, en: en.name },
        description: {
          zh: zh.summary?.trim() || zh.announcement,
          en: en.summary?.trim() || en.announcement,
        },
        download: false,
      });
    }
    for (const [id, pack] of content.roles) {
      const zh = pack.zh.template.bots[0];
      const en = pack.en.template.bots[0];
      if (!zh?.role || !en) continue;
      entries.set(`role:${id}`, {
        id,
        kind: "role",
        version: zh.role.version,
        name: { zh: zh.role.name ?? zh.name, en: en.role?.name ?? en.name },
        description: { zh: zh.description, en: en.description },
        download: false,
      });
    }
    for (const entry of cloud.entries) {
      const { kind, id, version, name, description, needsUpdate } = entry;
      const key = `${kind}:${id}`;
      if (!needsUpdate && id.length <= 64 && !entries.has(key))
        entries.set(key, { kind, id, version, name, description, download: true });
    }
    return [...entries.values()];
  }

  async prepare(input: Record<string, unknown>) {
    const { id, kind } = piManagerTools.catalog_install.schema.parse(input);
    const entry = (await this.entries()).find((item) => item.kind === kind && item.id === id);
    return entry && { entry, binding: JSON.stringify(entry) };
  }

  card: ToolCardDescriber = (_context, _input, language, prepared) => {
    const entry = prepared as Entry | undefined;
    const group = entry?.kind === "group";
    const title = group
      ? say(language, "Pi 想从模板建立群组", "Pi wants to create a group from a template")
      : say(language, "Pi 想从角色库安装 Bot", "Pi wants to install a Bot from the catalog");
    if (!entry)
      return {
        title,
        facts: [],
        invalid: { code: "pi_catalog_unknown", text: catalogUnknown(language) },
      };
    const line = (value: string) => firstLine(this.ctx.redactor.redact(value), 120);
    return {
      title,
      lead: entry.download
        ? say(
            language,
            "先下载已验证的目录包。",
            "The verified catalog pack will be downloaded first.",
          )
        : say(language, "使用本机的目录包。", "The catalog pack on this device will be used."),
      facts: [
        {
          kind: "write",
          label: group
            ? say(language, "群组模板", "Group template")
            : say(language, "角色", "Role"),
          value: line(entry.name[language]) || entry.id,
        },
        ...(entry.description[language]
          ? [
              {
                kind: "write" as const,
                label: say(language, "描述", "Description"),
                value: line(entry.description[language]) || "—",
              },
            ]
          : []),
        {
          kind: "write",
          label: say(language, "目录包", "Catalog pack"),
          value: `${entry.id} · v${entry.version}`,
        },
        ...(group
          ? [
              {
                kind: "write" as const,
                label: say(language, "群成员", "Members"),
                value: say(
                  language,
                  "复用已有的同角色 Bot，并创建缺少的成员。",
                  "Reuse existing Bots with matching roles and create missing members.",
                ),
              },
            ]
          : []),
      ],
    };
  };

  async install(
    context: ToolRunContext,
    prepared: unknown,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<LocalToolResult> {
    const { language } = context;
    const entry = prepared as Entry | undefined;
    if (!entry) return { text: catalogUnknown(language), isError: true };
    const { kind, id, version } = entry;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const guard = () => {
      deadline.throwIfAborted();
      assertCurrent();
    };
    try {
      guard();
      this.builtin.assertNewRecipient(kind, id);
      if (entry.download) {
        const availableRoles = new Set([
          ...(await this.builtin.content()).roles.keys(),
          ...this.builtin.existing().keys(),
        ]);
        guard();
        await this.installPack(kind, id, {
          version,
          signal: deadline,
          guard: () => {
            guard();
            this.builtin.assertNewRecipient(kind, id);
          },
          availableRoles,
        });
      }
      const routing = { version, guard };
      const result =
        kind === "role"
          ? await this.createBot(context, id, routing)
          : await this.createGroup(context, id, routing);
      const nextStep =
        kind === "role"
          ? say(
              language,
              "若为当前任务安装，请本轮调用 send_to_bot，将 botId 用作 bot。",
              "If installed for the current task, call send_to_bot this turn with botId as bot.",
            )
          : say(
              language,
              "若为当前任务安装，请本轮调用 send_to_group，将 groupId 用作 group。",
              "If installed for the current task, call send_to_group this turn with groupId as group.",
            );
      return {
        text: JSON.stringify({ ...result, nextStep }),
        summary: lineForResult(language, kind),
      };
    } catch (error) {
      return managerFailure(this.ctx, language, error, "catalog_install");
    }
  }

  private async createBot(context: ToolRunContext, id: string, routing: InstallGuard) {
    const { bot } = await this.builtin.createBot({ roleId: id }, routing);
    auditManaged(this.ctx, context, "bot_created", bot.name, { targetBotName: bot.name });
    return { botId: bot.id, name: this.ctx.redactor.redact(bot.name) };
  }

  private async createGroup(context: ToolRunContext, id: string, routing: InstallGuard) {
    const { groupIds, botIds, reusedBotIds } = await this.builtin.create(
      { groups: [id], reuseExisting: true, source: "template" },
      routing,
    );
    const groupId = groupIds[0];
    if (!groupId) throw new RpcError(RpcErrorCodes.internal, "builtin_create_failed");
    const name = new GroupsRepo(this.ctx.db).get(groupId)?.name ?? id;
    auditManaged(this.ctx, context, "group_created", name, { groupId });
    return { groupId, name: this.ctx.redactor.redact(name), botIds, reusedBotIds };
  }
}

type InstallGuard = { version: number; guard(): void };

function catalogUnknown(language: "zh" | "en") {
  return say(
    language,
    "本机目录没有这个可用条目。请用 team_directory 重新查看。",
    "This entry is unavailable in the local catalog. Check team_directory again.",
  );
}

function lineForResult(language: "zh" | "en", kind: Selection["kind"]) {
  return kind === "role"
    ? say(language, "已从角色库创建 Bot", "Created a Bot from the catalog")
    : say(language, "已从模板建立群组", "Created a group from a template");
}
