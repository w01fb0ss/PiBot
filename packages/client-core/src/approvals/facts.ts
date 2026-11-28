import type { createTranslator, TranslationKey } from "@pibot/i18n";
import { isolationReasonText, runErrorText, zh } from "@pibot/i18n";
import { type Approval, type ApprovalFact, CHAT_SEARCH_TARGET } from "@pibot/protocol";

export { isolationReasonText, runErrorText };

function knownSystemServiceLabel(
  service: string | undefined,
  t: ReturnType<typeof createTranslator>,
): string | undefined {
  if (!service) return undefined;
  if (/^com\.apple\.trustd(?:\.|$)/.test(service)) return t("permissions.serviceTrust");
  if (service === "com.apple.system.opendirectoryd.libinfo")
    return t("permissions.serviceDirectory");
  if (service === "com.apple.system.notification_center")
    return t("permissions.serviceNotification");
  if (/^com\.apple\.(?:SecurityServer|securityd(?:\..+)?|security\..+|secd)$/.test(service))
    return t("permissions.serviceKeychain");
  if (/^com\.apple\.pasteboard(?:\.|$)/.test(service)) return t("permissions.servicePasteboard");
  return undefined;
}

/** Plain label for a macOS system service bundle ID (shared by approval cards, notices, settings). */
export function systemServiceLabel(
  service: string | undefined,
  t: ReturnType<typeof createTranslator>,
) {
  return knownSystemServiceLabel(service, t) ?? t("permissions.serviceUnknown");
}

const SANDBOX_RULE_ALIASES: Record<string, TranslationKey> = {
  ".git/hooks": "tool.sandboxRule.git_hooks",
  ".git/config": "tool.sandboxRule.git_config",
};

/** Localized plain explanation for a known sandbox block rule; undefined hides unknown internal codes. */
export function sandboxRuleText(
  rule: string,
  t: ReturnType<typeof createTranslator>,
  options?: { websiteNotAllowed?: boolean },
): string | undefined {
  if (rule === "proxy_denied") {
    return t(
      options?.websiteNotAllowed
        ? "tool.sandboxRule.proxy_not_allowed"
        : "tool.sandboxRule.proxy_denied",
    );
  }
  if (Object.hasOwn(SANDBOX_RULE_ALIASES, rule)) {
    const alias = SANDBOX_RULE_ALIASES[rule];
    if (alias) return t(alias);
  }
  const key = `tool.sandboxRule.${rule}`;
  return Object.hasOwn(zh, key) ? t(key as TranslationKey) : undefined;
}

const SANDBOX_PLACEHOLDER_TARGETS = new Set(["sandbox rule", "sandbox", "socket"]);

export function isDirectRunApproval(approval: Approval): boolean {
  return (
    approval.category === "run_command" &&
    (approval.directRunRemember !== undefined ||
      (approval.isolation.reason === "windows_unisolated" &&
        !approval.explanation?.some((step) => step.code === "docker_access")) ||
      approval.facts.some(
        (fact) =>
          fact.kind === "warning" &&
          (fact.value === "outside_sandbox" || fact.value === "sandbox_outside_auto"),
      ) ||
      (approval.explanation?.some(
        (step) => step.code === "outside_sandbox_once" || step.code === "sandbox_outside_command",
      ) ??
        false))
  );
}

/** Humanizes sandbox block targets such as `"sandbox rule"`, `"socket"` or macOS `com.apple.*` service IDs. */
export function sandboxTargetText(
  block: { kind: string; target: string },
  t: ReturnType<typeof createTranslator>,
): string {
  if (!block.target || SANDBOX_PLACEHOLDER_TARGETS.has(block.target)) return "";
  if (block.kind === "system_service") {
    const knownService = knownSystemServiceLabel(block.target, t);
    return knownService ? ` ${knownService}` : "";
  }
  return ` ${block.target}`;
}

/**
 * Windows delegated commands carry the same direct-run risk as local commands. Older approval
 * rows may have only the structured policy trace, since display facts can already be translated.
 */
export function isWindowsDirectRunApproval(
  approval: Pick<Approval, "category" | "facts" | "explanation" | "isolation">,
) {
  return (
    approval.category === "run_command" &&
    !approval.isolation.available &&
    !approval.explanation?.some((step) => step.code === "docker_access") &&
    (approval.isolation.reason === "windows_unisolated" ||
      approval.facts.some(
        (fact) => fact.kind === "warning" && fact.value === "windows_unisolated",
      ) ||
      (approval.explanation?.some(
        (step) =>
          step.code === "windows_unisolated" ||
          step.code === "windows_command_scan" ||
          step.code === "windows_ordinary_command" ||
          step.code === "windows_requires_approval",
      ) ??
        false))
  );
}

const warnings: Record<string, TranslationKey> = {
  command_network_confirmation: "policy.reason.command_network_confirmation",
  command_install_confirmation: "policy.reason.command_install_confirmation",
  command_background_confirmation: "policy.reason.command_background_confirmation",
  host_ssh_static_identity: "facts.value.host_ssh_static_identity",
  git_configuration_project_setter: "facts.value.git_configuration_project_setter",
  git_configuration_global_setter: "facts.value.git_configuration_global_setter",
  git_configuration_sensitive_project_setter:
    "facts.value.git_configuration_sensitive_project_setter",
  git_entry_once: "facts.value.git_entry_once",
  readonly: "facts.value.readonly",
  topic_writable_scope: "facts.value.topic_writable_scope",
  incomplete_analysis: "facts.value.incomplete_analysis",
  windows_unisolated: "facts.value.windows_unisolated",
  outside_sandbox: "facts.value.outside_sandbox",
  outside_sandbox_login: "facts.value.outside_sandbox_login",
  system_service: "facts.value.system_service",
  local_service: "facts.value.local_service",
  sandbox_outside_auto: "permissions.sandboxRememberedOutside",
  acp_editor_terminal_unisolated: "facts.value.acp_editor_terminal_unisolated",
  editor_session_rememberable: "facts.value.editor_session_rememberable",
  outside_delete: "facts.value.outside_delete",
  protected_command_path: "facts.value.protected_command_path",
  outside_workplace_write: "facts.value.outside_workplace_write",
  // Policy already explained these two codes, but the card fell back to the generic
  // "impact cannot be fully determined" text, so the specific wording never reached the user.
  unknown_command_directory: "facts.value.unknown_command_directory",
  unknown_command_directory_sandboxed: "facts.value.unknown_command_directory_sandboxed",
  outside_permissions: "facts.value.outside_permissions",
  remove_workplace_root: "facts.value.remove_workplace_root",
  system_settings: "facts.value.system_settings",
  force_push: "facts.value.force_push",
  hard_remote_reset: "facts.value.hard_remote_reset",
  shutdown: "facts.value.shutdown",
  kill_init: "facts.value.kill_init",
  killall_without_target: "facts.value.killall_without_target",
  download_and_execute: "facts.value.download_and_execute",
  docker_access: "facts.value.docker_access",
  docker_unisolated: "facts.value.docker_unisolated",
  background_command: "facts.value.background_command",
  background_stdin: "facts.value.background_stdin",
};

export function approvalFactText(fact: ApprovalFact, t: ReturnType<typeof createTranslator>) {
  if (fact.labelKey === "memoryUser") return t("facts.value.memoryUser");
  if (fact.labelKey?.startsWith("memory")) return fact.value;
  if (fact.value === "readable_conversations") return t("facts.value.readableConversations");
  // A script judged by its content is named by that content's digest internally.
  if (fact.kind === "program" && /^script:[0-9a-f]+$/.test(fact.value))
    return t("facts.value.scriptByContent");
  if (fact.value === CHAT_SEARCH_TARGET) return t("facts.value.currentChatHistory");
  if (fact.kind === "network" && fact.value === "network_target_unknown")
    return t("facts.value.network_target_unknown");
  if (fact.kind === "warning") {
    const key = Object.hasOwn(warnings, fact.value) ? warnings[fact.value] : undefined;
    if (key) return t(key);
    // Preserve already translated prose; a future internal warning must not appear as code.
    if (/^[a-z]+(?:_[a-z]+)+$/.test(fact.value)) return t("facts.value.unknownWarning");
  }
  return fact.value;
}

/** Drafts, routines and Settings cards have their own settlement paths. */
export function approvalPausesAtDeadline(approval: Approval) {
  return (
    !approval.routineRunId &&
    !approval.draft &&
    !approval.connectorNetworkSite &&
    approval.category !== "settings_change"
  );
}

export function approvalDeadline(approval: Approval, now: number) {
  const remaining = Math.max(0, Math.ceil((Date.parse(approval.expiresAt) - now) / 1000));
  const pauses = approvalPausesAtDeadline(approval);
  return {
    remaining,
    pauses,
    paused: remaining === 0 && pauses,
    expired: remaining === 0 && !pauses,
  };
}

/**
 * Remaining time on an approval card. Routine approvals wait up to a day (chat ones 10 minutes),
 * so hours are shown instead of "1439:42".
 */
export function approvalCountdown(seconds: number) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
