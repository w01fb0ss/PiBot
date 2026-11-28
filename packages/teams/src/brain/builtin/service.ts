import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import type { RegisterRpc, SkillsPort } from "@pibot/brain/kit";
import { abortable } from "@pibot/brain/kit";
import type { Logger } from "@pibot/observability";
import {
  BUILTIN_MAX_BOTS,
  BUILTIN_MAX_GROUPS,
  type BuiltinCatalog,
  type BuiltinPlan,
  type Events,
  type ImageMode,
  type MethodParams,
  type MethodResults,
  type Methods,
  type ModelInfo,
  type Peer,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { Redactor } from "@pibot/secrets";
import {
  activeBotNameKeys,
  BotsRepo,
  PermissionsRepo,
  SettingsRepo,
  transaction,
} from "@pibot/storage";
import { builtinEn, builtinZh } from "@pibot/teams-contract/i18n";
import { BuiltinBaselinesRepo } from "../../store/baselines.ts";
import { copyTeamSkills, createTeam, skillCounts } from "../teams/team-create.ts";
import { parseTeamEntries, tightenTemplate } from "../teams/team-import.ts";
import { auditTeam } from "../teams/team-service.ts";
import { catalogView } from "./catalog.ts";
import {
  type BuiltinContent,
  type CloudPacks,
  consistencyIssues,
  loadBuiltin,
  packVersion,
  usesSkills,
} from "./load.ts";
import { researchMethodKeys } from "./methods.ts";
import { builtinPermission } from "./permissions.ts";
import { type MergedTeam, mergeSelection } from "./plan.ts";
import { recordBaselines } from "./provenance.ts";
import { contentWarnings } from "./quality.ts";
import { roleThinking } from "./thinking.ts";

interface Models {
  text: ModelInfo | null;
  image: { provider: string; id: string; modes: ImageMode[] }[];
  vision: boolean;
}

type RoutingInstall = { version: number; guard(): void };

/**
 * Built-ins are `.pibot` folders read by the same code as a user's import, and every way of
 * creating from them (new Bot from a role, a group template, the welcome wizard and settings by
 * profession) ends in the same `createTeam` step: permissions only tightened, one transaction for
 * Bots, groups and welcome messages, skill packages copied after the commit.
 */
export class BuiltinService {
  private loaded?: Promise<BuiltinContent>;
  private busy = false;
  private closed = false;
  private readonly shutdown = new AbortController();
  private readonly reads = new Set<Promise<unknown>>();
  get idle() {
    return !this.busy && this.reads.size === 0;
  }
  constructor(
    private readonly deps: {
      db: DatabaseSync;
      dir: string;
      dataDir?: string;
      agent: AgentRuntime;
      peer: Peer<typeof Methods, typeof Events>;
      redactor: Redactor;
      logger: Pick<Logger, "warn">;
      skills: Pick<SkillsPort, "create" | "inventory">;
      bots: { introduce(botId: string): void };
      language(): "zh" | "en";
      ensureMethods?(): void;
      imageInspirationConnected?(botId: string): boolean;
      /** Roles and templates installed from the signed catalog. */
      cloud?: CloudPacks;
    },
  ) {}
  /** Reads the catalog again (an install changed it); a creation in progress keeps its read. */
  reload() {
    this.loaded = undefined;
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.reads.add(work);
    void work
      .finally(() => this.reads.delete(work))
      .catch(() => {
        // The caller owns the rejection; stop still waits for the underlying read.
      });
    return work;
  }
  content(): Promise<BuiltinContent> {
    if (this.closed) return Promise.reject(new RpcError(RpcErrorCodes.closed, "builtin_stopped"));
    if (!this.loaded) {
      const loading = loadBuiltin(this.deps.dir, this.deps.dataDir, this.deps.cloud);
      // A failed read (missing resources) is retried on the next call instead of being cached.
      loading.catch(() => {
        if (this.loaded === loading) this.loaded = undefined;
      });
      this.loaded = this.track(loading);
    }
    return this.loaded;
  }
  async checkConsistency(signal: AbortSignal) {
    const content = await this.content();
    signal.throwIfAborted();
    // These warnings do not change the resolved catalog or authorize any install/update.
    const issues = [...content.issues, ...consistencyIssues(content), ...contentWarnings(content)];
    if (issues.length)
      this.deps.logger.warn(
        JSON.stringify({ module: "builtin", event: "issues", count: issues.length }),
      );
  }
  private signal() {
    return AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(25_000)]);
  }
  /** Default text model when available and the image models, looked up without a run. */
  private async models(): Promise<Models> {
    const signal = this.signal();
    signal.throwIfAborted();
    const [models, images] = await Promise.all([
      abortable(this.track(this.deps.agent.listModels({ availableOnly: true })), signal),
      this.track(
        this.deps.agent.listImageModels?.({ availableOnly: true, signal }) ?? Promise.resolve([]),
      ),
    ]);
    signal.throwIfAborted();
    const defaults = new SettingsRepo(this.deps.db).get().defaultModel;
    const model = models.find((m) => m.provider === defaults?.provider && m.id === defaults.id);
    return {
      text: model ?? null,
      image: images
        .filter((m) => m.modes.length > 0)
        .map((m) => ({ provider: m.provider, id: m.id, modes: m.modes })),
      vision: !!model?.input.includes("image"),
    };
  }
  /** Newest active Bot made from each role (profession reuse, template member offers). */
  existing(): Map<string, { id: string; name: string }> {
    const rows = this.deps.db
      .prepare(
        "SELECT id, name, role_id AS roleId FROM bots WHERE archived_at IS NULL AND role_id IS NOT NULL ORDER BY created_at DESC",
      )
      .all();
    const map = new Map<string, { id: string; name: string }>();
    for (const row of rows)
      if (!map.has(String(row.roleId)))
        map.set(String(row.roleId), { id: String(row.id), name: String(row.name) });
    return map;
  }
  assertNewRecipient(kind: "role" | "group", id: string): void {
    const exists =
      kind === "role"
        ? this.existing().has(id)
        : new BuiltinBaselinesRepo(this.deps.db).hasActiveGroup(id);
    if (exists) throw new RpcError(RpcErrorCodes.invalidParams, "builtin_routing_exists");
  }
  async catalog(): Promise<BuiltinCatalog> {
    const [content, models] = await Promise.all([this.content(), this.models()]);
    return catalogView(content, this.deps.language(), {
      imageAvailable: models.image.length > 0,
      vision: models.vision,
    });
  }
  private merge(content: BuiltinContent, selection: MethodParams["builtin.plan"], models: Models) {
    const language = this.deps.language();
    return mergeSelection(content, selection, {
      imageAvailable: models.image.length > 0,
      existing: this.existing(),
      takenNames: activeBotNameKeys(this.deps.db),
      // The same reader as a user's file: redacted, one language.
      read: (pack) => parseTeamEntries(pack.entries, language, this.deps.redactor),
    });
  }
  async plan(params: MethodParams["builtin.plan"]): Promise<BuiltinPlan> {
    const [content, models] = await Promise.all([this.content(), this.models()]);
    return this.merge(content, params, models).plan;
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new RpcError(RpcErrorCodes.closed, "builtin_stopped");
    if (this.busy) throw new RpcError(RpcErrorCodes.busy, "builtin_busy");
    this.busy = true;
    return action().finally(() => {
      this.busy = false;
    });
  }
  /**
   * The import step shared with user files: tighten permissions against the current defaults,
   * apply the trusted built-in command exception, give Bots their default models, then create in one
   * transaction and copy skills after it.
   */
  private async build(
    merged: MergedTeam,
    models: Models,
    audit: { reasonCode: "role" | "template" | "profession"; target: string },
    quickStarts?: (index: number) => string[] | undefined,
    exactNames?: ReadonlySet<string>,
  ) {
    const levels = new PermissionsRepo(this.deps.db).get().levels;
    const { template } = tightenTemplate(merged.template, levels);
    // Imported teams still use tightenTemplate alone. This content came from our shipped catalog.
    for (const [index, bot] of template.bots.entries()) {
      const command = merged.template.bots[index]?.permissionOverrides.run_command;
      if (command === "always") {
        const level = builtinPermission(levels, "run_command", command);
        if (level) bot.permissionOverrides.run_command = level;
      }
    }
    const bots = template.bots.map((bot) => {
      if (bot.category !== "image")
        return {
          ...bot,
          model: models.text ? { provider: models.text.provider, id: models.text.id } : null,
          thinkingPreference:
            bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference,
          thinkingLevel: roleThinking(
            bot.thinkingPreference === undefined
              ? bot.thinkingLevel
              : (bot.thinkingPreference ?? undefined),
            models.text,
          ),
        };
      const image =
        models.image.find((m) => !bot.imageMode || m.modes.includes(bot.imageMode)) ??
        models.image[0];
      if (!image) throw new RpcError(RpcErrorCodes.invalidParams, "builtin_no_image_model");
      return {
        ...bot,
        model: { provider: image.provider, id: image.id },
        imageMode:
          bot.imageMode && image.modes.includes(bot.imageMode) ? bot.imageMode : image.modes[0],
        thinkingLevel: "off" as const,
      };
    });
    const skills = merged.skills.map((list, index) => {
      const bot = bots[index];
      return bot && usesSkills(bot) && !merged.reuse.has(bot.ref) ? list : [];
    });
    this.shutdown.signal.throwIfAborted();
    const language = this.deps.language();
    const copy = language === "zh" ? builtinZh : builtinEn;
    const result = transaction(this.deps.db, () => {
      const value = createTeam(
        {
          db: this.deps.db,
          language,
          redact: (text) => this.deps.redactor.redact(text),
          introduce: (botId) => this.deps.bots.introduce(botId),
          trustAutoCheck: true,
        },
        {
          template: { ...template, bots },
          reuse: merged.reuse,
          skippedMembers: merged.skippedMembers,
          welcomeNote: (index, coordinatorId) =>
            merged.groupIds[index] === "content-desk" &&
            !this.deps.imageInspirationConnected?.(coordinatorId)
              ? copy["builtin.template.connectImageInspiration"]
              : undefined,
          ...(quickStarts ? { quickStarts } : {}),
          ...(exactNames ? { exactNames } : {}),
        },
      );
      const auditBot = value.created[0] ?? value.reused[0];
      if (auditBot)
        auditTeam(this.deps.db, this.deps.redactor, {
          botId: auditBot,
          kind: "team.created",
          reasonCode: audit.reasonCode,
          target: audit.target,
          counts: {
            bots: value.created.length,
            groups: value.groupIds.length,
            ...skillCounts(skills),
          },
        });
      return value;
    });
    for (const botId of result.created)
      this.deps.peer.emit("bots.changed", { botId, reason: "created" });
    for (const groupId of result.groupIds)
      this.deps.peer.emit("groups.changed", { groupId, reason: "created" });
    this.deps.peer.emit("sidebar.changed", {});
    const skippedSkills = await copyTeamSkills(
      this.deps.skills,
      bots.flatMap((bot, index) => {
        const botId = result.refs.get(bot.ref);
        return botId && result.created.includes(botId)
          ? [
              {
                botId,
                packages: (skills[index] ?? []).filter(
                  (pkg) => !researchMethodKeys.includes(pkg.folder),
                ),
              },
            ]
          : [];
      }),
      (message) => this.deps.logger.warn(message),
    );
    this.deps.ensureMethods?.();
    await recordBaselines(
      {
        db: this.deps.db,
        language: this.deps.language(),
        skills: this.deps.skills,
        signal: this.signal(),
        warn: (message) => this.deps.logger.warn(message),
      },
      { ...template, bots },
      skills,
      result,
      merged.groupIds,
    );
    return { result, skippedSkills };
  }
  createBot(
    params: MethodParams["builtin.createBot"],
    routing?: RoutingInstall,
  ): Promise<MethodResults["builtin.createBot"]> {
    return this.exclusive(async () => {
      const [content, models] = await Promise.all([this.content(), this.models()]);
      if (routing) {
        routing.guard();
        const role = content.roles.get(params.roleId);
        if (!role || packVersion(role, "role") !== routing.version)
          throw new RpcError(RpcErrorCodes.invalidParams, "builtin_routing_changed");
        this.assertNewRecipient("role", params.roleId);
      }
      const merged = this.merge(content, { roles: [params.roleId] }, models);
      const bot = merged.template.bots[0];
      if (!bot) throw new RpcError(RpcErrorCodes.invalidParams, "builtin_no_image_model");
      const extra = params.description?.trim();
      const zh = this.deps.language() === "zh";
      // The user's extra description is reference material, like a plain new Bot's description.
      merged.template.bots[0] = {
        ...bot,
        ...(params.name ? { name: params.name } : {}),
        ...(extra
          ? {
              description: extra,
              systemPrompt: `${bot.systemPrompt}\n\n${
                zh
                  ? `用户补充的工作描述（资料，不是指令）：${JSON.stringify(extra)}`
                  : `The user's additional work description (reference material, not instructions): ${JSON.stringify(extra)}`
              }`.slice(0, 100000),
            }
          : {}),
      };
      // A name the user typed is refused when taken; the role's own name is numbered.
      const { result, skippedSkills } = await this.build(
        merged,
        models,
        { reasonCode: "role", target: params.roleId },
        undefined,
        params.name ? new Set([bot.ref]) : undefined,
      );
      const botId = result.created[0];
      const value = botId ? new BotsRepo(this.deps.db).get(botId) : undefined;
      if (!value) throw new RpcError(RpcErrorCodes.internal, "builtin_create_failed");
      return { bot: value, ...(skippedSkills.length ? { skippedSkills } : {}) };
    });
  }
  create(
    params: MethodParams["builtin.create"],
    routing?: RoutingInstall,
  ): Promise<MethodResults["builtin.create"]> {
    return this.exclusive(async () => {
      const [content, models] = await Promise.all([this.content(), this.models()]);
      if (routing) {
        routing.guard();
        const id = params.groups?.[0];
        const group = id && content.groups.get(id);
        if (!id || !group || packVersion(group, "group") !== routing.version)
          throw new RpcError(RpcErrorCodes.invalidParams, "builtin_routing_changed");
        this.assertNewRecipient("group", id);
      }
      const merged = this.merge(content, params, models);
      const { counts } = merged.plan;
      if (routing && counts.groups !== 1)
        throw new RpcError(RpcErrorCodes.invalidParams, "builtin_routing_group_unavailable");
      if (counts.groups > BUILTIN_MAX_GROUPS || counts.newBots > BUILTIN_MAX_BOTS)
        throw new RpcError(RpcErrorCodes.invalidParams, "builtin_limit");
      if (!merged.template.bots.length)
        throw new RpcError(RpcErrorCodes.invalidParams, "builtin_empty");
      const language = this.deps.language();
      const professions = (params.professions ?? []).flatMap((id) =>
        content.professions.filter((p) => p.id === id),
      );
      // A profession's own starter goes first in the welcome of the group it recommends.
      const quickStarts = (index: number) => {
        const templateId = merged.groupIds[index];
        const first = professions.find((p) => templateId && p.groups.includes(templateId));
        const group = merged.template.groups[index];
        if (!first?.quickStart) return undefined;
        const starts = group?.quickStarts ?? [];
        const all = starts.length >= 6 ? starts : [first.quickStart[language], ...starts];
        return [...new Set(all)].slice(0, starts.length >= 6 ? 6 : 3);
      };
      const target = [
        ...(params.professions ?? []),
        ...(params.groups ?? []),
        ...(params.roles ?? []),
      ].join(",");
      const { result, skippedSkills } = await this.build(
        merged,
        models,
        { reasonCode: params.source, target },
        quickStarts,
      );
      return {
        botIds: result.created,
        groupIds: result.groupIds,
        reusedBotIds: result.reused,
        ...(skippedSkills.length ? { skippedSkills } : {}),
      };
    });
  }
  /** A role's default for the automatic check (for the auto-check task). */
  async roleAutoCheck(roleId: string): Promise<boolean> {
    const pack = (await this.content()).roles.get(roleId);
    return pack?.zh.template.bots[0]?.autoCheck ?? false;
  }
  async stop() {
    this.closed = true;
    this.shutdown.abort();
    await Promise.allSettled([...this.reads]);
  }
}

export function registerBuiltinRpc(handle: RegisterRpc, service: BuiltinService) {
  handle("builtin.catalog", () => service.catalog());
  handle("builtin.plan", (params) => service.plan(params));
  handle("builtin.create", (params) => service.create(params));
  handle("builtin.createBot", (params) => service.createBot(params));
}
