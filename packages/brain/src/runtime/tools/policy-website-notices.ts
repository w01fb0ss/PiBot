import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { DomainSchema } from "@pibot/protocol-base";
import { ChatNoticesRepo } from "@pibot/storage";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import { runPermissionScope } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { WEBSITE_RETRY } from "./command-guidance.ts";

/** A saved DNS name never grants access to its resolved private addresses. */
export function isWebsitePermissionDomain(domain: string) {
  const parsed = DomainSchema.safeParse(domain);
  return (
    parsed.success &&
    parsed.data === domain &&
    !isIP(domain) &&
    domain.includes(".") &&
    /\.[a-z][a-z0-9-]*$/.test(domain) &&
    !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(domain)
  );
}

/** Policy can stop a command before a sandbox exists; this is not outside-sandbox evidence. */
export function policyWebsiteGuidance(
  local: LocalService,
  context: ToolRunContext,
  prepared: PreparedTool,
  retrySignal?: AbortSignal,
): { help: string; retry?: Promise<boolean> } {
  const conversationId = context.conversationId;
  const input = prepared.call.input as { outsideSandbox?: unknown; docker?: unknown };
  if (
    prepared.call.tool !== "run_command" ||
    prepared.result.decision !== "deny" ||
    prepared.result.reason !== "domain_not_allowed" ||
    prepared.settings.network.allowAll ||
    !conversationId ||
    prepared.docker ||
    input.docker === true ||
    (prepared.boundary?.location && prepared.boundary.location.target !== "local") ||
    input.outsideSandbox === true
  )
    return { help: "" };
  const domains = [...new Set(prepared.result.analysis?.domains ?? [])].filter(
    (domain) =>
      !prepared.settings.network.domains.includes(domain) &&
      isWebsitePermissionDomain(domain) &&
      local.deps.redactor.redact(domain) === domain,
  );
  if (!domains.length) return { help: "" };
  const groupId = runPermissionScope(local, context);
  const repo = new ChatNoticesRepo(local.deps.db);
  const record = (domain: string, retryUntil?: string) => {
    const key = createHash("sha256").update(domain).digest("hex").slice(0, 16);
    return repo.addSandboxBlock({
      botId: context.botId,
      runId: context.runId,
      conversationId,
      text: `Network settings blocked (run ${context.runId} ${key}): ${domain}`.slice(0, 300),
      sandbox: {
        toolCallId: prepared.call.id,
        kind: "network",
        rule: "domain_not_allowed",
        target: domain,
        website: { domain, ...(groupId ? { groupId } : {}), ...(retryUntil ? { retryUntil } : {}) },
      },
    });
  };
  const publish = (notice: NonNullable<ReturnType<typeof record>>) =>
    local.deps.peer.emit("chat.notice", notice);
  const domain = domains.length === 1 ? domains[0] : undefined;
  const help = `\n${WEBSITE_RETRY}`;
  if (
    domain &&
    retrySignal &&
    prepared.commandSkill &&
    !context.routineSource &&
    local.deps.platform !== "win32" &&
    !(prepared.call.input as { background?: boolean }).background
  ) {
    return {
      help,
      retry: local.websiteRetries.wait(retrySignal, (until) => record(domain, until), publish),
    };
  }
  for (const candidate of domains) {
    const notice = record(candidate);
    if (notice) publish(notice);
  }
  return { help };
}
