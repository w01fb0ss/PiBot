import { z } from "zod";
import { plainText } from "../computer/apps.ts";
import { IdSchema } from "../core/ids.ts";
import { SkillVersionSchema } from "./contract.ts";
import { SkillCompatibilityReportSchema, SkillSourceFieldsSchema } from "./skill-compatibility.ts";
import { SkillLinkOriginSchema } from "./skill-link-origin.ts";

export * from "./skill-compatibility.ts";

const time = z.iso.datetime();
const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];

/** Display name, as the user types it ("导出客户反馈周表并发给小周"); not the folder name. */
export const SkillNameSchema = z.string().trim().min(1).max(80).refine(plainText);
// Agent Skills caps descriptions at 1024 characters; it is one line in the system prompt.
export const SkillDescriptionSchema = z.string().trim().min(1).max(1024).refine(plainText);
export const SKILL_BODY_MAX_BYTES = 256 * 1024;
/** A whole skill package (zip or folder, uncompressed): SKILL.md plus scripts and resources. */
export const SKILL_IMPORT_MAX_BYTES = 500 * 1024 * 1024;
export const SKILL_IMPORT_MAX_FILES = 20_000;
/** One file in a package; also the largest text one preview file view carries. */
export const SKILL_IMPORT_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const SkillBodySchema = z
  .string()
  .min(1)
  .refine((v) => !v.includes("\0"), "Invalid skill body")
  .refine((v) => new TextEncoder().encode(v).byteLength <= SKILL_BODY_MAX_BYTES, "Skill too large");
/** A `{param}` placeholder in the body; values differ per run and get a default. */
export const SkillParamSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[\p{L}\p{N}_]{1,40}$/u)
    .refine((v) => !RESERVED_KEYS.includes(v)),
  description: z.string().trim().max(200).refine(plainText).optional(),
  default: z.string().max(1000).refine(plainText).optional(),
});
/** What a Bot or the user writes: the model-facing tool and teach drafts carry only this. */
export const SkillDocumentBaseSchema = z.strictObject({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  body: SkillBodySchema,
  params: z
    .array(SkillParamSchema)
    .max(20)
    .refine((v) => new Set(v.map((p) => p.name)).size === v.length, "Duplicate parameter")
    .default([]),
});
/** Raw `metadata.pibot-contract` JSON, kept as written so an invalid one still round-trips. */
export const SKILL_CONTRACT_MAX_CHARS = 16_000;

/**
 * Measures JSON without first materializing an unbounded serialized copy. External RPC data is
 * plain JSON, but unsupported/cyclic/deep values still fail closed when called in-process.
 */
function boundedJsonLength(input: unknown, limit: number): number | undefined {
  const seen = new WeakSet<object>();
  const measureString = (value: string, remaining: number) => {
    if (value.length + 2 > remaining) return remaining + 1;
    return JSON.stringify(value).length;
  };
  const measure = (value: unknown, remaining: number, depth: number): number | undefined => {
    if (remaining < 0 || depth > 128) return remaining + 1;
    if (value === null) return 4;
    if (typeof value === "string") return measureString(value, remaining);
    if (typeof value === "boolean") return value ? 4 : 5;
    if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
    if (typeof value !== "object") return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    let length = 2;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (index) length++;
        if (length > remaining) break;
        const item = value[index];
        const itemLength = item === undefined ? 4 : measure(item, remaining - length, depth + 1);
        if (itemLength === undefined) {
          seen.delete(value);
          return undefined;
        }
        length += itemLength;
      }
    } else {
      let first = true;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
        if (!first) length++;
        first = false;
        length += measureString(key, remaining - length) + 1;
        if (length > remaining) break;
        const itemLength = measure(item, remaining - length, depth + 1);
        if (itemLength === undefined) {
          seen.delete(value);
          return undefined;
        }
        length += itemLength;
        if (length > remaining) break;
      }
    }
    seen.delete(value);
    return length;
  };
  return measure(input, limit, 0);
}

/** Opaque enough for field-level brain validation, but bounded before hashing or dispatch. */
export const SkillContractWireSchema = z.unknown().superRefine((value, issues) => {
  const length = boundedJsonLength(value, SKILL_CONTRACT_MAX_CHARS);
  if (length === undefined || length > SKILL_CONTRACT_MAX_CHARS)
    issues.addIssue({ code: "custom", message: "Invalid or oversized contract" });
});
/** Bounded raw metadata; the stricter canonical format is checked separately and may warn. */
export const SKILL_VERIFIED_MAX_CHARS = 1024;
/** A source-declared version string (`metadata.version`), kept for later update checks. */
export const SKILL_SOURCE_VERSION_MAX_CHARS = 128;
/**
 * A skill package may also carry `pibot-version` and a work contract. Both are preserved
 * through save, export and built-in copies; the contract is validated separately (an invalid one
 * leaves an ordinary skill with a warning, `SkillContractSchema`).
 */
export const SkillDocumentSchema = SkillDocumentBaseSchema.extend({
  /** Advisory source field names survive import normalization; never used for permissions. */
  sourceFields: SkillSourceFieldsSchema.optional(),
  linkOrigin: SkillLinkOriginSchema.optional(),
  version: SkillVersionSchema.optional(),
  /**
   * The importing source's own version. `version` stays Pi Bot's
   * counter, so the source value cannot overwrite the app's update bookkeeping.
   */
  sourceVersion: z.string().min(1).max(SKILL_SOURCE_VERSION_MAX_CHARS).optional(),
  contract: z.string().min(1).max(SKILL_CONTRACT_MAX_CHARS).optional(),
  /** Raw value is preserved so malformed verification metadata can warn without blocking load. */
  verified: z.string().min(1).max(SKILL_VERIFIED_MAX_CHARS).optional(),
});
export const SkillDocumentPatchSchema = z
  .strictObject({
    name: SkillNameSchema,
    description: SkillDescriptionSchema,
    body: SkillBodySchema,
    params: SkillDocumentSchema.shape.params.removeDefault(),
    /** Parsed at the brain boundary so invalid_params can name a field without echoing content. */
    contract: SkillContractWireSchema,
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Empty patch");
/**
 * Folder under the Bot directory that holds SKILL.md, relative so a moved data directory still
 * resolves. The slug is generated by brain (Agent Skills folder rules), never taken from input.
 */
export const SkillDirSchema = z.string().regex(/^skills\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export const SkillSourceSchema = z.enum(["taught", "proposed", "team", "imported"]);
export const SkillBuiltinKeySchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
/** One label pair of a skill, as written in one shipped language. */
const SkillLabelSchema = z.strictObject({
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
});
/**
 * A built-in method ships once per language, but a Bot's copy keeps the labels of the
 * language it was installed in. Carrying both lets the interface follow its own language without
 * touching the installed copy, its prompt entry or the prompt cache.
 */
export const SkillLabelsSchema = z.strictObject({ zh: SkillLabelSchema, en: SkillLabelSchema });
export const SkillSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  source: SkillSourceSchema,
  /**
   * This own skill is the Bot's copy of a built-in method (role / group pack). Set only
   * by the app's built-in sync, never accepted from a skill document or an import.
   */
  builtinKey: SkillBuiltinKeySchema.optional(),
  /** Present on a built-in copy the app still ships: its labels in both languages, for display. */
  builtinLabels: SkillLabelsSchema.optional(),
  /** Present with `builtinKey`: how this copy relates to the method the app ships now. */
  builtinState: z
    .strictObject({
      /** Built-in version it was installed or last updated from; null = unknown (user content). */
      version: z.number().int().min(0).max(99_999).nullable(),
      /** The content differs from that version (the user edited it). */
      modified: z.boolean(),
      /** Auto-updated to this version and not looked at yet (「已更新到 vN」). */
      updatedTo: z.number().int().min(0).max(99_999).optional(),
      /** Edited copy and the app ships a newer version the user has not kept theirs over. */
      newVersion: z.number().int().min(0).max(99_999).optional(),
    })
    .optional(),
  /**
   * A group workflow saved from this passed dynamic plan run (「常用计划」). Set only by
   * the save path after the brain checked the run; never accepted from a document or an import.
   */
  savedFromPlan: z.strictObject({ workflowRunId: IdSchema }).optional(),
  enabled: z.boolean(),
  lastUsedAt: time.nullable(),
  createdAt: time,
  updatedAt: time,
});
/** `skill_propose` tool input; the Bot cannot choose the source, folder or enabled state. */
export const SkillProposeInputSchema = SkillDocumentBaseSchema;
export const SkillProposalStatusSchema = z.enum(["open", "accepted", "declined", "expired"]);
export const SkillProposalSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  messageId: IdSchema.nullable(),
  payload: SkillDocumentBaseSchema,
  status: SkillProposalStatusSchema,
  resolvedSkillId: IdSchema.nullable(),
  createdAt: time,
  resolvedAt: time.nullable(),
});
/** `/`-separated path inside a skill package, relative to the folder that holds SKILL.md. */
export const SkillPackagePathSchema = z.string().min(1).max(512).refine(plainText);
export const SKILL_PACKAGE_MAX_DEPTH = 16;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f\u007f\\]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/**
 * A package is saved under the Bot folder and must be usable on every platform, so each name has
 * to be valid on Windows too (no reserved device names, no trailing dot or space). Shared by the
 * import reader and the editor, so a path the editor accepts is one an import would accept.
 */
export function skillPackagePathSafe(path: string): boolean {
  const parts = path.split("/");
  return (
    path.length <= 512 &&
    parts.length <= SKILL_PACKAGE_MAX_DEPTH &&
    parts.every(
      (part) =>
        !!part &&
        part !== "." &&
        part !== ".." &&
        new TextEncoder().encode(part).byteLength <= 255 &&
        !WINDOWS_FORBIDDEN.test(part) &&
        !WINDOWS_RESERVED.test(part) &&
        !/[. ]$/.test(part),
    )
  );
}
/** A supporting file the user names or edits; SKILL.md itself is written from the document. */
export const SkillPackageWritePathSchema = SkillPackagePathSchema.refine(
  (path) => skillPackagePathSafe(path) && path.toLowerCase() !== "skill.md",
);
export const SkillPackageFileSchema = z.strictObject({
  path: SkillPackagePathSchema,
  bytes: z.number().int().nonnegative().max(SKILL_IMPORT_FILE_MAX_BYTES),
  /**
   * Runnable content: a script by extension or `#!` line, or a native program. Listed separately in
   * the preview; it still only ever runs through `run_command` and its approval.
   */
  script: z.boolean(),
});
export const SkillImportPreviewSchema = z.strictObject({
  compatibility: SkillCompatibilityReportSchema.optional(),
  previewId: IdSchema,
  botId: IdSchema,
  // Shown in full before import (skill text is untrusted).
  document: SkillDocumentSchema,
  source: z.enum(["file", "zip", "folder"]),
  /** Picked file or folder name, for "From …". */
  sourceName: z.string().min(1).max(255).refine(plainText),
  // Every file that will be saved; text files can be opened with `skills.previewFile`.
  files: z
    .array(SkillPackageFileSchema.extend({ text: z.boolean() }))
    .min(1)
    .max(SKILL_IMPORT_MAX_FILES),
  totalBytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES),
  /** Files in the archive or folder outside the skill's own folder; they are not imported. */
  skipped: z.number().int().nonnegative().max(100_000),
  expiresAt: time,
});
/**
 * A runtime the package needs. Detection only proposes it; the environment is created from
 * a plan the user approved, and the state below says which of the five states it is in.
 */
export const SkillManagedRuntimeSchema = z.enum(["python", "node"]);
export type SkillManagedRuntime = z.infer<typeof SkillManagedRuntimeSchema>;

export const SkillRuntimeRequirementSchema = z.strictObject({
  runtime: SkillManagedRuntimeSchema,
  /** The author's constraint (`>=3.10`, `>=20`); the probe checks it but never installs anything. */
  version: z.string().max(200).optional(),
  packages: z.array(z.string().max(500)).max(1000).optional(),
});
/** Resource analysis contains names/counts only, never environment values or source paths. */
export const SkillPackageSummarySchema = z.strictObject({
  fileCount: z.number().int().min(1).max(SKILL_IMPORT_MAX_FILES),
  totalBytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES),
  largestFolders: z
    .array(
      z.strictObject({
        name: SkillPackagePathSchema,
        bytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES),
        fileCount: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_FILES),
      }),
    )
    .max(5),
  scriptCount: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_FILES),
  licenses: z
    .array(z.strictObject({ path: SkillPackagePathSchema, agpl: z.boolean(), gpl: z.boolean() }))
    .max(SKILL_IMPORT_MAX_FILES),
  environmentVariables: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
        /** True when the example only declares the name commented out (`# NAME=`). */
        optional: z.boolean(),
      }),
    )
    .max(SKILL_IMPORT_MAX_FILES),
  bindableEnvironmentVariables: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
    .max(64)
    .optional(),
  /** T3 owns the runtime requirement payload; absence means it has not been analyzed. */
  runtimeRequirements: z.array(SkillRuntimeRequirementSchema).max(2).optional(),
  /** Compiled-extension hints (advisory, shown on the approval card). */
  nativeModules: z.array(z.string().max(200)).max(100).optional(),
});
/**
 * A preview plus the resource summary. It lives here, with the preview itself, so both the
 * skills and the plugins contracts can describe the same bring-over payload without one capability
 * contract depending on another.
 */
export const SkillImportDetailsSchema = SkillImportPreviewSchema.extend({
  summary: SkillPackageSummarySchema.optional(),
});
/** Skill as carried in a version-2 `.pibot` team file. */
export const TeamSkillSchema = SkillDocumentSchema.extend({ enabled: z.boolean() });

export type SkillParam = z.infer<typeof SkillParamSchema>;
export type SkillDocument = z.output<typeof SkillDocumentSchema>;
export type SkillDocumentInput = z.input<typeof SkillDocumentSchema>;
export type SkillDocumentPatch = z.infer<typeof SkillDocumentPatchSchema>;
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type SkillLabels = z.infer<typeof SkillLabelsSchema>;
export type SkillProposal = z.infer<typeof SkillProposalSchema>;
export type SkillProposalStatus = z.infer<typeof SkillProposalStatusSchema>;
export type SkillImportPreview = z.infer<typeof SkillImportPreviewSchema>;
export type SkillImportDetails = z.output<typeof SkillImportDetailsSchema>;
export type SkillPackageSummary = z.output<typeof SkillPackageSummarySchema>;
export type SkillRuntimeRequirement = z.output<typeof SkillRuntimeRequirementSchema>;
export type SkillPackageFile = z.infer<typeof SkillPackageFileSchema>;
export type TeamSkill = z.output<typeof TeamSkillSchema>;

/** Public re-import locator only: never credentials, signed URLs or local paths. T4 revalidates downloads. */
export const SkillImportSourceSchema = z
  .strictObject({
    host: z
      .string()
      .max(253)
      .regex(/^[a-z0-9.-]+$/i),
    repository: z
      .string()
      .max(200)
      .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i)
      .optional(),
    ref: z.string().min(1).max(256).optional(),
    subpath: z
      .string()
      .max(512)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !path.split("/").some((part) => part === ".." || part === "."),
      )
      .default(""),
    url: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
        );
      }),
  })
  .refine((value) => new URL(value.url).hostname.toLowerCase() === value.host.toLowerCase());
export type SkillImportSource = z.infer<typeof SkillImportSourceSchema>;
