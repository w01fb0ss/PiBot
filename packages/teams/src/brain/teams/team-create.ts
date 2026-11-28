import type { DatabaseSync } from "node:sqlite";
import type { SkillsPort } from "@pibot/brain/kit";
import { avatarColors, defaultAutoCheckForNewBot, unusedAvatar } from "@pibot/brain/kit";
import type { TeamTemplate } from "@pibot/protocol";
import {
  BotsRepo,
  GroupsRepo,
  GroupVerificationRulesRepo,
  MessagesRepo,
  SidebarRepo,
} from "@pibot/storage";
import type { TeamSkillPackage } from "./team-archive.ts";

/**
 * Avatar pairs already used by active Bots, updated as Bots are inserted. Names are not tracked
 * here: BotsRepo.create gives each new Bot a free name inside the same transaction, with
 * the same comparison as every other way of naming a Bot.
 */
export class Taken {
  readonly avatars: Set<string>;
  constructor(db: DatabaseSync) {
    const rows = db
      .prepare("SELECT avatar_shape AS s, avatar_color AS c FROM bots WHERE archived_at IS NULL")
      .all();
    this.avatars = new Set(rows.map((r) => `${String(r.s)}:${String(r.c)}`));
  }
  /** The file's own look when free; otherwise the same shape in another colour, then any pair. */
  avatar(shape: string, color: string, eyes: string) {
    const free = (c: string) => !this.avatars.has(`${shape}:${c}`);
    const pickColor = free(color) ? color : avatarColors.find(free);
    const pick = pickColor
      ? { avatarShape: shape, avatarColor: pickColor, avatarEyes: eyes }
      : unusedAvatar(this.avatars);
    this.avatars.add(`${pick.avatarShape}:${pick.avatarColor}`);
    return pick;
  }
}

export interface CreateTeamContext {
  db: DatabaseSync;
  language: "zh" | "en";
  redact(text: string): string;
  /** BotService.introduce: the new Bot's first topic and fixed self-introduction. */
  introduce(botId: string): void;
  /**
   * Built-in content is trusted to set a new Bot's automatic check default (dev roles);
   * a user's imported file never is, whatever its `autoCheck` says.
   */
  trustAutoCheck?: boolean;
}
export interface CreateTeamInput {
  /** Resolved, tightened template whose models are already the ones to use. */
  template: TeamTemplate;
  /** Existing active Bots used instead of creating one for that ref (profession flow). */
  reuse?: ReadonlyMap<string, string>;
  /** Members left out of a group (no image model), named in its welcome message. */
  skippedMembers?: ReadonlyMap<number, string[]>;
  /** Quick starts per group index, when the caller adds a profession's own starter. */
  quickStarts?: (index: number) => string[] | undefined;
  welcomeNote?: (index: number, coordinatorId: string) => string | undefined;
  /** A sidebar section holding everything created (user imports keep theirs together). */
  sidebarSection?: string;
  /**
   * Refs whose name the user typed (new Bot from a role): a taken name is refused with
   * BotNameTakenError instead of becoming 「name 2」 like every file or built-in name.
   */
  exactNames?: ReadonlySet<string>;
}

/**
 * The single creation step behind every `.pibot` import — a user's file, a built-in role
 * ("new Bot from role"), a built-in group template and the profession flow. Runs inside the
 * caller's transaction: Bots with their role mark, norms and starters plus a fixed
 * self-introduction, then groups with the coordinator's fixed welcome (no model call).
 */
export function createTeam(context: CreateTeamContext, input: CreateTeamInput) {
  const bots = new BotsRepo(context.db);
  const groups = new GroupsRepo(context.db);
  const sidebar = new SidebarRepo(context.db);
  const section = input.sidebarSection ? sidebar.createGroup(input.sidebarSection) : undefined;
  const taken = new Taken(context.db);
  const refs = new Map<string, string>();
  const created: string[] = [];
  const reused: string[] = [];
  const r = context.redact;
  for (const b of input.template.bots) {
    const existing = input.reuse?.get(b.ref);
    if (existing) {
      const bot = bots.get(existing);
      if (!bot || bot.archivedAt) throw new TypeError("Reused Bot is no longer active");
      refs.set(b.ref, existing);
      reused.push(existing);
      continue;
    }
    const bot = bots.create(
      {
        name: r(b.name),
        category: b.category,
        ...(b.imageMode ? { imageMode: b.imageMode } : {}),
        isMain: false,
        description: r(b.description),
        systemPrompt: r(b.systemPrompt),
        ...taken.avatar(b.avatarShape, b.avatarColor, b.avatarEyes),
        ...(b.avatarImage ? { avatarImage: b.avatarImage } : {}),
        modelProvider: b.model?.provider ?? null,
        modelId: b.model?.id ?? null,
        thinkingLevel: b.category === "image" ? "off" : b.thinkingLevel,
        thinkingPreference:
          b.category === "image"
            ? "off"
            : b.thinkingPreference === undefined
              ? b.thinkingLevel
              : b.thinkingPreference,
        memoryMode: "auto",
        permissionOverrides: b.permissionOverrides,
        ...(b.role ? { role: { id: b.role.id, version: b.role.version } } : {}),
        ...(b.norms ? { norms: r(b.norms) } : {}),
        ...(b.quickPrompts?.length ? { quickPrompts: b.quickPrompts.map(r) } : {}),
      },
      { exactName: input.exactNames?.has(b.ref) === true },
    );
    context.introduce(bot.id);
    if (context.trustAutoCheck) defaultAutoCheckForNewBot(context.db, bot.id, b.autoCheck === true);
    if (section) sidebar.update(`dm:${bot.id}`, { groupId: section.id });
    refs.set(b.ref, bot.id);
    created.push(bot.id);
  }
  const names = new Set(
    context.db
      .prepare("SELECT name FROM groups")
      .all()
      .map((row) => String(row.name)),
  );
  const zh = context.language === "zh";
  const groupIds = input.template.groups.map((g, index) => {
    let name = g.name;
    for (let n = 2; names.has(name); n++) {
      const suffix = ` (${n})`;
      name = `${g.name.slice(0, 200 - suffix.length)}${suffix}`;
    }
    names.add(name);
    const group = groups.create({
      name: r(name),
      botIds: g.members.map((ref) => refs.get(ref) as string),
      coordinatorBotId: refs.get(g.coordinator),
      announcement: r(g.announcement),
      autoRoundLimit: g.autoRoundLimit,
    });
    if (g.verification) new GroupVerificationRulesRepo(context.db).set(group.id, g.verification);
    if (section) sidebar.update(`group:${group.id}`, { groupId: section.id });
    if (g.welcome) {
      const lines = [g.welcome];
      const note = input.welcomeNote?.(index, group.coordinatorBotId);
      if (note) lines.push(note);
      const skipped = input.skippedMembers?.get(index) ?? [];
      if (skipped.length)
        lines.push(
          zh
            ? `暂未加入：${skipped.join("、")}（还没有能生图的模型，之后可以在「新建 Bot」里补上）。`
            : `Not added yet: ${skipped.join(", ")} (no image generation model yet; add it later from New Bot).`,
        );
      const starts = input.quickStarts?.(index) ?? g.quickStarts ?? [];
      new MessagesRepo(context.db).create({
        conversationId: group.conversationId,
        botId: group.coordinatorBotId,
        role: "assistant",
        content: r(lines.join("\n\n")),
        ...(starts.length ? { usage: { groupQuickStarts: starts.map(r) } } : {}),
        status: "done",
      });
    }
    return group.id;
  });
  return { refs, created, reused, groupIds, sidebarGroupId: section?.id };
}

/**
 * Saves each newly created Bot's skill packages after the commit (their folders need the new
 * IDs). A skill that fails is skipped rather than undoing Bots already committed; the result
 * names it so the window can say so.
 */
export async function copyTeamSkills(
  skills: Pick<SkillsPort, "create"> | undefined,
  targets: readonly { botId: string; packages: readonly TeamSkillPackage[] }[],
  warn: (message: string) => void,
) {
  const skipped: { botId: string; name: string }[] = [];
  for (const { botId, packages } of targets)
    for (const skill of packages) {
      try {
        if (!skills) throw new Error("Skills unavailable");
        await skills.create(botId, skill.document, "team", {
          enabled: skill.enabled,
          files: skill.files,
          ...(skill.folder ? { folder: skill.folder } : {}),
        });
      } catch {
        warn(JSON.stringify({ module: "teams", event: "skill_skipped", botId }));
        skipped.push({ botId, name: skill.document.name });
      }
    }
  return skipped;
}
/** Counts for the audit line (never names or content). */
export function skillCounts(packages: readonly (readonly TeamSkillPackage[])[]) {
  const all = packages.flat();
  return {
    skills: all.length,
    files: all.reduce((sum, skill) => sum + skill.files.length + 1, 0),
    scripts: all.reduce((sum, skill) => sum + skill.files.filter((f) => f.script).length, 0),
  };
}
