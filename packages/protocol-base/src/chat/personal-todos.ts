import { z } from "zod";
import { InboxOriginSchema } from "../app/inbox-origin.ts";
import { IdSchema } from "../core/ids.ts";
import { optionalPageBefore } from "../tools/pagination.ts";

export const PersonalTodoColors = [
  "coral",
  "apricot",
  "lemon",
  "mint",
  "sky",
  "lavender",
  "blossom",
  "stone",
] as const;
export const PersonalTodoStickers = {
  phone: "📞",
  cake: "🎂",
  plane: "✈️",
  pill: "💊",
  work: "💼",
  home: "🏠",
  money: "💰",
  book: "📚",
  run: "🏃",
  heart: "❤️",
  star: "⭐",
  meeting: "🗓️",
} as const;
const decorations = {
  color: z.enum(PersonalTodoColors).nullable().optional(),
  sticker: z
    .enum(
      Object.keys(PersonalTodoStickers) as [
        keyof typeof PersonalTodoStickers,
        ...(keyof typeof PersonalTodoStickers)[],
      ],
    )
    .nullable()
    .optional(),
  endAt: z.iso.date().nullable().optional(),
};
const range = { from: z.iso.date().optional(), to: z.iso.date().optional() };
/**
 * A phone replays edits made while its computer was offline. With this time set, the brain
 * refuses the edit (`personal_todo_changed`) when the row changed after it, so the newer change
 * wins (maintainers 2026-11-20). Desktop calls leave it out and behave as before.
 */
const guard = { unchangedSince: z.iso.datetime().optional() };
/** A shared user list needs source identity as well as an item id to avoid cross-account clashes. */
const SourceKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    "Fully qualified source key: service + stable account/calendar identity + item ID + recurring instance date when applicable. Never use a bare item ID. Reuse the same key across Bots for the same source item; omit it if source identity is unknown.",
  );
function validDates(value: object) {
  const { dueAt, endAt, from, to } = value as {
    dueAt?: string | null;
    endAt?: string | null;
    from?: string;
    to?: string;
  };
  return (!endAt || (!!dueAt && endAt >= dueAt.slice(0, 10))) && (!from || !to || from <= to);
}
// Avatar hues map once here so every creator uses the same eight calendar colours.
export function personalTodoBotColor(color: string): (typeof PersonalTodoColors)[number] {
  const mapping: Record<string, (typeof PersonalTodoColors)[number]> = {
    red: "coral",
    orange: "apricot",
    amber: "lemon",
    brown: "stone",
    yellow: "lemon",
    green: "mint",
    blue: "sky",
    cyan: "sky",
    teal: "mint",
    purple: "lavender",
    violet: "lavender",
    pink: "blossom",
    gray: "stone",
    ink: "stone",
  };
  return mapping[color] ?? "apricot";
}
export const PersonalTodoSchema = z
  .strictObject({
    ...decorations,
    id: IdSchema,
    title: z.string().trim().min(1).max(500),
    dueAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable(),
    status: z.enum(["open", "done"]),
    sourceBotId: IdSchema.nullable(),
    sourceConversationId: IdSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine(validDates, "Invalid date range");
export const PersonalTodoInputSchema = z
  .discriminatedUnion("action", [
    z.strictObject({
      ...decorations,
      action: z.literal("create"),
      title: PersonalTodoSchema.shape.title,
      dueAt: PersonalTodoSchema.shape.dueAt.optional(),
      sourceKey: SourceKeySchema.optional(),
    }),
    z.strictObject({
      ...range,
      action: z.literal("list"),
      status: z.enum(["open", "done"]).default("open"),
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    z.strictObject({ action: z.literal("complete"), id: IdSchema }),
    z.strictObject({ action: z.literal("reopen"), id: IdSchema }),
  ])
  .refine(validDates, "Invalid date range");
// Provider tool declarations require an object at the root; the pipe still enforces action-specific fields.
export const PersonalTodoToolDeclarationSchema = z.strictObject({
  ...decorations,
  ...range,
  action: z.enum(["create", "list", "complete", "reopen"]),
  title: PersonalTodoSchema.shape.title.optional(),
  dueAt: PersonalTodoSchema.shape.dueAt.optional(),
  sourceKey: SourceKeySchema.optional(),
  id: IdSchema.optional(),
  status: z.enum(["open", "done"]).optional(),
  before: optionalPageBefore,
  limit: z.number().int().min(1).max(100).optional(),
});
const ACTION_FIELDS: Record<string, readonly string[]> = {
  create: ["title", "dueAt", "color", "sticker", "endAt", "sourceKey"],
  list: ["from", "to", "status", "before", "limit"],
  complete: ["id"],
  reopen: ["id"],
};
const NULL_MEANS_EMPTY = new Set(["dueAt", "color", "sticker", "endAt"]);
/**
 * Every field sits at the root for providers, and some models fill all of them (gpt-6.1-sol sent
 * create with from/to/status/limit and placeholder ids five times running in an acceptance run). Fields
 * of other actions, and nulls where null means nothing, are dropped before the strict parse.
 */
function actionFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const keep = ACTION_FIELDS[String((value as { action?: unknown }).action)];
  if (!keep) return value;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, field]) =>
        key === "action" ||
        (keep.includes(key) && (field !== null || NULL_MEANS_EMPTY.has(key))) ||
        !Object.hasOwn(PersonalTodoToolDeclarationSchema.shape, key),
    ),
  );
}
export const PersonalTodoToolSchema = z
  .preprocess(actionFields, PersonalTodoToolDeclarationSchema)
  .pipe(PersonalTodoInputSchema);
export const PersonalTodoMethods = {
  "personalTodos.create": {
    params: z
      .strictObject({
        ...decorations,
        requestId: IdSchema,
        title: PersonalTodoSchema.shape.title,
        dueAt: PersonalTodoSchema.shape.dueAt,
      })
      .refine(validDates, "Invalid date range"),
    result: PersonalTodoSchema,
  },
  "personalTodos.update": {
    params: z
      .strictObject({
        ...decorations,
        ...guard,
        id: IdSchema,
        title: PersonalTodoSchema.shape.title,
        dueAt: PersonalTodoSchema.shape.dueAt,
      })
      .refine(validDates, "Invalid date range"),
    result: PersonalTodoSchema,
  },
  "personalTodos.delete": {
    params: z.strictObject({ ...guard, id: IdSchema, confirmed: z.literal(true) }),
    result: z.null(),
  },
  "personalTodos.list": {
    params: z
      .strictObject({
        ...range,
        status: z.enum(["open", "done"]).default("open"),
        before: IdSchema.optional(),
        limit: z.number().int().min(1).max(100).default(30),
      })
      .refine(validDates, "Invalid date range"),
    result: z
      .array(PersonalTodoSchema.safeExtend({ origin: InboxOriginSchema.optional() }))
      .max(100),
  },
  "personalTodos.undatedCount": { params: z.undefined(), result: z.number().int().nonnegative() },
  "personalTodos.counts": {
    params: z.undefined(),
    result: z.strictObject({
      open: z.number().int().nonnegative(),
      done: z.number().int().nonnegative(),
    }),
  },
  "personalTodos.setStatus": {
    params: z.strictObject({ ...guard, id: IdSchema, status: z.enum(["open", "done"]) }),
    result: PersonalTodoSchema,
  },
};
export type PersonalTodo = z.infer<typeof PersonalTodoSchema>;
