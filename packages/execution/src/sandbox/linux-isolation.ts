import type { IsolationProbe } from "./isolation-probe.ts";
import { linuxUserNamespaceSettings } from "./linux-userns.ts";

/** The real host uses a different environment from the caller; use its failure, not a PATH recheck. */
export async function linuxIsolationFailure(probe: IsolationProbe) {
  const { stage, stderr } = probe;
  if (stderr === "ripgrep: not found") return "linux_ripgrep_unavailable";
  if (stderr === "apply-seccomp: unavailable (not found or not executable)")
    return "linux_seccomp_helper_unavailable";
  if (
    stage === "start_host" &&
    (stderr === "sandbox host: module not found" || stderr === "sandbox host: resources invalid")
  )
    return "linux_sandbox_host_unavailable";
  if (stage === "initialize_runtime") {
    if (stderr === "bubblewrap (bwrap) not installed") return "linux_bubblewrap_missing";
    if (stderr === "socat not installed") return "linux_socat_missing";
  }
  if (stage === "run_sandbox") {
    const settings = await linuxUserNamespaceSettings();
    if (settings.clone === 0) return "linux_userns_disabled";
    if (settings.max === 0) return "linux_userns_limit_zero";
    // The sysctl alone says nothing about whether this executable is restricted.
    if (
      settings.apparmor === 1 &&
      (stderr === "bwrap: namespace creation denied" ||
        stderr === "apply-seccomp: unshare(CLONE_NEWUSER)" ||
        stderr?.startsWith("apply-seccomp: write /proc/self/"))
    )
      return "linux_userns_restricted";
  }
  return "sandbox_dependencies_or_runtime_unavailable";
}
