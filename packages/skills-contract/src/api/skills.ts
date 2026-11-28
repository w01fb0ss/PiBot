import {
  DomainSchema,
  IdSchema,
  PageSchema,
  SecretNameSchema,
  SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
  SkillBuiltinKeySchema,
  SkillCompatibilityReportSchema,
  SkillDescriptionSchema,
  SkillDocumentBaseSchema,
  SkillDocumentPatchSchema,
  SkillDocumentSchema,
  type SkillImportDetails,
  SkillImportDetailsSchema,
  type SkillLabels,
  SkillLabelsSchema,
  SkillManagedRuntimeSchema,
  SkillNameSchema,
  SkillPackageFileSchema,
  SkillPackagePathSchema,
  SkillPackageSummarySchema,
  SkillPackageWritePathSchema,
  SkillProposalSchema,
  SkillRuntimeRequirementSchema,
  SkillSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

export const SKILL_IMPORT_PREVIEW_TEXT_MAX_BYTES = 5 * 1024 * 1024;
export const SKILL_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const SKILL_DROP_MAX_BYTES = SKILL_ATTACHMENT_MAX_BYTES;

export type { SkillImportDetails };
// The import payload lives in protocol-base so the plugins contract can describe the same
// bring-over preview without one capability contract depending on another.
export { SkillImportDetailsSchema, SkillPackageSummarySchema, SkillRuntimeRequirementSchema };

export const SkillRuntimeStateSchema = z.enum([
  "not_required",
  "not_prepared",
  "preparing",
  "ready",
  "failed",
  "needs_prepare",
]);
export const SkillRuntimeStatusSchema = z.strictObject({
  skillId: IdSchema,
  state: SkillRuntimeStateSchema,
  requirements: z.array(SkillRuntimeRequirementSchema).max(2),
  runtime: SkillManagedRuntimeSchema.optional(),
  reviewedPackages: z.array(z.string().min(1).max(500)).max(1000).optional(),
  resolvesPythonPackages: z.literal(true).optional(),
  networkDomains: z
    .strictObject({
      primary: z.array(DomainSchema).min(1).max(16),
      withMirror: z.array(DomainSchema).min(1).max(16).optional(),
    })
    .optional(),
  nativeModules: z.array(z.string().max(200)).max(100),
  interpreter: z
    .strictObject({ command: z.string().max(300), version: z.string().max(100) })
    .nullable(),
  requiresUnisolatedConfirmation: z.literal(true).optional(),
  managedPython: z
    .strictObject({
      uvVersion: z.string().max(32),
      uvBytes: z.number().int().positive(),
      pythonRequest: z.string().max(100),
    })
    .optional(),
  /** Directory name under `<dataDir>/skill-envs`; null until an environment is planned. */
  envId: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .nullable(),
  /** Digests everything the approval card shows; prepare refuses a plan the UI no longer shows. */
  planHash: z.string().max(64).nullable(),
  packages: z.number().int().nonnegative().max(100_000),
  bytes: z.number().int().nonnegative().safe().nullable(),
  /** Structured reason code for `failed` (never a raw command line or its output). */
  reason: z.string().max(64).nullable(),
  logPath: z.string().max(4096).nullable(),
  progress: z
    .strictObject({
      phase: z.enum(["create", "dependencies", "verify"]),
      done: z.number().int().nonnegative().max(100_000),
      total: z.number().int().nonnegative().max(100_000),
    })
    .nullable(),
});
export type SkillRuntimeStatus = z.infer<typeof SkillRuntimeStatusSchema>;
/** Interpreters a package's files need; a change between versions needs a new environment. */
export const SkillRuntimeTagSchema = z.enum(["python", "node", "bash", "powershell"]);
/** Bounded SKILL.md texts: a comparison frame, not a copy of the package. */
export const SKILL_UPDATE_TEXT_MAX_CHARS = 20_000;
/**
 * What changed between the referenced package and the newer source content. Counts alone do not
 * say whether the instructions changed, so both rendered SKILL.md texts travel (bounded).
 */
export const SkillUpdateSummarySchema = z.strictObject({
  added: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_FILES),
  modified: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_FILES),
  removed: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_FILES),
  filesBefore: z.number().int().min(1).max(SKILL_IMPORT_MAX_FILES),
  filesAfter: z.number().int().min(1).max(SKILL_IMPORT_MAX_FILES),
  skillTextBefore: z.string().max(SKILL_UPDATE_TEXT_MAX_CHARS),
  skillTextAfter: z.string().max(SKILL_UPDATE_TEXT_MAX_CHARS),
  skillTextTruncated: z.boolean(),
  runtimeBefore: z.array(SkillRuntimeTagSchema).max(4),
  runtimeAfter: z.array(SkillRuntimeTagSchema).max(4),
  /** Runtime tags or dependency files differ: the prepared environment cannot be reused. */
  runtimeNeedsPreparation: z.boolean(),
});
export type SkillUpdateSummary = z.output<typeof SkillUpdateSummarySchema>;
/** A newer package a check downloaded and published; kept while the user decides. */
export const SkillUpdatePendingSchema = z.strictObject({
  packageId: z.string().regex(/^[0-9a-f]{16}$/),
  /** Source version (SKILL.md `metadata.version` or the commit); null when the source has none. */
  version: z.string().min(1).max(200).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.iso.datetime(),
  summary: SkillUpdateSummarySchema,
});
export type SkillUpdatePending = z.output<typeof SkillUpdatePendingSchema>;
/**
 * The package this skill referenced before its last update. A null packageId is the skill's own
 * folder (an edited or locally imported copy), which stays on disk and can be switched back to.
 */
export const SkillUpdatePreviousSchema = z.strictObject({
  packageId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .nullable(),
  version: z.string().min(1).max(200).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.iso.datetime(),
});
export type SkillUpdatePrevious = z.output<typeof SkillUpdatePreviousSchema>;
/** One imported skill's source version and update / rollback state, for the detail panel. */
export const SkillUpdateStateSchema = z.strictObject({
  sourceVersion: z.string().min(1).max(200).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  importedAt: z.iso.datetime(),
  checkedAt: z.iso.datetime().nullable(),
  /** Set by a check that found new content; applying switches the reference to this package. */
  available: SkillUpdatePendingSchema.nullable(),
  /** Set after an update, until the previous package is cleaned up (7 days) or rolled back. */
  rollback: SkillUpdatePreviousSchema.nullable(),
});
export type SkillUpdateState = z.output<typeof SkillUpdateStateSchema>;

const ok = z.strictObject({ ok: z.literal(true) });
/**
 * K2: one change to a skill's supporting files, saved together with SKILL.md in one atomic write.
 * Uploaded bytes stay in brain (`skills.pickFiles`); the editor only names them.
 */
export const SkillFileChangeSchema = z.union([
  z.strictObject({
    path: SkillPackageWritePathSchema,
    text: z.string().max(SKILL_IMPORT_FILE_MAX_BYTES),
  }),
  z.strictObject({
    path: SkillPackageWritePathSchema,
    upload: z.strictObject({ uploadId: IdSchema, path: SkillPackagePathSchema }),
  }),
  z.strictObject({ path: SkillPackagePathSchema, remove: z.literal(true) }),
]);
export type SkillFileChange = z.infer<typeof SkillFileChangeSchema>;
// Every file of a full package removed and as many added is the largest meaningful edit.
const fileChanges = z
  .array(SkillFileChangeSchema)
  .max(SKILL_IMPORT_MAX_FILES * 2)
  .refine(
    (changes) => new Set(changes.map((c) => c.path.toLowerCase())).size === changes.length,
    "Duplicate file",
  );
const editableFile = SkillPackageFileSchema.extend({ text: z.boolean() });
/**
 * One row of the connections page's skill list — every skill the Bots and groups already
 * have, plus the ones brought over from other AI tools. Copies with the same name (ignoring case)
 * and the same description are one row; who has an enabled copy is listed by id.
 */
export const SkillCatalogItemSchema = z.strictObject({
  key: z.string().regex(/^[a-f0-9]{32}$/),
  /** A representative copy (an enabled one when there is one): its detail opens from here. */
  skillId: IdSchema,
  botId: IdSchema,
  groupId: IdSchema.optional(),
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  /** builtin: a role / group method; otherwise the representative copy's source. */
  origin: z.enum(["builtin", "taught", "proposed", "team", "imported"]),
  /** The built-in method this row copies; set with `builtinLabels` so the row reads in the UI language. */
  builtinKey: SkillBuiltinKeySchema.optional(),
  /** The built-in method's labels in both languages; display only. */
  builtinLabels: SkillLabelsSchema.optional(),
  /** The other AI tool it was brought over from. */
  originTool: z.enum(["claude-code", "codex", "cursor", "pi", "opencode"]).optional(),
  /** Bots that have an enabled copy of their own. */
  bots: z.array(IdSchema).max(500),
  /** Groups in which some member has an enabled copy. */
  groups: z.array(IdSchema).max(500),
  /**
   * Every copy in the row, switched off ones included: copies are separate skills, so editing
   * the representative must say when others stay unchanged.
   */
  copies: z.number().int().min(1).max(500),
});
export type SkillCatalogItem = z.output<typeof SkillCatalogItemSchema>;
/**
 * A built-in skill ships in both languages, while a Bot's copy keeps the labels of the
 * language it was installed in. Lists and details show the interface language; every other skill
 * has one set of labels and is returned unchanged.
 */
export function skillLabels(
  skill: { name: string; description: string; builtinLabels?: SkillLabels },
  language: "zh" | "en",
): { name: string; description: string } {
  return skill.builtinLabels?.[language] ?? { name: skill.name, description: skill.description };
}
const skillSecretBinding = z.strictObject({
  variable: SecretNameSchema,
  secretName: SecretNameSchema.nullable(),
});
const skillSecretBindings = z
  .array(skillSecretBinding)
  .max(64)
  .refine((bindings) => new Set(bindings.map(({ variable }) => variable)).size === bindings.length);
const skillId = z.strictObject({ skillId: IdSchema, groupId: IdSchema.optional() });
export const SKILL_PACKAGE_VERIFY_TIMEOUT_MS = 5 * 60_000;
const SKILL_PACKAGE_READ_RPC_TIMEOUT_MS = 2 * SKILL_PACKAGE_VERIFY_TIMEOUT_MS;

const runtimeTarget = z.strictObject({
  groupId: IdSchema.optional(),
  skillId: IdSchema,
  runtime: SkillManagedRuntimeSchema.optional(),
});

export const SkillMethods = {
  "skills.list": {
    params: PageSchema.extend({
      groupId: IdSchema.optional(),
      botId: IdSchema,
      enabled: z.boolean().optional(),
      /**
       * In a group, list what the member's runs use — the group's own skills for it, or
       * its own Bot skills while the group has none (read-only listing; management omits this).
       */
      effective: z.boolean().optional(),
      /**
       * False leaves out the role's built-in methods (`builtinKey`). They stay installed
       * as planning references for the Bot, but no user-facing list or picker shows them.
       */
      builtin: z.literal(false).optional(),
    }),
    result: z.array(SkillSchema).max(200),
  },
  "skills.get": {
    timeoutMs: SKILL_PACKAGE_READ_RPC_TIMEOUT_MS,
    params: skillId.extend({
      /** First paint does not need to open every supporting file. Omission keeps the editor API. */
      includeResources: z.literal(false).optional(),
    }),
    result: z.strictObject({
      skill: SkillSchema,
      document: SkillDocumentSchema,
      compatibility: SkillCompatibilityReportSchema.optional(),
      /** Source version and update / rollback state; absent for skills never checked. */
      update: SkillUpdateStateSchema.optional(),
      /**
       * Supporting files saved with the skill (everything except SKILL.md). `text` is judged from
       * the first bytes only; `skills.readFile` gives null if the whole file turns out binary.
       */
      files: z
        .array(SkillPackageFileSchema.extend({ text: z.boolean().optional() }))
        .max(SKILL_IMPORT_MAX_FILES),
    }),
  },
  /** K2: one supporting file of a saved skill or a pending upload, for the editor; null = binary. */
  "skills.readFile": {
    timeoutMs: SKILL_PACKAGE_READ_RPC_TIMEOUT_MS,
    params: z.union([
      z.strictObject({
        groupId: IdSchema.optional(),
        skillId: IdSchema,
        path: SkillPackagePathSchema,
      }),
      z.strictObject({
        groupId: IdSchema.optional(),
        uploadId: IdSchema,
        path: SkillPackagePathSchema,
      }),
    ]),
    result: z.strictObject({
      path: SkillPackagePathSchema,
      text: z.string().max(SKILL_IMPORT_FILE_MAX_BYTES).nullable(),
    }),
  },
  /**
   * K2: the editor's 「上传文件 / 上传文件夹」. Brain opens the picker and keeps the bytes (same
   * limits and link checks as an import); a later create / update names them by `uploadId`.
   * A folder keeps its own name as the top folder. null when the user cancels.
   */
  "skills.pickFiles": {
    params: z
      .strictObject({
        groupId: IdSchema.optional(),
        botId: IdSchema,
        from: z.enum(["file", "folder", "drop"]),
        dropId: IdSchema.optional(),
      })
      .refine(({ from, dropId }) => (from === "drop") === (dropId !== undefined)),
    result: z
      .strictObject({
        uploadId: IdSchema,
        files: z.array(editableFile).min(1).max(SKILL_IMPORT_MAX_FILES),
      })
      .nullable(),
  },
  /**
   * A skill the person writes on the connections page: saved for one Bot as its own (`taught`,
   * like a taught or hand-made workflow). Plain documents only; workflows have
   * `skills.createWorkflow`. Errors `skill_name_exists`, `skill_invalid`, `skill_bot_unavailable`.
   */
  "skills.create": {
    params: z.strictObject({
      requestId: IdSchema,
      botId: IdSchema,
      document: SkillDocumentBaseSchema,
      /** false: written for nobody yet; kept switched off until given to Bots from its details. */
      enabled: z.boolean().default(true),
      /** Supporting files to save next to SKILL.md (no removals: nothing exists yet). */
      files: fileChanges.optional(),
    }),
    result: SkillSchema,
  },
  "skills.update": {
    params: skillId.extend({
      requestId: IdSchema,
      patch: SkillDocumentPatchSchema,
      /** Added, changed and removed supporting files; files not named stay as they are. */
      files: fileChanges.optional(),
    }),
    result: SkillSchema,
  },
  "skills.delete": { params: skillId.extend({ confirmed: z.literal(true) }), result: ok },
  "skills.setEnabled": { params: skillId.extend({ enabled: z.boolean() }), result: SkillSchema },
  // Opens the file (SKILL.md / .zip) or folder picker; null when the user cancels.
  "skills.secretChoices": {
    params: z.strictObject({ botId: IdSchema }),
    result: z.array(SecretNameSchema).max(200),
  },
  "skills.preview": {
    timeoutMs: 135 * 60_000,
    params: z.strictObject({
      groupId: IdSchema.optional(),
      botId: IdSchema,
      from: z.enum(["file", "folder"]).optional(),
      /**
       * The picker and the first copy run before there is any preview id to cancel by.
       * The caller picks this id before dispatch so `skills.cancelPreviewBatch` can wait for the
       * whole preview call to unwind instead of closing on a local abort.
       */
      batchId: IdSchema.optional(),
    }),
    result: SkillImportDetailsSchema.nullable(),
  },
  // One text file of a pending preview, exactly as it would be saved; null for binary files.
  "skills.previewFile": {
    params: z.strictObject({
      groupId: IdSchema.optional(),
      previewId: IdSchema,
      path: SkillPackagePathSchema,
    }),
    result: z.strictObject({
      path: SkillPackagePathSchema,
      text: z.string().max(SKILL_IMPORT_PREVIEW_TEXT_MAX_BYTES).nullable(),
      /** The resource may be imported but is too large for a text preview frame. */
      tooLarge: z.literal(true).optional(),
    }),
  },
  "skills.cancelPreview": {
    params: z.strictObject({ groupId: IdSchema.optional(), previewId: IdSchema }),
    result: ok,
  },
  /** Drains the picker/copy and releases its preview slot even if the reply was lost. */
  "skills.cancelPreviewBatch": {
    params: z.strictObject({ batchId: IdSchema }),
    result: ok,
  },
  "skills.secretBindings": {
    params: skillId,
    result: z.strictObject({
      bindings: skillSecretBindings,
      available: z.array(SecretNameSchema).max(200),
    }),
  },
  "skills.setSecretBindings": {
    params: skillId.extend({ bindings: skillSecretBindings }),
    result: ok,
  },
  "skills.import": {
    timeoutMs: 125 * 60_000,
    params: z.strictObject({
      groupId: IdSchema.optional(),
      previewId: IdSchema,
      bindings: skillSecretBindings.optional(),
    }),
    result: SkillSchema,
  },
  /**
   * 「检查更新」, only when the user asks — never on startup. A link import re-resolves the
   * stored URL and downloads it again; a local import needs its folder or zip picked again.
   * The newer content is published to a shared package and kept until the user applies or checks
   * again, so applying does not depend on the network or on a source that changed in between.
   */
  "skills.checkUpdate": {
    timeoutMs: 135 * 60_000,
    params: skillId.extend({ from: z.enum(["file", "folder"]).optional() }),
    result: SkillUpdateStateSchema,
  },
  /** Switch the reference to the package the last check found; the old one stays 7 days. */
  "skills.applyUpdate": {
    params: skillId.extend({ requestId: IdSchema }),
    result: SkillUpdateStateSchema,
  },
  /** Switch back to the package replaced by the last update, if it is still retained. */
  "skills.rollbackUpdate": {
    params: skillId.extend({ requestId: IdSchema }),
    result: SkillUpdateStateSchema,
  },
  "skills.catalog": {
    params: z.strictObject({
      /** Opaque position after the last row of the previous page. */
      cursor: z.string().min(1).max(400).optional(),
      limit: z.number().int().min(1).max(100).default(50),
      query: z.string().trim().max(200).optional(),
    }),
    result: z.strictObject({
      items: z.array(SkillCatalogItemSchema).max(100),
      nextCursor: z.string().max(400).nullable(),
      /** Rows in the whole catalog (with the query applied), for the tab count. */
      total: z.number().int().nonnegative().safe(),
    }),
  },
  /**
   * Gives one Bot a skill from the catalog (copies it, or turns its own copy back on) or takes it
   * away (turns that Bot's copy off; nothing is deleted). `groupId` is where `skillId` lives;
   * `targetGroupId` gives it to the Bot as a member of that group (the group's own store, like a
   * group import) instead of to the Bot's private skills.
   */
  "skills.catalogAssign": {
    params: z.strictObject({
      skillId: IdSchema,
      groupId: IdSchema.optional(),
      targetGroupId: IdSchema.optional(),
      botId: IdSchema,
      enabled: z.boolean(),
    }),
    result: ok,
  },
  /**
   * Delete every copy of a catalog row's skill, the Bots' own and every group's (not
   * built-ins). `groupId` is where `skillId` lives, as in the catalog item.
   */
  "skills.catalogDelete": {
    params: z.strictObject({
      skillId: IdSchema,
      groupId: IdSchema.optional(),
      confirmed: z.literal(true),
    }),
    result: ok,
  },
  "skills.proposals": {
    params: PageSchema.extend({
      botId: IdSchema.optional(),
      messageId: IdSchema.optional(),
      id: IdSchema.optional(),
    }),
    result: z.array(SkillProposalSchema).max(200),
  },
  "skills.propose.resolve": {
    params: z.strictObject({
      proposalId: IdSchema,
      accept: z.boolean(),
      edits: SkillDocumentPatchSchema.optional(),
      /** Supporting files added on the card before accepting. */
      files: fileChanges.optional(),
    }),
    result: z.strictObject({ proposal: SkillProposalSchema, skill: SkillSchema.nullable() }),
  },
  /**
   * Detected requirements, the interpreter found on this machine and the environment's
   * state. Read-only; nothing is installed until `skills.runtime.prepare` is called.
   */
  "skills.runtime": {
    timeoutMs: SKILL_PACKAGE_READ_RPC_TIMEOUT_MS,
    params: runtimeTarget,
    result: SkillRuntimeStatusSchema,
  },
  /**
   * Installs the plan the user approved. `planHash` is what the card displayed: a plan that changed
   * since then (another interpreter, another package set) is refused instead of silently run.
   */
  "skills.runtime.prepare": {
    timeoutMs: 30 * 60_000,
    params: runtimeTarget.extend({
      requestId: IdSchema,
      planHash: z.string().min(1).max(64),
      confirmWithoutIsolation: z.literal(true).optional(),
      useMirror: z.literal(true).optional(),
    }),
    result: SkillRuntimeStatusSchema,
  },
  "skills.runtime.cancel": {
    params: runtimeTarget,
    result: SkillRuntimeStatusSchema,
  },
  /** Deletes only the environment directory; the skill and its files stay. */
  "skills.runtime.remove": {
    params: runtimeTarget,
    result: SkillRuntimeStatusSchema,
  },
  "skills.runtime.log": {
    params: runtimeTarget,
    result: z.strictObject({
      path: z.string().max(4096).nullable(),
      text: z.string().max(200_000),
    }),
  },
} as const;
export const SkillEvents = {
  /** Install progress; the log file holds the full output. */
  "skills.runtimeProgress": z.strictObject({
    runtime: SkillManagedRuntimeSchema.optional(),
    groupId: IdSchema.optional(),
    skillId: IdSchema,
    state: SkillRuntimeStateSchema,
    phase: z.enum(["create", "dependencies", "verify"]),
    done: z.number().int().nonnegative().max(100_000),
    total: z.number().int().nonnegative().max(100_000),
  }),
  "skills.importProgress": z.strictObject({
    groupId: IdSchema.optional(),
    botId: IdSchema,
    previewId: IdSchema,
    phase: z.enum(["copying", "done", "cancelled", "failed"]),
    files: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_FILES),
    bytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES),
    totalFiles: z.number().int().min(1).max(SKILL_IMPORT_MAX_FILES),
    totalBytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES),
  }),
  "skills.changed": z.strictObject({
    groupId: IdSchema.optional(),
    botId: IdSchema,
    reason: z.enum([
      "created",
      "updated",
      "removed",
      "enabled",
      "disabled",
      "proposed",
      "resolved",
    ]),
    skillId: IdSchema.optional(),
    proposalId: IdSchema.optional(),
    messageId: IdSchema.optional(),
  }),
} as const;
