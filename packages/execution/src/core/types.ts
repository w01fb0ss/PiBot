import type { IsolationProbeStage } from "../sandbox/isolation-probe.ts";
import type { NetworkProxy } from "../web/network-proxy.ts";

export type { IsolationStatus } from "../sandbox/isolation-probe.ts";

export interface ExecRedactor {
  redact(text: string): string;
  stream(): { push(text: string): string; finish(): string };
}

export interface NetworkSettings {
  allowAll: boolean;
  domains: string[];
}

/** Physical metadata, without a host's virtual archive-directory view. */
export type AliasFileSystem = Pick<
  typeof import("node:fs/promises"),
  "lstat" | "opendir" | "realpath"
>;

/** Fixed metadata only: no pathname or raw filesystem error may cross this diagnostic boundary. */
export interface ProfileWriteRootDiagnostic {
  /** One-based index in the write roots supplied to the profile builder. */
  index: number;
  kind: "env" | "python" | "cache" | "uv" | "home" | "workplace" | "other";
}

export interface CommandDiagnostic {
  /** Fixed recognized probe text only; never raw command output. */
  diagnostic?: string;
  probeStage?: IsolationProbeStage;
  runId: string;
  stage: "workspace" | "isolation" | "environment" | "log" | "alias_scan" | "profile" | "dispatch";
  code: string;
  readonlyRoots: number;
  profileWriteRootIndex?: number;
  profileWriteRootKind?: ProfileWriteRootDiagnostic["kind"];
  reason?: ExecError["reason"];
}
export interface ExecOptions {
  onDiagnostic?(event: CommandDiagnostic): void;
  /** Report background cleanup health so callers can log and explain it. */
  onBackgroundDrain?(event: import("../command/background/types.ts").BackgroundDrainEvent): void;
  aliasFileSystem?: AliasFileSystem;
  proxy?: () => NetworkProxy | undefined;
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  systemHome: string;
  tempDir: string;
  resourcesDir?: string;
  /** Fixed host arguments supplied by a packaged Node SEA entry; no arbitrary script loading. */
  helperArgs?: { sandbox: string[]; violations: string[] };
  redactor: ExecRedactor;
  /**
   * Linux: where this data directory records SRT placeholder paths its sandboxes may create, so a
   * killed sandbox's empty files can be removed at the next start (sandbox/placeholder-ledger.ts).
   */
  placeholderLedger?: string;
}

export interface CommandPromotion {
  id: string;
  request: AbortSignal;
  ready(job: import("../command/background.ts").BackgroundJob): void;
  promote(
    job: import("../command/background.ts").BackgroundJob,
    trigger: "timeout" | "user",
    seconds: number,
  ): boolean;
  callbacks: import("../command/background/types.ts").BackgroundCallbacks;
}

/** A file (absolute, as the command names it) and the SHA-256 of the bytes policy judged. */
export interface ScriptPin {
  path: string;
  sha256: string;
  /** An installed script must still resolve to this path inside its skill package at launch. */
  canonicalPath?: string;
}

export interface RunCommandOptions {
  /** Private in-process exact-output plan; structural or serialized objects are rejected. */
  gitOutput?: import("../git/git-output.ts").GitOutputPlan;
  /** Local single-call hook recipe, supplied only by brain; never a model or remote wire field. */
  gitHook?: import("../git/git-hook-types.ts").GitHookExecution;
  /** Trusted fixed recipe only; never model input or a remote wire capability. */
  hostSsh?: import("../ssh/ssh-types.ts").PreparedHostSsh;
  /** Trusted in-process ownership handoff; never a model parameter or remote wire value. */
  promotion?: CommandPromotion;
  /** Issued once by brain after a person confirmed it; never a model or wire value. */
  outsideSandbox?: import("../command/outside-sandbox.ts").OutsideSandboxPermit;
  /** Brain-only, per-call secrets. Never inherited by monitors or subsequent commands. */
  secretEnv?: Record<string, string>;
  /** Trusted local-only mask, installed before any output or log is published. */
  secretOutput?: readonly import("../command/secret-output.ts").SecretOutputValue[];
  rootIdentities?: {
    canonicalPath: string;
    device: string | null;
    inode: string | null;
    role?: "primary" | "readonly" | "writable";
  }[];
  denyWriteRoots?: string[];
  command: string;
  cwd: string;
  dataDir: string;
  botHome: string;
  /** Trusted source group; derives a separate readonly member skill root, never a model path. */
  skillGroupId?: string;
  /** In-process effective skill assignment only; never accepted from runner wire input. */
  skillPackageIds?: readonly string[];
  /**
   * A prepared skill runtime, resolved by brain from the skill scope; never a model,
   * wire or remote field. `bin` is relative to `dir` and goes first on PATH.
   */
  skillEnv?: {
    id: string;
    dir: string;
    /** The read-only skill source folder whose script is being invoked. */
    sourceDir?: string;
    bin: string;
    python?: string;
    node?: string;
  };
  /** Trusted local skill Python preparation; never accepted from model or runner inputs. */
  skillPythonPreparation?: {
    envId: string;
    uvVersion: string;
    windowsConfirmed?: true;
    useMirror?: true;
    phase: "create" | "dependencies" | "verify";
  };
  /** Trusted npm setup of the exact skill environment directory. */
  skillNodePreparation?: { envId: string; windowsConfirmed?: true };
  /** Compatibility alias; when supplied it must resolve to botHome. */
  homeDir?: string;
  runId: string;
  /** Trusted tool-call identity for command-log segment correlation. */
  toolCallId?: string;
  writeRoots: string[];
  network: NetworkSettings;
  /** Trusted per-run approvals for private destinations, separate from stored website settings. */
  privateNetworkHosts?: string[];
  pathEntries?: string[];
  /**
   * The sole result-bearing program, from brain's shell analysis (`soleInvokedProgram`).
   * Login/status inference requires ownsStatus: one un-negated invocation without file redirects.
   */
  credentialProgram?: { program: string; ownsStatus: boolean };
  /** Trusted brain preparation only; never an arbitrary model-provided socket path. */
  docker?: import("../docker/docker.ts").DockerConnection;
  /** Loopback services allowed for this command, bound to folder/program/target. */
  systemServices?: string[];
  localServices?: { ports: number[]; sockets: string[] };
  assertDockerAuthorized?(): void;
  /**
   * Script files policy judged by their bytes (brain-only, local targets
   * only, never model or wire input). Re-read right before dispatch; any change is refused.
   */
  scriptPins?: readonly ScriptPin[];
  /**
   * Security review N2: interpreters (`python3`, `sh`, `/usr/bin/env` targets) a script verdict
   * assumed are the system ones; resolved in the command's PATH right before dispatch.
   */
  scriptInterpreters?: readonly string[];
  /** Revalidate a trusted caller's current authority immediately before every dispatch. */
  assertAuthorized?(): void;
  /** Async host confirmation at the final dispatch boundary (for remote execution targets). */
  confirmDispatch?(): Promise<void>;
  timeoutSec?: number;
  /** A runner-held entry plan; only a runner host consumes it (and strips it). */
  gitEntryPlanId?: string;
  /** Restrict lookups and Git helpers for a foreground Windows read approved by policy. */
  windowsReadOnly?: true;
  signal: AbortSignal;
  onOutput?(text: string): void;
  // Brain must explicitly accept the status shown on the approval card.
  allowUnisolated?: boolean;
}

/** Background mode: same boundary as a command, but the process outlives the call. */
export interface BackgroundStartOptions
  extends Omit<
    RunCommandOptions,
    | "timeoutSec"
    | "onOutput"
    | "runId"
    | "gitHook"
    | "hostSsh"
    | "gitOutput"
    | "windowsReadOnly"
    | "skillPythonPreparation"
    | "skillNodePreparation"
  > {
  skillPythonPreparation?: never;
  skillNodePreparation?: never;
  gitOutput?: never;
  gitHook?: never;
  hostSsh?: never;
  /** Names the log in the Bot's private command-log directory and the job. */
  jobId: string;
  /** Tracks pending startup retirement with its originating run, not the long-lived job. */
  runId?: string;
  callbacks?: import("../command/background.ts").BackgroundCallbacks;
}

/** Why a failed sandboxed command was blocked, in fixed categories for model and UI. */
export type SandboxBlockKind =
  | "outside_workplace_write"
  | "protected_name"
  | "git_resource"
  | "network"
  | "local_service"
  | "system_service"
  | "protected_path"
  /** A CLI's own login/config store (~/.aws, ~/.config/gh, …) was unreadable. */
  | "credential_read"
  /** Another protected location (browser data, Pi Bot data, …) was unreadable. */
  | "protected_read"
  | "other";
export interface SandboxBlockItem {
  kind: SandboxBlockKind;
  /** Fixed rule id, e.g. the protected name or "explicit_deny"; never free text from output. */
  rule: string;
  /**
   * Canonical absolute path or host. Protected reads name the store or deny root as `~/…`
   * instead of the file that was wanted.
   */
  target: string;
  /** Exact public DNS name from the sandbox proxy's own refusal, never command output. */
  networkDomain?: string;
}
export interface SandboxBlock {
  kinds: SandboxBlockKind[];
  items: SandboxBlockItem[];
}

export interface CommandResult {
  /**
   * A sandboxed command hit a known deny rule: from output hints when it exited non-zero, or from
   * the sandbox's own reports, which also count when it exited 0.
   */
  sandboxBlock?: SandboxBlock;
  outputFile?: { path: string; bytes: number; revision: string };
  /** Filter stages of a listed outside run executed by their pinned system path. */
  pinnedFilters?: number;
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  durationMs: number;
  logPath: string;
  truncatedOutput: string;
  promoted?: { id: string; trigger: "timeout" | "user"; outputLines: number };
}

export interface FileContext {
  /** Revalidate live authority immediately before publication after asynchronous file preparation. */
  assertCurrent?(): void;
  /** Async host confirmation immediately before a visible filesystem side effect. */
  confirmDispatch?(): Promise<void>;
  /** Recovery may touch an earlier batch; its targets require their own live authorization. */
  authorizeRecovery?(paths: readonly string[], signal: AbortSignal): Promise<void>;
  rootIdentities?: RunCommandOptions["rootIdentities"];
  denyWriteRoots?: string[];
  cwd: string;
  signal: AbortSignal;
  writeRoots: string[];
  /** Brain binds execution to the canonical path that policy actually authorized. */
  expectedPath?: string;
}

export interface PageOptions {
  proxy?: NetworkProxy;
  url: string;
  maxChars?: number;
  allowDomain(domain: string, signal: AbortSignal, url: string): boolean | Promise<boolean>;
  signal: AbortSignal;
}

export interface PageResult {
  url: string;
  domain: string;
  title: string;
  text: string;
  truncated: boolean;
  mimeType: string;
  /** Present only for binary formats that the caller must decode, currently PDF. */
  bytes?: Uint8Array;
  /** Characters of decoded page text before truncation; zero until a binary format is decoded. */
  length: number;
  /** A bounded, deterministic indication that the page needs the Bot browser fallback. */
  blocked?: "http_status" | "anti_bot_page" | "js_required";
  /** Preserve successful text if a conservative blocked-page classification cannot be confirmed. */
  status?: number;
}

/** Only brain supplies generated, managed image bytes; this is not a model tool argument. */
export interface ImageBinaryIdentity {
  runId: string;
  attachmentId: string;
  extension: "png" | "jpg" | "webp" | "gif";
}

export interface BinaryWriteReceipt {
  path: string;
  identityKey: string;
  sha256: string;
  bytes: number;
  device: string;
  inode: string;
  parentDevice: string;
  parentInode: string;
}

export interface ImageBinaryWriteOptions extends FileContext, ImageBinaryIdentity {
  bytes: Uint8Array;
  /** A receipt retained by brain, never a claim supplied by the model. */
  previous?: BinaryWriteReceipt;
  /** Brain rechecks the current owner and policy boundary after asynchronous file IO. */
  revalidate(signal: AbortSignal): Promise<void>;
}

export class ExecError extends Error {
  constructor(
    readonly code:
      | "command_path_discovery_failed"
      | "command_not_found"
      | "docker_permission_changed"
      | "docker_command_invalid"
      | "docker_unsupported"
      | "docker_endpoint_unavailable"
      | "docker_endpoint_changed"
      | "invalid_input"
      | "outside_workplace"
      | "isolation_unavailable"
      | "isolation_scan_limit"
      | "busy"
      | "closed"
      | "timeout"
      | "write_timeout"
      | "file_failed"
      | "file_not_found"
      | "file_not_directory"
      /** An explicit path that the search would silently filter out. */
      | "file_filter_mismatch"
      | "file_sensitive"
      | "file_access_denied"
      | "file_conflict"
      | "file_in_use"
      | "edit_not_unique"
      | "edit_overlap"
      | "output_failed"
      | "command_failed"
      | "web_blocked"
      | "web_failed"
      | "git_unavailable"
      | "connector_server_unavailable"
      | "authorization_changed"
      | "managed_identity_changed"
      /** A script policy judged by its text changed before the run began. */
      | "script_changed"
      /** N2: a judged script's interpreter resolves into a writable folder or a shim. */
      | "interpreter_untrusted",
    readonly reason?:
      | "path_canonicalization_failed"
      | "write_path_alias"
      | "write_path_protected"
      | "write_path_hardlink"
      | "write_path_outside_root"
      | "workspace_root_alias"
      | "workspace_identity_missing"
      | "workspace_identity_changed"
      | "profile_data_root"
      | "profile_bot_home"
      | "profile_bot_skills"
      | "profile_bot_attachments"
      | "profile_group_skills"
      | "profile_group_home"
      | "profile_skill_package"
      | "profile_skill_env"
      | "profile_python_env"
      | "profile_managed_python"
      | "profile_uv_cache"
      | "profile_uv_binary"
      | "profile_write_root"
      | "profile_temp_root"
      | "profile_read_root"
      | "profile_temp_namespace"
      | "proxy_auth_failed"
      | "proxy_unavailable"
      | "proxy_credentials_unavailable"
      | "unsupported_url"
      | "private_address"
      | "domain_denied"
      | "unsupported_content_type"
      | "response_too_large"
      | "redirect_limit"
      | "http_status"
      | "cancelled"
      | "timeout"
      | "dns_failed"
      | "connection_failed"
      | "tls_failed"
      | "dispatcher_incompatible"
      | "body_failed"
      | "html_failed"
      | "cleanup_failed"
      | "sandbox_initialization_timeout"
      | "sandbox_cleanup_timeout"
      | "process_snapshot_timeout"
      | "process_snapshot_limit"
      | "process_snapshot_failed"
      | "process_monitor_failed"
      /** The OS kill or its verification failed; says nothing about the command itself. */
      | "process_kill_failed"
      /** A failure flag was raised without a more specific reason. */
      | "process_unknown"
      | "listener_check_failed"
      | "stdin_closed"
      | "stdin_unconfirmed"
      | "process_stream_failed"
      | "process_spawn_failed"
      | "unsupported_platform"
      /** A remote execution device dropped its link while this operation was in flight. */
      | "runner_disconnected"
      /** The runner is still confirming the cleanup of an earlier command. */
      | "cleanup_unconfirmed"
      /** ACP: the editor did not advertise fs read / write or terminal for this session. */
      | "editor_capability_missing"
      | "isolation_start_failed"
      | "ripgrep_unavailable"
      | "seccomp_helper_unavailable"
      /** Windows runs commands unisolated; a proxy with credentials cannot reach them safely. */
      | "windows_proxy_credentials",
    readonly profileWriteRoot?: ProfileWriteRootDiagnostic,
  ) {
    super(code);
    this.name = "ExecError";
  }

  /** The existing specific reason wins; old callers still identify the coarse check. */
  get check() {
    return this.reason ?? (`execution_${this.code}` as const);
  }
}

/**
 * A nonunique `edit_file` / `apply_patch` needle. Carries how often it matched so the tool result
 * can say it (the model kept retrying with too-short context: 19 × edit_not_unique on 2026-11-05).
 * `occurrences` is absent when counting would cost more than the hint is worth.
 */
export class EditNotUniqueError extends ExecError {
  constructor(readonly occurrences?: number) {
    super("edit_not_unique");
    this.name = "EditNotUniqueError";
  }
}

/** Publication completed even when later root checks or cleanup failed; brain must retain this fact. */
export class BinaryWriteError extends ExecError {
  constructor(
    code: ExecError["code"],
    readonly receipt: BinaryWriteReceipt,
    reason?: ExecError["reason"],
  ) {
    super(code, reason);
    this.name = "BinaryWriteError";
  }
}
