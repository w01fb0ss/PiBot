import { CALENDAR_MAC_SCRIPT, NATIVE_ACCESS_PROMPT_MS } from "./scripts/mac.ts";
import { CALENDAR_WINDOWS_SCRIPT } from "./scripts/win.ts";

const str = (maxLength = 4096) => ({ type: "string", minLength: 1, maxLength });
const limit = { type: "integer", minimum: 1, maximum: 100 } as const;
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  readOnlyHint = true,
) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  readOnlyHint,
});

export const calendarTools = [
  tool("list_calendars", "List available calendars / 列出可用日历", {}),
  tool(
    "list_events",
    "Read up to 31 days across calendars in one call: omit calendarIds for ALL readable calendars, or pass multiple IDs; do not call once per calendar. Globally sorted pages include calendarName and calendarWritable. Use nextCursor with the same range/IDs. calendarId is a legacy single-ID alternative; do not combine it with calendarIds. / 一次读取最多31天的多个日历；不传calendarIds即全部可读日历，无需逐个调用。统一排序分页，带日历名和可写标记；nextCursor沿用同一日期与日历范围，calendarId仅兼容单日历且不能与calendarIds同传。",
    {
      start: str(64),
      end: str(64),
      calendarId: str(),
      calendarIds: { type: "array", items: str(), minItems: 1, maxItems: 100, uniqueItems: true },
      cursor: {
        type: ["string", "number", "null"],
        maxLength: 4096,
        description:
          "Omit cursor for the first page; never pass placeholders. Copy nextCursor for later pages.",
      },
      limit,
    },
    ["start", "end"],
  ),
  tool(
    "create_event",
    "Create an event without attendees after user review. Local ISO times without an offset are resolved in this computer's current time zone before review; DST folds/gaps need an explicit offset. A rejected review means not created; do not retry automatically. / 创建不含参会人的日程；无偏移ISO时间在确认前按本机时区确定化，夏令时歧义须明确偏移。用户拒绝即未创建，不自动重试。",
    {
      title: str(512),
      start: str(64),
      end: str(64),
      calendarId: str(),
      notes: str(8192),
      location: str(1024),
      allDay: { type: "boolean" },
    },
    ["title", "start", "end"],
    false,
  ),
  tool(
    "update_event",
    "Update one existing event / 更新一条现有日程",
    {
      id: str(),
      title: str(512),
      start: str(64),
      end: str(64),
      notes: str(8192),
      location: str(1024),
      allDay: { type: "boolean" },
    },
    ["id"],
    false,
  ),
  tool(
    "delete_event",
    "Delete one event; disabled by default / 删除一条日程，默认关闭",
    { id: str() },
    ["id"],
    false,
  ),
] as const;

export const calendarScripts = {
  darwin: CALENDAR_MAC_SCRIPT,
  win32: CALENDAR_WINDOWS_SCRIPT,
} as const;
export const calendarAccessPromptMs = NATIVE_ACCESS_PROMPT_MS;
