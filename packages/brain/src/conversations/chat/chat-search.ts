import {
  CHAT_SEARCH_TARGET,
  chatSearchTopicLink,
  type ReadMessagesSearchInput,
  type ReadMessagesSearchItem,
  ReadMessagesSearchItemSchema,
  ReadMessagesSearchResultSchema,
} from "@pibot/protocol-base";
import { ChatSearchIndex, ChatSearchRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { historyImport, historyReferenceText } from "./history-reference.ts";

const clip = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");

function excerpt(body: string, query: string) {
  // A change in Unicode case length is unusual; if the match cannot be located, show the start.
  const folded = body.toLowerCase();
  const match = folded.length === body.length ? folded.indexOf(query.toLowerCase()) : -1;
  const start = Math.max(0, match - 100);
  return (
    (start ? "…" : "") +
    clip(body.slice(start).replace(/^[\uDC00-\uDFFF]/u, ""), 598) +
    (body.length > start + 598 ? "…" : "")
  );
}

function searchItems(
  local: LocalService,
  { botId, groupId }: ToolRunContext,
  query: string,
  rows: Awaited<ReturnType<ChatSearchRepo["search"]>>,
  signal: AbortSignal,
) {
  const { redactor, logger } = local.deps;
  const items: ReadMessagesSearchItem[] = [];
  let skipped = 0;
  for (const { messageId, conversationId, title, createdAt, body, importSource } of rows) {
    signal.throwIfAborted();
    const source = groupId
      ? { kind: "group", groupId, conversationId, messageId }
      : { kind: "dm", botId, conversationId, messageId };
    const parsed = ReadMessagesSearchItemSchema.safeParse({
      title: clip(redactor.redact(String(title ?? "")), 200),
      createdAt,
      snippet: excerpt(redactor.redact(String(body)), query),
      importedFrom: historyImport(importSource, createdAt),
      conversationId,
      link: chatSearchTopicLink({
        conversationId: String(conversationId),
        messageId: String(messageId),
      }),
      source,
    });
    if (parsed.success) items.push(parsed.data);
    else skipped++;
  }
  // Legacy identifiers, timestamps and parser issues are not diagnostic data.
  if (skipped)
    logger.warn(
      JSON.stringify({ module: "chat_search", event: "invalid_result_rows", count: skipped }),
    );
  return items;
}

export async function searchMessages(
  local: LocalService,
  context: ToolRunContext,
  input: ReadMessagesSearchInput,
  signal: AbortSignal,
  output: (text: string) => void,
  revalidate: () => void,
) {
  const { botId, groupId } = context;
  const { db, redactor } = local.deps;
  // A recognized secret in the query must not be a test for its presence in historical data.
  const rows = redactor.contains(input.query).length
    ? []
    : await new ChatSearchRepo(db).search(groupId ? { botId, groupId } : { botId }, input, signal);
  revalidate();
  const items = searchItems(local, context, input.query, rows, signal);
  const result = ReadMessagesSearchResultSchema.parse({
    mode: "search",
    untrusted: true,
    backfillPending: new ChatSearchIndex(db).pending(),
    items,
  });
  signal.throwIfAborted();
  local.approvals.audit.append({
    botId,
    runId: context.runId,
    kind: "messages.read",
    summary: "Searched permitted chat history / 搜索获准聊天历史",
    detail: {
      category: "read_messages",
      toolName: "read_messages",
      target: CHAT_SEARCH_TARGET,
      messageCount: items.length,
      conversationCount: new Set(items.map(({ conversationId }) => conversationId)).size,
      reasonCode: "done",
    },
  });
  const payload = JSON.stringify(result);
  output(payload);
  return {
    text: historyReferenceText(
      payload,
      items.some((item) => item.importedFrom),
    ),
    summary: "read_messages",
    details: { resultCount: items.length },
  };
}
