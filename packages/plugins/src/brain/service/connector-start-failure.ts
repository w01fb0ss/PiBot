// One fixed reason per stdio MCP that did not come up. Exec reports facts; this turns
// them into the sentence the person reads and the codes the log keeps. Matching runs on the
// redacted stderr tail only; nothing of it reaches the log.
import { type ConnectorServerDiagnosis, ConnectorStartError, ExecError } from "@pibot/execution";
import type { ConnectorStartFailure, ConnectorStartReason } from "@pibot/plugins-contract/full";
import { ConnectorStartFailureSchema } from "@pibot/plugins-contract/full";

/**
 * A server waiting for a terminal password (Python getpass without a TTY warns and prompts on
 * stderr; ssh/sudo/gpg say a terminal is required), or a prompt left as the last line.
 */
const PASSWORD_PROMPT = [
  /GetPassWarning|Password input may be echoed|Can not control echo/i,
  /\b(?:a terminal is required|no tty present|not a tty|cannot open \/dev\/tty|Device not configured: '\/dev\/tty')/i,
  /(?:password|passphrase|passcode|pin)[^\n]{0,40}:\s*$/i,
];
/** The server says it needs a login first (no cached token, expired session). */
const LOGIN_REQUIRED =
  /\b(?:run|use|try)\b[^\n]{0,40}\blog ?in\b|\bnot (?:logged|signed) in\b|\blog ?in required\b|\bplease (?:log|sign) ?in\b|\bno (?:cached|saved|stored) (?:token|credentials?|login)\b|\b(?:session|token|credentials?) (?:has |have )?expired\b|\bunauthenticated\b/i;
/** Plain-text hints of a sandbox refusal when the kernel did not report one (Linux, piped). */
const SANDBOX_TEXT = /\bOperation not permitted\b|\bsandbox(?:-exec|_init)?\b/i;
/**
 * The program started but could not load its own code: Python/Node module errors and version
 * breaks (maintainers 2026-11-15: a uv MCP pulled mcp 2.x, where mcp.server.fastmcp no longer exists).
 */
const DEPENDENCY_TEXT =
  /\b(?:ModuleNotFoundError|ImportError|No module named|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|LoadError|cannot load such file)\b/;
const COMMAND_TEXT = /\bcommand not found\b|\bNo such file or directory\b|\bnot executable\b/i;
const SHELL_PREFIX = /^(?:\S*\/)?(?:ba|da|z|k|a)?sh: (?:line \d+: |\d+: )?(?:exec: )?/;

const sigName = (value: string | null) =>
  value && /^SIG[A-Z0-9]{1,16}$/.test(value) ? value : null;

/**
 * Why exec refused before spawning. These carry no diagnosis, so without a reason of their own the
 * person saw only 「连接失败」; the reason names the kind of refusal, never the path.
 */
export function startRefusalReason(error: unknown): ConnectorStartReason | undefined {
  if (!(error instanceof ExecError) || error instanceof ConnectorStartError) return undefined;
  switch (error.code) {
    case "outside_workplace":
      return "location_refused";
    case "invalid_input":
      return error.reason === "proxy_unavailable" ? "proxy_scheme" : "config_invalid";
    case "command_not_found":
    case "command_path_discovery_failed":
      return "command_not_found";
    case "isolation_unavailable":
    case "isolation_scan_limit":
      return "sandbox_start_failed";
    case "connector_server_unavailable":
      return "sandbox_start_failed";
    // A stop or cancel while starting is not a failure of the server.
    case "closed":
      return undefined;
    default:
      return "unknown";
  }
}

export interface ConnectorLauncherHint {
  name: NonNullable<ConnectorStartFailure["launcher"]>;
  command: string;
  issue?: ConnectorStartFailure["launcherIssue"];
}

export function classifyStartFailure(input: {
  phase: ConnectorStartFailure["phase"];
  diagnosis?: ConnectorServerDiagnosis;
  timedOut: boolean;
  outsideSandbox: boolean;
  reconfirm?: boolean;
  /** Set when exec refused before spawning; it wins over anything read from a diagnosis. */
  refusal?: ConnectorStartReason;
  launcher?: ConnectorLauncherHint;
  redact(value: string): string;
}): ConnectorStartFailure {
  const diagnosis = input.diagnosis;
  const stderr = input.redact(diagnosis?.stderrTail ?? "").slice(-4096);
  const exitCode = diagnosis?.exitCode ?? null;
  const sandboxed = !input.outsideSandbox && diagnosis?.outsideSandbox !== true;
  const denials = (diagnosis?.denials ?? []).slice(0, 16).map((item) => ({
    kind: item.kind,
    rule: item.rule,
    target: input.redact(item.target).slice(0, 1024),
  }));
  // Match the shell's command word and status, independent of the diagnostic's language.
  const launcher = input.launcher;
  const firstLine = stderr.trimStart().split("\n", 1)[0] ?? "";
  const prefix = SHELL_PREFIX.exec(firstLine)?.[0];
  const shellLaunchFailed =
    launcher &&
    prefix &&
    (exitCode === 126 || exitCode === 127) &&
    firstLine.slice(prefix.length).startsWith(`${input.redact(launcher.command)}: `);
  const reason: ConnectorStartReason = input.refusal
    ? input.refusal
    : input.reconfirm
      ? "outside_sandbox_reconfirm"
      : diagnosis?.hostFailed
        ? "sandbox_start_failed"
        : diagnosis?.spawnFailed || (shellLaunchFailed && !denials.length)
          ? "command_not_found"
          : sandboxed && denials.length
            ? "sandbox_denied"
            : PASSWORD_PROMPT.some((pattern) => pattern.test(stderr))
              ? "password_prompt"
              : LOGIN_REQUIRED.test(stderr)
                ? "login_required"
                : diagnosis?.exited && exitCode !== 0 && DEPENDENCY_TEXT.test(stderr)
                  ? "dependency_missing"
                  : sandboxed && SANDBOX_TEXT.test(stderr)
                    ? "sandbox_denied"
                    : !launcher &&
                        (exitCode === 126 ||
                          exitCode === 127 ||
                          (diagnosis?.exited && exitCode !== 0 && COMMAND_TEXT.test(stderr)))
                      ? "command_not_found"
                      : input.timedOut
                        ? "timeout"
                        : diagnosis?.exited
                          ? "exited"
                          : diagnosis
                            ? "protocol_error"
                            : "unknown";
  const missingLauncher =
    launcher &&
    reason === "command_not_found" &&
    (diagnosis?.spawnFailed || input.refusal === "command_not_found" || shellLaunchFailed);
  return ConnectorStartFailureSchema.parse({
    phase: input.phase,
    reason,
    ...(missingLauncher ? { launcher: launcher.name, launcherIssue: launcher.issue } : {}),
    exitCode,
    signal: sigName(diagnosis?.signal ?? null),
    timedOut: input.timedOut,
    outsideSandbox: !sandboxed,
    denials,
    stderrTail: stderr,
    at: new Date().toISOString(),
  });
}

/** The structured log line: codes and counts only, never stderr, arguments or environment. */
export function startFailureLog(connectorId: string, failure: ConnectorStartFailure) {
  return {
    module: "connector",
    event: "start_failed",
    connectorId,
    phase: failure.phase,
    reasonCode: failure.reason,
    exitCode: failure.exitCode,
    signal: failure.signal,
    timedOut: failure.timedOut,
    outsideSandbox: failure.outsideSandbox,
    denialKinds: [...new Set(failure.denials.map((item) => `${item.kind}:${item.rule}`))],
  };
}
