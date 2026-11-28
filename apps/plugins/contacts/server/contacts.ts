import { CONTACTS_MAC_SCRIPT, NATIVE_ACCESS_PROMPT_MS } from "./scripts/mac.ts";
import { CONTACTS_WINDOWS_SCRIPT } from "./scripts/win.ts";

const str = (maxLength = 4096) => ({ type: "string", minLength: 1, maxLength });
const limit = { type: "integer", minimum: 1, maximum: 100 } as const;
const cursor = {
  type: ["string", "number", "null"],
  maxLength: 64,
  description:
    "Omit cursor for the first page; never pass placeholders. Copy nextCursor for later pages.",
};
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

export const contactTools = [
  tool(
    "count_contacts",
    "Count local contacts without returning names, phones or emails. Use this for quantity questions / 只统计本机联系人数量，不返回姓名、电话或邮箱；问数量时使用此工具",
    {},
  ),
  tool(
    "list_contacts",
    "List local contact names with bounded pagination; follow nextCursor for more. For counts use count_contacts / 分页列出本机联系人姓名，按 nextCursor 继续；问数量用 count_contacts",
    { cursor, limit },
  ),
  tool(
    "search_contacts",
    "Search contacts by name, phone digits, email or company, with bounded pagination. If empty or failed, explain the result and next step; never fall back to clicking Contacts / 按姓名、电话数字、邮箱或公司搜索，分页返回。失败或无结果时说明原因和下一步，不改用操作电脑点通讯录",
    { query: str(256), cursor, limit },
    ["query"],
  ),
  tool(
    "create_contact",
    "Create a local contact / 创建本机联系人",
    {
      givenName: str(256),
      familyName: str(256),
      email: str(512),
      phone: str(128),
      organization: str(512),
    },
    ["givenName"],
    false,
  ),
  tool(
    "update_contact",
    "Update an existing local contact / 更新本机联系人",
    {
      id: str(),
      givenName: str(256),
      familyName: str(256),
      email: str(512),
      phone: str(128),
      organization: str(512),
    },
    ["id"],
    false,
  ),
  tool(
    "delete_contact",
    "Delete one contact; disabled by default / 删除一个联系人，默认关闭",
    { id: str() },
    ["id"],
    false,
  ),
] as const;

export const contactScripts = {
  darwin: CONTACTS_MAC_SCRIPT,
  win32: CONTACTS_WINDOWS_SCRIPT,
} as const;
export const contactAccessPromptMs = NATIVE_ACCESS_PROMPT_MS;
