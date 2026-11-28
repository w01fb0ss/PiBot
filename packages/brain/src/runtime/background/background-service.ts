import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LocalToolResult } from "@pibot/agent";
import {
  type BackgroundJob,
  commandLogRoot,
  type FileContext,
  type RunCommandOptions,
} from "@pibot/execution";
import {
  type AuditDetail,
  type BackgroundCommand,
  type BackgroundCommandRecord,
  type BackgroundStopReason,
  MAX_BACKGROUND_COMMANDS_PER_BOT,
  MAX_BACKGROUND_COMMANDS_PER_TOPIC,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import {
  type BackgroundCommandRow,
  BackgroundCommandsRepo,
  RunsRepo,
  SettingsRepo,
  transaction,
} from "@pibot/storage";
import { backgroundInputScope, backgroundText } from "@pibot/tools/command";
import { abortable } from "../../core/abort.ts";
import { auditText } from "../../core/audit-fields.ts";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import { runPermissionScope } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { BackgroundContinuation } from "./background-continuation.ts";
import { BackgroundLimits } from "./background-limits.ts";
import { BackgroundRecovery } from "./background-recovery.ts";
import { waitForBackgroundOutput } from "./background-wait.ts";
import { ForegroundCommands, type ForegroundSource } from "./foreground-commands.ts";
import { ScanRegistry, scanOutputPath, scanPaths, scanScope } from "./scan-registry.ts";

/** How long a start waits for the first listening port (or an early exit) before returning. */
const SETTLE_MS = 3000;
/** Ended jobs whose recent output the Bot may still read in this brain. */
const RECENT_ENDED = 30;

interface Entry {
  row: BackgroundCommandRow;
  job: BackgroundJob;
  /** Why we asked it to stop (who / which cleanup), recorded when it has ended. */
  reason?: BackgroundStopReason;
  waiters: Set<() => void>;
  roots: string[];
  sourceConversationId?: string;
  scanOutput?: string;
  input: { command: string; cwd: string; scope: string };
}

export interface BackgroundStart {
  secretEnv?: Record<string, string>;
  context: ToolRunContext;
  prepared: PreparedTool;
  command: string;
  skillEnv?: RunCommandOptions["skillEnv"];
  file: Omit<FileContext, "signal" | "expectedPath">;
  allowUnisolated: boolean;
  assertAuthorized(): void;
  auditFields: AuditDetail;
  signal: AbortSignal;
}

/**
 * Background commands for all Bots. Owner: LocalService. Starts go through the same
 * policy / approval / exec boundary as run_command (exec owns the processes); this service keeps
 * the rows, audit, events, per-Bot limit and the Bot-facing tool, tells the Bot browser which
 * loopback ports each Bot may open, and stops commands when their chat or Bot goes away.
 */
export class BackgroundService {
  readonly foreground: ForegroundCommands;
  private readonly limits: BackgroundLimits;
  private readonly recovery: BackgroundRecovery;
  private readonly promoted = new Set<string>();
  readonly continuation: BackgroundContinuation;
  readonly repo: BackgroundCommandsRepo;
  private readonly live = new Map<string, Entry>();
  private readonly ended = new Map<string, BackgroundJob>();
  private readonly cleanups = new Map<
    string,
    { rows: BackgroundCommandRow[]; roots: string[]; settled: Promise<void> }
  >();
  private readonly scans = new ScanRegistry<Entry>();
  /** Starts between the limit check and the row insert, per Bot. */
  private readonly starting = new Map<string, number>();
  private readonly startingTopics = new Map<string, number>();
  /** BrowserService pushes new `localPorts` to the host when a Bot's ports change. */
  onPortsChanged?: (botId: string) => void;

  constructor(private readonly local: LocalService) {
    this.repo = new BackgroundCommandsRepo(local.deps.db);
    this.continuation = new BackgroundContinuation(local);
    this.recovery = new BackgroundRecovery(local, this.repo);
    this.limits = new BackgroundLimits({
      minutes: () => new SettingsRepo(local.deps.db).get().backgroundCommandLimitMinutes ?? 120,
      expire: async (id) => {
        const entry = this.live.get(id);
        if (!entry) return;
        entry.reason ??= "time_limit";
        await entry.job.stop();
        await entry.job.ended;
      },
      failed: (id) =>
        local.deps.logger.warn(
          JSON.stringify({ module: "background", event: "time_limit_stop_unverified", jobId: id }),
        ),
    });
    this.foreground = new ForegroundCommands({
      refusal: (context) => this.refusal(context),
      adopt: (source, job, trigger, seconds) => this.adopt(source, job, trigger, seconds),
      emit: (state) => local.deps.peer.emit("foregroundCommands.changed", state),
      change: (id) => this.changed(id),
      progress: (id) => {
        const entry = this.live.get(id);
        if (entry) this.emit(entry.row);
      },
    });
  }
  /** Kept until the actual process exit; database terminal status alone cannot certify drain. */
  resources() {
    const cleanups = [...this.cleanups.values()];
    return {
      starting:
        this.starting.size > 0 ||
        this.recovery.pending ||
        (this.local.deps.platform === "win32"
          ? cleanups.some((cleanup) => !cleanup.roots.length)
          : cleanups.length > 0),
      roots: [
        ...[...this.live.values()].flatMap((entry) => entry.roots),
        ...cleanups.flatMap((entry) => entry.roots),
      ],
    };
  }

  /** Keep the old command/write lease, while the queue may release the drained SDK session. */
  retainCleanup(
    runId: string,
    settling: () => Promise<void>,
    release: () => void,
    commandRoots?: readonly string[],
  ) {
    const entries = [...this.live.values()].filter(
      (entry) => entry.row.runId === runId && this.promoted.has(entry.row.id),
    );
    if (!entries.length && !commandRoots) return false;
    if (this.cleanups.has(runId)) return true;
    const settled = settling().then(() => {
      release();
      this.cleanups.delete(runId);
    });
    this.cleanups.set(runId, {
      rows: entries.map((entry) => entry.row),
      roots: [...new Set([...entries.flatMap((entry) => entry.roots), ...(commandRoots ?? [])])],
      settled,
    });
    void settled.catch(() => {
      // A rejected drain remains an owned resource, even if its database row is terminal.
      this.local.deps.logger.warn(
        JSON.stringify({ module: "background", event: "cleanup_unconfirmed", runId }),
      );
    });
    return true;
  }

  /** A live sandbox retains its startup roots until actual exit, even after the chat finishes. */
  topicBusy(conversationId: string) {
    return (
      this.repo.conversationBusy(conversationId) ||
      this.startingTopics.has(conversationId) ||
      [...this.cleanups.values()].some((entry) =>
        entry.rows.some((row) => row.conversationId === conversationId),
      ) ||
      [...this.live.values()].some(
        (entry) =>
          entry.row.conversationId === conversationId ||
          entry.sourceConversationId === conversationId,
      )
    );
  }

  /**
   * Brain restart: whatever a previous brain left running is stopped (it has no owner and no
   * chat line can stop it), then marked. Idempotent; safe when nothing is left.
   */
  recover(signal: AbortSignal) {
    return this.recovery.recover(signal);
  }

  refreshLimits() {
    this.limits.refresh();
  }

  /** Loopback ports this Bot's running background commands listen on (newest discovered first). */
  ports(botId: string, groupId?: string, scoped = false): number[] {
    const ports: number[] = [];
    const seen = new Set<number>();
    for (const entry of this.live.values())
      if (entry.row.botId === botId && (!scoped || (entry.row.groupId ?? undefined) === groupId))
        for (const port of entry.job.ports()) {
          if (seen.has(port)) continue;
          seen.add(port);
          ports.push(port);
        }
    return ports.slice(0, 48);
  }

  /** Standby: a running server is work the user expects to keep going. */
  isIdle() {
    return (
      this.live.size === 0 &&
      this.starting.size === 0 &&
      this.cleanups.size === 0 &&
      !this.recovery.pending
    );
  }

  runningRows() {
    return [...this.live.values()].map((entry) => entry.row);
  }
  /** Whether this process owns the command now (running, or its sandbox still cleaning up). */
  owns(id: string) {
    return (
      this.live.has(id) ||
      [...this.cleanups.values()].some((entry) => entry.rows.some((row) => row.id === id))
    );
  }

  /**
   * Pi's repair, on the person's request: a row still marked running that no live job owns. The
   * same orphan cleanup a restart does runs for this one row first; only a confirmed stop ends the
   * row, since a process that is still there must not disappear from the list.
   */
  async forgetGone(id: string, signal: AbortSignal): Promise<"forgotten" | "live" | "ended"> {
    if (this.owns(id)) return "live";
    const row = this.repo.running().find((value) => value.id === id);
    if (!row) return "ended";
    const left = await this.local.target.background.killOrphans(
      [{ group: row.group, processes: row.processes }],
      signal,
    );
    signal.throwIfAborted();
    if (left || this.owns(id)) return "live";
    const ended = transaction(this.local.deps.db, () => {
      if (this.repo.get(id)?.status !== "running") return false;
      this.repo.finish(id, { status: "stopped", stopReason: "orphaned", exitCode: null });
      this.audit(row, "stopped", "orphaned", "user");
      return true;
    });
    if (!ended) return "ended";
    this.refreshStatus(id);
    return "forgotten";
  }
  refreshStatus(id: string) {
    const row = this.repo.get(id);
    if (row) this.emit(row);
  }
  waitingRun(runId: string) {
    return (
      this.continuation.pendingRun(runId) ||
      this.runningRows().some(
        (row) =>
          row.runId === runId &&
          ["automatic", "waiting"].includes(this.continuation.state(row).continuation ?? ""),
      )
    );
  }
  followedRun(runId: string) {
    const runs = new RunsRepo(this.local.deps.db);
    let current = runs.get(runId);
    for (let depth = 0; current && depth < 32; depth++) {
      if (this.waitingRun(current.id)) return { run: current, waiting: true };
      const next = runs.backgroundChild(current.id);
      if (!next) break;
      current = next;
    }
    return { run: current, waiting: false };
  }

  list(botId: string, limit = 20, conversationId?: string): BackgroundCommand[] {
    return this.repo.list(botId, limit, conversationId).map((row) => this.view(row));
  }

  /** Records page: one page of running or ended commands with the chat they belong to. */
  page(query: {
    ids?: string[];
    from?: string;
    state: "running" | "ended";
    groupId?: string;
    botId?: string;
    before?: string;
    limit?: number;
  }): BackgroundCommandRecord[] {
    let rows: ReturnType<BackgroundCommandsRepo["page"]>;
    try {
      rows = this.repo.page(query);
    } catch (error) {
      if (error instanceof RangeError)
        throw new RpcError(RpcErrorCodes.invalidParams, "background_cursor_unknown");
      throw error;
    }
    return rows.map(({ place, ...row }) => ({ ...this.view(row), place }));
  }

  /**
   * Checked when the call is judged, so the user is not asked to approve a start that cannot
   * happen (start() checks again: another start may have finished meanwhile).
   */
  refusal(
    context: ToolRunContext,
  ): "background_routine" | "background_limit" | "background_bot_limit" | undefined {
    if (context.routineSource) return "background_routine";
    // Parallel topics each own their limit; the Bot-wide ceiling still bounds their sum.
    const live = [...this.live.values()];
    const running =
      live.filter((entry) => entry.row.botId === context.botId).length +
      (this.starting.get(context.botId) ?? 0);
    // Bot limit first: telling the model to stop in this topic would not free a slot.
    if (running >= MAX_BACKGROUND_COMMANDS_PER_BOT) return "background_bot_limit";
    const topic = context.conversationId;
    if (topic) {
      // Same topic scope as topicBusy: a command started from a task thread counts for both.
      const inTopic =
        live.filter(
          (entry) => entry.row.conversationId === topic || entry.sourceConversationId === topic,
        ).length + (this.startingTopics.get(topic) ?? 0);
      if (inTopic >= MAX_BACKGROUND_COMMANDS_PER_TOPIC) return "background_limit";
    }
    return undefined;
  }

  async start(input: BackgroundStart): Promise<LocalToolResult> {
    const { context, prepared } = input;
    const language = context.language;
    input.signal.throwIfAborted();
    input.assertAuthorized();
    const source = this.local.tasks.source(context);
    const platform = prepared.boundary?.location?.platform ?? this.local.deps.platform;
    const scanSignal = AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]);
    const paths =
      context.routineSource || Object.keys(input.secretEnv ?? {}).length
        ? undefined
        : scanPaths(prepared, platform);
    let roots: string[] | undefined;
    try {
      roots = paths
        ? await abortable(
            Promise.all(paths.map((path) => this.local.target.realpath(path, scanSignal))),
            scanSignal,
          )
        : undefined;
    } catch (error) {
      scanSignal.throwIfAborted();
      // Metadata is an optimization: du must still return partial results for accessible roots.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!code || !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(code)) throw error;
    }
    scanSignal.throwIfAborted();
    input.assertAuthorized();
    const scope = scanScope(context, source, prepared);
    const reservation = roots ? this.scans.acquire(scope, roots, platform) : undefined;
    if (reservation?.previous) {
      const entry = await abortable(reservation.previous, scanSignal);
      scanSignal.throwIfAborted();
      input.assertAuthorized();
      const row = this.repo.get(entry.row.id) ?? entry.row;
      this.local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "execution.todo.changed",
        summary: "Existing scan reused / 复用已有扫描",
        detail: {
          target: row.id,
          toolCallId: prepared.call.id,
          reasonCode: "scan_overlap_reused",
          actor: "automatic",
        },
      });
      return {
        text: `${language === "zh" ? "同一目录树已有扫描，本次未启动新命令；目录范围和扫描深度可能不同，请核对已有范围与输出，完成后只补未覆盖部分。" : "This tree already has a scan; no new command was started. Roots and depth may differ; check the existing scope and output, then scan only missing coverage after completion."}\n${backgroundText("output", language, { rows: [this.view(row)], output: entry.job.output(2000), logPath: entry.job.logPath, permissionOnly: entry.job.permissionOnly })}\n${language === "zh" ? "日志" : "Log"}: ${entry.job.logPath}${entry.scanOutput ? `\n${language === "zh" ? "原扫描结果文件（本次未创建新文件）" : "Original scan result file (no new file created)"}: ${auditText(entry.scanOutput, this.local.deps.redactor, 4000)}` : ""}`,
        untrustedContent: true,
        summary: language === "zh" ? "复用已有扫描" : "Existing scan reused",
        details: { backgroundWaiting: entry.job.running },
      };
    }
    const scan = reservation?.owner;
    // Routines run unattended; a server outliving the routine would have nobody to stop it.
    const refused = this.refusal(context);
    if (refused) {
      scan?.reject(new RpcError(RpcErrorCodes.busy, refused));
      scan?.release();
      return {
        text: backgroundText(
          refused === "background_routine"
            ? "routine"
            : refused === "background_bot_limit"
              ? "bot_limit"
              : "limit",
          language,
        ),
        isError: true,
      };
    }
    const topics = new Set(
      [context.conversationId, source.conversationId].filter((id): id is string => !!id),
    );
    for (const topic of topics)
      this.startingTopics.set(topic, (this.startingTopics.get(topic) ?? 0) + 1);
    this.starting.set(context.botId, (this.starting.get(context.botId) ?? 0) + 1);
    const id = randomUUID();
    const row: BackgroundCommandRow = {
      id,
      botId: context.botId,
      conversationId: context.conversationId ?? null,
      groupId: source.groupId ?? null,
      runId: context.runId,
      toolCallId: prepared.call.id.slice(0, 200),
      command: auditText(input.command, this.local.deps.redactor, 500),
      logPath: join(commandLogRoot(prepared.home), "background", `${id}.log`),
      status: "running",
      stopReason: null,
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    let entry: Entry | undefined;
    try {
      // Insert first: a crash right after the spawn still leaves a row to clean up from.
      this.repo.insert(row);
      const privateNetworkHosts =
        platform !== "win32" &&
        (!prepared.boundary?.location || prepared.boundary.location.target === "local")
          ? this.local.privateNetwork
              .hosts(context.runId)
              .map((host) => (host.includes(":") ? `[${host}]` : host))
          : [];
      const job = await this.local.target.startBackground({
        ...input.file,
        command: input.command,
        secretEnv: input.secretEnv,
        cwd: prepared.cwd,
        dataDir: this.local.deps.dataDir,
        botHome: prepared.home,
        skillGroupId: runPermissionScope(this.local, context),
        skillEnv: input.skillEnv,
        skillPackageIds:
          prepared.boundary?.location?.target === "local"
            ? this.local.skills?.packageIds?.(
                context.botId,
                runPermissionScope(this.local, context),
              )
            : undefined,
        jobId: id,
        runId: context.runId,
        toolCallId: prepared.call.id,
        network: {
          ...prepared.settings.network,
          domains: [...new Set([...prepared.settings.network.domains, ...privateNetworkHosts])],
        },
        privateNetworkHosts,
        pathEntries: prepared.settings.pathEntries,
        allowUnisolated: input.allowUnisolated,
        // The scripts this verdict read are re-checked right before the job starts.
        ...(prepared.result.analysis?.scriptPins?.length
          ? { scriptPins: prepared.result.analysis.scriptPins }
          : {}),
        // N2: and the interpreters it assumed are the system ones.
        ...(prepared.result.analysis?.scriptInterpreters?.length
          ? { scriptInterpreters: prepared.result.analysis.scriptInterpreters }
          : {}),
        assertAuthorized: input.assertAuthorized,
        signal: input.signal,
        callbacks: {
          onChange: () => this.changed(id),
          onProgress: () => {
            const current = this.live.get(id);
            if (current) this.emit(current.row);
          },
        },
      });
      row.logPath = job.logPath;
      entry = {
        row,
        job,
        waiters: new Set(),
        roots: [...input.file.writeRoots, prepared.cwd],
        sourceConversationId: source.conversationId,
        scanOutput: paths ? scanOutputPath(prepared, platform) : undefined,
        input: { command: input.command, cwd: prepared.cwd, scope: backgroundInputScope(prepared) },
      };
      this.live.set(id, entry);
      this.limits.add(id, row.startedAt);
      scan?.accept(entry);
      if (scan)
        void job.ended.then(
          () => scan.release(),
          () => {
            // Unconfirmed exit keeps both the process owner and its scan reservation.
          },
        );
      this.continuation.register(row, !!context.routineSource || !!context.executionTaskId);
      void job.ended.then((result) => this.finished(id, result));
    } catch (error) {
      if (!entry) {
        scan?.reject(error);
        scan?.release();
      }
      this.repo.finish(id, { status: "failed", stopReason: null, exitCode: null });
      throw error;
    } finally {
      for (const topic of topics) {
        const left = (this.startingTopics.get(topic) ?? 1) - 1;
        if (left > 0) this.startingTopics.set(topic, left);
        else this.startingTopics.delete(topic);
      }
      const left = (this.starting.get(context.botId) ?? 1) - 1;
      if (left > 0) this.starting.set(context.botId, left);
      else this.starting.delete(context.botId);
    }
    this.audit(row, "started", undefined, "automatic", input.auditFields);
    this.emit(row);
    await this.settle(entry, input.signal);
    const job = entry.job;
    const final = job.running ? undefined : this.repo.get(id);
    return {
      text: backgroundText("started", language, {
        id,
        logPath: job.logPath,
        ports: job.ports(),
        visible: job.listeners.supported,
        running: job.running,
        output: job.output(2000),
        permissionOnly: job.permissionOnly,
        exit: final?.exitCode ?? null,
        reason: final?.stopReason ?? null,
      }),
      summary:
        language === "zh"
          ? job.running
            ? "已在后台运行"
            : "后台命令已结束"
          : job.running
            ? "Running in the background"
            : "Background command ended",
      isError: !!final && final.status !== "exited",
      details: {
        backgroundWaiting: job.running,
        backgroundJobId: id,
        backgroundStatus: final?.status ?? "running",
        exitCode: final?.exitCode ?? null,
        timedOut: final?.stopReason === "time_limit",
        stopped: final?.status === "stopped",
      },
    };
  }

  private adopt(
    source: ForegroundSource,
    job: BackgroundJob,
    trigger: "timeout" | "user",
    seconds: number,
  ) {
    const { context, prepared } = source;
    if (this.refusal(context) || !job.running) return false;
    const parent = this.local.tasks.source(context);
    const row: BackgroundCommandRow = {
      id: job.id,
      botId: context.botId,
      runId: context.runId,
      conversationId: context.conversationId ?? null,
      groupId: parent.groupId ?? null,
      toolCallId: prepared.call.id,
      command: auditText(String(prepared.call.input.command), this.local.deps.redactor, 500),
      logPath: job.logPath,
      status: "running",
      stopReason: null,
      exitCode: null,
      startedAt: new Date(Date.now() - seconds * 1000).toISOString(),
      endedAt: null,
    };
    transaction(this.local.deps.db, () => {
      this.repo.insert(row);
      this.repo.setProcesses(row.id, job.record());
      this.local.approvals.audit.append({
        botId: context.botId,
        runId: context.runId,
        kind: "exec.promoted_to_background",
        summary: "Command moved to background / 命令已转入后台",
        detail: { target: job.id, durationMs: seconds * 1000, reasonCode: trigger },
      });
    });
    this.live.set(job.id, {
      row,
      job,
      waiters: new Set(),
      roots: [...(prepared.boundary?.roots.map((root) => root.canonicalPath) ?? []), prepared.cwd],
      sourceConversationId: parent.conversationId,
      scanOutput: scanOutputPath(
        prepared,
        prepared.boundary?.location?.platform ?? this.local.deps.platform,
      ),
      input: {
        command: String(prepared.call.input.command),
        cwd: prepared.cwd,
        scope: backgroundInputScope(prepared),
      },
    });
    this.limits.add(job.id, row.startedAt);
    this.promoted.add(job.id);
    const paths = scanPaths(
      prepared,
      prepared.boundary?.location?.platform ?? this.local.deps.platform,
    );
    if (paths) {
      const entry = this.live.get(job.id) as Entry;
      const release = this.scans.track(scanScope(context, parent, prepared), paths, entry);
      void job.ended.then(release, () => {
        // An unconfirmed promoted process must continue blocking duplicate scans.
      });
    }
    this.continuation.register(row, !!context.routineSource || !!context.executionTaskId);
    void job.ended.then(
      (result) => this.finished(job.id, result),
      () => {
        // Keep the live row and its roots when process exit cannot be certified.
        this.local.deps.logger.warn(`Promoted command drain failed id=${job.id}`);
      },
    );
    this.emit(row);
    return true;
  }

  /** Input can trigger new work and cannot borrow another topic's long-lived process. */
  inputTarget(context: ToolRunContext, id: string) {
    const entry = this.live.get(id);
    if (
      context.routineSource ||
      context.executionTaskId ||
      this.promoted.has(id) ||
      !entry ||
      !entry.job.running ||
      entry.row.botId !== context.botId ||
      !context.conversationId ||
      entry.row.conversationId !== context.conversationId ||
      entry.row.groupId !== (context.groupId ?? null)
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "background_input_unavailable");
    return entry.input;
  }

  /** Narrow host views used by the tools package; ownership and persistence stay here. */
  toolRecord(botId: string, id: string): BackgroundCommand | undefined {
    const row = this.repo.get(id);
    return row?.botId === botId ? this.view(row) : undefined;
  }

  toolOutput(botId: string, id: string, maxChars: number) {
    const row = this.repo.get(id);
    if (!row || row.botId !== botId) throw new RpcError(RpcErrorCodes.invalidParams, "unknown");
    const job = this.live.get(row.id)?.job ?? this.ended.get(row.id);
    return {
      row: this.view(row),
      output: job ? job.output(Math.min(Math.max(maxChars, 200), 20_000)) : null,
      permissionOnly: job?.permissionOnly,
      logPath: row.logPath,
    };
  }

  /** Snapshot and consumption share one synchronous owner turn, before queue availability. */
  readOutput(botId: string, id: string, maxChars: number, conversationId?: string) {
    const result = this.toolOutput(botId, id, maxChars);
    this.continuation.consume(result.row, botId, conversationId);
    return result;
  }

  async waitOutput(
    botId: string,
    id: string,
    maxChars: number,
    seconds: number,
    signal: AbortSignal,
    conversationId?: string,
    untilEnd = false,
  ) {
    signal.throwIfAborted();
    // Check the same Bot scope as output before registering any waiters.
    this.toolOutput(botId, id, maxChars);
    const entry = this.live.get(id);
    const endWait = this.continuation.wait(id);
    try {
      if (entry)
        await waitForBackgroundOutput(
          entry.job,
          seconds,
          signal,
          (changed) => {
            entry.waiters.add(changed);
            return () => entry.waiters.delete(changed);
          },
          // running becomes false before log/resource settlement; only finished retires the entry.
          () => this.live.get(id) !== entry,
          untilEnd,
        );
      signal.throwIfAborted();
      return this.readOutput(botId, id, maxChars, conversationId);
    } finally {
      endWait();
    }
  }

  /** Stops one command (user from the chat line, or the Bot); resolves with its final row. */
  async stop(botId: string, id: string, actor: "user" | "bot"): Promise<BackgroundCommand> {
    const row = this.repo.get(id);
    if (!row || row.botId !== botId) throw new RpcError(RpcErrorCodes.invalidParams, "unknown");
    const entry = this.live.get(id);
    // Start process cancellation before awaiting a continuation that may itself be draining it.
    const stopping = entry
      ? (async () => {
          entry.reason ??= actor;
          await entry.job.stop();
          await entry.job.ended;
        })()
      : Promise.resolve();
    await Promise.all([
      stopping,
      actor === "user" ? this.continuation.cancel(id) : Promise.resolve(),
    ]);
    return this.view(this.repo.get(id) ?? row);
  }

  /**
   * "Open in Bot browser": a new tab in this Bot's own browser, which
   * already lets exactly this Bot's listening ports through. brain builds the address from a
   * port the job listens on right now, so the UI cannot open anything else. The user asked for
   * it, not the model: no site approval, but an audit row.
   */
  async open(botId: string, id: string, requested: number | undefined, signal: AbortSignal) {
    const entry = this.live.get(id);
    const ports = entry && entry.row.botId === botId ? entry.job.ports() : [];
    const port = requested ?? ports[0];
    if (!entry || port === undefined || !ports.includes(port))
      throw new RpcError(RpcErrorCodes.invalidParams, "port_unavailable");
    const browser = entry.row.groupId
      ? this.local.browser.forGroup(entry.row.groupId)
      : this.local.browser;
    await browser.openLocal(botId, `http://localhost:${port}/`, signal);
    this.local.approvals.audit.append({
      botId,
      runId: entry.row.runId,
      kind: "browser.local_opened",
      summary: "User opened a local service in the Bot browser / 在 Bot 浏览器打开本机服务",
      detail: {
        actor: "user",
        domain: "localhost",
        target: `localhost:${port}`,
        toolCallId: entry.row.toolCallId,
      },
    });
    return { ok: true as const };
  }

  /** Close handoff admission and request stop before queue retirement waits for these owners. */
  async retirePromoted(botId?: string) {
    this.foreground.retire(botId);
    const entries = [...this.live.values()].filter(
      (entry) => this.promoted.has(entry.row.id) && (!botId || entry.row.botId === botId),
    );
    // Issue every stop before awaiting cancellation: a queued continuation can own a lease too.
    const stops = entries.map((entry) => {
      entry.reason ??= botId ? "bot_archived" : "app_quit";
      return entry.job.stop().then(() => entry.job.ended);
    });
    const cancellations = [...this.promoted]
      .filter((id) => !botId || this.repo.get(id)?.botId === botId)
      .map((id) => this.continuation.cancel(id));
    await Promise.all([...stops, ...cancellations]);
    await Promise.all(
      [...this.cleanups.values()]
        .filter((entry) => !botId || entry.rows.some((row) => row.botId === botId))
        .map((entry) => entry.settled),
    );
  }

  /** Bot archived / group deleted / Bot left a group / app quit: stop matching commands. */
  async stopWhere(match: (row: BackgroundCommandRow) => boolean, reason: BackgroundStopReason) {
    const entries = [...this.live.values()].filter((entry) => match(entry.row));
    await Promise.allSettled(
      entries.map(async (entry) => {
        entry.reason ??= reason;
        await entry.job.stop();
        await entry.job.ended;
      }),
    );
    await Promise.all(
      [...this.cleanups.values()]
        .filter((entry) => entry.rows.some(match))
        .map((entry) => entry.settled),
    );
  }

  /** Quit or brain stop: every command ends with the app. */
  async stopAll(reason: BackgroundStopReason = "app_quit") {
    // Client disconnect and force release may resume on this same brain instance.
    await this.stopWhere(() => true, reason);
  }

  private async settle(entry: Entry, signal: AbortSignal) {
    if (entry.job.ports().length || !entry.job.running) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        entry.waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (entry.job.ports().length || !entry.job.running) done();
      };
      const timer = setTimeout(done, SETTLE_MS);
      signal.addEventListener("abort", done, { once: true });
      entry.waiters.add(check);
      void entry.job.ended.then(done);
    });
  }

  private changed(id: string) {
    const entry = this.live.get(id);
    if (!entry) return;
    try {
      this.repo.setProcesses(id, entry.job.record());
    } catch {
      // A failed record only weakens restart cleanup; the process itself is still tracked.
      this.local.deps.logger.warn(`Background record failed id=${id}`);
    }
    for (const check of [...entry.waiters]) check();
    this.emit(entry.row);
    this.onPortsChanged?.(entry.row.botId);
  }

  private finished(
    id: string,
    result: { exitCode: number | null; reason: "exited" | "stopped" | "exposed" | "failed" },
  ) {
    const entry = this.live.get(id);
    if (!entry) return;
    this.limits.remove(id);
    this.live.delete(id);
    this.ended.set(id, entry.job);
    if (this.ended.size > RECENT_ENDED) {
      const oldest = this.ended.keys().next().value as string;
      this.ended.delete(oldest);
      this.promoted.delete(oldest);
      this.continuation.forget(oldest);
    }
    const status =
      result.reason === "exited" ? "exited" : result.reason === "failed" ? "failed" : "stopped";
    const stopReason: BackgroundStopReason | null =
      result.reason === "exposed"
        ? "exposed"
        : status === "stopped"
          ? (entry.reason ?? "user")
          : null;
    try {
      this.repo.finish(id, { status, stopReason, exitCode: result.exitCode });
      if (this.promoted.has(id)) {
        // A handoff ends only the foreground wait; count completion once, after actual drain.
        this.local.approvals.audit.append({
          botId: entry.row.botId,
          runId: entry.row.runId,
          kind: "exec.finished",
          summary: "Command finished / 命令结束",
          detail: {
            toolName: "run_command",
            toolCallId: entry.row.toolCallId,
            exitCode: result.exitCode,
            stopped: status === "stopped",
            ...(stopReason ? { reasonCode: stopReason } : {}),
            durationMs: Math.max(0, Date.now() - Date.parse(entry.row.startedAt)),
          },
        });
      } else
        this.audit(
          entry.row,
          "stopped",
          stopReason ?? status,
          stopReason === "user" ? "user" : "system",
        );
    } catch {
      // Shutdown may have closed the database; the restart cleanup covers the row.
      this.local.deps.logger.warn(`Background finish not recorded id=${id}`);
    }
    for (const check of [...entry.waiters]) check();
    const row = this.repo.get(id);
    if (row)
      this.continuation.finished(
        { ...row, outputLines: entry.job.outputLines },
        this.promoted.has(id),
      );
    if (row) this.emit(row);
    this.onPortsChanged?.(entry.row.botId);
  }

  private view(row: BackgroundCommandRow): BackgroundCommand {
    const job = this.live.get(row.id)?.job;
    const outputLines = (job ?? this.ended.get(row.id))?.outputLines;
    const { logPath: _logPath, ...rest } = row;
    return {
      ...rest,
      ...this.continuation.state(row),
      ...(this.promoted.has(row.id) ? { promoted: true } : {}),
      ...(outputLines === undefined ? {} : { outputLines }),
      ports: job?.running ? job.ports().slice(0, 16) : [],
      portsVisible: job ? job.listeners.supported : this.local.deps.platform !== "linux",
    };
  }

  private emit(row: BackgroundCommandRow) {
    const current = this.repo.get(row.id) ?? row;
    this.local.deps.peer.emit("backgroundCommands.changed", this.view(current));
    this.foreground.refresh();
  }

  private audit(
    row: BackgroundCommandRow,
    phase: "started" | "stopped",
    reason: string | undefined,
    actor: "user" | "automatic" | "system",
    fields: AuditDetail = {},
  ) {
    this.local.approvals.audit.append({
      botId: row.botId,
      runId: row.runId,
      kind: phase === "started" ? "exec.background.started" : "exec.background.stopped",
      summary:
        phase === "started"
          ? "Background command started / 后台命令开始"
          : "Background command ended / 后台命令结束",
      // Like exec.started: program names only (in `fields`), never the full command line.
      detail: {
        ...fields,
        toolCallId: row.toolCallId,
        actor,
        ...(reason ? { reasonCode: reason } : {}),
        ...(row.groupId ? { groupId: row.groupId } : {}),
      },
    });
  }

  async dispose() {
    const owners = [this.limits.dispose(), this.recovery.dispose()];
    await Promise.all([...owners, ...[...this.cleanups.values()].map((entry) => entry.settled)]);
    this.continuation.dispose();
    this.foreground.dispose();
    this.promoted.clear();
    this.live.clear();
    this.ended.clear();
  }
}
