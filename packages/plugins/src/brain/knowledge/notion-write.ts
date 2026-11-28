import { setTimeout } from "node:timers/promises";
import type { LocalToolCall } from "@pibot/agent";
import {
  type ConnectorCallInput,
  dispatchReadConnector,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { connectorCallRequest } from "@pibot/policy";
import { TASK_TOOL } from "../../store/notion-tools.ts";
import type { KnowledgeToolContext, KnowledgeToolDeps } from "./common.ts";
import {
  assertNotionReply,
  fetchNotionPage,
  type NotionPage,
  payloadOf,
  READ_TOOLS,
  record,
  stringOf,
  WRITE_TOOLS,
} from "./notion.ts";
import { type KnowledgeWriteInput, writeError, writeRef } from "./write-input.ts";

const NOTION_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu;

export function notionWriteTarget(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  context: ToolRunContext,
  call: LocalToolCall,
  connectorId: string,
  input: KnowledgeWriteInput,
) {
  const ref = writeRef(input);
  if ((input.action === "create" && input.parent === undefined) || !NOTION_ID.test(ref))
    writeError("knowledge_path_invalid");
  const connector = deps.connectors.get(connectorId);
  if (!connector) writeError("knowledge_write_unavailable");
  const tools = deps.service.discoverToolsForBot(
    context.botId,
    { connectorId, limit: 100 },
    false,
    context.groupId,
    true,
  ).items;
  const write = tools.find((tool) => tool.tool === WRITE_TOOLS[input.action] && !tool.readOnly);
  const read = READ_TOOLS.map((name) =>
    tools.find((tool) => tool.tool === name && tool.readOnly),
  ).find((tool) => tool !== undefined);
  const task =
    input.action === "delete"
      ? undefined
      : tools.find((tool) => tool.tool === TASK_TOOL && tool.readOnly);
  if (!write || !read) writeError("knowledge_write_unavailable");
  const access = deps.connectors.access(connectorId);
  return {
    ref,
    binding: JSON.stringify([
      connectorId,
      connector.revision,
      connector.catalogVersion,
      read.tool,
      write.tool,
      task?.tool,
    ]),
    requests: [write, read, ...(task ? [task] : [])].map((tool) =>
      connectorCallRequest({ connector, access, tool }),
    ),
    async apply(
      content: string | null,
      before: NotionPage | undefined,
      signal: AbortSignal,
      assertCurrent: () => void,
      recordInputTranslation?: (text: string) => void,
    ) {
      const dispatch = async (
        name: string,
        args: Record<string, unknown>,
        current: AbortSignal,
      ) => {
        const connectorInput: ConnectorCallInput = {
          connectorId,
          catalogVersion: connector.catalogVersion,
          tool: name,
          args: args as ConnectorCallInput["args"],
        };
        const assertDispatch = () => {
          assertCurrent();
          if (deps.connectors.get(connectorId)?.revision !== connector.revision)
            writeError("knowledge_source_changed");
        };
        assertDispatch();
        if (name === write.tool) {
          if (ctx.local.deps.redactor.contains(args).length) writeError("secret_write_out");
          const approved = deps.service.resolveKnowledgeWrite(
            context.botId,
            connectorInput,
            context.groupId,
          );
          return deps.service.dispatchKnowledgeWrite(
            context.botId,
            connectorInput,
            approved,
            current,
            assertDispatch,
          );
        }
        const approved = deps.service.resolveTool(context.botId, connectorInput, context.groupId);
        return dispatchReadConnector(
          { local: ctx.local, context, assertDispatch, recordInputTranslation },
          { call, explanation: [] },
          connectorInput,
          approved,
          current,
        );
      };
      const page = await fetchNotionPage(
        ref,
        { signal, tools: () => tools, call: dispatch },
        read.tool,
      );
      if (input.action !== "create") {
        if (page.object !== "page" || !page.version) writeError("knowledge_write_unavailable");
        if (
          page.version !== input.expectedVersion ||
          (input.action === "update" && page.markdown !== before?.markdown)
        )
          writeError("knowledge_conflict");
      }
      let args: Record<string, unknown>;
      if (input.action === "create") {
        const parentField =
          page.object === "database"
            ? "database_id"
            : page.object === "data_source"
              ? "data_source_id"
              : "page_id";
        if (!page.object) writeError("knowledge_write_unavailable");
        args = {
          parent: { [parentField]: ref },
          pages: [{ properties: { title: input.title }, content }],
        };
      } else if (input.action === "update") {
        const old = before?.markdown;
        if (old === undefined) writeError("knowledge_write_unavailable");
        // One replacement keeps a patch atomic even on servers that skip individual missing edits.
        args =
          old && input.edits
            ? {
                page_id: ref,
                command: "update_content",
                content_updates: [{ old_str: old, new_str: content }],
              }
            : { page_id: ref, command: "replace_content", new_str: content };
      } else {
        args = { page_ids: [ref], user_confirmed: true };
      }
      let reply = await dispatch(write.tool, args, signal);
      assertNotionReply(reply);
      let result = record(payloadOf(reply).value);
      if (result?.object === "async_task") {
        const taskId = stringOf(result.id);
        if (!task || !taskId) writeError("knowledge_outcome_unknown");
        while (["queued", "running", "retrying"].includes(String(result?.status))) {
          const seconds = Math.min(10, Math.max(1, Number(result?.poll_after_seconds) || 2));
          await setTimeout(seconds * 1000, undefined, { signal });
          reply = await dispatch(task.tool, { task_id: taskId }, signal);
          assertNotionReply(reply);
          result = record(payloadOf(reply).value);
        }
        if (result?.status !== "succeeded") writeError("knowledge_outcome_unknown");
        result = record(result.result);
      }
      if (input.action === "create") {
        const pageId = Array.isArray(result?.pages) && stringOf(record(result.pages[0])?.id);
        if (!pageId || !NOTION_ID.test(pageId)) writeError("knowledge_outcome_unknown");
        return { ref: pageId, warnings: Array.isArray(result?.warnings) };
      }
      return { ref, warnings: Array.isArray(result?.warnings) };
    },
  };
}
