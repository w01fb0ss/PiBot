// The whole health check: every rule, the person's scope, names for people, a stable order and
// a bounded page. Deterministic for the same state, so the repair's re-check compares like with like.
import type { CapabilityContext } from "@pibot/brain/kit";
import { BotsRepo, ConversationsRepo, GroupsRepo } from "@pibot/storage";
import {
  PI_HEALTH_KINDS,
  PI_HEALTH_PAGE,
  type PiHealthItem,
  type PiHealthKind,
} from "@pibot/teams-contract";
import { connectionItems, planItems, roundItems, taskItems } from "./detect-groups.ts";
import { approvalItems, backgroundItems, runItems, topicItems } from "./detect-runs.ts";
import { type DraftItem, liveState } from "./live.ts";

export type HealthScope =
  | { kind: "all" }
  | { kind: "bot"; botId: string; name: string }
  | {
      kind: "group";
      groupId: string;
      name: string;
    };

const order = new Map<PiHealthKind, number>(PI_HEALTH_KINDS.map((kind, index) => [kind, index]));

/** Every stuck item now, unpaged (each rule is bounded by its own scan). */
export function detectAll(ctx: CapabilityContext, now = Date.now()): DraftItem[] {
  const live = liveState(ctx);
  const items = [
    ...approvalItems(ctx.db, live, now),
    ...runItems(ctx.db, live, now),
    ...topicItems(ctx.db, live, now),
    ...planItems(ctx, live, now),
    ...roundItems(ctx),
    ...taskItems(ctx, live, now),
    ...connectionItems(ctx),
    ...backgroundItems(ctx.db, live, now),
  ];
  const seen = new Set<string>();
  return items
    .filter((item) => !seen.has(item.id) && seen.add(item.id))
    .sort(
      (a, b) =>
        (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) ||
        (a.since ?? "").localeCompare(b.since ?? "") ||
        a.id.localeCompare(b.id),
    );
}

function inScope(ctx: CapabilityContext, item: DraftItem, scope: HealthScope) {
  if (scope.kind === "all") return true;
  if (scope.kind === "group") return item.where.groupId === scope.groupId;
  if (item.where.botId === scope.botId) return true;
  // A group item counts for a Bot that is one of the group's members.
  return (
    !!item.where.groupId &&
    !!new GroupsRepo(ctx.db)
      .get(item.where.groupId)
      ?.members.some((member) => member.botId === scope.botId)
  );
}

/** Names people read; redacted and short, never message text. */
export function named(ctx: CapabilityContext, item: DraftItem): PiHealthItem {
  const bots = new BotsRepo(ctx.db);
  const bot = item.where.botId ? bots.get(item.where.botId) : undefined;
  const group = item.where.groupId ? new GroupsRepo(ctx.db).get(item.where.groupId) : undefined;
  const topic = item.where.conversationId
    ? new ConversationsRepo(ctx.db).get(item.where.conversationId)
    : undefined;
  const title = item.where.title ?? (topic?.kind !== "group" ? topic?.title : undefined);
  const clean = (value: string | undefined) =>
    value
      ? ctx.redactor.redact(value).replace(/\s+/g, " ").trim().slice(0, 200) || undefined
      : undefined;
  const botName = clean(bot?.name);
  const groupName = clean(group?.name);
  const shown = clean(title);
  return {
    ...item,
    where: {
      ...(item.where.botId ? { botId: item.where.botId } : {}),
      ...(botName ? { botName } : {}),
      ...(item.where.groupId ? { groupId: item.where.groupId } : {}),
      ...(groupName ? { groupName } : {}),
      ...(item.where.conversationId ? { conversationId: item.where.conversationId } : {}),
      ...(shown ? { title: shown } : {}),
    },
  };
}

export interface HealthPage {
  items: PiHealthItem[];
  /** Items in scope after this page. */
  more: number;
  /** Counts per kind of everything in scope (the audit entry and Pi's summary). */
  counts: { kind: PiHealthKind; count: number }[];
  total: number;
}

export function healthPage(
  ctx: CapabilityContext,
  scope: HealthScope,
  after?: string,
  now = Date.now(),
): HealthPage {
  const all = detectAll(ctx, now).filter((item) => inScope(ctx, item, scope));
  const start = after ? all.findIndex((item) => item.id === after) + 1 : 0;
  const page = all.slice(start, start + PI_HEALTH_PAGE);
  return {
    items: page.map((item) => named(ctx, item)),
    more: Math.max(0, all.length - start - page.length),
    counts: PI_HEALTH_KINDS.map((kind) => ({
      kind,
      count: all.filter((item) => item.kind === kind).length,
    })).filter((entry) => entry.count > 0),
    total: all.length,
  };
}

/** The item with this id as it stands now (the repair's re-check), or undefined when it is gone. */
export function currentItem(ctx: CapabilityContext, id: string): DraftItem | undefined {
  return detectAll(ctx).find((item) => item.id === id);
}
