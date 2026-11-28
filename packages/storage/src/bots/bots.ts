import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Bot,
  BotCategorySchema,
  BotSchema,
  botNameKey,
  freeBotName,
  type Page,
  PageSchema,
} from "@pibot/protocol-base";
import { type CleanupManifest, deleteConversations } from "../database/cleanup.ts";
import { transaction } from "../database/database.ts";
import { readPage } from "../database/paging.ts";

const botColumns = `id, name, is_main AS isMain, avatar_shape AS avatarShape,
  avatar_color AS avatarColor, avatar_eyes AS avatarEyes, model_provider AS modelProvider,
  model_id AS modelId, thinking_level AS thinkingLevel, thinking_preference AS thinkingPreference, system_prompt AS systemPrompt,
  created_at AS createdAt, updated_at AS updatedAt, permission_overrides AS permissionOverrides,
  description, memory_mode AS memoryMode, memory_extraction AS memoryExtraction,
  archived_at AS archivedAt, category, image_mode AS imageMode,
  role_id AS roleId, role_version AS roleVersion, norms, quick_prompts AS quickPrompts,
  review_bot_id AS reviewBotId, auto_review AS autoReview, kind, default_video_model AS defaultVideoModel,
  (SELECT value FROM settings WHERE key='avatar:bot:' || bots.id) AS avatarImage`;

function parseBot(row: Record<string, unknown>): Bot {
  const {
    roleId,
    roleVersion,
    quickPrompts,
    norms,
    avatarImage,
    reviewBotId,
    autoReview,
    kind,
    defaultVideoModel,
    ...rest
  } = row;
  // Absent role fields stay absent so Bots made before roles existed keep their exact shape.
  return BotSchema.parse({
    ...rest,
    ...(typeof avatarImage === "string" ? { avatarImage: JSON.parse(avatarImage) } : {}),
    imageMode: row.imageMode ?? undefined,
    isMain: row.isMain === 1,
    memoryExtraction: row.memoryExtraction === 1,
    permissionOverrides: JSON.parse(String(row.permissionOverrides)),
    ...(typeof roleId === "string" && typeof roleVersion === "number"
      ? { role: { id: roleId, version: roleVersion } }
      : {}),
    ...(typeof norms === "string" && norms ? { norms } : {}),
    ...(typeof quickPrompts === "string" ? { quickPrompts: JSON.parse(quickPrompts) } : {}),
    // Absent unless set, so existing Bots keep their exact shape.
    ...(typeof reviewBotId === "string" ? { reviewBotId } : {}),
    ...(autoReview === 1 ? { autoReview: true } : {}),
    ...(kind === "agent" ? { kind } : {}),
    ...(typeof defaultVideoModel === "string"
      ? { defaultVideoModel: JSON.parse(defaultVideoModel) }
      : {}),
  });
}
function roleColumns(bot: Bot) {
  return [
    bot.role?.id ?? null,
    bot.role?.version ?? null,
    bot.norms ?? "",
    bot.quickPrompts?.length ? JSON.stringify(bot.quickPrompts) : null,
  ] as const;
}

export type CreateBot = Omit<Bot, "id" | "createdAt" | "updatedAt" | "category"> & {
  category?: Bot["category"];
};

/** A name the user chose is already used by another non-archived Bot. */
export class BotNameTakenError extends Error {
  constructor() {
    // Fixed text: the name itself stays out of messages and logs; the window already has it.
    super("bot_name_taken");
    this.name = "BotNameTakenError";
  }
}

/** Name keys of non-archived Bots, optionally leaving one Bot out (its own rename). */
export function activeBotNameKeys(db: DatabaseSync, exceptId?: string): Set<string> {
  const rows = db
    .prepare("SELECT name FROM bots WHERE archived_at IS NULL AND id IS NOT ?")
    .all(exceptId ?? null);
  return new Set(rows.map((row) => botNameKey(String(row.name))));
}

export class BotsRepo {
  constructor(private readonly db: DatabaseSync) {}

  private saveAvatar(id: string, image: Bot["avatarImage"]) {
    if (image == null) this.db.prepare("DELETE FROM settings WHERE key=?").run(`avatar:bot:${id}`);
    else
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(`avatar:bot:${id}`, JSON.stringify(image));
  }

  /**
   * Under the caller's write transaction: `exact` refuses a taken name (a name the user
   * typed), otherwise the first free 「name 2」, 「name 3」… is used (automatic names).
   */
  private uniqueName(name: string, mode: "exact" | "free", exceptId?: string): string {
    const taken = activeBotNameKeys(this.db, exceptId);
    const trimmed = name.trim();
    if (mode === "free") return freeBotName(trimmed, taken);
    if (taken.has(botNameKey(trimmed))) throw new BotNameTakenError();
    return trimmed;
  }

  list(): Bot[] {
    return this.db.prepare(`SELECT ${botColumns} FROM bots ORDER BY rowid`).all().map(parseBot);
  }

  /** Active Bot ids in stable order, paged: background maintenance must not load every Bot at once. */
  activeIds(before = ""): string[] {
    return this.db
      .prepare("SELECT id FROM bots WHERE archived_at IS NULL AND id>? ORDER BY id LIMIT 100")
      .all(before)
      .map((row) => String(row.id));
  }

  get(id: string): Bot | undefined {
    const row = this.db.prepare(`SELECT ${botColumns} FROM bots WHERE id = ?`).get(id);
    return row ? parseBot(row) : undefined;
  }
  getMain(): Bot | undefined {
    const row = this.db.prepare(`SELECT ${botColumns} FROM bots WHERE is_main=1 LIMIT 1`).get();
    return row ? parseBot(row) : undefined;
  }

  /**
   * `exactName` is for a name the user typed: a taken one throws BotNameTakenError. Without it
   * (persona, role, template, import and copy names) a taken name becomes 「name 2」….
   */
  create(input: CreateBot, options: { exactName?: boolean } = {}): Bot {
    return transaction(this.db, () => this.insert(input, options.exactName ? "exact" : "free"));
  }

  private insert(input: CreateBot, naming: "exact" | "free"): Bot {
    if (input.permissionOverrides) this.checkOverrides(input.permissionOverrides);
    const now = new Date().toISOString();
    const bot = BotSchema.parse({
      permissionOverrides: {},
      description: "",
      memoryMode: "auto",
      memoryExtraction: true,
      archivedAt: null,
      ...input,
      thinkingPreference:
        input.thinkingPreference === undefined ? input.thinkingLevel : input.thinkingPreference,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    this.checkCategory(bot);
    // Archived Bots keep whatever name they had; only active names must be unique.
    if (!bot.archivedAt) bot.name = BotSchema.shape.name.parse(this.uniqueName(bot.name, naming));
    this.db
      .prepare(`INSERT INTO bots (id, name, is_main, avatar_shape, avatar_color, avatar_eyes,
        model_provider, model_id, thinking_level, system_prompt, created_at, updated_at, permission_overrides, description, memory_mode, memory_extraction, archived_at, category, image_mode,
        role_id, role_version, norms, quick_prompts, google_compat_at, thinking_preference,
        review_bot_id, auto_review, kind, default_video_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        bot.id,
        bot.name,
        Number(bot.isMain),
        bot.avatarShape,
        bot.avatarColor,
        bot.avatarEyes,
        bot.modelProvider,
        bot.modelId,
        bot.thinkingLevel,
        bot.systemPrompt,
        now,
        now,
        JSON.stringify(bot.permissionOverrides ?? {}),
        bot.description ?? "",
        bot.memoryMode ?? "auto",
        Number(bot.memoryExtraction ?? true),
        bot.archivedAt ?? null,
        bot.category,
        bot.imageMode ?? null,
        ...roleColumns(bot),
        // Google compatibility mode is on for every new Bot; the user can still turn it off.
        now,
        bot.thinkingPreference ?? null,
        bot.reviewBotId ?? null,
        Number(bot.autoReview ?? false),
        bot.kind ?? null,
        bot.defaultVideoModel ? JSON.stringify(bot.defaultVideoModel) : null,
      );
    if (bot.avatarImage) this.saveAvatar(bot.id, bot.avatarImage);
    return bot;
  }

  /** A new `name` must be free (BotNameTakenError); a Bot coming back from the archive is renumbered. */
  update(id: string, patch: Partial<CreateBot>): Bot | undefined {
    const parsed = BotSchema.omit({ id: true, createdAt: true, updatedAt: true, category: true })
      .partial()
      .extend({ category: BotCategorySchema.optional() })
      .parse(patch);
    return transaction(this.db, () => this.write(id, parsed));
  }

  private write(id: string, parsed: Partial<CreateBot>): Bot | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    if (parsed.permissionOverrides) this.checkOverrides(parsed.permissionOverrides);
    if (current.isMain && (parsed.isMain === false || parsed.archivedAt))
      throw new TypeError("Cannot archive main Bot");
    const values = Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value !== undefined),
    );
    const bot = BotSchema.parse({ ...current, ...values, updatedAt: new Date().toISOString() });
    if (bot.category !== current.category) throw new TypeError("Bot category is immutable");
    if (bot.kind !== current.kind) throw new TypeError("Bot kind is immutable");
    this.checkCategory(bot);
    if (!bot.archivedAt) {
      // Un-archiving cannot ask anyone, so it takes the next free number like an import does.
      if (current.archivedAt) bot.name = this.uniqueName(bot.name, "free", id);
      else if (parsed.name !== undefined) bot.name = this.uniqueName(bot.name, "exact", id);
      BotSchema.shape.name.parse(bot.name);
    }
    this.db
      .prepare(`UPDATE bots SET name = ?, is_main = ?, avatar_shape = ?, avatar_color = ?,
        avatar_eyes = ?, model_provider = ?, model_id = ?, thinking_level = ?,
        system_prompt = ?, updated_at = ?, permission_overrides = ?, description = ?, memory_mode = ?, memory_extraction = ?, archived_at = ?, category = ?, image_mode = ?,
        role_id = ?, role_version = ?, norms = ?, quick_prompts = ?, thinking_preference = ?,
        review_bot_id = ?, auto_review = ?, default_video_model = ? WHERE id = ?`)
      .run(
        bot.name,
        Number(bot.isMain),
        bot.avatarShape,
        bot.avatarColor,
        bot.avatarEyes,
        bot.modelProvider,
        bot.modelId,
        bot.thinkingLevel,
        bot.systemPrompt,
        bot.updatedAt,
        JSON.stringify(bot.permissionOverrides ?? {}),
        bot.description ?? "",
        bot.memoryMode ?? "auto",
        Number(bot.memoryExtraction ?? true),
        bot.archivedAt ?? null,
        bot.category,
        bot.imageMode ?? null,
        ...roleColumns(bot),
        bot.thinkingPreference ?? null,
        bot.reviewBotId ?? null,
        Number(bot.autoReview ?? false),
        bot.defaultVideoModel ? JSON.stringify(bot.defaultVideoModel) : null,
        id,
      );
    if (parsed.avatarImage !== undefined) this.saveAvatar(id, parsed.avatarImage);
    return bot;
  }

  ensureMainBot(systemPrompt = ""): Bot {
    return transaction(this.db, () => {
      const row = this.db
        .prepare(`SELECT ${botColumns} FROM bots WHERE is_main = 1 ORDER BY rowid LIMIT 1`)
        .get();
      if (row) return parseBot(row);
      // Persona text belongs to brain; store only supplies the specified persistence defaults.
      return this.insert(
        {
          name: "Pi",
          isMain: true,
          avatarShape: "blob",
          avatarColor: "violet",
          avatarEyes: "marks",
          modelProvider: null,
          modelId: null,
          thinkingLevel: "off",
          thinkingPreference: null,
          systemPrompt,
        },
        "free",
      );
    });
  }
  private checkCategory(bot: Bot): void {
    if (
      bot.category === "image"
        ? bot.isMain || !bot.imageMode || !bot.modelProvider || !bot.modelId
        : bot.imageMode !== undefined
    )
      throw new TypeError("Invalid Bot category or image mode");
  }

  page(page: Page = {}, includeArchived = false): Bot[] {
    return readPage(
      this.db,
      "bots",
      botColumns,
      "created_at",
      page,
      includeArchived ? [] : [["archived_at", null]],
    ).map(parseBot);
  }
  archive(id: string): Bot | undefined {
    return transaction(this.db, () => {
      const bot = this.get(id);
      if (!bot) return undefined;
      if (bot.isMain) throw new TypeError("Cannot archive main Bot");
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE bots SET archived_at=COALESCE(archived_at,?),updated_at=? WHERE id=?")
        .run(now, now, id);
      this.db
        .prepare(
          "INSERT INTO sidebar_entries(conversation_key,bot_id,hidden_at) VALUES (?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET hidden_at=excluded.hidden_at",
        )
        .run(`dm:${id}`, id, now);
      return this.get(id);
    });
  }
  duplicate(id: string, avatarColor: string): Bot {
    const bot = this.get(id);
    if (!bot || bot.archivedAt) throw new TypeError("Unknown active Bot");
    if (!avatarColor || avatarColor === bot.avatarColor)
      throw new TypeError("Copy requires different color");
    const { id: _id, createdAt: _created, updatedAt: _updated, ...config } = bot;
    return this.create({
      ...config,
      isMain: false,
      archivedAt: null,
      avatarColor,
      permissionOverrides: bot.permissionOverrides,
    });
  }
  archivedBefore(before: string, page: Page = {}): Bot[] {
    const { before: cursor, limit = 50 } = PageSchema.parse(page);
    return this.db
      .prepare(
        `SELECT ${botColumns} FROM bots WHERE archived_at<=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`,
      )
      .all(before, cursor ?? null, cursor ?? null, limit)
      .map(parseBot);
  }
  purgeArchived(
    id: string,
    now = new Date(),
    options?: { userConfirmed: true },
  ): CleanupManifest | undefined {
    return transaction(this.db, () => {
      const b = this.get(id);
      if (!b) return undefined;
      if (
        b.isMain ||
        !b.archivedAt ||
        (!options?.userConfirmed && now.getTime() - Date.parse(b.archivedAt) < 30 * 86400000)
      )
        throw new TypeError("Bot retention not expired");
      if (this.db.prepare("SELECT 1 FROM group_members WHERE bot_id=? LIMIT 1").get(id))
        throw new TypeError("Archived Bot still belongs to group");
      const cleanup = deleteConversations(this.db, "bot_id", id);
      // Scoped memory ownership is cleaned by the Bot deletion trigger; user memory survives.
      this.db.prepare("DELETE FROM grants WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM bot_sessions WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM bot_workplace WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM working_folders WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM sidebar_entries WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM settings WHERE key=?").run(`topic:${id}`);
      this.saveAvatar(id, null);
      this.db.prepare("DELETE FROM bots WHERE id=?").run(id);
      return cleanup;
    });
  }
  private checkOverrides(overrides: NonNullable<Bot["permissionOverrides"]>): void {
    // Saved overrides are independent; only their schema and physical boundaries constrain them.
    BotSchema.shape.permissionOverrides.parse(overrides);
  }
  remove(id: string): boolean {
    const bot = this.get(id);
    if (!bot) return false;
    if (bot.isMain) throw new TypeError("Cannot delete main Bot");
    // Legacy internal removal only succeeds for unused records. User deletion must use archive().
    return transaction(this.db, () => {
      this.db.prepare("DELETE FROM sidebar_entries WHERE bot_id=?").run(id);
      this.saveAvatar(id, null);
      return this.db.prepare("DELETE FROM bots WHERE id = ?").run(id).changes > 0;
    });
  }
}
