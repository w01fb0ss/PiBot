import type { TranslationKey } from "./zh.ts";

const isolationReasons: Record<string, TranslationKey> = {
  windows_unisolated: "isolation.reason.windows_unisolated",
  acp_editor_terminal_unisolated: "isolation.reason.acp_editor_terminal_unisolated",
  platform_unsupported: "isolation.reason.platform_unsupported",
  sandbox_dependencies_or_runtime_unavailable:
    "isolation.reason.sandbox_dependencies_or_runtime_unavailable",
  linux_bubblewrap_missing: "isolation.reason.linux_bubblewrap_missing",
  linux_socat_missing: "isolation.reason.linux_socat_missing",
  linux_ripgrep_unavailable: "isolation.reason.linux_ripgrep_unavailable",
  linux_sandbox_host_unavailable: "isolation.reason.linux_sandbox_host_unavailable",
  linux_userns_disabled: "isolation.reason.linux_userns_disabled",
  linux_userns_limit_zero: "isolation.reason.linux_userns_limit_zero",
  linux_seccomp_helper_unavailable: "isolation.reason.linux_seccomp_helper_unavailable",
  linux_userns_restricted: "isolation.reason.linux_userns_restricted",
  isolation_check_unfinished: "isolation.reason.isolation_check_unfinished",
};

/**
 * Why commands are not isolated, in words. The approval card and the execution-device row both
 * show it, so the mapping lives once; internal codes (e.g. a transient exec_closed) are
 * not shown at all rather than rendered raw.
 */
export function isolationReasonText(
  reason: string | undefined,
  t: (key: TranslationKey) => string,
  windowsYoloConsent?: boolean,
): string {
  if (reason === "windows_unisolated" && windowsYoloConsent)
    return t("isolation.reason.windows_unisolated_consented");
  const key =
    reason && Object.hasOwn(isolationReasons, reason) ? isolationReasons[reason] : undefined;
  return key ? t(key) : "";
}
