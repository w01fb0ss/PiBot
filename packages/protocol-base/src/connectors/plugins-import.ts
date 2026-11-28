import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { BuiltinAppSchema } from "./apps.ts";

const kind = z.enum(["file", "directory"]);
const ok = z.strictObject({ ok: z.literal(true) });
const selection = z.strictObject({ selectionId: IdSchema });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bringOver = z.strictObject({
  tool: z.enum(["claude-code", "codex", "cursor", "pi", "opencode"]),
  key: z.string().regex(/^(?:claude-code|codex|cursor|pi|opencode):plugin:[a-f0-9]{24}$/),
});
const bringOverOrigin = bringOver.extend({ sourcePath: z.string().min(1).max(4096) });
export type ConnectorImportOrigin = z.output<typeof bringOverOrigin>;
const safeText = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"));
const configValue = z.union([z.string(), z.number(), z.boolean()]);
const configVisibility = z.strictObject({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  equals: configValue,
});
const configOption = z.strictObject({ value: configValue, label: safeText });

export const ClaudePluginComponentSchema = z.strictObject({
  kind: z.enum([
    "skill",
    "command",
    "mcp",
    "setting",
    "hook",
    "monitor",
    "bin",
    "agent",
    "lsp",
    "output-style",
    "theme",
    "workflow",
    "pibot",
  ]),
  name: safeText,
  path: safeText.optional(),
  status: z.enum(["import", "unsupported"]),
  // `secret` marks a component skipped because it looked like it carried a
  // credential, so one such skill no longer refuses the whole plugin.
  reason: z.enum(["policy-bypass", "executable", "not-supported", "secret"]).optional(),
});
export type ClaudePluginComponent = z.output<typeof ClaudePluginComponentSchema>;

export const ClaudePluginConfigFieldSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  type: z.enum(["string", "number", "boolean", "directory", "file"]),
  title: safeText,
  description: safeText,
  sensitive: z.boolean(),
  required: z.boolean(),
  default: configValue.optional(),
  options: z.array(configOption).max(30).optional(),
  visibleWhen: configVisibility.optional(),
});
export type ClaudePluginConfigField = z.output<typeof ClaudePluginConfigFieldSchema>;

export const ClaudePluginSkillSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  kind: z.enum(["skill", "command"]),
  path: safeText,
  name: safeText,
  description: safeText,
});
export type ClaudePluginSkill = z.output<typeof ClaudePluginSkillSchema>;

/** Host-only snapshot envelope. It contains metadata and MCP templates, never resource bodies. */
export const ClaudePluginBundleSchema = z.strictObject({
  pibotClaudePlugin: z.literal(1),
  name: safeText,
  version: safeText,
  versionDeclared: z.boolean().optional(),
  description: safeText,
  /** A Pi Bot application package is shown in Applications in addition to its runtime connection. */
  application: z.boolean().default(false),
  applicationId: z
    .string()
    .regex(/^[a-z][a-z0-9.-]{1,63}$/)
    .optional(),
  applicationCard: BuiltinAppSchema.omit({ id: true, supported: true, unsupportedReason: true })
    .extend({
      platforms: z
        .array(z.enum(["darwin", "win32", "linux"]))
        .min(1)
        .max(3),
    })
    .optional(),
  mcpServers: z.record(z.string(), z.json()),
  skills: z.array(ClaudePluginSkillSchema).max(100),
  config: z.array(ClaudePluginConfigFieldSchema).max(100),
  components: z.array(ClaudePluginComponentSchema).max(300),
});
export type ClaudePluginBundle = z.output<typeof ClaudePluginBundleSchema>;
export const ConnectorImportFileChangesSchema = z.strictObject({
  added: z.array(z.string().max(4096)).max(300),
  removed: z.array(z.string().max(4096)).max(300),
  truncated: z.boolean(),
});
export type ConnectorImportFileChanges = z.output<typeof ConnectorImportFileChangesSchema>;

export const ConnectorImportHostMethods = {
  "host.pickConnectorImport": {
    params: z.strictObject({ kind }),
    result: z.strictObject({ selectionId: IdSchema.nullable(), canceled: z.boolean() }),
  },
  "host.readConnectorImport": {
    params: selection.extend({ installationId: IdSchema }),
    result: z.strictObject({
      text: z.string().max(1024 * 1024),
      sourceDigest: digest,
      sourceKind: z.enum(["json", "plugin"]),
      fileChanges: ConnectorImportFileChangesSchema.optional(),
      bringOver: bringOverOrigin.optional(),
    }),
  },
  "host.materializeConnectorImport": {
    params: selection.extend({ installationId: IdSchema, expectedDigest: digest }),
    result: ok,
  },
  /**
   * The brain found a plugin folder of another AI tool (never a renderer-supplied path)
   * and the user chose to bring it over; the host turns it into the same short-lived selection a
   * picked folder becomes, so the rest of the import path is unchanged.
   */
  "host.adoptConnectorImport": {
    params: z.strictObject({
      temporary: z.boolean().optional(),
      bringOver: bringOver.optional(),
      path: z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => !value.includes("\0")),
    }),
    result: z.strictObject({ selectionId: IdSchema }),
  },
  "host.releaseConnectorImport": { params: selection, result: ok },
  "host.removeConnectorImport": {
    params: z.strictObject({ installationId: IdSchema }),
    result: ok,
  },
  "host.confirmConnectorCommand": {
    params: z.strictObject({
      connectorId: IdSchema,
      installationId: IdSchema,
      revision: z.number().int().positive().safe(),
      command: z.string().min(1).max(256),
      args: z.array(z.string().max(4096)).max(64),
      networkDomains: z.array(z.string().max(253)).max(64),
      /**
       * `windows`: S3-W, Windows has no command sandbox. `outside_sandbox`: the person
       * asked a macOS / Linux MCP to run as them. Absent means `windows` (older brains).
       */
      mode: z.enum(["windows", "outside_sandbox"]).optional(),
    }),
    result: z.strictObject({ approved: z.boolean() }),
  },
} as const;
export interface ConnectorImportHost {
  /** A dismissed dialog is reported, never turned into a missing or failed selection. */
  pick(input: {
    kind: "file" | "directory";
  }): Promise<{ selectionId: string | null; canceled: boolean }>;
  /** A plugin folder the brain discovered; absent where no host can read it. */
  adopt?(input: {
    path: string;
    temporary?: boolean;
    bringOver?: z.output<typeof bringOver>;
  }): Promise<{ selectionId: string }>;
  read(input: { selectionId: string; installationId: string }): Promise<{
    text: string;
    sourceDigest: string;
    sourceKind: "json" | "plugin";
    fileChanges?: ConnectorImportFileChanges;
    bringOver?: ConnectorImportOrigin;
  }>;
  materialize(input: {
    selectionId: string;
    installationId: string;
    expectedDigest: string;
  }): Promise<{ ok: true }>;
  /** Replace an existing brought-over plugin bundle after its source preview is confirmed. */
  replaceMaterialize?(input: {
    selectionId: string;
    installationId: string;
    expectedDigest: string;
  }): Promise<{ ok: true }>;
  release(input: { selectionId: string }): Promise<{ ok: true }>;
  remove(input: { installationId: string }): Promise<{ ok: true }>;
}
export type ConnectorCommandConfirmation = z.output<
  (typeof ConnectorImportHostMethods)["host.confirmConnectorCommand"]["params"]
>;
