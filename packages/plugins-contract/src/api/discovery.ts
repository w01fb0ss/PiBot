import { IdSchema, SkillImportDetailsSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { ConnectorMethods } from "./methods.ts";

// Read-only discovery of skills / MCP servers / plugins that other AI tools on
// this computer already have, and bringing them over through the existing import paths. Only
// names, one-line descriptions and the *names* of required secrets cross to the renderer; file
// paths, command arguments that look like credentials and every secret value stay in the brain.
const time = z.iso.datetime();
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes("\0"));

export const DiscoverySourceIdSchema = z.enum(["claude-code", "codex", "cursor", "pi", "opencode"]);
export type DiscoverySourceId = z.output<typeof DiscoverySourceIdSchema>;
export const DiscoveredItemKindSchema = z.enum(["skill", "mcp", "plugin"]);
export type DiscoveredItemKind = z.output<typeof DiscoveredItemKindSchema>;
/** Opaque handle of one scanned item; the brain maps it back to the file it came from. */
export const DiscoveredItemKeySchema = z
  .string()
  .regex(/^(?:claude-code|codex|cursor|pi|opencode):(?:skill|mcp|plugin):[a-f0-9]{24}$/);
export const DiscoverySecretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/);
export const DiscoveredItemSchema = z.strictObject({
  key: DiscoveredItemKeySchema,
  kind: DiscoveredItemKindSchema,
  name: text(200).pipe(z.string().min(1)),
  /** SKILL.md description, plugin manifest description, or an MCP command / host summary. */
  description: text(1024),
  /**
   * Keys this item uses, by name only. stored: the configuration has the value written in, and
   * bringing it over saves it in Pi Bot's keychain; needed: the configuration reads it from the
   * environment. A saved key with the same name can be selected during setup.
   */
  secrets: z
    .array(
      z.strictObject({
        name: DiscoverySecretNameSchema,
        kind: z.enum(["stored", "needed"]),
        existing: z.boolean(),
      }),
    )
    .max(64),
  /**
   * same_name: Pi Bot already has something with this name (bringing it over saves a "name 2");
   * imported: this exact item was brought over before.
   */
  conflict: z.enum(["none", "same_name", "imported"]),
  /**
   * Plugins only: what the package carries, so the MCP tab offers the ones with servers and the
   * 技能 tab the ones with skills (maintainers 2026-10-31).
   */
  contains: z.strictObject({ mcp: z.boolean(), skills: z.boolean() }).optional(),
  /** Plugins only: requires userConfig settings before importing, so bring-over routes to setup. */
  needsSetup: z.boolean().optional(),
  workingDirectory: text(4096).pipe(z.string().min(1)).optional(),
  registrySites: z
    .array(text(253).pipe(z.string().min(1)))
    .max(64)
    .optional(),
});
export type DiscoveredItem = z.output<typeof DiscoveredItemSchema>;
export const DiscoverySourceSchema = z.strictObject({
  id: DiscoverySourceIdSchema,
  name: text(64).pipe(z.string().min(1)),
  /** The tool's configuration folder exists on this computer. */
  installed: z.boolean(),
  items: z.array(DiscoveredItemSchema).max(500),
});
export type DiscoverySource = z.output<typeof DiscoverySourceSchema>;
export const DiscoveryResultSchema = z.strictObject({
  /** Null until the user agreed and a scan ran. */
  scannedAt: time.nullable(),
  consent: z.boolean(),
  sources: z.array(DiscoverySourceSchema).max(5),
});
export type DiscoveryResult = z.output<typeof DiscoveryResultSchema>;
export const BringOverReasonSchema = z.enum([
  /** Not in the latest scan (rescan first). */
  "unknown_item",
  "no_consent",
  /** The source file changed or disappeared since the scan. */
  "changed",
  /** This kind cannot be brought over from that tool, or the host cannot read it here. */
  "unsupported",
  /** The configuration or package failed Pi Bot's import validation. */
  "invalid",
  /** The package holds a link or file the import refuses for safety. */
  "unsafe",
  "too_large",
  /** Open the shared import preview to choose credentials or fill in settings. */
  "needs_setup",
  /** A stored secret of the same name already holds a different value. */
  "secret_conflict",
  "name_exists",
  "busy",
  "failed",
]);
export type BringOverReason = z.output<typeof BringOverReasonSchema>;
export const BringOverResultSchema = z.strictObject({
  key: DiscoveredItemKeySchema,
  outcome: z.enum(["imported", "skipped", "failed"]),
  reason: BringOverReasonSchema.optional(),
  /** The name it was saved under ("name 2" after a clash). */
  name: text(200).optional(),
  /** The installed plugin/MCP record created by this bring-over item, when applicable. */
  installationId: IdSchema.optional(),
});
export type BringOverResult = z.output<typeof BringOverResultSchema>;
/**
 * Skills another tool keeps are read into the same bounded preview a picked folder gets
 * (size, licence, compatibility, assignment) before anything is written. The renderer imports the
 * returned previewId through `skills.import` and drops it through `skills.cancelPreview`, so a
 * bring-over is no longer a silent create behind the person's back.
 */
export const BringOverPreviewSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    key: DiscoveredItemKeySchema,
    outcome: z.literal("previewed"),
    preview: SkillImportDetailsSchema,
  }),
  z.strictObject({
    key: DiscoveredItemKeySchema,
    outcome: z.literal("failed"),
    reason: BringOverReasonSchema,
  }),
]);
export type BringOverPreview = z.output<typeof BringOverPreviewSchema>;

/**
 * 访问令牌: a token a connection carries itself (typed when connecting or brought over from
 * another AI tool). Only whether a value is stored crosses to the renderer; replacing it goes
 * through `connectors.authorize`, so its Bots are the connection's Bots.
 */
export const ConnectionTokenSchema = z.strictObject({
  connectorId: IdSchema,
  connectorName: text(200),
  connectorRevision: z.number().int().positive().safe(),
  installationId: IdSchema,
  originTool: DiscoverySourceIdSchema.optional(),
  /** The name the token had in the other tool (or TOKEN for one typed when connecting). */
  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  hasValue: z.boolean(),
});
export type ConnectionToken = z.output<typeof ConnectionTokenSchema>;
export const DiscoveryMethods = {
  /** Without consent this returns `consent: false` and reads no file. */
  "connections.discover": {
    params: z.strictObject({}),
    result: DiscoveryResultSchema,
  },
  "connections.discoverConsent": {
    params: z.strictObject({ allow: z.boolean() }),
    result: z.strictObject({ consent: z.boolean() }),
  },
  "connections.bringOver": {
    params: z.strictObject({
      keys: z
        .array(DiscoveredItemKeySchema)
        .min(1)
        .max(100)
        .refine((keys) => new Set(keys).size === keys.length, "Duplicate keys"),
      /**
       * Lets the caller stop and then wait for this batch (`connections.cancelBringOver`).
       * A local abort only proves the stop frame was sent, not that copies or rollbacks finished.
       */
      batchId: IdSchema.optional(),
    }),
    result: z.strictObject({ results: z.array(BringOverResultSchema).max(100) }),
  },
  /** Resolves once the batch has stopped, so a closed dialog hides no live write. */
  "connections.cancelBringOver": {
    params: z.strictObject({ batchId: IdSchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  /** The preview step of a bring-over; nothing is written until the person confirms. */
  "connections.previewBringOver": {
    params: z.strictObject({
      /**
       * Known before dispatch, so a dialog that stops while the first preview is still
       * being made can wait for this batch through `connections.cancelBringOver`.
       */
      batchId: IdSchema.optional(),
      keys: z
        .array(DiscoveredItemKeySchema)
        .min(1)
        .max(100)
        .refine((keys) => new Set(keys).size === keys.length, "Duplicate keys"),
    }),
    result: z.strictObject({ results: z.array(BringOverPreviewSchema).max(100) }),
  },
  /** Turns a discovered plugin folder into a short-lived import selection so setup can run. */
  "connections.adoptBringOver": {
    params: z.strictObject({ key: DiscoveredItemKeySchema }),
    result: z.strictObject({ selectionId: IdSchema }),
  },
  "connections.previewSetup": {
    params: z.strictObject({ key: DiscoveredItemKeySchema }),
    result: ConnectorMethods["plugins.previewImport"].result,
  },
  "connections.tokens": {
    params: z.strictObject({}),
    result: z.strictObject({ items: z.array(ConnectionTokenSchema).max(200) }),
  },
} as const;
