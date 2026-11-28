// Long-lived stdio JSON-RPC processes inside the command sandbox: stdio MCP connections and
// external ACP agents share this host. One sandbox host process per server (see
// sandbox-host.ts for why hosts are per-command). The server's JSON-RPC stdio is carried on two
// extra pipes (fds 4 and 5) instead of the job log; the host inherits them numerically into the
// command. Exec owns process creation, the group kill and the private TMPDIR; callers only consume
// the returned stream. The SRT host path is POSIX-only.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { parseHostViolations } from "../command/process.ts";
import { checkedRoot, within } from "../core/paths.ts";
import type { ExecRedactor } from "../core/types.ts";
import { ExecError } from "../core/types.ts";
import {
  CONNECTOR_NETWORK_WAIT_MS,
  type ConnectorNetworkFilter,
  ConnectorNetworkRequestSchema,
} from "../sandbox/connector-network.ts";
import { classifySandboxBlock } from "../sandbox/sandbox-block.ts";
import { SANDBOX_HOST_DIR } from "../sandbox/sandbox-config.ts";
import { prepareSandboxHost } from "../sandbox/sandbox-host-launch.ts";
import { agentTempDir } from "../sandbox/temp-boundary.ts";
import { createViolationMonitor } from "../sandbox/violation-monitor.ts";
import { VIOLATIONS_LINE_BYTES } from "../sandbox/violation-report.ts";
import {
  type ConnectorServerDiagnosis,
  ConnectorStartError,
  DIAGNOSIS_STDERR_CHARS,
  settleWithin,
} from "./connector-diagnosis.ts";

/** Startup budget: SRT initialization (macOS ≈0.3 s, Linux more) plus the server's own boot. */
const HOST_READY_MS = 30_000;
/** SIGTERM to SIGKILL for the process group on close. */
const STOP_GRACE_MS = 3000;
/** Server stderr kept for diagnostics; brain decides what reaches logs or the UI. */
const STDERR_TAIL_CHARS = 8 * 1024;
/** One JSON-RPC frame above this size is a broken or hostile server, not a big result. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** A server that is already exiting reports its own code; longer means it is still running. */
const EXIT_SETTLE_MS = 1000;
/** Late kernel reports of a server that just died still belong to its start. */
const KERNEL_REPORT_MS = 600;
/** Longest a start waits for the kernel-report stream before sending the payload anyway. */
const MONITOR_READY_MS = 800;

/** Structural match of the protocol's ConnectorStream; exec has no workspace dependencies. */
export interface ConnectorServerStream {
  write(message: string, signal: AbortSignal): Promise<void>;
  onMessage(listener: (message: string) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
  /** Redacted recent server stderr, at most 8 KB. */
  stderrTail(): string;
  /**
   * What is known about this server's start so far. The first call also ends the
   * startup watch (the macOS kernel-report stream), so callers make it once startup is over,
   * whether it succeeded or not. Safe after close().
   */
  diagnose(retainKernelMonitor?: boolean): Promise<ConnectorServerDiagnosis>;
}

export interface SandboxedStdioOptions {
  platform: NodeJS.Platform;
  /**
   * Watch the macOS kernel's Seatbelt reports for this process until the first
   * diagnose() (or close). MCP starts want them; a long-lived agent that never asks would keep a
   * `log stream` process running for its whole session, so it leaves this off.
   */
  kernelReports?: boolean;
  /** Complete SRT boundary, built by the caller's own profile function. */
  config: SandboxRuntimeConfig;
  allowAll: boolean;
  networkFilter?: ConnectorNetworkFilter;
  command: string;
  args: readonly string[];
  /** Payload environment of the server; HOME and TMPDIR are set here. */
  env: NodeJS.ProcessEnv;
  tempDir: string;
  systemHome: string;
  /**
   * `private`: HOME is a fresh folder in the host's TMPDIR (connectors never see the user's
   * profile). `real`: HOME is the user's own (an external agent finds its login there; the
   * sandbox still decides what it may read). `cwd` was validated by the caller.
   */
  home: { kind: "private"; cwd?: string } | { kind: "real"; path: string; cwd: string };
  commandIdPrefix: string;
  signal: AbortSignal;
  redactor?: ExecRedactor;
  /** Dev-probe seam: run this host script instead of the built-in sandbox host. */
  hostScriptPath?: string;
  /**
   * External agents: TMPDIR is a short private folder of its own (`agentTempDir`), also exported
   * under these extra names (Claude Code reads CLAUDE_CODE_TMPDIR and otherwise uses /tmp).
   */
  agentTemp?: {
    variables: readonly string[];
    /** Further names pointed at a subfolder of it (tool caches and logs a program writes). */
    subfolders?: Readonly<Record<string, string>>;
  };
}

const TEMP_VARIABLES = ["TMPDIR", "TMP", "TEMP"];
const VARIABLE = /^[A-Z][A-Z0-9_]*$/;

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

export async function openSandboxedStdio(
  options: SandboxedStdioOptions,
): Promise<ConnectorServerStream> {
  // stdio may be the first command of this app lifetime; no previous exec creates this root.
  const hostRoot = join(await realpath(options.tempDir), SANDBOX_HOST_DIR);
  await mkdir(hostRoot, { recursive: true, mode: 0o700 });
  await checkedRoot(hostRoot);
  const host = await prepareSandboxHost({
    tempDir: options.tempDir,
    systemHome: options.systemHome,
    ...(options.hostScriptPath ? { scriptPath: options.hostScriptPath } : {}),
  });
  const config = options.config;
  // Not inside the host's TMPDIR: the payload denies writes there (it holds SRT's proxy sockets)
  // and a deny outranks this allow, so a home there was read-only and every npx / uv / pip
  // server failed creating its cache. A sibling 0700 folder under the host root is private to
  // this process; other sandboxes are denied writes under that root.
  const privateDir = await mkdtemp(join(hostRoot, "c")).catch(async (error: unknown) => {
    await host.cleanup();
    throw error;
  });
  let agentDir: string | undefined;
  const cleanup = async () => {
    await host.cleanup();
    await rm(privateDir, { recursive: true, force: true });
    if (agentDir) await rm(agentDir, { recursive: true, force: true });
  };
  const variables = [...TEMP_VARIABLES, ...(options.agentTemp?.variables ?? [])];
  try {
    if (!variables.every((name) => VARIABLE.test(name))) throw new ExecError("invalid_input");
    for (const [name, folder] of Object.entries(options.agentTemp?.subfolders ?? {}))
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || !/^[a-z0-9-]{1,40}$/.test(folder))
        throw new ExecError("invalid_input");
    await checkedRoot(privateDir);
    if (options.agentTemp) agentDir = await checkedRoot(await agentTempDir());
    // An agent boundary hides the whole temp tree on purpose and re-allows this folder below;
    // any other deny covering it (Pi Bot data, a protected root) still refuses to start.
    const tempParents = new Set([await realpath(tmpdir()), await realpath(options.tempDir)]);
    if (
      config.filesystem.denyRead.some(
        (entry) =>
          typeof entry !== "string" &&
          within(entry.path, privateDir) &&
          !(options.home.kind === "real" && tempParents.has(entry.path)),
      )
    )
      throw new ExecError("outside_workplace");
    options.signal.throwIfAborted();
  } catch (error) {
    await cleanup();
    throw error;
  }
  const temp = agentDir ?? privateDir;
  const own = [...new Set([privateDir, temp])].map((path) => ({ path, literal: true as const }));
  // Keep proxy sockets in the parent read-only; only this process's private folders are writable.
  config.filesystem.allowWrite = [...config.filesystem.allowWrite, ...own];
  // An agent boundary hides the temp trees; this process's own private folders stay usable.
  config.filesystem.allowRead = [...(config.filesystem.allowRead ?? []), ...own];
  const home = options.home.kind === "private" ? privateDir : options.home.path;
  const serverCwd = options.home.cwd ?? privateDir;
  // `exec` replaces the wrapping shell so signals hit the server directly and
  // the group stays small; the server keeps the inherited request/response fds.
  // SRT replaces the payload's TMPDIR with its shared /tmp/claude; set ours again in the shell.
  const line = [
    `export ${[
      ...variables.map((name) => `${name}=${quote(temp)}`),
      ...Object.entries(options.agentTemp?.subfolders ?? {}).map(
        ([name, folder]) => `${name}=${quote(join(temp, folder))}`,
      ),
    ].join(" ")}`,
    ["exec", options.command, ...options.args].map(quote).join(" "),
  ].join("\n");
  const commandId = `${options.commandIdPrefix}-${randomUUID()}`;
  const payload = host.payload({
    config,
    allowAll: options.allowAll,
    command: line,
    commandId,
    commandText: line,
    cwd: serverCwd,
    env: { ...options.env, HOME: home, TMPDIR: temp },
    stdioServer: true,
    ...(options.networkFilter ? { connectorNetwork: true } : {}),
  });

  // The kernel names what it refused (a hidden script, the Keychain). Started before
  // the host so it attaches during SRT setup; ends with the startup diagnosis.
  const monitor =
    options.kernelReports && options.platform === "darwin"
      ? createViolationMonitor("darwin")
      : undefined;
  let tracker = monitor?.track(commandId);
  const child = spawn(host.executable, host.args, {
    cwd: privateDir,
    env: host.env,
    detached: true,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (!pid) {
    // A failed host spawn still emits an asynchronous error after returning without a pid.
    child.once("error", () => {});
    child.unref();
    monitor?.dispose();
    await cleanup();
    throw new ExecError("connector_server_unavailable", "isolation_start_failed");
  }

  const stdio = child.stdio as unknown as import("node:stream").Writable[];
  const stdin = stdio[4];
  const responses = stdio[5] as unknown as import("node:stream").Readable;
  const status = child.stdio[3] as NodeJS.ReadableStream | null;
  if (!stdin) {
    child.unref();
    monitor?.dispose();
    await cleanup();
    throw new ExecError("connector_server_unavailable", "isolation_start_failed");
  }
  // A dead server reports through the response/status 'close' events; the read
  // sides must not crash the brain with an unhandled EPIPE. The request write
  // side gets a noop here because the ready handshake below writes the payload
  // before failChannelWrites (which also settles pending writes) is registered.
  stdin.on("error", () => {});
  responses.on("error", () => {});
  if (status) status.on("error", () => {});

  /** The stream is dead (process gone or close started); new writes are refused. */
  let connectionClosed = false;
  const networkLifetime = new AbortController();
  /** The private TMPDIR was actually removed; natural exit still requires this. */
  let cleanedUp = false;
  let closePromise: Promise<void> | undefined;
  const closeListeners = new Set<() => void>();
  const messageListeners = new Set<(message: string) => void>();
  /** Frames that arrived before the first listener subscribed (bounded). */
  const pendingMessages: string[] = [];
  let stderrTail = "";
  /** Serialized writes: backpressure must not reorder JSON-RPC frames. */
  let writeChain: Promise<void> = Promise.resolve();

  const killGroup = (signalName: NodeJS.Signals) => {
    try {
      process.kill(-pid, signalName);
    } catch {
      // The group is already gone.
    }
  };

  const note = (text: string) => {
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
  };

  /** Set once shutdown starts: a later exit is ours, not the server's own. */
  let stopRequested = false;
  /** The host exits with the server's own status (sandbox-host.ts), 125 for its own failures. */
  let exit: { code: number | null; signal: string | null; own: boolean } | undefined;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", (code, signal) => {
      exit = { code, signal, own: !stopRequested };
      resolve();
    }),
  );
  let hostFailed = false;
  /** The host's proxy refusals, sent once on fd 3 as it exits. */
  let proxyViolations: string[] = [];
  let watch: Promise<string[]> | undefined;
  const endWatch = (retain = false) => {
    watch ??= (async () => {
      try {
        if (!tracker) return [];
        // `log stream` delivers a dying process's reports up to a few hundred ms late (measured
        // with the run-as-me probe); only failure paths and background callers wait for this.
        await new Promise((resolve) => setTimeout(resolve, KERNEL_REPORT_MS));
        return await tracker.finish();
      } finally {
        if (retain) {
          tracker = monitor?.track(commandId);
          watch = undefined;
        } else monitor?.dispose();
      }
    })();
    return watch;
  };
  const diagnose = async (retainKernelMonitor = false): Promise<ConnectorServerDiagnosis> => {
    await settleWithin(exited, EXIT_SETTLE_MS);
    const kernel = await endWatch(retainKernelMonitor);
    const block = classifySandboxBlock({
      candidates: [],
      violations: [...kernel, ...proxyViolations],
      homes: [...new Set([options.systemHome, home])],
      cwd: serverCwd,
      config,
      platform: options.platform,
      succeeded: false,
      quietLoginKeychainMetadata: retainKernelMonitor && options.home.kind === "real",
    });
    const own = exit?.own === true;
    return {
      exited: own,
      exitCode: own ? (exit?.code ?? null) : null,
      signal: own ? (exit?.signal ?? null) : null,
      hostFailed,
      spawnFailed: false,
      outsideSandbox: false,
      stderrTail: stderrTail.slice(-DIAGNOSIS_STDERR_CHARS),
      denials: block?.items ?? [],
    };
  };

  const markClosed = () => {
    if (connectionClosed) return;
    connectionClosed = true;
    networkLifetime.abort();
    for (const listener of closeListeners) listener();
  };

  /** The request channel (fd 4) is dead: no request can be delivered, even
   * while responses (fd 5) still arrive. Tracked as state, not events, so a
   * write issued after the close/error event already fired cannot wait on a
   * drain that will never come. */
  let stdinDead = false;
  /** Backpressure waits in flight; the channel death fails them together. */
  const drainWaiters = new Set<(error: ExecError) => void>();

  const failChannelWrites = () => {
    if (stdinDead) return;
    stdinDead = true;
    // A closed request channel ends the connection: late responses cannot
    // serve new requests, so callers must observe the death.
    markClosed();
    const waiters = [...drainWaiters];
    drainWaiters.clear();
    for (const fail of waiters) fail(new ExecError("closed"));
  };

  // Replaces the previous noop: the error must both keep the process alive
  // (no uncaught EPIPE) and settle every pending write.
  stdin.on("error", failChannelWrites);
  stdin.on("close", failChannelWrites);

  /** Resolves once the whole process group is gone (ESRCH) or the deadline passes. */
  const waitGroupGone = (deadlineMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const started = Date.now();
      const poll = () => {
        try {
          process.kill(-pid, 0);
        } catch {
          resolve(true);
          return;
        }
        if (Date.now() - started >= deadlineMs) {
          resolve(false);
          return;
        }
        // Not unref'd: the close awaiter has no other handle to keep the loop alive.
        setTimeout(poll, 25);
      };
      poll();
    });

  /** Full shutdown: stop the group, wait for the streams, then remove the TMPDIR. */
  const shutdown = async (): Promise<void> => {
    // A server whose pipes already ended stopped by itself; the exit that follows is its own.
    if (!connectionClosed) stopRequested = true;
    connectionClosed = true;
    networkLifetime.abort();
    if (child.exitCode === null && !child.killed) {
      // Ending stdin also makes the host stop its own group; signal the group
      // directly as well so close() does not depend on the host noticing.
      stdin.end();
      killGroup("SIGTERM");
      // Drain means the whole group is gone: a server that traps SIGTERM must
      // not be left running (nor orphaned) after close() resolves.
      if (!(await waitGroupGone(STOP_GRACE_MS))) killGroup("SIGKILL");
      await waitGroupGone(STOP_GRACE_MS);
    } else {
      stdin.end();
    }
    // The group is gone; wait until the response/status pipes report their end
    // so no late frame is lost after close() resolves. The events may already
    // have fired while the group was draining.
    await Promise.all([
      responsesClosed
        ? Promise.resolve()
        : new Promise<void>((resolve) => responses.once("close", resolve)),
      ...(status
        ? [
            statusClosed
              ? Promise.resolve()
              : new Promise<void>((resolve) => status.once("close", resolve)),
          ]
        : []),
    ]);
    child.unref();
    // A start whose diagnosis was never asked for (an abort) still releases the log stream; not
    // awaited, so close() does not wait for late kernel reports nobody may read.
    void endWatch();
    if (!cleanedUp) {
      // A failed cleanup keeps ownership: close() can be retried.
      await cleanup();
      cleanedUp = true;
    }
  };

  const close = (): Promise<void> => {
    // A failed close clears the cache so a retry re-runs the pending cleanup.
    closePromise ??= shutdown().catch((error) => {
      closePromise = undefined;
      throw error;
    });
    return closePromise;
  };

  child.stdin?.on("error", () => {});
  // A spawn error (ENOENT and friends) is reported as a fixed note; the raw
  // error may carry paths. The readiness handshake below still fails through
  // the status pipe closing.
  child.once("error", () => note("host process error\n"));

  // Server stderr: capped, redacted tail for diagnostics only.
  const stderrDecoder = new StringDecoder("utf8");
  if (child.stderr) {
    const redacted = options.redactor ? options.redactor.stream() : undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      const text = redacted
        ? redacted.push(stderrDecoder.write(chunk))
        : stderrDecoder.write(chunk);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
    });
    child.stderr.once("end", () => {
      const text = redacted ? redacted.finish() : stderrDecoder.end();
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
    });
    child.stderr.once("error", () => {});
  }

  // Newline-delimited JSON-RPC from the server; malformed frames are dropped
  // (the SDK layer reports the protocol failure, not the raw bytes). A frame
  // above the cap without a newline is a broken server: end the stream.
  let responseTail = "";
  let responseTailBytes = 0;
  const responseDecoder = new StringDecoder("utf8");
  responses.on("data", (chunk: Buffer) => {
    responseTail += responseDecoder.write(chunk);
    responseTailBytes += chunk.byteLength;
    for (
      let newline = responseTail.indexOf("\n");
      newline >= 0;
      newline = responseTail.indexOf("\n")
    ) {
      const frame = responseTail.slice(0, newline);
      responseTail = responseTail.slice(newline + 1);
      if (!frame) continue;
      if (messageListeners.size === 0) {
        // Deliver after subscription instead of dropping early server output.
        if (pendingMessages.length < 64) pendingMessages.push(frame);
        continue;
      }
      for (const listener of messageListeners) listener(frame);
    }
    responseTailBytes = Buffer.byteLength(responseTail);
    if (responseTailBytes > MAX_FRAME_BYTES) {
      note("response frame exceeded the size limit\n");
      responses.destroy();
      markClosed();
    }
  });
  let responsesClosed = false;
  let statusClosed = false;
  responses.once("close", () => {
    responsesClosed = true;
    markClosed();
  });
  if (status)
    status.once("close", () => {
      statusClosed = true;
    });

  // Network decisions use the host-only status/control pipes, never the MCP JSON-RPC pipes.
  const networkPending = new Map<number, AbortController>();
  const networkLine = (line: string) => {
    const filter = options.networkFilter;
    if (!filter || networkLifetime.signal.aborted) return;
    if (line.startsWith("network-cancel ")) {
      networkPending.get(Number(line.slice(15)))?.abort();
      return;
    }
    if (!line.startsWith("network ") || line.length > 512 || networkPending.size >= 32) return;
    try {
      const { id, ...attempt } = ConnectorNetworkRequestSchema.parse(JSON.parse(line.slice(8)));
      if (networkPending.has(id)) return;
      const controller = new AbortController();
      networkPending.set(id, controller);
      const signal = AbortSignal.any([
        networkLifetime.signal,
        controller.signal,
        AbortSignal.timeout(CONNECTOR_NETWORK_WAIT_MS),
      ]);
      void filter(attempt, signal)
        .catch(() => false) // Failure at the decision boundary refuses the request.
        .then((allow) => {
          if (!signal.aborted)
            child.stdin?.write(`${JSON.stringify({ id, allow })}
`);
        })
        .finally(() => networkPending.delete(id));
    } catch {
      // A malformed host frame can never authorize egress.
    }
  };
  let statusText = "";
  const afterReady = (text: string) => {
    if (statusText.length > VIOLATIONS_LINE_BYTES) return;
    statusText += text;
    for (let newline = statusText.indexOf("\n"); newline >= 0; newline = statusText.indexOf("\n")) {
      const line = statusText.slice(0, newline);
      statusText = statusText.slice(newline + 1);
      if (line.startsWith("violations "))
        proxyViolations = parseHostViolations(line.slice(11)) ?? [];
      else networkLine(line);
    }
  };

  // One payload line, then the readiness report on fd 3; the channel stays
  // open afterwards as the liveness signal (a closed stdin stops the group).
  const ready = await new Promise<boolean>((resolve) => {
    if (!status) return resolve(false);
    let text = "";
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      status.off("data", data);
      status.off("close", closedEarly);
      resolve(ok);
    };
    const data = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 1024) return done(false);
      for (
        let newline = text.indexOf("\n");
        newline >= 0 && !settled;
        newline = text.indexOf("\n")
      ) {
        const reportLine = text.slice(0, newline);
        text = text.slice(newline + 1);
        done(reportLine === "ready");
        if (reportLine === "ready") {
          // The same chunk may already carry the exit report of a server that died at once.
          status.on("data", (chunk: Buffer) => afterReady(chunk.toString("utf8")));
          if (text) afterReady(text);
        }
      }
    };
    const closedEarly = () => done(false);
    const abort = () => done(false);
    const timeout = setTimeout(abort, HOST_READY_MS);
    status.on("data", data);
    status.once("close", closedEarly);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    // The kernel-report stream attaches first (~0.5 s measured), else the denials of a server that
    // dies at once can be missed. macOS also folds repeats of one denial into "duplicate
    // reports", so a quick retry may show none. Bounded: a stdio start is not a hot path.
    else
      void settleWithin(tracker?.ready ?? Promise.resolve(), MONITOR_READY_MS).then(() => {
        if (!settled) child.stdin?.write(payload);
      });
  });
  if (!ready) {
    const reason: ExecError["reason"] = options.signal.aborted
      ? "cancelled"
      : "isolation_start_failed";
    hostFailed = !options.signal.aborted;
    await close();
    if (options.signal.aborted) throw new ExecError("connector_server_unavailable", reason);
    // The diagnosis carries the host's (bwrap / SRT / server) redacted stderr tail, which
    // explains a failed start, with the exit and the sandbox's own refusals.
    throw new ConnectorStartError(reason, await diagnose());
  }

  return {
    write(message: string, signal: AbortSignal) {
      if (connectionClosed) return Promise.reject(new ExecError("closed"));
      const line = `${message}\n`;
      // Serialize onto the chain so concurrent writes keep their order under
      // backpressure instead of interleaving partial frames.
      const result = writeChain.then(async () => {
        // The channel may have died while this write was queued: state, not
        // event listeners, is the source of truth here, because the close or
        // error event can have fired before this callback ran.
        if (connectionClosed || stdin.destroyed || stdin.writableEnded)
          throw new ExecError("closed");
        // Map abort to the stream's own error shape (not the raw DOMException)
        // and reject before touching stdin, so an already-aborted signal cannot
        // leave a drain/abort listener pair waiting on a drain that never comes.
        if (signal.aborted) throw new ExecError("closed", "cancelled");
        if (!stdin.write(line)) {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const onDrain = () => settle();
            const onAbort = () => settle(new ExecError("closed", "cancelled"));
            /** Registered in drainWaiters so channel death fails this wait. */
            const fail = (error: ExecError) => settle(error);
            const settle = (error?: ExecError) => {
              if (settled) return;
              settled = true;
              // Every settlement path removes all listeners: a reused signal
              // must not accumulate listeners across writes.
              signal.removeEventListener("abort", onAbort);
              stdin.off("drain", onDrain);
              drainWaiters.delete(fail);
              if (error) reject(error);
              else resolve();
            };
            signal.addEventListener("abort", onAbort);
            drainWaiters.add(fail);
            stdin.once("drain", onDrain);
            // The channel can die between the state check above and these
            // listeners: fail now instead of waiting for a dead drain.
            if (stdinDead || connectionClosed) settle(new ExecError("closed"));
          });
        }
      });
      // A failure must not poison the chain for later writes; the caller sees
      // the original error.
      writeChain = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    onMessage(listener) {
      messageListeners.add(listener);
      // Frames buffered before the first subscription arrive in order now.
      for (const frame of pendingMessages.splice(0)) listener(frame);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close,
    stderrTail: () => stderrTail,
    diagnose,
  };
}
