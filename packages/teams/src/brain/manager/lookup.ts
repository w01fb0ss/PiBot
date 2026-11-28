// Names the model gives are matched to the person's Bots and groups; ids win, then one exact name.
import type { DatabaseSync } from "node:sqlite";
import type { Bot, Group } from "@pibot/protocol";
import { BotsRepo, GroupsRepo } from "@pibot/storage";

export type Language = "zh" | "en";
export const say = (language: Language, zh: string, en: string) => (language === "zh" ? zh : en);

const key = (value: string) => value.trim().toLowerCase();

/** All Bots (active first) without the main Pi; bounded like the sidebar. */
export function allBots(db: DatabaseSync, includeArchived: boolean): Bot[] {
  return new BotsRepo(db).page({ limit: 200 }, includeArchived);
}

export function findBot(db: DatabaseSync, ref: string | undefined): Bot | undefined {
  if (!ref) return undefined;
  const repo = new BotsRepo(db);
  const byId = repo.get(ref.trim());
  if (byId) return byId;
  const named = allBots(db, true).filter((bot) => key(bot.name) === key(ref));
  // An active Bot wins over an archived one with the same name (names are unique among active).
  const active = named.filter((bot) => !bot.archivedAt);
  return active.length === 1 ? active[0] : named.length === 1 ? named[0] : undefined;
}

/** Resolve the same roster for the approval card and for the group it authorizes. */
export function groupCreation(db: DatabaseSync, refs: readonly string[] = [], requested?: string) {
  const bots = new Map<string, Bot>();
  const unknown: string[] = [];
  for (const ref of refs) {
    const bot = findBot(db, ref);
    if (!bot || bot.archivedAt) unknown.push(ref);
    else bots.set(bot.id, bot);
  }
  const members = [...bots.values()];
  const chosen = requested ? findBot(db, requested) : members[0];
  const eligible = (bot: Bot | undefined): bot is Bot =>
    !!bot && bot.kind !== "agent" && bot.category !== "image" && !bot.archivedAt;
  let coordinator = chosen && bots.has(chosen.id) ? chosen : undefined;
  if (
    members.length >= 2 &&
    coordinator &&
    members.some((bot) => bot.kind === "agent") &&
    !eligible(coordinator)
  ) {
    coordinator = members.find(eligible);
    if (!coordinator && members.length < 6) {
      const pi = new BotsRepo(db).getMain();
      if (eligible(pi)) {
        coordinator = pi;
        members.push(pi);
      }
    }
  }
  return {
    members,
    unknown,
    coordinator,
    coordinatorNotMember: !!requested && (!chosen || !bots.has(chosen.id)),
  };
}

export function groupCoordinatorRequired(language: Language) {
  return say(
    language,
    "请选一位能统筹的 Pi Bot 成员。群组最多六位成员。",
    "Choose a Pi Bot member to coordinate. The group can have up to six members.",
  );
}

export function allGroups(db: DatabaseSync, includeArchived: boolean): Group[] {
  const repo = new GroupsRepo(db);
  return [
    ...repo.list({ limit: 100 }),
    ...(includeArchived ? repo.list({ limit: 100, archived: true }) : []),
  ];
}

export function findGroup(db: DatabaseSync, ref: string | undefined): Group | undefined {
  if (!ref) return undefined;
  const byId = new GroupsRepo(db).get(ref.trim());
  if (byId) return byId;
  const named = allGroups(db, true).filter((group) => key(group.name) === key(ref));
  const active = named.filter((group) => !group.archivedAt);
  return active.length === 1 ? active[0] : named.length === 1 ? named[0] : undefined;
}

export function botName(db: DatabaseSync, id: string): string {
  return new BotsRepo(db).get(id)?.name ?? id;
}

/** "provider/model-id" or "default"; anything else is not a model reference. */
export function parseModel(
  value: string | undefined,
): { provider: string; id: string } | null | undefined {
  if (value === undefined) return undefined;
  if (key(value) === "default") return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash).trim(), id: value.slice(slash + 1).trim() };
}

export function oneLine(value: string, limit = 160): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function shortDispatchTitle(value: string): string {
  return (
    oneLine(value.replace(/[\p{Cc}\p{Cf}]/gu, " "), 40).replace(/[\uD800-\uDBFF](?=…$)/u, "") || "—"
  );
}

export function firstLine(value: string, limit: number): string {
  return oneLine(value.trim().split(/\r\n?|\n|\u2028|\u2029/u, 1)[0] ?? "", limit);
}

/** Whether a role change rewrites the persona; the card states it, the edit applies it. */
export function personaFollowsRole(
  bot: Bot,
  role: string | undefined,
  persona: string | undefined,
) {
  return (
    role !== undefined &&
    persona === undefined &&
    role !== (bot.description ?? "") &&
    bot.kind !== "agent" &&
    bot.category !== "image"
  );
}
