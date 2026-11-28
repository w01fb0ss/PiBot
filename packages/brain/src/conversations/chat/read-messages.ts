import { ExecError } from "@pibot/execution";
import {
  type Attachment,
  CHAT_SEARCH_TARGET,
  type ReadMessagesInput,
  ReadMessagesResultSchema,
} from "@pibot/protocol-base";
import { ReadMessagesRepo } from "@pibot/storage";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { searchMessages } from "./chat-search.ts";
import { historyImport, historyReferenceText } from "./history-reference.ts";

export function messageScope(
  local: LocalService,
  context: ToolRunContext,
  input: ReadMessagesInput,
): string | undefined {
  const repo = new ReadMessagesRepo(local.deps.db);
  if (
    context.executionTaskId ||
    !context.conversationId ||
    !repo.caller(
      context.botId,
      context.runId,
      context.messageId,
      context.conversationId,
      context.groupId,
      context.threadId,
      context.routineRunId,
    )
  )
    return undefined;
  const origin = repo.scope(context.botId, context.conversationId);
  const target =
    input.mode === "messages"
      ? repo.scope(context.botId, input.conversationId)
      : input.mode === "search"
        ? CHAT_SEARCH_TARGET
        : "readable_conversations";
  return origin && target ? JSON.stringify([origin, target]) : undefined;
}

export function readMessages(
  local: LocalService,
  context: ToolRunContext,
  input: ReadMessagesInput,
  prepared: PreparedTool,
  signal: AbortSignal,
  output: (text: string) => void,
  authorizationStillValid: () => boolean,
) {
  const repo = new ReadMessagesRepo(local.deps.db);
  const assertCaller = () => {
    signal.throwIfAborted();
    // A drained checkpoint can be inspected for consent, but only a running SDK may read data.
    if (
      !prepared.messageScope ||
      messageScope(local, context, input) !== prepared.messageScope ||
      !repo.caller(
        context.botId,
        context.runId,
        context.messageId,
        context.conversationId ?? "",
        context.groupId,
        context.threadId,
      )
    )
      throw new ExecError("invalid_input");
  };
  assertCaller();
  if (input.mode === "search")
    return searchMessages(local, context, input, signal, output, () => {
      assertCaller();
      if (!authorizationStillValid()) throw new ExecError("invalid_input");
    });
  return readPage(local, context, input, repo, signal, assertCaller);
}

function readPage(
  local: LocalService,
  context: ToolRunContext,
  input: Exclude<ReadMessagesInput, { mode: "search" }>,
  repo: ReadMessagesRepo,
  signal: AbortSignal,
  revalidate: () => void,
) {
  const limit = input.limit ?? (input.mode === "list" ? 20 : 50);
  const raw =
    input.mode === "list"
      ? repo.conversations(context.botId, input, signal)
      : repo.messages(context.botId, input.conversationId, input, signal);
  const attachments =
    input.mode === "messages"
      ? repo.attachments(
          context.botId,
          input.conversationId,
          raw.slice(0, limit).map((r) => String(r.id)),
        )
      : new Map<string, Attachment[]>();
  const safe = (value: unknown, max: number) =>
    local.deps.redactor
      .redact(String(value ?? ""))
      .slice(0, max)
      .replace(/[\uD800-\uDBFF]$/u, "");
  const items: Record<string, unknown>[] = [];
  let bytes = 1024;
  for (const { importSource, createdAt, ...row } of raw.slice(0, limit)) {
    signal.throwIfAborted();
    const content = local.deps.redactor.redact(String(row.content ?? ""));
    const importedFrom = historyImport(importSource, createdAt);
    const item =
      input.mode === "list"
        ? { ...row, title: safe(row.title, 200), importedFrom }
        : {
            id: row.id,
            role: row.role,
            botId: row.botId,
            content: safe(content, 4000),
            createdAt,
            importedFrom,
            truncated: !!row.truncated || content.length > 4000,
            attachments: (attachments.get(String(row.id)) ?? []).map((a) => ({
              ...a,
              name: safe(a.name, 200),
              mimeType: safe(a.mimeType, 256),
            })),
          };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > 64 * 1024) break;
    bytes += size;
    items.push(item);
  }
  const hasMore = raw.length > items.length,
    nextBefore = hasMore ? String(items.at(-1)?.id ?? "") : null;
  const value = ReadMessagesResultSchema.parse(
    input.mode === "list"
      ? { mode: "list", conversations: items, nextBefore }
      : { mode: "messages", conversationId: input.conversationId, messages: items, nextBefore },
  );
  revalidate();
  local.approvals.audit.append({
    botId: context.botId,
    runId: context.runId,
    kind: "messages.read",
    summary: "Read permitted chat history / 读取获准聊天历史",
    detail: {
      category: "read_messages",
      toolName: "read_messages",
      target: input.mode === "messages" ? input.conversationId : "readable_conversations",
      messageCount: input.mode === "messages" ? items.length : 0,
      conversationCount: input.mode === "list" ? items.length : 1,
      reasonCode: "done",
    },
  });
  return {
    text: historyReferenceText(
      JSON.stringify(value),
      items.some((item) => item.importedFrom),
    ),
    summary: "read_messages",
  };
}
