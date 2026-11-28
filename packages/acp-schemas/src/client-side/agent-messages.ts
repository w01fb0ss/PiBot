/*
 * What Pi Bot accepts from an external agent while Pi Bot is the ACP client. Agents are
 * third-party programs, so every frame is untrusted: objects stay loose (agents add their own
 * fields, which are ignored), strings and arrays are capped, and only the fields Pi Bot uses are
 * declared. Unknown `sessionUpdate` kinds parse as `ignored` instead of failing the whole turn.
 */
import { z } from "zod";
import { absolutePath } from "../common/path.ts";

/** ACP major version both sides speak (Pi Bot pins v1 on the agent side too). */
export const ACP_CLIENT_PROTOCOL_VERSION = 1;

const id = z.string().min(1).max(200);
/**
 * A "current" pointer: agents may report it empty when nothing is selected (Cursor 2026.10.22
 * answers session/new with models.currentModelId ""), which means no current choice.
 */
const currentId = z.string().max(200);
const label = z.string().max(500);
const text = z.string().max(400_000);
/**
 * A list an agent may legitimately grow (models, modes, settings, commands, plan entries): never
 * a reason to reject the frame. Entries that do not match are dropped and only the first `max`
 * are kept (OpenCode offered 650 models on 2026-11-14 and failed the old 256 cap). The frame
 * itself stays bounded by the connection's frame-size limit.
 */
export const LIST_MAX = 4096;
function lenientList<T extends z.ZodType>(item: T, max = LIST_MAX) {
  return z.array(z.unknown()).transform((items) =>
    items.slice(0, max).flatMap((entry) => {
      const parsed = item.safeParse(entry);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }),
  );
}

export const agentInfo = z.looseObject({
  name: z.string().max(200),
  title: label.optional(),
  version: z.string().max(100).optional(),
});
export const authMethod = z.looseObject({
  id,
  name: label,
  description: z.string().max(2000).nullish(),
});
export const initializeResult = z.looseObject({
  protocolVersion: z.number().int().min(0).max(1000),
  agentCapabilities: z
    .looseObject({
      loadSession: z.boolean().optional(),
      promptCapabilities: z
        .looseObject({
          image: z.boolean().optional(),
          embeddedContext: z.boolean().optional(),
        })
        .optional(),
      sessionCapabilities: z.looseObject({}).optional(),
    })
    .optional(),
  agentInfo: agentInfo.optional(),
  authMethods: lenientList(authMethod, 32).optional(),
});
export type InitializeResult = z.infer<typeof initializeResult>;

// Entries with an empty id are dropped by the reader instead of failing the whole session.
export const sessionMode = z.looseObject({
  id: currentId,
  name: label,
  description: z.string().max(2000).nullish(),
});
export const sessionModes = z.looseObject({
  currentModeId: currentId,
  availableModes: lenientList(sessionMode),
});
export const sessionModels = z.looseObject({
  currentModelId: currentId,
  availableModels: lenientList(
    z.looseObject({
      modelId: currentId,
      name: label,
      description: z.string().max(2000).nullish(),
    }),
  ),
});
/** Only `select` options are shown as pickers; other kinds keep their id for later. */
export const configOption = z.looseObject({
  id,
  name: label,
  type: z.string().max(40).optional(),
  currentValue: z.union([z.string().max(600), z.boolean(), z.number()]).nullish(),
  options: lenientList(
    z.union([
      z.looseObject({ value: z.string().max(600), name: label }),
      z.looseObject({
        group: z.string().max(200).optional(),
        name: label.optional(),
        options: lenientList(z.looseObject({ value: z.string().max(600), name: label })),
      }),
    ]),
  ).optional(),
});
export const newSessionResult = z.looseObject({
  sessionId: id,
  modes: sessionModes.nullish(),
  models: sessionModels.nullish(),
  configOptions: lenientList(configOption, 256).nullish(),
});
export type NewSessionResult = z.infer<typeof newSessionResult>;
/** `session/load` and `session/resume` answer with the same optional state, without an id. */
export const loadSessionResult = newSessionResult.omit({ sessionId: true });

export const contentBlock = z.union([
  z.looseObject({ type: z.literal("text"), text }),
  z.looseObject({ type: z.string().max(40) }),
]);

const location = z.looseObject({ path: absolutePath, line: z.number().int().min(0).nullish() });
export const toolKind = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
export type ToolKind = z.infer<typeof toolKind>;
export const toolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
/** An unknown kind degrades to "other" so a newer agent cannot fail the parse with a new value. */
const kind = z
  .string()
  .max(40)
  .transform((value) => toolKind.catch("other").parse(value));
const status = z
  .string()
  .max(40)
  .transform((value) => toolStatus.catch("in_progress").parse(value));

export const toolCall = z.looseObject({
  toolCallId: id,
  title: label.nullish(),
  kind: kind.nullish(),
  status: status.nullish(),
  locations: lenientList(location, 256).nullish(),
  rawInput: z.unknown().optional(),
});
export type ToolCall = z.infer<typeof toolCall>;
export const planEntry = z.looseObject({
  content: z.string().max(2000),
  priority: z.string().max(20).optional(),
  status: z
    .string()
    .max(20)
    .transform((value) =>
      z.enum(["pending", "in_progress", "completed"]).catch("pending").parse(value),
    ),
});

export const sessionUpdate = z.union([
  z.looseObject({
    sessionUpdate: z.enum(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]),
    content: contentBlock,
  }),
  toolCall.extend({ sessionUpdate: z.literal("tool_call") }),
  toolCall.partial().extend({ sessionUpdate: z.literal("tool_call_update"), toolCallId: id }),
  z.looseObject({ sessionUpdate: z.literal("plan"), entries: lenientList(planEntry, 500) }),
  z.looseObject({ sessionUpdate: z.literal("current_mode_update"), currentModeId: currentId }),
  z.looseObject({
    sessionUpdate: z.literal("config_option_update"),
    configOptions: lenientList(configOption, 256),
  }),
  // Context use and (Claude, OpenCode) the session's cost so far, as the agent reports them.
  z.looseObject({
    sessionUpdate: z.literal("usage_update"),
    used: z.number().nonnegative().max(1e12).optional(),
    size: z.number().nonnegative().max(1e12).optional(),
    cost: z
      .looseObject({
        amount: z.number().nonnegative().max(1_000_000),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .nullish(),
  }),
  z.looseObject({
    sessionUpdate: z.literal("available_commands_update"),
    availableCommands: lenientList(
      z.looseObject({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        // ACP: an unstructured argument the command takes, with a hint shown while typing it.
        input: z.looseObject({ hint: z.string().max(2000).optional() }).nullish(),
      }),
      1000,
    ),
  }),
  z.looseObject({ sessionUpdate: z.string().max(80) }).transform(() => ({
    sessionUpdate: "ignored" as const,
  })),
]);
export type SessionUpdate = z.infer<typeof sessionUpdate>;
export const sessionNotification = z.looseObject({ sessionId: id, update: sessionUpdate });

export const permissionOptionKind = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
export const permissionOption = z.looseObject({
  optionId: id,
  name: label,
  // Selecting an option returns its opaque ID. Only accept kinds whose effect ACP defines.
  kind: permissionOptionKind,
});
export const requestPermissionParams = z.looseObject({
  sessionId: id,
  toolCall: toolCall.partial().extend({ toolCallId: id }),
  options: z.array(permissionOption).min(1).max(16),
});
export type RequestPermissionParams = z.infer<typeof requestPermissionParams>;

export const stopReason = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);
export const promptResult = z.looseObject({
  stopReason: z
    .string()
    .max(40)
    .transform((value) => stopReason.catch("end_turn").parse(value)),
});
export type PromptResult = z.infer<typeof promptResult>;
