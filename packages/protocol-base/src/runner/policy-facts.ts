import { z } from "zod";
import { AbsolutePathSchema, WorkspaceSnapshotSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";
import { ApprovalFactSchema } from "../permissions/approvals.ts";
import { GrantScopeSchema } from "../permissions/grants.ts";
import { PolicyStepSchema } from "../permissions/policy-explain.ts";
import {
  BotPermissionOverridesSchema,
  CategorySchema,
  PermissionsSettingsSchema,
} from "../permissions/settings.ts";
import { WorkplacesSchema } from "../workspace/workplaces.ts";

const text = z.string().max(32768);
const invocation = z.object({ program: text, args: z.array(text).max(4096) });
export const RunnerCommandAnalysisSchema = z.object({
  literalCommand: invocation.optional(),
  literalOutputRedirect: z
    .object({ command: invocation, path: text, operator: z.enum([">", ">>"]) })
    .optional(),
  programs: z.array(text).max(4096),
  commands: z.array(invocation).max(4096),
  reads: z.array(text).max(4096),
  writes: z.array(text).max(4096),
  domains: z.array(text).max(4096),
  network: z.boolean(),
  incomplete: z.boolean(),
  warnings: z.array(text).max(4096),
  unknownOptions: z.array(text).max(4096),
  readonly: z.boolean(),
  fileRedirect: z.literal(true).optional(),
  outputRedirect: z.literal(true).optional(),
  inputRedirect: z.literal(true).optional(),
  negated: z.literal(true).optional(),
  pipedCommands: z.array(z.number().int().nonnegative()).max(4096).optional(),
  filterCandidates: z
    .array(z.object({ index: z.number().int(), start: z.number().int(), end: z.number().int() }))
    .max(4096)
    .optional(),
});
export const RunnerPreparedFactsSchema = z.object({
  result: z.object({
    decision: z.enum(["allow", "ask", "deny"]),
    reason: z.string().max(200),
    risk: z.enum(["normal", "danger"]),
    facts: z.array(ApprovalFactSchema).max(4096),
    canRemember: z.boolean(),
    windowsReadOnly: z.literal(true).optional(),
    explanation: z.array(PolicyStepSchema).max(200),
    category: CategorySchema.optional(),
    grantScope: GrantScopeSchema.optional(),
    analysis: RunnerCommandAnalysisSchema.optional(),
    path: z
      .object({
        path: AbsolutePathSchema,
        root: AbsolutePathSchema.optional(),
        exists: z.boolean(),
      })
      .optional(),
    cwd: AbsolutePathSchema.optional(),
    command: text.optional(),
    commandHome: AbsolutePathSchema.optional(),
    outsideWrites: z.array(AbsolutePathSchema).max(202).optional(),
    outsideWriteRoots: z.array(AbsolutePathSchema).max(202).optional(),
  }),
  scope: GrantScopeSchema.optional(),
  incomplete: z.boolean(),
  outside: z.boolean().optional(),
  gitHook: z.literal(true).optional(),
  gitConfiguration: z.enum(["project", "global", "hooks-path", "sensitive-project"]).optional(),
});
export const RunnerOfflineContextSchema = z.strictObject({
  botId: IdSchema,
  topicId: IdSchema,
  name: z.string().max(200),
  workplace: WorkplacesSchema,
  boundary: WorkspaceSnapshotSchema,
  settings: PermissionsSettingsSchema,
  overrides: BotPermissionOverridesSchema.optional(),
  tools: z.array(z.string().max(80)).max(12),
});
export const RunnerPolicyRequestSchema = z.discriminatedUnion("category", [
  z.strictObject({
    category: z.literal("run_command"),
    command: z.string().min(1).max(16384),
    cwd: AbsolutePathSchema,
    background: z.literal(true).optional(),
    stdin: z.literal(true).optional(),
    writePaths: z.array(AbsolutePathSchema).min(1).max(8).optional(),
  }),
  z.strictObject({
    category: z.enum(["read_file", "write_file", "list_dir"]),
    path: text,
    cwd: AbsolutePathSchema,
  }),
]);
export const RunnerPolicyPreparationSchema = z.strictObject({
  opId: z.string().uuid(),
  context: RunnerOfflineContextSchema,
  request: RunnerPolicyRequestSchema,
});
export type RunnerOfflineContext = z.infer<typeof RunnerOfflineContextSchema>;
export type RunnerPolicyPreparation = z.infer<typeof RunnerPolicyPreparationSchema>;
export const RunnerPolicyMethods = {
  "runner.policy.prepare": {
    params: RunnerPolicyPreparationSchema,
    result: RunnerPreparedFactsSchema,
  },
} as const;
