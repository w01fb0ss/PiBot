import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import { abortable, ConnectorToolError, type ToolRunContext } from "@pibot/brain/kit";
import { applyEdits, ExecError, textDiff } from "@pibot/execution";
import { type ApprovalFact, ConnectorCallError } from "@pibot/plugins-contract/full";
import type { PolicyRequest } from "@pibot/policy";
import {
  type CallAuthorization,
  type KnowledgeToolContext,
  type KnowledgeToolDeps,
  knowledgeCode,
  selectSources,
} from "./common.ts";
import { NotionBusy, type NotionPage } from "./notion.ts";
import { notionWriteTarget } from "./notion-write.ts";
import { firstHeading, obsidianVault } from "./obsidian.ts";
import { applyVaultWrite, vaultWriteSnapshot, vaultWriteTarget } from "./obsidian-write.ts";
import {
  type KnowledgeWriteInput,
  type KnowledgeWriteTool,
  parseKnowledgeWrite,
  writeError,
} from "./write-input.ts";

const WRITE_TOOLS = ["knowledge_create", "knowledge_update", "knowledge_delete"] as const;
const CONFIRM = "knowledge_write_confirmation";
const MAX_RECENT_PAGES = 64;
type Source = ReturnType<typeof selectSources>[number];
interface ApprovedWrite {
  write: (
    signal: AbortSignal,
    assertCurrent: () => void,
    recordInputTranslation?: (text: string) => void,
  ) => Promise<{ ref: string; warnings?: boolean }>;
  source: Source;
  input: KnowledgeWriteInput;
  ref: string;
  previousBytes: number;
  bytes: number;
}

function errorCode(error: unknown): string {
  if (error instanceof ExecError) {
    if (["file_conflict", "file_not_found"].includes(error.code)) return "knowledge_conflict";
    if (error.code === "outside_workplace") return "knowledge_path_invalid";
    return error.code;
  }
  if (error instanceof ConnectorCallError) {
    if (error.outcome === "unknown") return "knowledge_outcome_unknown";
    if (error.reason === "rate_limited") return "knowledge_busy";
  }
  const code =
    error instanceof ConnectorCallError
      ? (error.reason ?? "knowledge_notion_failed")
      : knowledgeCode(error);
  if (code === "rate_limited" || code === "knowledge_busy") return "knowledge_busy";
  return [
    "connector_unavailable",
    "connector_auth_required",
    "connector_tool_denied",
    "connector_args_invalid",
    "connector_not_assigned",
    "restricted_resource",
    "object_not_found",
    "unauthorized",
    "forbidden",
  ].includes(code)
    ? "knowledge_write_unavailable"
    : code;
}

export function knowledgeWrites(ctx: KnowledgeToolContext, deps: KnowledgeToolDeps) {
  const pending = new Map<string, Promise<unknown>>();
  const recent = new Map<string, NotionPage>();
  const recentKey = (context: ToolRunContext, source: Source, ref: string) =>
    JSON.stringify([
      context.botId,
      context.groupId,
      source.source.id,
      source.source.updatedAt,
      ref.replaceAll("-", "").toLowerCase(),
    ]);
  const selected = (context: ToolRunContext, selector: string) => {
    const entries = selectSources(deps.repo, context, selector);
    const entry = entries[0];
    if (entries.length !== 1 || !entry) writeError("knowledge_write_disabled");
    return entry;
  };
  const redact = (value: string) => ctx.local.deps.redactor.redact(value);

  async function execute(
    context: ToolRunContext,
    call: LocalToolCall,
    signal: AbortSignal,
    authorization: CallAuthorization | undefined,
  ): Promise<LocalToolResult> {
    if (!authorization) writeError("knowledge_source_changed");
    const plan = authorization.data as ApprovedWrite | undefined;
    if (!plan?.write) writeError("knowledge_source_changed");
    const id = plan.source.source.id;
    const previous = pending.get(id) ?? Promise.resolve();
    const assertCurrent = () => {
      signal.throwIfAborted();
      authorization.assertCurrent();
      const now = selected(context, id);
      if (
        !now.source.writable ||
        now.source.updatedAt !== plan.source.source.updatedAt ||
        JSON.stringify(now.config) !== JSON.stringify(plan.source.config)
      )
        writeError("knowledge_source_changed");
    };
    const task = previous
      .catch(() => {
        // A failed write must release the library for the next queued write.
      })
      .then(async () => {
        assertCurrent();
        const result = await plan.write(
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          assertCurrent,
          authorization.recordInputTranslation,
        );
        recent.delete(recentKey(context, plan.source, plan.ref));
        ctx.local.approvals.audit.append({
          kind: "file.written",
          summary: "Knowledge library write / 写入知识库",
          botId: context.botId,
          runId: context.runId,
          detail: {
            toolName: call.tool,
            toolCallId: call.id,
            target: id,
            knowledgeWrite: {
              action: plan.input.action,
              ref: redact(result.ref).slice(0, 1000),
              previousBytes: plan.previousBytes,
              bytes: plan.bytes,
            },
          },
        });
        deps.repo.markUsed([id]);
        return {
          text: JSON.stringify({
            source: plan.source.source.name,
            action: plan.input.action,
            ...result,
          }),
        };
      });
    pending.set(id, task);
    void task
      .finally(() => {
        if (pending.get(id) === task) pending.delete(id);
      })
      .catch(() => {
        // The caller below receives the original task's failure.
      });
    try {
      return await abortable(task, signal);
    } catch (error) {
      signal.throwIfAborted();
      const code = errorCode(error);
      const retryAfter =
        error instanceof NotionBusy ||
        error instanceof ConnectorCallError ||
        error instanceof ConnectorToolError
          ? error.retryAfter
          : undefined;
      return {
        isError: true,
        text:
          writeErrorText(code) + (retryAfter === undefined ? "" : ` (retry-after: ${retryAfter}s)`),
        details: {
          errorCode: code,
          ...(plan.source.config.kind === "notion" && code === "knowledge_write_unavailable"
            ? { settingsAction: { kind: "open_knowledge", sourceId: id } }
            : {}),
        },
      };
    }
  }
  for (const name of WRITE_TOOLS) ctx.executor(name, execute);

  return {
    remember(context: ToolRunContext, source: Source, page: NotionPage) {
      if (!source.source.writable || page.object !== "page" || !page.version) return;
      const key = recentKey(context, source, page.ref);
      recent.delete(key);
      recent.set(key, page);
      if (recent.size > MAX_RECENT_PAGES) {
        const expired = recent.keys().next().value;
        if (expired !== undefined) recent.delete(expired);
      }
    },
    async prepare(
      context: ToolRunContext,
      call: LocalToolCall,
      tool: KnowledgeWriteTool,
      args: unknown,
      caller: AbortSignal,
    ) {
      const signal = AbortSignal.any([caller, AbortSignal.timeout(20_000)]);
      let source: Source | undefined;
      try {
        const input = parseKnowledgeWrite(tool, args);
        source = selected(context, input.source);
        if (!source.source.writable) writeError("knowledge_write_disabled");
        // Every knowledge write (create, update, delete) requires an explicit per-edit
        // preview/confirmation card so ordinary Notion or local edits never bypass confirmation.
        const base = { primary: true, confirmation: CONFIRM };
        const approval = (
          ref: string,
          title: string,
          before: string | null,
          after: string | null,
          write: ApprovedWrite["write"],
        ) => {
          const targetSource = source as Source;
          return preview(
            { source: targetSource, input, ref, title, before, after, write },
            signal,
            redact,
          );
        };
        if (source.config.kind === "notion") {
          const notionSource = source;
          const connectorId = source.config.connectorId;
          const target = notionWriteTarget(ctx, deps, context, call, connectorId, input);
          return {
            ...base,
            requests: target.requests,
            binding: JSON.stringify([
              notionSource.source.id,
              notionSource.source.updatedAt,
              target.binding,
            ]),
            inspect: async () => {
              try {
                const before =
                  input.action === "create"
                    ? undefined
                    : recent.get(recentKey(context, notionSource, target.ref));
                if (input.action !== "create" && before?.version !== input.expectedVersion)
                  writeError("knowledge_conflict");
                const text = before?.markdown ?? null;
                if (input.action === "update" && text === null)
                  writeError("knowledge_write_unavailable");
                const after = await updatedContent(input, text, signal);
                return await approval(
                  target.ref,
                  before?.title ?? (input.action === "create" ? input.title : target.ref),
                  text,
                  after,
                  (signal, assertCurrent, recordInputTranslation) =>
                    target.apply(after, before, signal, assertCurrent, recordInputTranslation),
                );
              } catch (error) {
                caller.throwIfAborted();
                return { refusal: errorCode(error) };
              }
            },
          };
        }
        if (input.action === "delete" && !ctx.local.deps.host.knowledge?.trashNote)
          writeError("knowledge_trash_unavailable");
        const target = await vaultWriteTarget(obsidianVault(source.config), input, signal);
        const requests: PolicyRequest[] = [
          { category: "write_file", path: target.path, knowledgeRoot: target.root.path },
        ];
        return {
          ...base,
          requests,
          binding: JSON.stringify([
            source.source.id,
            source.source.updatedAt,
            target.root.identity,
          ]),
          inspect: async () => {
            try {
              const version = input.action === "create" ? null : input.expectedVersion;
              const prior = await vaultWriteSnapshot(target, version, signal);
              // A vault's title is its first heading, so keep a supplied title when the body has none.
              const after =
                input.action === "create" && !firstHeading(input.content)
                  ? `# ${input.title}\n\n${input.content}`
                  : await updatedContent(input, prior.text, signal);
              return await approval(
                target.ref,
                input.action === "create" ? input.title : prior.title,
                prior.text,
                after,
                async (signal, assertCurrent) => {
                  if (after !== null) {
                    if (ctx.local.deps.redactor.contains(after).length)
                      writeError("secret_write_out");
                    await applyVaultWrite(target, after, version, signal, assertCurrent);
                  } else {
                    const trash = ctx.local.deps.host.knowledge?.trashNote;
                    if (!trash || version === null) writeError("knowledge_trash_unavailable");
                    await vaultWriteSnapshot(target, version, signal);
                    assertCurrent();
                    await trash(
                      {
                        vault: { path: target.root.path, ...target.root.identity },
                        relativePath: target.ref,
                        expectedVersion: version,
                      },
                      signal,
                    );
                  }
                  return { ref: target.ref };
                },
              );
            } catch (error) {
              caller.throwIfAborted();
              return { refusal: errorCode(error) };
            }
          },
        };
      } catch (error) {
        caller.throwIfAborted();
        const code = errorCode(error);
        return {
          primary: true,
          requests: [],
          refusal: code,
          ...(code === "knowledge_vault_changed" && source
            ? {
                settingsAction: {
                  kind: "repoint_knowledge" as const,
                  sourceId: source.source.id,
                },
              }
            : source?.config.kind === "notion" &&
                (code === "knowledge_write_unavailable" || code === "knowledge_write_disabled")
              ? {
                  refusalText: writeErrorText(code),
                  settingsAction: { kind: "open_knowledge" as const, sourceId: source.source.id },
                }
              : {}),
        };
      }
    },
  };
}

async function updatedContent(
  input: KnowledgeWriteInput,
  before: string | null,
  signal: AbortSignal,
) {
  if (input.action === "delete") return null;
  if (input.action === "create") return input.content;
  return (
    input.content ?? (await applyEdits(before ?? "", input.edits ?? [], signal)).toString("utf8")
  );
}

async function preview(
  options: {
    source: Source;
    input: KnowledgeWriteInput;
    ref: string;
    title: string;
    before: string | null;
    after: string | null;
    write: ApprovedWrite["write"];
  },
  signal: AbortSignal,
  redact: (value: string) => string,
) {
  const { source, input, ref, title, before, after, write } = options;
  const facts: ApprovalFact[] = [
    { kind: "write", labelKey: "library", value: redact(source.source.name) },
    { kind: "write", labelKey: "note", value: `${redact(title).slice(0, 200)} · ${redact(ref)}` },
  ];
  if (after === null) {
    facts.push({ kind: "warning", value: "knowledge_move_to_trash" });
  } else {
    // Redact before the bounded diff so truncation cannot show a secret prefix.
    const diff = await textDiff(
      redact(ref),
      before === null ? null : redact(before),
      redact(after),
      signal,
    );
    if (diff) facts.push({ kind: "write", labelKey: "diff", value: diff });
  }
  const prepared: ApprovedWrite = {
    source,
    input,
    ref,
    write,
    previousBytes: Buffer.byteLength(before ?? ""),
    bytes: Buffer.byteLength(after ?? ""),
  };
  return { facts, prepared };
}

function writeErrorText(code: string) {
  switch (code) {
    case "knowledge_conflict":
      return "knowledge_conflict: 内容已经变了，请先重新读取 / The note changed. Read it again before retrying.";
    case "knowledge_busy":
      return "knowledge_busy: 知识库繁忙，请稍后重试 / The library is busy. Retry after the suggested wait.";
    case "knowledge_write_unavailable":
      return "knowledge_write_unavailable: 请打开知识库详情，查看当前支持的 Notion 操作和页面授权 / Open the library details to check which Notion actions are available and manage page access.";
    case "knowledge_write_disabled":
      return "knowledge_write_disabled: 请打开知识库详情，查看是否可以开启编辑 / Open the library details to see whether editing can be enabled.";
    case "knowledge_trash_unavailable":
      return "knowledge_trash_unavailable: 系统废纸篓不可用 / The system Trash is unavailable.";
    case "knowledge_outcome_unknown":
      return "knowledge_outcome_unknown: 请检查 Notion 中的实际结果，再决定是否重试 / Check the result in Notion before retrying.";
    default:
      return code;
  }
}
