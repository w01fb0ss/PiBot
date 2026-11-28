import { IdSchema, KnowledgeVaultSchema } from "@pibot/protocol-base";
import { z } from "zod";

// Knowledge sources are references to something the person already keeps elsewhere
// (an Obsidian vault folder, a Notion workspace). Only the reference is stored here, never note
// content or an index copy, so these methods carry metadata and assignments and nothing else.
const time = z.iso.datetime();
/** Display name shown on the Connections page; the person can rename a source. */
export const KnowledgeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("\0"));

/** Bot/group targets plus an optional all-Bot/group mode for sources shared with everyone. */
export const KnowledgeTargetsSchema = z.strictObject({
  /** `false` is the compatibility default for sources created by older versions. */
  all: z.boolean().default(false),
  bots: z.array(IdSchema).max(500),
  groups: z.array(IdSchema).max(500),
});
export type KnowledgeTargets = z.output<typeof KnowledgeTargetsSchema>;

export const KnowledgeKindSchema = z.enum(["obsidian", "notion", "folder"]);
export type KnowledgeKind = z.output<typeof KnowledgeKindSchema>;

const LocalKnowledgeConfigFields = {
  path: z.string().min(1).max(32768),
  // Recorded when the folder is added, in execution's own encoding (see
  // `@pibot/execution` file-identity), so a folder that was moved or replaced fails closed
  // instead of silently searching whichever folder now sits at the same path. Absent on
  // records created before that, which require the user to select the folder again.
  device: z.string().min(1).max(64).nullish(),
  inode: z.string().min(1).max(64).nullish(),
};

/**
 * Stored configuration. Local folder paths are canonical folders the host dialog returned; the
 * Notion side only points at the connector that holds its OAuth credential. Kept in one place so
 * the store, the RPC results and the later readers share exactly one shape.
 */
const NotionWriteActionSchema = z.enum(["create", "update", "delete"]);
export type NotionWriteAction = z.output<typeof NotionWriteActionSchema>;
const NotionWriteActionsSchema = z.array(NotionWriteActionSchema).max(3);

export const KnowledgeConfigSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("obsidian"), ...LocalKnowledgeConfigFields }),
  z.strictObject({ kind: z.literal("folder"), ...LocalKnowledgeConfigFields }),
  z.strictObject({
    kind: z.literal("notion"),
    connectorId: IdSchema,
    writeActions: NotionWriteActionsSchema.optional(),
  }),
]);
export type KnowledgeConfig = z.output<typeof KnowledgeConfigSchema>;

export const KnowledgeFolderSummarySchema = z.strictObject({
  status: z.enum(["ok", "changed", "denied", "unreadable", "timeout"]),
  supported: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  scannedPdf: z.number().int().nonnegative().default(0),
  skippedLarge: z.number().int().nonnegative().default(0),
  skippedUnreadable: z.number().int().nonnegative().default(0),
  unexamined: z.number().int().nonnegative().default(0),
  byKind: z.strictObject({
    markdown: z.number().int().nonnegative(),
    text: z.number().int().nonnegative(),
    pdf: z.number().int().nonnegative(),
    word: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
});
export type KnowledgeFolderSummary = z.output<typeof KnowledgeFolderSummarySchema>;

export const KnowledgeNotionWriteToolsSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  enabled: z.number().int().nonnegative(),
  readOnlyMode: z.boolean().default(false),
  availableWrites: NotionWriteActionsSchema,
  missingWrites: NotionWriteActionsSchema,
  readAvailable: z.boolean(),
  readToolToEnable: z.string().optional(),
});
export type KnowledgeNotionWriteTools = z.output<typeof KnowledgeNotionWriteToolsSchema>;

export const KnowledgeSourceSchema = z.strictObject({
  id: IdSchema,
  kind: KnowledgeKindSchema,
  name: KnowledgeNameSchema,
  targets: KnowledgeTargetsSchema,
  writable: z.boolean().default(false),
  createdAt: time,
  updatedAt: time,
  /** Written by the search / read tools; null until first use. */
  lastUsedAt: time.nullable(),
});
export type KnowledgeSource = z.output<typeof KnowledgeSourceSchema>;

export const KnowledgeRepointRecipientsSchema = z
  .array(
    z.strictObject({
      kind: z.enum(["bot", "group"]),
      name: z.string().min(1).nullable(),
      archived: z.boolean(),
    }),
  )
  .max(1000);

const KnowledgeRepointResultSchema = z.strictObject({
  source: KnowledgeSourceSchema.nullable(),
  conflict: KnowledgeSourceSchema.pick({ id: true, name: true }).optional(),
  preview: z
    .strictObject({
      token: IdSchema,
      path: LocalKnowledgeConfigFields.path,
      source: KnowledgeSourceSchema,
      recipients: KnowledgeRepointRecipientsSchema,
    })
    .optional(),
});

/**
 * Which Notion account a source is connected as, read with Notion's `notion-get-self` tool
 * through the connection's ordinary call channel. Only display text is kept — no token or id.
 * `unavailable` explains why it could not be read (a workspace-owned connection may not offer the
 * tool); the connection itself keeps working either way.
 */
export const KnowledgeAccountSchema = z.strictObject({
  status: z.enum(["ok", "unavailable"]),
  reason: z.enum(["no_bot", "signin", "tool_missing", "denied", "failed", "unreadable"]).nullable(),
  workspace: z.string().max(200).nullable(),
  name: z.string().max(200).nullable(),
  email: z.string().max(320).nullable(),
  checkedAt: time,
});
export type KnowledgeAccount = z.output<typeof KnowledgeAccountSchema>;

export const KnowledgePageSchema = z.strictObject({
  before: IdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

/**
 * One vault the host found on this computer, plus whether a source already points at it.
 * `added` is decided by the brain (canonical path), so the tab can skip vaults that are in place.
 */
export const KnowledgeDetectedVaultSchema = KnowledgeVaultSchema.extend({ added: z.boolean() });
export type KnowledgeDetectedVault = z.output<typeof KnowledgeDetectedVaultSchema>;

/**
 * A read-only look at this computer — Obsidian's own vault list and whether the Notion
 * desktop app is installed. No note, page or workspace content is read, and a platform the host
 * cannot inspect answers the empty shape instead of an error.
 */
export const KnowledgeDetectResultSchema = z.strictObject({
  obsidian: z.strictObject({
    installed: z.boolean(),
    vaults: z.array(KnowledgeDetectedVaultSchema).max(50),
  }),
  notion: z.strictObject({ installed: z.boolean() }),
});
export type KnowledgeDetectResult = z.output<typeof KnowledgeDetectResultSchema>;

/**
 * The person clicked an Obsidian reference inside one reply. Only the message and the
 * href that was rendered travel: the Bot, the group, the vault and the note are derived from the
 * stored message and the current assignments, never taken from the renderer.
 */
export const KnowledgeOpenReferenceSchema = z.strictObject({
  messageId: IdSchema,
  href: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
});
export type KnowledgeOpenReference = z.output<typeof KnowledgeOpenReferenceSchema>;

export const KnowledgeMethods = {
  "knowledge.detect": { params: z.strictObject({}), result: KnowledgeDetectResultSchema },
  "knowledge.list": {
    params: KnowledgePageSchema,
    result: z.strictObject({
      items: z.array(KnowledgeSourceSchema).max(100),
      nextBefore: IdSchema.nullable(),
    }),
  },
  "knowledge.get": {
    params: z.strictObject({ id: IdSchema }),
    result: z.strictObject({
      source: KnowledgeSourceSchema,
      origin: KnowledgeConfigSchema,
      notionWriteTools: KnowledgeNotionWriteToolsSchema.optional(),
    }),
  },
  /** Read-only summary of a local folder's recognized vs. unsupported files and identity health. */
  "knowledge.inspect": {
    params: z.strictObject({ id: IdSchema }),
    result: z.strictObject({ summary: KnowledgeFolderSummarySchema.nullable() }),
  },
  /**
   * The host owns the folder dialog: the renderer never hands the brain a read root, so adding a
   * local folder is one user action rather than a path parameter. null means the dialog was cancelled.
   */
  "knowledge.addObsidian": {
    params: z.strictObject({
      /**
       * A vault the host already found by reading Obsidian's own list, echoed back so the
       * tab can add it in one click. The brain re-runs that detection before accepting it, so this
       * is never "any folder the renderer names"; absent when the person picks in the dialog.
       */
      detectedPath: z.string().min(1).max(32768).optional(),
      /** Distinguishes an Obsidian vault from a general local document folder. */
      kind: z.enum(["obsidian", "folder"]).optional(),
      /** Optional initial Bot/group assignments chosen explicitly in the add confirmation step. */
      targets: KnowledgeTargetsSchema.optional(),
    }),
    result: z.strictObject({
      source: KnowledgeSourceSchema.nullable(),
      alreadyAdded: z.literal(true).optional(),
    }),
  },
  /** Re-selects a local source's folder via the OS dialog, preserving name and Bot assignments. */
  "knowledge.repoint": {
    params: z.strictObject({ id: IdSchema, confirmationToken: IdSchema.optional() }),
    result: KnowledgeRepointResultSchema,
  },
  /**
   * Identifies the local library to open in Settings for a citation that needs reselection.
   * Derives the source id from the stored reply and current assignment.
   */
  "knowledge.repointReference": {
    params: KnowledgeOpenReferenceSchema,
    result: z.strictObject({ sourceId: IdSchema }),
  },
  /** Creates the remote MCP connector and returns it, so the UI can run connectors.authorize. */
  "knowledge.addNotion": {
    params: z.strictObject({
      /** Optional initial Bot/group assignments chosen explicitly in the add confirmation step. */
      targets: KnowledgeTargetsSchema.optional(),
    }),
    result: z.strictObject({ source: KnowledgeSourceSchema, connectorId: IdSchema }),
  },
  /**
   * The Notion account of a source. Answers the stored account; reads it from Notion when none
   * is stored or when `refresh` is set (after sign-in, 重试). null for a non-Notion source.
   */
  "knowledge.account": {
    params: z.strictObject({ id: IdSchema, refresh: z.boolean().default(false) }),
    result: z.strictObject({ account: KnowledgeAccountSchema.nullable() }),
  },
  "knowledge.update": {
    params: z.strictObject({
      id: IdSchema,
      name: KnowledgeNameSchema,
      targets: KnowledgeTargetsSchema,
      writable: z.boolean().optional(),
      notionWriteActions: NotionWriteActionsSchema.optional(),
      notionConnectorRevision: z.number().int().nonnegative().optional(),
    }),
    result: KnowledgeSourceSchema,
  },
  /** Removes the record and its assignments only; the vault and the Notion workspace stay. */
  "knowledge.remove": {
    params: z.strictObject({ id: IdSchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  /**
   * Opens a note in the person's own Obsidian through a host port that rebuilds the URI
   * from verified identities, or falls back to revealing the verified local file in the system
   * file manager when Obsidian cannot resolve the folder.
   */
  "knowledge.openReference": {
    params: KnowledgeOpenReferenceSchema,
    result: z.strictObject({
      opened: z.literal(true),
      method: z.enum(["obsidian", "revealed"]).optional(),
      fallbackReason: z
        .enum(["obsidian_unavailable", "duplicate_vault", "not_in_obsidian", "document_file"])
        .optional(),
    }),
  },
} as const;

export const KnowledgeEvents = {
  "knowledge.changed": z.strictObject({
    id: IdSchema,
    reason: z.enum(["added", "updated", "removed"]),
  }),
} as const;
