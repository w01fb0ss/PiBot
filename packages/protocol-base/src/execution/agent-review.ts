import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { optionalPageOffset } from "../tools/pagination.ts";
import { ReviewFindingSchema } from "../workspace/changes.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !/[\0\r\n]/.test(v));
const count = z.number().int().nonnegative().safe();
const scope = { botId: IdSchema, conversationId: IdSchema };
const page = { before: IdSchema.optional(), limit: z.number().int().min(1).max(50).optional() };
const navigateOperations = [
  "definition",
  "references",
  "diagnostics",
  "symbol",
  "outline",
  "callers",
  "callees",
  "implementations",
] as const;
export const CodeNavigateSchema = z
  .strictObject({
    operation: z.enum(navigateOperations),
    // Symbol search is the only operation that may span the project, so it alone can omit the path.
    path: path.optional(),
    // The name either searches (`symbol`) or stands in for a line + column, so a delegated name must
    // resolve to exactly one declaration; anything else is reported back as candidates.
    query: z.string().trim().min(1).max(200).optional(),
    line: z.number().int().min(1).max(10_000_000).optional(),
    column: z.number().int().min(1).max(10_000_000).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .refine((v) => {
    if (v.operation === "symbol") return !!v.query && !v.line && !v.column;
    if (!v.path) return false;
    if (v.operation === "diagnostics" || v.operation === "outline") return true;
    // A name and a position for the same call would make the target ambiguous.
    if (v.query) return !v.line && !v.column;
    return !!v.line && !!v.column;
  });
export type CodeNavigate = z.infer<typeof CodeNavigateSchema>;
const position = z.number().int().min(1).safe();
const range = z.strictObject({
  line: position,
  column: position,
  endLine: position,
  endColumn: position,
});
// TypeScript names declaration kinds as free-form strings ("function", "local var", ...), so this
// stays a bounded string instead of an enum that would break on a compiler upgrade.
const declaration = {
  name: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  range,
  preview: z.string().max(240),
};
export const CodeNavigateResultSchema = z.strictObject({
  engine: z.literal("typescript"),
  engineVersion: z.literal("6.0.3"),
  operation: z.enum(navigateOperations),
  snapshotHash: hash,
  config: path.nullable(),
  partial: z.boolean(),
  reasons: z.array(z.string().max(100)).max(30),
  locations: z.array(z.strictObject({ path, range, preview: z.string().max(240) })).max(200),
  diagnostics: z
    .array(
      z.strictObject({
        path: path.nullable(),
        range: range.nullable(),
        code: count,
        category: z.enum(["warning", "error", "suggestion", "message"]),
        message: z.string().max(2000),
      }),
    )
    .max(200),
  // Declarations: `symbol` search hits, `callers` / `callees` neighbours, or the candidates of a name
  // that matched more than one declaration. Other operations keep the previous payload untouched.
  symbols: z
    .array(z.strictObject({ path, ...declaration, containerName: z.string().max(200).nullable() }))
    .max(200)
    .optional(),
  outline: z
    .array(z.strictObject({ ...declaration, depth: count }))
    .max(200)
    .optional(),
  truncated: z.boolean(),
});
export type CodeNavigateResult = z.infer<typeof CodeNavigateResultSchema>;
// The multi-language tools answer from tree-sitter tags queries, which match syntax and
// names, so every result says so instead of looking like the type-accurate code_navigate output.
const syntaxEngine = z.literal("tree-sitter");
const syntaxReason = z.array(z.string().max(100)).max(30);
const syntaxDeclaration = {
  name: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  range,
};
export const CodeOutlineSchema = z.strictObject({
  path,
  limit: z.number().int().min(1).max(500).optional(),
});
export type CodeOutline = z.infer<typeof CodeOutlineSchema>;
export const CodeOutlineResultSchema = z.strictObject({
  // Keep accepting historical TypeScript results; new outlines use syntax extraction for every
  // language, without implying that a file outline type-checks the project.
  engine: z.enum(["typescript", "tree-sitter"]),
  approximate: z.boolean(),
  path,
  hash,
  outline: z.array(z.strictObject({ ...declaration, depth: count })).max(500),
  truncated: z.boolean(),
  // Optional for older persisted results that predate single-file coverage reporting.
  partial: z.boolean().optional(),
  reasons: syntaxReason,
});
export type CodeOutlineResult = z.infer<typeof CodeOutlineResultSchema>;
export const CodeSymbolsSchema = z.strictObject({
  // A name, never source text: tags match the spelling, so a qualified or generic name may miss.
  query: z.string().trim().min(1).max(200),
  // A file or a subdirectory of the working root; omitted means the whole root.
  path: path.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type CodeSymbols = z.infer<typeof CodeSymbolsSchema>;
const indexedSymbol = { path, hash, ...syntaxDeclaration };
export const CodeSymbolsResultSchema = z.strictObject({
  engine: syntaxEngine,
  approximate: z.literal(true),
  query: z.string().max(200),
  definitions: z.array(z.strictObject(indexedSymbol)).max(200),
  references: z.array(z.strictObject(indexedSymbol)).max(200),
  // The index is incremental and bounded, so a partial index is reported rather than hidden.
  indexed: z.strictObject({ files: count, symbols: count }),
  truncated: z.boolean(),
  reasons: syntaxReason,
});
export type CodeSymbolsResult = z.infer<typeof CodeSymbolsResultSchema>;
export const CodeMapSchema = z.strictObject({
  // A subdirectory narrows the map; omitted means the whole working root.
  path: path.optional(),
  // Token budget is estimated as characters / 4; the model asks for more instead of getting more.
  maxTokens: z.number().int().min(100).max(4000).optional(),
});
export type CodeMap = z.infer<typeof CodeMapSchema>;
const mapSymbol = {
  name: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  line: z.number().int().min(1).max(10_000_000),
  range,
};
export const CodeMapResultSchema = z.strictObject({
  engine: syntaxEngine,
  approximate: z.literal(true),
  scope: path,
  maxTokens: count,
  estimatedTokens: count,
  files: z
    .array(
      z.strictObject({
        path,
        hash,
        language: z.string().min(1).max(40).nullable(),
        // How often this file's definitions are named elsewhere in the root: the ranking key.
        references: count,
        symbols: z.array(z.strictObject(mapSymbol)).max(200),
      }),
    )
    .max(200),
  indexed: z.strictObject({ files: count, symbols: count }),
  truncated: z.boolean(),
  reasons: syntaxReason,
});
export type CodeMapResult = z.infer<typeof CodeMapResultSchema>;
export const ReviewProfileSchema = z.strictObject({
  kind: z.literal("review"),
  reviewId: IdSchema,
  snapshotHash: hash,
  /** Another Bot's model and persona run this read-only review; scope stays the author's. */
  reviewerBotId: IdSchema.optional(),
});
export type ReviewProfile = z.infer<typeof ReviewProfileSchema>;
export const ReviewStartSchema = z.strictObject({
  scope: z.enum(["turn", "uncommitted"]),
  instructions: z.string().max(2000).optional(),
});
export const ReviewReadSchema = z
  .strictObject({
    kind: z.enum(["manifest", "diff", "file"]),
    path: path.optional(),
    offset: optionalPageOffset.describe("Omit offset for the first page; never pass placeholders."),
    limit: z.number().int().min(1).max(2000).optional(),
  })
  .refine((v) => v.kind !== "file" || !!v.path);
/** The changes root a review belongs to: a folder id, or the Bot's default folder ("home"). */
const reviewRootId = z.union([z.literal("home"), IdSchema]);
export const ReviewSummarySchema = z.strictObject({
  id: IdSchema,
  rootId: reviewRootId.optional(),
  rootPath: path.optional(),
  ...scope,
  parentRunId: IdSchema,
  rootRunId: IdSchema,
  taskId: IdSchema.nullable(),
  reviewerRunId: IdSchema.nullable(),
  snapshotHash: hash,
  status: z.enum(["capturing", "queued", "running", "done", "error", "aborted", "interrupted"]),
  freshness: z.enum(["checking", "current", "stale", "unavailable"]),
  coverage: z.strictObject({
    complete: z.boolean(),
    capturedFiles: count,
    omitted: z.array(z.strictObject({ reason: z.string().max(100), count })).max(30),
  }),
  findingsCount: count,
  /** The Bot whose model and persona ran the review (absent = the author itself). */
  reviewerBotId: IdSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;
const evidenceBase = {
  id: IdSchema,
  ...scope,
  rootRunId: IdSchema,
  runId: IdSchema,
  createdAt: z.iso.datetime(),
  codeHash: hash.nullable(),
};
export const DeliveryEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("command"),
    toolRecordId: IdSchema,
    /** Selects the step's own log when the run holds several command logs. */
    toolCallId: z.string().min(1).max(300).optional(),
    toolStatus: z.string().max(30),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    logAvailable: z.boolean(),
  }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("screenshot"),
    computerStepId: IdSchema,
    available: z.boolean(),
    capturedAt: z.iso.datetime(),
  }),
  z.strictObject({ ...evidenceBase, kind: z.literal("review"), review: ReviewSummarySchema }),
  z.strictObject({
    ...evidenceBase,
    kind: z.literal("unverified"),
    label: z.string().min(1).max(500),
    source: z.enum(["user", "agent"]),
  }),
]);
export type DeliveryEvidence = z.infer<typeof DeliveryEvidenceSchema>;
export const DeliveryEvidenceInputSchema = z.strictObject({
  toolRecordIds: z.array(IdSchema).max(20).optional(),
  computerStepIds: z.array(IdSchema).max(20).optional(),
  reviewIds: z.array(IdSchema).max(20).optional(),
  unverified: z.array(z.string().min(1).max(500)).max(20).optional(),
});
export type DeliveryEvidenceInput = z.infer<typeof DeliveryEvidenceInputSchema>;
export const ReviewExecutionMethods = {
  "reviewExecutions.findings": {
    params: z.strictObject({ ...scope, id: IdSchema }),
    result: z.strictObject({
      reviewId: IdSchema,
      snapshotHash: hash,
      freshness: ReviewSummarySchema.shape.freshness,
      findings: z.array(ReviewFindingSchema).max(200),
      truncated: z.boolean(),
    }),
  },
  "reviewExecutions.list": {
    params: z.strictObject({ ...scope, ...page, rootId: reviewRootId.optional() }),
    result: z.strictObject({
      items: z.array(ReviewSummarySchema).max(50),
      next: IdSchema.nullable(),
    }),
  },
  "reviewExecutions.get": {
    params: z.strictObject({ ...scope, id: IdSchema }),
    result: ReviewSummarySchema,
  },
} as const;
export const DeliveryEvidenceMethods = {
  "deliveryEvidence.list": {
    params: z.strictObject({ ...scope, ...page }),
    result: z.strictObject({
      items: z.array(DeliveryEvidenceSchema).max(50),
      next: IdSchema.nullable(),
    }),
  },
  "deliveryEvidence.get": {
    params: z.strictObject({ ...scope, id: IdSchema }),
    result: DeliveryEvidenceSchema,
  },
} as const;
export const AgentReviewEvents = {
  "review.execution.changed": z.strictObject({ ...scope, id: IdSchema }),
  "delivery.evidence.changed": z.strictObject({ ...scope, id: IdSchema }),
} as const;
