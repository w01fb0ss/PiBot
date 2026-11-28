/*
 * The two knowledge tools. Each call reads what the person assigned to this Bot or group
 * right now, merges every library into one answer, and reports a failing library inside the result
 * instead of failing the whole search: a Bot whose Notion connection expired can still quote the
 * vault.
 *
 * Reaching a library (vault permission, connector channel) lives in `access.ts`; the prepare-phase
 * policy requests live in `policy.ts`.
 */
import { isDeepStrictEqual } from "node:util";
import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { ToolRunContext } from "@pibot/brain/kit";
import {
  type KnowledgeConfig,
  KnowledgeReadInputSchema,
  KnowledgeSearchInputSchema,
  type KnowledgeSource,
  RpcError,
} from "@pibot/plugins-contract/full";
import { auditVaultRead, notionAccess, vaultAccess } from "./access.ts";
import {
  type CallAuthorization,
  CHANGED,
  DEFAULT_LIMIT,
  type Failure,
  type Item,
  type KnowledgeToolContext,
  type KnowledgeToolDeps,
  knowledgeCode,
  log,
  markUntrusted,
  noSourceText,
  selectSources,
  text,
  UNTRUSTED,
} from "./common.ts";
import { type NotionPage, readNotion, searchNotion } from "./notion.ts";
import {
  obsidianVault,
  openUrl,
  readNote,
  searchVault,
  type VaultRoot,
  vaultRoot,
} from "./obsidian.ts";
import type { knowledgeWrites } from "./write.ts";

export type { KnowledgeToolContext, KnowledgeToolDeps } from "./common.ts";

export function registerKnowledgeTools(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  writes?: ReturnType<typeof knowledgeWrites>,
): void {
  ctx.executor("knowledge_search", (context, call, signal, authorization) =>
    searchKnowledge(ctx, deps, context, call, signal, authorization),
  );
  ctx.executor("knowledge_read", (context, call, signal, authorization) =>
    readKnowledge(ctx, deps, context, call, signal, authorization, writes),
  );
}

async function searchKnowledge(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
  authorization: CallAuthorization | undefined,
): Promise<LocalToolResult> {
  const input = KnowledgeSearchInputSchema.parse(call.input);
  const assigned = selectSources(deps.repo, context, input.source);
  if (assigned.length === 0)
    return {
      text: noSourceText(deps.repo, context, input.source),
      isError: true,
      details: { errorCode: "knowledge_source_unavailable" },
    };
  const limit = input.limit ?? DEFAULT_LIMIT;
  const completed: {
    entry: (typeof assigned)[number];
    result: Awaited<ReturnType<typeof searchSource>>;
  }[] = [];
  let fetched = 0;
  const items: Item[] = [];
  const failures: Failure[] = [];
  const read: string[] = [];
  let truncatedReason: "results" | "scan_limit" | "byte_limit" | "time_limit" | undefined;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  let scannedPdf = 0;
  for (const entry of assigned) {
    signal.throwIfAborted();
    if (fetched >= limit) break;
    try {
      const found = await searchSource(
        ctx,
        deps,
        context,
        call,
        authorization,
        entry,
        input.query,
        signal,
        limit - fetched,
      );
      fetched += found.items.length;
      completed.push({ entry, result: found });
    } catch (error) {
      // A cancelled run is not a failing library: keep the cancellation, not a "source failed".
      signal.throwIfAborted();
      failures.push(searchFailure(entry.source, knowledgeCode(error)));
    }
  }
  // Other sources may have taken time after this source returned. Check the exact local roots
  // again, then check assignments and origins without another await before delivering any text.
  const checked = await Promise.all(
    completed.map(async ({ entry, result }) => {
      try {
        if (result.localRoot) await vaultRoot(result.localRoot, signal);
        return { entry, result };
      } catch (error) {
        signal.throwIfAborted();
        return { entry, result, error: knowledgeCode(error) };
      }
    }),
  );
  signal.throwIfAborted();
  authorization?.assertCurrent();
  const current = currentAssignments(deps, context);
  for (const { entry, result, error } of checked) {
    const live = current.get(entry.source.id);
    if (!live || !isDeepStrictEqual(live.config, entry.config)) {
      failures.push(searchFailure(entry.source, "knowledge_source_changed"));
      continue;
    }
    if (error) {
      failures.push(searchFailure(entry.source, error));
      continue;
    }
    items.push(...result.items);
    if (result.truncated && !truncatedReason) truncatedReason = result.truncated;
    skippedLarge += result.skippedLarge ?? 0;
    skippedUnreadable += result.skippedUnreadable ?? 0;
    scannedPdf += result.scannedPdf ?? 0;
    read.push(entry.source.id);
  }
  if (read.length > 0) deps.repo.markUsed(read);
  const vaultChangedFailure = failures.find(
    (failure) => failure.code === "knowledge_vault_changed",
  );
  const repointAction = vaultChangedFailure
    ? { kind: "repoint_knowledge" as const, sourceId: vaultChangedFailure.sourceId }
    : undefined;
  markUntrusted(context);
  log(ctx, "knowledge_search", {
    botId: context.botId,
    groupId: context.groupId,
    sources: assigned.length,
    hits: items.length,
    failures: failures.length,
    ...(truncatedReason ? { truncated: truncatedReason } : {}),
    ...(skippedLarge ? { skippedLarge } : {}),
    ...(skippedUnreadable ? { skippedUnreadable } : {}),
    ...(scannedPdf ? { scannedPdf } : {}),
  });
  // Preserve real scan/time/byte limits even when the hit list reached the requested limit.
  const effectiveTruncated =
    truncatedReason ?? (items.length >= limit ? ("results" as const) : undefined);
  const skipped =
    skippedLarge > 0 || skippedUnreadable > 0 || scannedPdf > 0
      ? {
          ...(skippedLarge > 0 ? { tooLarge: skippedLarge } : {}),
          ...(skippedUnreadable > 0 ? { unreadable: skippedUnreadable } : {}),
          ...(scannedPdf > 0 ? { scannedPdf } : {}),
        }
      : undefined;
  const failed = items.length === 0 && failures.length > 0;
  return {
    text: text([
      UNTRUSTED,
      JSON.stringify({
        query: input.query,
        items,
        ...(failures.length ? { errors: failures } : {}),
        ...(effectiveTruncated ? { truncated: effectiveTruncated } : {}),
        ...(skipped ? { skipped } : {}),
      }),
    ]),
    ...(failed ? { isError: true } : {}),
    details: {
      resultCount: items.length,
      ...(failures.length
        ? {
            errorCode: failed
              ? (vaultChangedFailure?.code ?? "knowledge_sources_failed")
              : "knowledge_partial_failure",
          }
        : {}),
      ...(repointAction ? { settingsAction: repointAction } : {}),
    },
  };
}

function currentAssignments(deps: KnowledgeToolDeps, context: ToolRunContext) {
  return new Map(
    deps.repo
      .assigned({ botId: context.botId, groupId: context.groupId })
      .map((entry) => [entry.source.id, entry]),
  );
}

function searchFailure(source: KnowledgeSource, code: string): Failure {
  return {
    source: source.name,
    sourceId: source.id,
    code,
    ...(code === "knowledge_source_changed"
      ? { message: CHANGED }
      : code === "knowledge_vault_changed"
        ? {
            message:
              "知识源文件夹已移动或同步变更，请点击重新选择文件夹 / The library folder moved or changed; choose the folder again.",
          }
        : {}),
  };
}

async function readKnowledge(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  context: ToolRunContext,
  call: LocalToolCall,
  signal: AbortSignal,
  authorization: CallAuthorization | undefined,
  writes?: ReturnType<typeof knowledgeWrites>,
): Promise<LocalToolResult> {
  const input = KnowledgeReadInputSchema.parse(call.input);
  const assigned = selectSources(deps.repo, context, input.source);
  if (assigned.length === 0)
    return {
      text: noSourceText(deps.repo, context, input.source),
      isError: true,
      details: { errorCode: "knowledge_source_unavailable" },
    };
  // A read is about one document: two libraries with the same name would silently pick one.
  if (assigned.length > 1)
    return {
      text: `知识库名称不唯一，请用 id 指定 / Ambiguous source; pass the id: ${assigned
        .map((entry) => `${entry.source.name} (${entry.source.id})`)
        .join(", ")}`,
      isError: true,
      details: { errorCode: "knowledge_source_ambiguous" },
    };
  const entry = assigned[0] as (typeof assigned)[number];
  let notionPage: NotionPage | undefined;
  let page: Awaited<ReturnType<typeof readObsidian>> | NotionPage;
  try {
    if (entry.config.kind === "notion") {
      notionPage = await readNotion(
        input.ref,
        notionAccess(ctx, deps, context, call, authorization, entry.config, signal),
      );
      page = notionPage;
    } else {
      page = await readObsidian(ctx, context, entry, input.ref, signal);
    }
  } catch (error) {
    signal.throwIfAborted();
    const code = knowledgeCode(error);
    if (code === "knowledge_vault_changed") {
      return {
        text: "知识源文件夹已移动或同步变更，请点击重新选择文件夹 / The library folder moved or changed; choose the folder again.",
        isError: true,
        details: {
          errorCode: "knowledge_vault_changed",
          settingsAction: { kind: "repoint_knowledge", sourceId: entry.source.id },
        },
      };
    }
    if (code !== "knowledge_source_changed") throw error;
    return { text: CHANGED, isError: true, details: { errorCode: "knowledge_source_changed" } };
  }
  const current = currentAssignments(deps, context).get(entry.source.id);
  if (!current || !isDeepStrictEqual(current.config, entry.config))
    return { text: CHANGED, isError: true, details: { errorCode: "knowledge_source_changed" } };
  signal.throwIfAborted();
  authorization?.assertCurrent();
  if (notionPage) writes?.remember(context, entry, notionPage);
  deps.repo.markUsed([entry.source.id]);
  markUntrusted(context);
  log(ctx, "knowledge_read", {
    botId: context.botId,
    groupId: context.groupId,
    sourceId: entry.source.id,
    kind: entry.source.kind,
    truncated: page.truncated,
  });
  return {
    details: { resultCount: 1 },
    text: text([
      UNTRUSTED,
      JSON.stringify({
        source: entry.source.name,
        kind: entry.source.kind,
        ref: page.ref,
        title: page.title,
        ...(page.url ? { url: page.url } : {}),
        truncated: page.truncated,
        ...(page.version ? { version: page.version } : {}),
        text: page.text,
      }),
    ]),
  };
}

async function searchSource(
  ctx: KnowledgeToolContext,
  deps: KnowledgeToolDeps,
  context: ToolRunContext,
  call: LocalToolCall,
  authorization: CallAuthorization | undefined,
  entry: { source: KnowledgeSource; config: KnowledgeConfig },
  query: string,
  signal: AbortSignal,
  limit: number,
): Promise<{
  items: Item[];
  truncated?: "results" | "scan_limit" | "byte_limit" | "time_limit";
  skippedLarge?: number;
  skippedUnreadable?: number;
  scannedPdf?: number;
  localRoot?: VaultRoot;
}> {
  const base = { source: entry.source.name, sourceId: entry.source.id };
  if (entry.config.kind === "obsidian" || entry.config.kind === "folder") {
    const found = await searchVault(
      obsidianVault(entry.config),
      query,
      await vaultAccess(ctx, context, signal),
      {
        db: deps.db,
        sourceId: entry.source.id,
        limit,
        redact: (text) => ctx.local.deps.redactor.redact(text),
      },
    );
    auditVaultRead(ctx, context, entry, "knowledge_search", found.hits.length);
    const kind = entry.config.kind;
    return {
      localRoot: found.root,
      items: found.hits.slice(0, limit).map((hit) => ({
        ...base,
        kind,
        title: hit.title,
        ref: hit.path,
        url: hit.url,
        line: hit.line,
        snippet: hit.snippet,
      })),
      ...(found.truncated ? { truncated: found.truncated } : {}),
      skippedLarge: found.skippedLarge,
      skippedUnreadable: found.skippedUnreadable,
      scannedPdf: found.scannedPdf ?? 0,
    };
  }
  const found = await searchNotion(
    query,
    notionAccess(ctx, deps, context, call, authorization, entry.config, signal),
  );
  return {
    items: found.hits.slice(0, limit).map((hit) => ({
      ...base,
      kind: "notion" as const,
      title: hit.title,
      ref: hit.ref,
      url: hit.url,
      snippet: hit.snippet,
    })),
  };
}

async function readObsidian(
  ctx: KnowledgeToolContext,
  context: ToolRunContext,
  entry: { source: KnowledgeSource; config: KnowledgeConfig },
  ref: string,
  signal: AbortSignal,
) {
  const config = entry.config;
  if (config.kind !== "obsidian" && config.kind !== "folder")
    throw new RpcError(-32602, "knowledge_source_missing");
  const note = await readNote(obsidianVault(config), ref, await vaultAccess(ctx, context, signal));
  auditVaultRead(ctx, context, entry, "knowledge_read", 1);
  return {
    ref: note.path,
    title: note.title,
    url: openUrl(config.path, note.path, entry.source.id),
    text: note.text,
    truncated: note.truncated,
    version: note.version,
  };
}
