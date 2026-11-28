import { z } from "zod";
import { ComputerAppIdListSchema } from "../computer/apps.ts";
import { AbsolutePathSchema, ExecutionLocationTargetSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";
import { BotPageSchema } from "../core/page.ts";
import { CredentialSiteSchema } from "../credentials/site.ts";
import { CategorySchema, DomainSchema } from "./settings.ts";

const text = z.string().min(1);
const time = z.iso.datetime();
export const GrantScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("send_target"),
    connectorId: IdSchema,
    tool: text,
    target: text.max(4096),
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ kind: z.literal("secret"), name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }),
  z.strictObject({ kind: z.literal("connector"), connectorId: IdSchema }),
  z.strictObject({
    kind: z.literal("connector_tool"),
    connectorId: IdSchema,
    tool: text.max(4096),
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("programs"),
    topicId: IdSchema.optional(),
    programs: z.array(text).min(1),
    root: text,
    /** Missing on historical rows means the local execution target only. */
    target: ExecutionLocationTargetSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("folder"),
    path: text,
    target: ExecutionLocationTargetSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("workplace"),
    topicId: IdSchema.optional(),
    root: text,
    target: ExecutionLocationTargetSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("domain"), domain: DomainSchema }),
  // Routine preauthorization of operating the computer. Only app IDs; the
  // screenshot-click option has no representation, so it can never be preauthorized.
  z.strictObject({ kind: z.literal("apps"), apps: ComputerAppIdListSchema }),
  // "don't ask again" for automatic login, per Bot and saved site (category web).
  z.strictObject({ kind: z.literal("login"), site: CredentialSiteSchema }),
  // "always allow" submitting forms in the Bot browser on this site, per Bot
  // (category web). Covers subdomains like the only-allowed list.
  z.strictObject({ kind: z.literal("submit"), domain: DomainSchema }),
  // "always allow" on a web_fetch card: this Bot reads public pages by cookieless GET
  // without asking per site (category web). Never the Bot browser, logins, form submissions or
  // private/loopback addresses; the network allowlist still applies.
  z.strictObject({ kind: z.literal("web_read") }),
  // Owner decision 2026-10-23: "don't ask again" on a paid image generation card, per Bot (the
  // grant's botId) and exact image model (category web). A different model asks again; a routine
  // can hold the same scope as a pre-approval. The web "never" level and the network allowlist
  // still deny before any grant is consulted.
  z.strictObject({
    kind: z.literal("paid_image"),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
  }),
]);
export const GrantSchema = z
  .strictObject({
    id: IdSchema,
    botId: IdSchema,
    groupId: IdSchema.nullable().optional(),
    category: CategorySchema,
    scope: GrantScopeSchema,
    createdAt: time,
    revokedAt: time.nullable(),
  })
  .refine(
    ({ category, scope, groupId }) =>
      (category === "computer" && !!groupId && scope.kind === "apps") ||
      (category === "connector" &&
        (scope.kind === "connector" || scope.kind === "connector_tool")) ||
      (category === "send_out" && scope.kind === "send_target") ||
      (category === "run_command" && (scope.kind === "programs" || scope.kind === "secret")) ||
      (["read_file", "list_dir"].includes(category) && scope.kind === "folder") ||
      (category === "write_file" && scope.kind === "workplace") ||
      (category === "web" &&
        (scope.kind === "domain" ||
          scope.kind === "login" ||
          scope.kind === "submit" ||
          scope.kind === "web_read" ||
          scope.kind === "paid_image")),
    "Grant scope does not match category",
  );
/** Fresh display metadata; never persisted or used as authorization evidence. */
export const GrantListItemSchema = GrantSchema.safeExtend({
  topicWorkplace: z
    .strictObject({
      title: z.string().max(200),
      writeRoots: z.array(AbsolutePathSchema).max(5),
      available: z.boolean(),
    })
    .optional(),
  /** A paid image grant names its provider by id; this is the provider's current display name. */
  providerName: z.string().max(200).optional(),
});
export type GrantListItem = z.infer<typeof GrantListItemSchema>;
export const GrantPageSchema = BotPageSchema.extend({
  groupId: IdSchema.optional(),
  connectorId: IdSchema.optional(),
}).refine((value) => !(value.botId && value.groupId));
const _botId = z.strictObject({ botId: IdSchema });
const ok = z.strictObject({ ok: z.literal(true) });
export const GrantMethods = {
  "grants.list": { params: GrantPageSchema, result: z.array(GrantListItemSchema).max(200) },
  "grants.revoke": { params: z.strictObject({ id: IdSchema }), result: ok },
} as const;
export type Grant = z.infer<typeof GrantSchema>;
export type GrantScope = z.infer<typeof GrantScopeSchema>;
