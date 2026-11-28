import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { SandboxBlock } from "@pibot/execution";
import {
  LISTED_OUTSIDE_SANDBOX_REASON,
  OUTSIDE_SANDBOX_REASON,
  OUTSIDE_WRITE_REASON,
} from "@pibot/policy";
import type { Approval } from "@pibot/protocol-base";
import { ChatNoticesRepo } from "@pibot/storage";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import { runPermissionScope } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { isWebsitePermissionDomain } from "./policy-website-notices.ts";

export function recordSandboxNotices(
  local: LocalService,
  context: ToolRunContext,
  prepared: PreparedTool,
  block: SandboxBlock,
  retrySignal?: AbortSignal,
) {
  const registry = context.sandboxBlocks;
  const conversationId = context.conversationId;
  const input = prepared.call.input as { command?: unknown; cwd?: string };
  const command = input.command;
  if (!registry || !conversationId || typeof command !== "string") return;
  const repo = new ChatNoticesRepo(local.deps.db);
  const analyzed = prepared.result.analysis?.commands?.[0]?.program;
  const program =
    analyzed &&
    local.deps.redactor
      .redact(basename(analyzed.replaceAll("\\", "/")))
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .slice(0, 128);
  // An unrecognized rule next to a recognized one is noise (Go's sysctl-read beside trustd).
  const named = block.items.some((item) => item.kind !== "other");
  let retry: Promise<boolean> | undefined;
  for (const item of block.items) {
    if (named && item.kind === "other") continue;
    const domain =
      item.kind === "network" &&
      item.rule === "proxy_denied" &&
      item.networkDomain &&
      isWebsitePermissionDomain(item.networkDomain) &&
      local.deps.redactor.redact(item.networkDomain) === item.networkDomain &&
      !prepared.docker &&
      (!prepared.boundary?.location || prepared.boundary.location.target === "local")
        ? item.networkDomain
        : undefined;
    if (registry.noticeRecorded(item.kind, item.rule, domain)) continue;
    const groupId = domain ? runPermissionScope(local, context) : undefined;
    const target = local.deps.redactor
      .redact(item.target)
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .slice(0, 256);
    const rule = item.rule.replace(/[^A-Za-z0-9_.:/-]/g, "_").slice(0, 128);
    // Truncating the plain fallback must not make different long hosts hit the unique index.
    const key = domain ? ` ${createHash("sha256").update(domain).digest("hex").slice(0, 16)}` : "";
    const record = (retryUntil?: string) =>
      repo.addSandboxBlock({
        botId: context.botId,
        runId: context.runId,
        conversationId,
        // agent_warning text is unique per conversation (migration 0169, one agent start warning per
        // topic). A sandbox note is once per run, so the run id keeps the same block in a later turn
        // from hitting that index and failing the command (seen in acceptance: adb,
        // ERR_SQLITE_ERROR).
        // The text is only the plain fallback; the chat renders the sandbox fields.
        text: `Sandbox blocked (run ${context.runId}${key}): ${item.kind} ${target} (${rule})`.slice(
          0,
          300,
        ),
        sandbox: {
          toolCallId: prepared.call.id,
          kind: item.kind,
          rule,
          target: target || "sandbox",
          ...(program ? { program } : {}),
          ...(domain
            ? {
                website: {
                  domain,
                  ...(groupId ? { groupId } : {}),
                  ...(retryUntil ? { retryUntil } : {}),
                },
              }
            : {}),
        },
      });
    const publish = (notice: NonNullable<ReturnType<typeof record>>) => {
      registry.rememberNotice(
        item.kind,
        item.rule,
        notice.id,
        { command, cwd: input.cwd },
        prepared.cwd,
        domain,
      );
      local.deps.peer.emit("chat.notice", notice);
    };
    if (retrySignal && domain && !retry && block.items.length === 1) {
      retry = local.websiteRetries.wait(retrySignal, record, publish);
    } else {
      const notice = record();
      if (notice) publish(notice);
    }
  }
  return retry;
}

export function linkSandboxApproval(
  local: LocalService,
  context: ToolRunContext,
  prepared: PreparedTool,
  approval: Approval,
) {
  const input = prepared.call.input as { command?: unknown; cwd?: string };
  if (
    prepared.call.tool !== "run_command" ||
    ![
      OUTSIDE_SANDBOX_REASON,
      LISTED_OUTSIDE_SANDBOX_REASON,
      OUTSIDE_WRITE_REASON,
      "local_service_once",
      "system_service_once",
    ].includes(prepared.result.reason) ||
    typeof input.command !== "string" ||
    !context.conversationId ||
    approval.runId !== context.runId ||
    approval.conversationId !== context.conversationId ||
    approval.botId !== context.botId
  )
    return;
  const ids =
    context.sandboxBlocks?.noticeIds({ command: input.command, cwd: input.cwd }, prepared.cwd) ??
    [];
  const repo = new ChatNoticesRepo(local.deps.db);
  for (const id of ids) {
    const notice = repo.linkSandboxApproval(
      id,
      context.runId,
      context.conversationId,
      approval.id,
      approval.toolCallId,
    );
    if (notice) local.deps.peer.emit("chat.notice", notice);
  }
}
