import { z } from "zod";
import type { CapabilityToolSpec } from "./capability-tools.ts";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const page = z.number().int().min(1).max(100).optional();
const cursorPlaceholders = new Set(["", "0", "start", "first", "none", "null", "undefined"]);
const cursor = z
  .union([z.string().max(64), z.number(), z.null()])
  .transform((value) => {
    // Third-party connections may issue opaque tokens. Native apps decode their own offsets.
    const token = value === null ? "" : String(value).trim();
    return cursorPlaceholders.has(token.toLowerCase()) ? undefined : token;
  })
  .optional()
  .describe(
    "Omit cursor for the first page; never pass placeholders. Copy nextCursor for later pages.",
  );
// A template without a connection: policy denies it for the missing connectorId; brain judges a
// served call with the connection's own request instead. The strictest mode keeps it closed.
const connectorPolicy = (readOnly: boolean) =>
  ({
    category: "connector",
    operation: "call",
    visible: true,
    readOnly,
    confirmationMode: "always_ask",
  }) as const;

export const appCapabilityTools = {
  calendar_list_events: {
    group: "apps",
    schema: z
      .strictObject({
        start: text(64),
        end: text(64),
        calendarId: text(4096).optional(),
        calendarIds: z
          .array(text(4096))
          .min(1)
          .max(100)
          .refine((ids) => new Set(ids).size === ids.length, "Calendar IDs must be unique")
          .optional(),
        cursor,
        limit: page,
      })
      .refine(
        (args) => !(args.calendarId && args.calendarIds),
        "Use calendarId or calendarIds, not both",
      ),
    description:
      "List up to 31 days of events in ONE call across ALL readable calendars (including read-only) by omitting calendarId and calendarIds. Or pass calendarIds for multiple calendars, or legacy calendarId for one; never combine them. Pages are globally sorted, with calendarName and calendarWritable on each event; false means read-only. Follow nextCursor with the same range/IDs to count every page. Do not call once per calendar. On failure or empty results explain next steps; never switch to computer tools to click Calendar unless explicitly requested. / 不传日历即一次查全部可读日历（含只读），不要逐个调用；多选用calendarIds，分页带日历名及可写标记，统计须读完分页。",
    policy: connectorPolicy(true),
    attributes: { readOnly: true },
  },
  calendar_create_event: {
    group: "apps",
    schema: z.strictObject({
      title: text(512),
      start: text(64),
      end: text(64),
      calendarId: text(4096).optional(),
      notes: text(8192).optional(),
      location: text(1024).optional(),
      allDay: z.boolean().optional(),
    }),
    description:
      "Create a calendar event only after user review. ISO local times without an offset use this computer's current time zone; ambiguous or nonexistent DST times require an explicit offset, e.g. 2026-11-01T15:00:00+08:00. List calendars first when selecting one so its name is available for review. User rejection means not created: acknowledge it, never ask to approve again or retry automatically.",
    policy: connectorPolicy(false),
    attributes: { readOnly: false, output: "message" },
  },
  contacts_count: {
    group: "apps",
    schema: z.strictObject({}),
    description:
      "Count local contacts without returning names, phones or emails. For quantity questions use this instead of enumerating contacts.",
    policy: connectorPolicy(true),
    attributes: { readOnly: true },
  },
  contacts_search: {
    group: "apps",
    schema: z.strictObject({
      query: text(256),
      cursor,
      limit: page,
    }),
    description:
      "Search contacts by name, normalized phone digits, email or company with bounded pagination. On failure or empty results explain next steps; never switch to computer tools to click Contacts unless the user explicitly requests operating that app.",
    policy: connectorPolicy(true),
    attributes: { readOnly: true },
  },
  contacts_create: {
    group: "apps",
    schema: z.strictObject({
      givenName: text(256),
      familyName: text(256).optional(),
      email: text(512).optional(),
      phone: text(128).optional(),
      organization: text(512).optional(),
    }),
    description: "Create a contact as a reviewable send draft.",
    policy: connectorPolicy(false),
    attributes: { readOnly: false, output: "message" },
  },
} as const satisfies Record<string, CapabilityToolSpec>;
