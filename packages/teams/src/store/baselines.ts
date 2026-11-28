import type { DatabaseSync } from "node:sqlite";
import { IdSchema, LevelSchema, ThinkingLevelSchema } from "@pibot/protocol";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{16}$/);
const language = z.enum(["zh", "en"]);
const roleId = z.string().regex(/^[a-z0-9-]{1,64}$/);

/**
 * The built-in values a Bot held right after it was made from (or updated to) a role
 * version — after permissions were tightened and thinking fitted to the model, so "unchanged"
 * means unchanged by the user. Skills are tracked by id so a renamed folder still matches.
 */
export const BotBaselineSchema = z.strictObject({
  language,
  thinkingLevel: ThinkingLevelSchema,
  permissionOverrides: z.record(z.string().max(40), LevelSchema),
  norms: hash,
  skills: z
    .array(
      z.strictObject({
        // null: part of that version but removed by the user, so it is not brought back.
        skillId: IdSchema.nullable(),
        folder: z.string().max(64),
        fingerprint: hash,
        /** `pibot-version` of the copy as installed (absent before skills had versions, or unversioned). */
        version: z.number().int().positive().optional(),
      }),
    )
    .max(100),
});
export const GroupBaselineSchema = z.strictObject({
  language,
  coordinatorBotId: IdSchema.optional(),
  announcement: hash,
  autoRoundLimit: z.number().int().min(1).max(10),
  members: z.array(roleId).max(6),
  quickStarts: hash,
});
export type BotBaseline = z.infer<typeof BotBaselineSchema>;
export type GroupBaseline = z.infer<typeof GroupBaselineSchema>;
export interface Stored<T> {
  sourceId: string;
  version: number;
  /** Absent when the row only remembers a「保留当前」answer (no recognised built-in values). */
  baseline?: T;
  dismissedVersion: number | null;
}

/** Rows written only by the built-in create and update paths (repository pattern, no raw SQL elsewhere). */
export class BuiltinBaselinesRepo {
  constructor(private readonly db: DatabaseSync) {}
  private read<T>(table: string, key: string, source: string, id: string, schema: z.ZodType<T>) {
    const row = this.db
      .prepare(
        `SELECT ${source} AS sourceId, version, baseline, dismissed_version AS dismissed FROM ${table} WHERE ${key}=?`,
      )
      .get(IdSchema.parse(id));
    if (!row) return undefined;
    // A baseline this version cannot read counts as "no provenance": treated as changed.
    const parsed = schema.safeParse(JSON.parse(String(row.baseline)));
    return {
      sourceId: String(row.sourceId),
      version: Number(row.version),
      ...(parsed.success ? { baseline: parsed.data } : {}),
      dismissedVersion: row.dismissed === null ? null : Number(row.dismissed),
    } satisfies Stored<T>;
  }
  bot(botId: string): Stored<BotBaseline> | undefined {
    return this.read("builtin_bot_baselines", "bot_id", "role_id", botId, BotBaselineSchema);
  }
  group(groupId: string): Stored<GroupBaseline> | undefined {
    return this.read(
      "builtin_group_baselines",
      "group_id",
      "template_id",
      groupId,
      GroupBaselineSchema,
    );
  }
  hasActiveGroup(templateId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM builtin_group_baselines b JOIN groups g ON g.id=b.group_id
       WHERE b.template_id=? AND g.archived_at IS NULL LIMIT 1`,
      )
      .get(templateId);
  }
  setBot(botId: string, roleIdValue: string, version: number, baseline: BotBaseline) {
    this.db
      .prepare(
        `INSERT INTO builtin_bot_baselines(bot_id,role_id,version,baseline,dismissed_version,updated_at)
         VALUES (?,?,?,?,NULL,?) ON CONFLICT(bot_id) DO UPDATE SET role_id=excluded.role_id,
         version=excluded.version,baseline=excluded.baseline,dismissed_version=NULL,updated_at=excluded.updated_at`,
      )
      .run(
        IdSchema.parse(botId),
        roleId.parse(roleIdValue),
        version,
        JSON.stringify(BotBaselineSchema.parse(baseline)),
        new Date().toISOString(),
      );
  }
  setGroup(groupId: string, templateId: string, version: number, baseline: GroupBaseline) {
    this.db
      .prepare(
        `INSERT INTO builtin_group_baselines(group_id,template_id,version,baseline,dismissed_version,updated_at)
         VALUES (?,?,?,?,NULL,?) ON CONFLICT(group_id) DO UPDATE SET template_id=excluded.template_id,
         version=excluded.version,baseline=excluded.baseline,dismissed_version=NULL,updated_at=excluded.updated_at`,
      )
      .run(
        IdSchema.parse(groupId),
        roleId.parse(templateId),
        version,
        JSON.stringify(GroupBaselineSchema.parse(baseline)),
        new Date().toISOString(),
      );
  }
  /**
   * 「保留当前」: remembered per Bot / group until a newer version ships. Without a baseline row
   * (made before provenance existed) the row is created with the recognised values, if any.
   */
  dismissBot(
    botId: string,
    version: number,
    fallback: Omit<Stored<BotBaseline>, "dismissedVersion">,
  ) {
    this.db
      .prepare(
        `INSERT INTO builtin_bot_baselines(bot_id,role_id,version,baseline,dismissed_version,updated_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET dismissed_version=excluded.dismissed_version,
         updated_at=excluded.updated_at`,
      )
      .run(
        IdSchema.parse(botId),
        roleId.parse(fallback.sourceId),
        fallback.version,
        fallback.baseline ? JSON.stringify(BotBaselineSchema.parse(fallback.baseline)) : "{}",
        version,
        new Date().toISOString(),
      );
  }
  dismissGroup(
    groupId: string,
    version: number,
    fallback: Omit<Stored<GroupBaseline>, "dismissedVersion">,
  ) {
    this.db
      .prepare(
        `INSERT INTO builtin_group_baselines(group_id,template_id,version,baseline,dismissed_version,updated_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET dismissed_version=excluded.dismissed_version,
         updated_at=excluded.updated_at`,
      )
      .run(
        IdSchema.parse(groupId),
        roleId.parse(fallback.sourceId),
        fallback.version,
        fallback.baseline ? JSON.stringify(GroupBaselineSchema.parse(fallback.baseline)) : "{}",
        version,
        new Date().toISOString(),
      );
  }
}
