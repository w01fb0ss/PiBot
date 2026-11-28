import { z } from "zod";
import {
  BuiltinVideoCatalogModelSchema,
  BuiltinVideoProviderIdSchema,
} from "../chat/video-models.ts";
import { IdSchema } from "../core/ids.ts";
import { ApprovalStatusSchema, RiskSchema } from "../permissions/approvals.ts";
import { PolicyStepSchema } from "../permissions/policy-explain.ts";

const text = z.string().min(1);
const time = z.iso.datetime();
const count = z.number().int().nonnegative().safe();
export const ToolStatusSchema = z.enum([
  "pending",
  "running",
  "done",
  "error",
  "blocked",
  "aborted",
]);
/** A program-produced parsing fact, never a permission or completion claim. */
export const CodeAnalysisSchema = z.strictObject({
  engine: z.literal("tree-sitter"),
  approximate: z.literal(true),
});
export type CodeAnalysis = z.infer<typeof CodeAnalysisSchema>;

/** A navigation or recovery action emitted by the brain, never parsed from tool or message text. */
export const ToolSettingsActionSchema = z.union([
  z.strictObject({
    kind: z.literal("open_settings"),
    page: z.enum(["models", "connections", "passwords"]),
  }),
  z.strictObject({
    kind: z.literal("enable_video_model"),
    providerId: BuiltinVideoProviderIdSchema,
    model: BuiltinVideoCatalogModelSchema,
  }),
  z.strictObject({
    kind: z.enum(["repoint_knowledge", "open_knowledge"]),
    sourceId: IdSchema,
  }),
]);
export type ToolSettingsAction = z.infer<typeof ToolSettingsActionSchema>;

export const ToolCallRecordSchema = z.strictObject({
  id: IdSchema,
  toolCallId: text,
  tool: text,
  summary: z.string(),
  inputTranslation: text.optional(),
  codeAnalysis: CodeAnalysisSchema.optional(),
  settingsAction: ToolSettingsActionSchema.optional(),
  status: ToolStatusSchema,
  exitCode: z.number().int().safe().nullable(),
  durationMs: count.nullable(),
  createdAt: time,
  finishedAt: time.nullable(),
  approval: z
    .strictObject({
      status: ApprovalStatusSchema,
      remembered: z.boolean(),
      risk: RiskSchema,
      explanation: z.array(PolicyStepSchema).max(200).optional(),
      /** The paused card closed as out of date (see `ApprovalSchema.superseded`). */
      superseded: z.literal(true).optional(),
    })
    .optional(),
  /**
   * A policy refusal or execution check carries the fixed code, so the row can
   * say why instead of only "denied". The code never contains a path, message or backend text.
   */
  denialReason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  /** Allowed by the conversation's YOLO switch instead of a card. */
  yolo: z.strictObject({ risk: RiskSchema }).optional(),
});
export const ToolCallEvents = {
  "chat.tool": z.strictObject({
    botId: IdSchema.optional(),
    conversationId: IdSchema.optional(),
    groupId: IdSchema.optional(),
    threadId: IdSchema.optional(),
    runId: IdSchema,
    messageId: IdSchema,
    toolCallId: text,
    phase: z.enum(["start", "output", "end"]),
    tool: text,
    summary: z.string(),
    inputTranslation: text.optional(),
    codeAnalysis: CodeAnalysisSchema.optional(),
    settingsAction: ToolSettingsActionSchema.optional(),
    output: z.string().optional(),
    exitCode: z.number().int().safe().optional(),
    durationMs: count.optional(),
    status: ToolStatusSchema.optional(),
    /** The tool waits for this Bot (display name) to finish writing the same folder. */
    waitingFor: z.string().max(200).optional(),
    /**
     * A refusal or failed execution check carries its code on the end event, so the live step
     * says why before history is reloaded (the record keeps the same code).
     */
    denialReason: z
      .string()
      .regex(/^[a-z0-9_]{1,64}$/)
      .optional(),
    /** This step was allowed by the conversation's YOLO switch, without a card. */
    yolo: z.strictObject({ risk: RiskSchema }).optional(),
  }),
} as const;
const _botId = z.strictObject({ botId: IdSchema });
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
export type ToolStatus = z.infer<typeof ToolStatusSchema>;
