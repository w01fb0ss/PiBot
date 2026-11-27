import { win32 } from "node:path";
import type { LocalToolCall } from "@pibot/agent";
import type { PolicyResult } from "@pibot/policy";
import type { AuditDetail, CapabilityToolRegistry } from "@pibot/protocol-base";
import { CHAT_SEARCH_TARGET } from "@pibot/protocol-base";
import type { Redactor } from "@pibot/secrets";
import { toolPermissionCategory } from "./tool-category.ts";

export function auditText(value: string, redactor: Pick<Redactor, "redact">, limit = 200) {
  const safe = redactor.redact(
    redactor
      .redact(value)
      .replace(/https?:\/\/[^\s]+/giu, (site) => {
        try {
          return new URL(site).hostname;
        } catch {
          return "";
        }
      })
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
  return safe.length <= limit
    ? safe
    : `${safe.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}
const tools = new Set([
  "browser_network",
  "browser_request",
  "browser_secret",
  "office_inspect",
  "office_read",
  "office_create",
  "office_edit",
  "office_preview",
  "office_validate",
  "office_render",
  "office_capabilities",
  "office_convert",
  "tool_discover",
  "connector_discover",
  "connector_call",
  "read_messages",
  "skill_propose",
  "check_command_propose",
  "run_command",
  "read_file",
  "send_file",
  "reveal_in_folder",
  "list_dir",
  "find_files",
  "search_text",
  "write_file",
  "edit_file",
  "apply_patch",
  "web_fetch",
  "web_search",
  "image_generation",
  "image_result",
  "assign_task",
  "group_plan",
  "ask_bot",
  "finish_task",
  "group_pause",
  "project_notes",
  "memory_add",
  "memory_update",
  "memory_remove",
]);
export function auditProviderName(id: string): string | undefined {
  return (
    {
      anthropic: "Claude Pro/Max",
      "openai-codex": "ChatGPT",
      "openai-chatgpt": "ChatGPT",
      "chatgpt-codex": "ChatGPT (Codex)",
      "github-copilot": "GitHub Copilot",
      brave: "Brave",
      tavily: "Tavily",
      keenable: "Keenable",
      searxng: "SearXNG",
      duckduckgo: "DuckDuckGo",
      bing: "Microsoft Bing",
    } as Record<string, string>
  )[id];
}
export function auditLeaf(value: string, redactor: Pick<Redactor, "redact">) {
  // Derive metadata only after masking, so truncation/path splitting cannot expose a partial key.
  return auditText(win32.basename(auditText(value, redactor, 32768)), redactor);
}
export function auditToolFields(
  call: Pick<LocalToolCall, "tool" | "input">,
  redactor: Pick<Redactor, "redact">,
  result?: Pick<PolicyResult, "analysis" | "facts" | "path" | "domain" | "url"> & {
    category?: AuditDetail["category"];
  } & Partial<Pick<PolicyResult, "explanation" | "commandHome">>,
  registry: CapabilityToolRegistry = { specs: {}, groups: [] },
): AuditDetail {
  const detail: AuditDetail = result
    ? { policySteps: (result.explanation ?? []).map((step) => step.code) }
    : {};
  const tool = call.tool === "web" ? "web_fetch" : call.tool;
  if (tools.has(tool) || Object.hasOwn(registry.specs, tool)) detail.toolName = tool;
  const category = result?.category ?? toolPermissionCategory(tool, registry);
  if (category) detail.category = category;
  const input =
    call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  if (tool === "browser_secret" || tool === "browser_request") {
    if (typeof input.origin === "string") detail.target = auditText(input.origin, redactor);
    detail.reason = auditText(
      [input.kind ?? input.method, input.name]
        .filter((value) => typeof value === "string")
        .join(": "),
      redactor,
    );
  } else if (tool === "connector_call" || tool === "connector_discover") {
    if (typeof input.connectorId === "string" && /^[a-f0-9-]{36}$/i.test(input.connectorId))
      detail.connectorId = input.connectorId;
    if (
      typeof input.catalogVersion === "number" &&
      Number.isSafeInteger(input.catalogVersion) &&
      input.catalogVersion >= 0
    )
      detail.catalogVersion = input.catalogVersion;
    if (tool === "connector_call" && typeof input.tool === "string")
      detail.target = auditText(input.tool, redactor);
  } else if (tool === "read_messages") {
    const target = input.mode === "messages" ? input.conversationId : "readable_conversations";
    if (input.mode === "search") detail.target = CHAT_SEARCH_TARGET;
    else if (
      typeof target === "string" &&
      /^(?:readable_conversations|[a-f0-9-]{36})$/i.test(target)
    )
      detail.target = target;
  } else if (tool === "image_generation") {
    if (typeof input.provider === "string") detail.providerId = auditText(input.provider, redactor);
    if (typeof input.model === "string") detail.modelId = auditText(input.model, redactor);
    if (input.mode === "text-to-image" || input.mode === "image-to-image")
      detail.imageMode = input.mode;
    if (typeof input.recipient === "string") {
      try {
        const url = new URL(`https://${input.recipient}`);
        if (
          !url.username &&
          !url.password &&
          !url.port &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        )
          detail.target = auditText(url.hostname, redactor);
      } catch {
        // A malformed recipient yields no target, never a raw URL or request body.
      }
    }
  } else if (tool === "image_result") {
    const images = result?.facts.filter((fact) => fact.kind === "read") ?? [];
    detail.imageCount = images.length;
    detail.target = auditText(images.map((fact) => fact.value).join(", "), redactor) || undefined;
  } else if (tool === "write_stdin") {
    if (typeof input.id === "string") detail.target = input.id;
    if (typeof input.text === "string") detail.bytes = Buffer.byteLength(input.text);
  } else if (tool === "run_command") {
    if (result?.commandHome) detail.commandHome = auditText(result.commandHome, redactor, 4096);
    for (const [field, kind] of [
      ["commandReads", "read"],
      ["commandWrites", "write"],
    ] as const) {
      const paths = result?.facts.filter((fact) => fact.kind === kind).slice(0, 16) ?? [];
      if (paths.length) detail[field] = paths.map((fact) => auditText(fact.value, redactor, 4096));
    }
    if (input.docker === true) detail.reasonCode = "docker_access";
    const programs =
      result?.analysis?.programs ??
      result?.facts.filter((fact) => fact.kind === "program").map((fact) => fact.value) ??
      [];
    detail.programs = [
      ...new Set(programs.slice(0, 3).map((name) => auditLeaf(name, redactor))),
    ].filter((name) => /^[\p{L}\p{N}_.+-]+$/u.test(name));
    if (detail.programs.length) detail.target = auditText(detail.programs.join(", "), redactor);
  } else if (
    [
      "send_file",
      "reveal_in_folder",
      "read_file",
      "list_dir",
      "find_files",
      "search_text",
      "project_notes",
      "write_file",
      "edit_file",
      "apply_patch",
      "office_inspect",
      "office_read",
      "office_create",
      "office_edit",
      "office_preview",
      "office_validate",
      "office_render",
    ].includes(tool)
  ) {
    const path =
      result?.path?.path ??
      input.path ??
      result?.facts.find((fact) => fact.kind === "read" || fact.kind === "write")?.value;
    if (typeof path === "string") detail.target = auditLeaf(path, redactor) || undefined;
  } else if (tool === "web_fetch") {
    const site = result?.domain ?? result?.url ?? input.url;
    if (typeof site === "string") {
      try {
        const safe = redactor.redact(site);
        const url = new URL(result?.domain ? `https://${safe}` : safe);
        if (["http:", "https:"].includes(url.protocol))
          detail.target = auditText(url.hostname, redactor);
      } catch {
        // Masked/malformed URLs have no safe domain; never fall back to a URL containing a query.
      }
    }
  }
  return detail;
}
export function collaborationAuditFields(options: {
  action: NonNullable<AuditDetail["collaborationAction"]>;
  botName?: string;
  targetBotName?: string;
  taskTitle?: string;
  actor?: AuditDetail["actor"];
  botRole?: AuditDetail["botRole"];
  redactor: Pick<Redactor, "redact">;
}): AuditDetail {
  const fields: AuditDetail = { collaborationAction: options.action };
  for (const key of ["botName", "targetBotName", "taskTitle"] as const) {
    const value = options[key];
    if (value) fields[key] = auditText(value, options.redactor) || undefined;
  }
  if (options.actor) fields.actor = options.actor;
  if (options.botRole) fields.botRole = options.botRole;
  if (options.action === "completion_wake") fields.internal = true;
  return fields;
}
