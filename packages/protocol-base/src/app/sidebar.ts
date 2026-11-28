import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { PageSchema } from "../core/page.ts";

const label = z.string().trim().min(1).max(200);
const time = z.iso.datetime();
export const SidebarKeySchema = z
  .string()
  .regex(/^(dm|group):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const SidebarEntrySchema = z.strictObject({
  conversationKey: SidebarKeySchema,
  pinnedAt: time.nullable(),
  groupId: IdSchema.nullable(),
  hiddenAt: time.nullable(),
  unread: z.boolean(),
  waitingForPlan: z.boolean().optional(),
  lastReadAt: time.nullable(),
});
export const SidebarGroupSchema = z.strictObject({
  id: IdSchema,
  name: label,
  position: z.number().int().nonnegative(),
  collapsed: z.boolean(),
  createdAt: time,
});
export type SidebarEntry = z.infer<typeof SidebarEntrySchema>;
export type SidebarGroup = z.infer<typeof SidebarGroupSchema>;
const ok = z.strictObject({ ok: z.literal(true) });
const page = PageSchema;
export const SidebarMethods = {
  "sidebar.list": {
    params: page.extend({ includeHidden: z.boolean().optional() }),
    result: z.strictObject({
      entries: z.array(SidebarEntrySchema).max(200),
      archivedCount: z.number().int().nonnegative().optional(),
      groups: z.array(SidebarGroupSchema).max(200),
    }),
  },
  "sidebar.update": {
    params: SidebarEntrySchema.omit({ lastReadAt: true, waitingForPlan: true })
      .partial()
      .required({ conversationKey: true }),
    result: SidebarEntrySchema,
  },
  "sidebar.open": {
    params: z.strictObject({ conversationKey: SidebarKeySchema }),
    result: SidebarEntrySchema,
  },
  /**
   * Marks a conversation read without making it the desktop's open conversation (sidebar.open
   * does both). The phone calls it when the user reads a chat there.
   */
  "sidebar.read": {
    params: z.strictObject({ conversationKey: SidebarKeySchema }),
    result: SidebarEntrySchema,
  },
  "sidebar.groups.list": { params: page, result: z.array(SidebarGroupSchema).max(200) },
  "sidebar.groups.create": { params: z.strictObject({ name: label }), result: SidebarGroupSchema },
  "sidebar.groups.update": {
    params: SidebarGroupSchema.omit({ createdAt: true }).partial().required({ id: true }),
    result: SidebarGroupSchema,
  },
  "sidebar.groups.remove": { params: z.strictObject({ id: IdSchema }), result: ok },
} as const;
export const SidebarEvents = {
  "sidebar.changed": z.strictObject({
    conversationKey: SidebarKeySchema.optional(),
    resetHistory: z.literal(true).optional(),
  }),
  // Topic edits can affect rows beyond the first page without changing the sidebar entry.
  "sidebar.topicsChanged": z.strictObject({
    conversationKey: SidebarKeySchema,
  }),
} as const;
