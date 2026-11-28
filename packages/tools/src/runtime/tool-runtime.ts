import type {
  DockerConnection,
  ExecutionTarget,
  fetchPage,
  NetworkProxy,
  RunCommandOptions,
} from "@pibot/execution";
import type {
  AuditDetail,
  BackgroundCommand,
  BrowserBlocked,
  BrowserPage,
  ComputerStepAction,
  ImageContent,
  LoginApprovalRequest,
  LoginFillResult,
  PermissionsSettings,
  WorkspaceSnapshot,
} from "@pibot/protocol-base";
import type { RunWebCache } from "../web/web-cache.ts";

export interface ToolCallView {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface PreparedToolView {
  call: ToolCallView;
  result: {
    windowsReadProven?: true;
    windowsReadOnly?: true;
    command?: string;
    /** Policy's reason code; the local-service card is told apart by it. */
    reason?: string;
    facts?: readonly { kind: string; value?: string }[];
    commandNetwork?: { allowAll: boolean; domains: string[] };
    category?: string;
    decision?: "allow" | "ask" | "deny";
    domain?: string;
    path?: { path: string; root?: string };
    analysis?: {
      literalCommand?: CommandLiteralView;
      leadingAndCommand?: {
        invocation: CommandLiteralView;
        directory?: string;
        remainder?: string;
      };
      commands?: CommandLiteralView[];
      incomplete?: boolean;
      /** Script files the verdict read by content; execution re-checks them before the run. */
      scriptPins?: readonly { path: string; sha256: string; canonicalPath?: string }[];
      /** Interpreters the verdict assumed are the system ones; resolved again before the run. */
      scriptInterpreters?: readonly string[];
    };
    outsideWrites?: string[];
  };
  boundary?: WorkspaceSnapshot;
  patchPaths?: string[];
  roots: string[];
  cwd: string;
  home: string;
  authorization: string;
  settings: PermissionsSettings;
  docker?: DockerConnection;
  secretUses?: readonly unknown[];
  login?: LoginApprovalRequest;
  /** A runner-held entry plan id; the runner re-checks that plan right before spawn. */
  gitEntries?: { plan?: { remotePlanId?: string } };
}

export interface CommandLiteralView {
  program: string;
  args: string[];
}

export interface BackgroundInputTarget {
  command: string;
  cwd: string;
  scope: string;
}

export interface BackgroundOutputView {
  row: BackgroundCommand;
  output: string | null;
  permissionOnly?: boolean;
  logPath: string;
}

export interface ToolResult {
  /** The producer returned external content, including failed or timed-out command output. */
  untrustedContent?: boolean;
  text: string;
  images?: ImageContent[];
  summary?: string;
  details?: {
    exitCode?: number | null;
    timedOut?: boolean;
    stopped?: boolean;
    durationMs?: number;
    logPath?: string;
    backgroundWaiting?: boolean;
    backgroundJobId?: string;
    backgroundStatus?: "running" | "exited" | "stopped" | "failed";
    /** Program metadata only; never extracted from a text result. */
    errorCode?: string;
    resultCount?: number | null;
    fallback?: "browser";
    fallbackReason?: "http_status" | "anti_bot_page" | "js_required";
  };
  isError?: boolean;
}

export type BrowserToolInput =
  | { tool: "browser_network"; args: import("@pibot/protocol-base").BrowserNetworkQuery }
  | { tool: "browser_request"; args: import("@pibot/protocol-base").BrowserRequest }
  | { tool: "browser_secret"; args: import("@pibot/protocol-base").BrowserSecret }
  | { tool: "browser_diagnostics"; args: { tab?: string; after?: number; limit?: number } }
  | { tool: "browser_inspect"; args: { tab?: string; ref: string; documentId?: string } }
  | { tool: "browser_open"; args: { url: string; newTab?: boolean } }
  | { tool: "browser_snapshot"; args: { tab?: string; maxChars?: number } }
  | { tool: "browser_click"; args: import("@pibot/protocol-base").BrowserClick }
  | {
      tool: "browser_type";
      args: { ref: string; text: string; submit?: boolean; tab?: string };
    }
  | { tool: "browser_select"; args: { ref: string; value: string; tab?: string } }
  | {
      tool: "browser_scroll";
      args: { direction: "up" | "down" | "left" | "right"; amount?: number; tab?: string };
    }
  | { tool: "browser_back"; args: { tab?: string } }
  | { tool: "browser_tabs"; args: Record<string, never> }
  | { tool: "browser_close"; args: { tab: string } }
  | {
      tool: "browser_screenshot";
      args: {
        tab?: string;
        fullPage?: boolean;
        viewport?: {
          width: number;
          height: number;
          deviceScaleFactor?: number;
          mobile?: boolean;
        };
      };
    }
  | {
      tool: "browser_wait";
      args: {
        for: "load" | "text" | "ref";
        value?: string;
        timeoutMs?: number;
        tab?: string;
      };
    }
  | { tool: "browser_download_list"; args: Record<string, never> };

export interface BrowserActionResultView {
  page?: BrowserPage;
  text: string;
  image?: ImageContent;
}

export interface BrowserLoginSelection {
  available: boolean;
  login?: LoginApprovalRequest;
  pageUrl?: string;
  chosen?: string;
  label?: string;
}

export interface BrowserToolPort {
  assertRun(): void;
  retryBoundary(tool: string): string | undefined;
  /** `step_picture` names the step thumbnail; `retryBoundary("step_picture")` checks it. */
  stopRetries(reason: "takeover" | "screenshot" | "step_picture"): void;
  isYolo(): boolean;
  pauseTakeover(): void;
  resumeTakeover(): void;
  approveInitialSite(prepared: PreparedToolView): void;
  configure(
    prepared: PreparedToolView,
    writeRoot: string | undefined,
    signal: AbortSignal,
    force?: boolean,
  ): Promise<void>;
  action(input: BrowserToolInput, signal: AbortSignal): Promise<BrowserActionResultView>;
  readTemporary(
    prepared: PreparedToolView,
    url: string,
    signal: AbortSignal,
  ): Promise<{ page?: FetchedPage; needsTakeover?: boolean } | undefined>;
  screenshot(page: BrowserPage, signal: AbortSignal): Promise<ImageContent>;
  recordStep(input: {
    toolCallId: string;
    target: string;
    action: ComputerStepAction;
    result: "done" | "error" | "denied";
    image?: ImageContent;
    page?: BrowserPage;
  }): Promise<unknown>;
  auditInspection(tool: string, toolCallId: string): void;
  authorizeBlocked(
    call: ToolCallView,
    entry: BrowserBlocked,
    writeRoot: string | undefined,
    signal: AbortSignal,
  ): Promise<{ approved: boolean; note?: string }>;
  googleCompatibility(): boolean;
  observe(page: Pick<BrowserPage, "url">): void;
  forgetPage(): void;
  takeUserOpened(): string | undefined;
  takeHandBack(): string | undefined;
  loginSelection(prepared: PreparedToolView): BrowserLoginSelection;
  fillLogin(
    prepared: PreparedToolView,
    chosen: string,
    signal: AbortSignal,
  ): Promise<LoginFillResult>;
  auditLogin(chosen: string, site: string, label: string, toolCallId: string, reason: string): void;
  completeLogin(site: string, chosen: string, page: BrowserPage): void;
}

export interface PageExtractResult {
  text: string;
  model: { provider: string; id: string };
  readChars: number;
}

export interface ToolRuntime {
  readonly webFetchCache?: RunWebCache;
  timing?(callId: string): import("@pibot/protocol-base").ToolTiming | undefined;
  readonly context: {
    botId: string;
    runId: string;
    language: "zh" | "en";
    routineSource?: "routine" | "trial";
    routineRunId?: string;
    pdfBatch?: { admitted: Set<string>; read: Set<string>; total: number };
  };
  readonly target: ExecutionTarget;
  readonly platform: "darwin" | "linux" | "win32";
  readonly dataDir: string;
  readonly fetchPage?: typeof fetchPage;
  readonly proxy?: () => NetworkProxy | undefined;
  readonly extractPage?: (input: {
    onQueue?(): () => void;
    question: string;
    page: { url: string; title: string; text: string };
    signal: AbortSignal;
  }) => Promise<PageExtractResult>;
  readonly revealPath?: (
    input: { path: string; allowedRoots: string[] },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly browser?: BrowserToolPort;

  redact(text: string): string;
  log(level: "info" | "warn", fields: Record<string, unknown>): void;
  assertDispatch(prepared: PreparedToolView): void;
  admitPdf?(path: string): boolean;
  authorizationMatches(prepared: PreparedToolView): boolean;
  allowsUnisolated(toolCallId: string): boolean;
  commandSecretEnvironment(
    prepared: PreparedToolView,
    signal: AbortSignal,
  ): Promise<Record<string, string>>;
  validateCommandHandles?(prepared: PreparedToolView, signal: AbortSignal): Promise<void>;
  commandHandleEnvironment?(
    prepared: PreparedToolView,
    signal: AbortSignal,
  ): Promise<{ env: Record<string, string>; values: { handle: string; value: string }[] }>;
  commandSkillSecrets?(
    prepared: PreparedToolView,
    signal: AbortSignal,
  ): Promise<
    { env: Record<string, string>; values: { handle: string; value: string }[] } | undefined
  >;
  /** The prepared runtime for this command's skill; brain-only, never model input. */
  commandSkillEnvironment?(prepared: PreparedToolView): Promise<RunCommandOptions["skillEnv"]>;
  commandGroupId(): string | undefined;
  /**
   * Maintainers 2026-11-14: local-network hosts a person allowed in this run, read at dispatch so a
   * card answered moments ago already applies; the sandbox proxy reaches exactly these.
   */
  commandPrivateHosts?(): readonly string[];
  commandSkillPackageIds?(): readonly string[] | undefined;
  watchCommandRoots(prepared: PreparedToolView, serial?: boolean): Promise<void>;
  clearCommandChecks(): void;
  beginCommandCheck(
    command: string,
    prepared: PreparedToolView,
    signal: AbortSignal,
  ): Promise<unknown>;
  finishCommandCheck(
    check: unknown,
    toolCallId: string,
    success: boolean,
    signal: AbortSignal,
  ): Promise<void>;
  assertDockerDispatch(prepared: PreparedToolView): void;
  commandFailureGuidance(
    literal: CommandLiteralView | undefined,
    output: string,
    sandboxBlock?: import("@pibot/execution").SandboxBlock,
    outsideSandbox?: boolean,
    sandboxedExecution?: boolean,
    network?: { allowAll: boolean; domains: readonly string[] },
    commands?: readonly CommandLiteralView[],
    ranOutsideSandbox?: boolean,
  ): string | undefined;
  /**
   * Undefined once this run already said it — a per-call reminder would train the model to
   * ignore it, so the host decides how often a read hint is worth repeating.
   */
  commandReadGuidance(literal: CommandLiteralView | undefined): string | undefined;
  /** One hint after a successful system-browser command. */
  commandBrowserOpenGuidance(literal: CommandLiteralView | undefined): string | undefined;
  /** Remember a block of this call; true when running outside the sandbox may be offered. */
  retrySandboxWebsite?(
    prepared: PreparedToolView,
    block: Parameters<ToolRuntime["recordSandboxBlock"]>[1],
    signal: AbortSignal,
  ): Promise<ToolResult | undefined>;
  recordSandboxBlock(
    prepared: PreparedToolView,
    block: import("@pibot/execution").SandboxBlock,
  ): boolean;
  /** Number of same-command, same-rule sandbox blocks in this run. */
  sandboxBlockRepeatCount?(
    prepared: PreparedToolView,
    block: import("@pibot/execution").SandboxBlock,
  ): number;
  /** A one-time permit for the confirmed call, or undefined when it did not ask to leave. */
  /** The line's one result-bearing program (shell analysis), for missing-login hints. */
  commandCredentialProgram?(
    prepared: PreparedToolView,
  ): { program: string; ownsStatus: boolean } | undefined;
  rememberOutsideCommand?(prepared: PreparedToolView): void;
  commandSystemServices?(prepared: PreparedToolView): string[] | undefined;
  commandLocalServices?(
    prepared: PreparedToolView,
  ): { ports: number[]; sockets: string[] } | undefined;
  outsideSandboxPermit(
    prepared: PreparedToolView,
  ): import("@pibot/execution").OutsideSandboxPermit | undefined;
  auditCommand(phase: "started" | "finished", summary: string, detail: AuditDetail): void;
  prepareForegroundCommand?(prepared: PreparedToolView):
    | {
        promotion: import("@pibot/execution").CommandPromotion;
        dispose(): void;
      }
    | undefined;
  startBackgroundCommand(input: {
    prepared: PreparedToolView;
    command: string;
    secretEnv: Record<string, string>;
    allowUnisolated: boolean;
    auditFields: AuditDetail;
    signal: AbortSignal;
  }): Promise<ToolResult>;
  listBackgroundCommands(limit: number): BackgroundCommand[];
  getBackgroundCommand(id: string): BackgroundCommand | undefined;
  stopBackgroundCommand(id: string): Promise<BackgroundCommand>;
  backgroundOutput(id: string, maxChars: number): BackgroundOutputView;
  observeBackground?(id: string, value: string): boolean;
  waitBackgroundOutput(
    id: string,
    maxChars: number,
    seconds: number,
    signal: AbortSignal,
    /** Return only when the command ends (or seconds pass), not on new output. */
    untilEnd?: boolean,
  ): Promise<BackgroundOutputView>;
  backgroundInputTarget(id: string): BackgroundInputTarget;
  writeRoots(prepared: PreparedToolView): string[];
  allowPage(call: ToolCallView, signal: AbortSignal): Promise<boolean>;
  authorizePatchRecovery(
    prepared: PreparedToolView,
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<void>;
  authorizeSearchPath(
    prepared: PreparedToolView,
    signal: AbortSignal,
  ): Promise<(path: string, kind: "directory" | "file", signal: AbortSignal) => Promise<boolean>>;
  observeProjectNotes?(
    prepared: PreparedToolView,
    path: string,
    text: string,
    ownWrite?: boolean,
  ): void;
  beforeWrite(path: string): Promise<unknown>;
  afterWrite(before: unknown, path: string, root: string): Promise<void>;
  auditInput(
    fields: AuditDetail,
    input: { kind: "file"; path: string } | { kind: "web"; domain: string },
  ): void;
  auditWritten(
    entries: readonly {
      detail: AuditDetail;
      summary: string;
    }[],
  ): void;
  auditRevealed(fields: AuditDetail & { path: string }): void;
  postWrite(call: ToolCallView, signal: AbortSignal): Promise<string | undefined>;
  afterEdit(root: string, path: string, signal: AbortSignal): Promise<unknown>;
  markSkillUsed(path: string): string | undefined;
  redactAiConfig(path: string, text: string): { ok: true; text: string } | { ok: false };
  extractPdf(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<{ text: string; totalChars: number; pages?: number; scanned?: boolean }>;
  mapPageError(error: unknown): string;
}

export type FetchedPage = Awaited<ReturnType<typeof fetchPage>>;

export function redactValue(value: unknown, runtime: Pick<ToolRuntime, "redact">): unknown {
  if (typeof value === "string") return runtime.redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, runtime));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, runtime)]),
    );
  return value;
}
