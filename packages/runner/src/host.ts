import { createHash, randomUUID } from "node:crypto";
import type { BackgroundJob, ExecutionTarget, GitEntryPlan } from "@pibot/execution";
import { ExecError, gitEntryPlanCurrent } from "@pibot/execution";
import { MAX_PLAINTEXT } from "@pibot/link";
import type { PhoneControlGrant } from "@pibot/protocol-base";
import {
  createPeer,
  HostComputerMethods,
  type HostComputerParams,
  type HostComputerResults,
  type ManagedGitPort,
  type Params,
  type Port,
  RpcError,
  RpcErrorCodes,
  RUNNER_CAPABILITY_VERSIONS,
  RUNNER_TRANSFER_MAX_BYTES,
  RunnerBackgroundOrphanResultSchema,
  RunnerBackgroundOrphansSchema,
  RunnerBackgroundPageSchema,
  RunnerBackgroundSnapshotSchema,
  RunnerBinaryPublicationSchema,
  type RunnerExecutionError,
  RunnerExecutionErrorSchema,
  RunnerFileRequestSchema,
  RunnerIdSchema,
  RunnerManagedGitExecuteResultSchema,
  RunnerManagedGitInspectResultSchema,
  RunnerManagedGitPrepareResultSchema,
  type RunnerMethods,
  runnerEvents,
  runnerFileResultSchemas,
  runnerMethods,
} from "@pibot/protocol-base";
import { RunnerJobCapacityError, type RunnerJobRegistry } from "./jobs.ts";
import type { ExecutionJournal } from "./journal.ts";
import { type PolicyFactSource, phonePolicyFacts } from "./phone-policy.ts";

const CHUNK_BYTES = 512 * 1024;
const MAX_ACTIVE_TRANSFERS = 4;
const MAX_AGGREGATE_BYTES = 128 * 1024 * 1024;
if (Math.ceil((CHUNK_BYTES * 4) / 3) + 1024 > MAX_PLAINTEXT)
  throw new Error("Runner chunk exceeds encrypted frame limit");

type PhoneControls = {
  update(grants: PhoneControlGrant[]): Promise<void>;
  assert(grant: PhoneControlGrant): Promise<void>;
};
type Control = { kind: "phone"; grant: PhoneControlGrant };
type RuntimeOptions = {
  policyFacts?: PolicyFactSource;
  phoneControls?: PhoneControls;
  deviceId: string;
  appVersion?: string;
  platform: "darwin" | "win32" | "linux";
  /** Supplied by the runner entry, never by a command request or desktop. */
  commandProtectionRoots?: readonly string[];
  target: ExecutionTarget;
  managedGitPort?: ManagedGitPort;
  journal: ExecutionJournal;
  jobs: RunnerJobRegistry;
  registerSecrets(values: readonly string[]): () => void;
  computer?: {
    call<K extends keyof HostComputerParams>(
      method: K,
      input: HostComputerParams[K],
      signal: AbortSignal,
    ): Promise<HostComputerResults[K]>;
    setBlocklist(ids: readonly string[]): void;
    revokeAll(): void | Promise<void>;
    dispose(): Promise<void>;
  };
};
type HostOptions = RuntimeOptions & { port: Port };
type BackgroundEnd = Awaited<BackgroundJob["ended"]>;
type BackgroundSnapshot = ReturnType<typeof RunnerBackgroundSnapshotSchema.parse>;
type RuntimeBackgrounds = ReturnType<typeof createRuntimeBackgrounds>;
type SessionOptions = HostOptions & {
  backgrounds: RuntimeBackgrounds;
  control?: Control;
  ready: Promise<void>;
};
type Upload = {
  spec: Params<RunnerMethods, "runner.transfer.begin">;
  bytes: Buffer;
  offset: number;
  sequence: number;
  timer: ReturnType<typeof setTimeout>;
};
type Download = {
  capability: string;
  cleanupReceipt: boolean;
  bytes: Buffer;
  sequence: number;
  timer: ReturnType<typeof setTimeout>;
};

const SAFE_CODE = /^[A-Za-z0-9_.:$-]{1,80}$/;

/** Identifiers only: an error message may quote a path or the command. */
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const raw = (error as { code?: unknown }).code;
  if (typeof raw === "string" && SAFE_CODE.test(raw)) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  const name = error.constructor?.name;
  return name && name !== "Object" && SAFE_CODE.test(name) ? name : undefined;
}

function mapExecutionError(error: unknown, includeCheck: boolean): never {
  if (error instanceof RpcError) throw error;
  if (error instanceof ExecError) {
    const data: RunnerExecutionError | undefined = includeCheck
      ? { kind: "runner_execution_check_v1", code: error.code, reason: error.reason }
      : undefined;
    if (error.reason === "unsupported_platform" || error.code === "docker_unsupported")
      throw new RpcError(RpcErrorCodes.unsupported, "Runner operation unsupported", data);
    if (error.code === "busy") throw new RpcError(RpcErrorCodes.busy, "Runner busy", data);
    // A reason the desktop must tell apart from a broken command: it clears by itself.
    if (error.reason === "cleanup_unconfirmed")
      throw new RpcError(
        RpcErrorCodes.runnerCleanupUnconfirmed,
        "Runner cleanup unconfirmed",
        data,
      );
    // Only the monitor giving up is "stopped part-way, may have partially run; check state first":
    // a snapshot failure while killing or confirming cleanup means the command may already have
    // executed and is cleanup_failed instead.
    if (error.reason === "process_monitor_failed")
      throw new RpcError(RpcErrorCodes.runnerTransient, "runner_transient", data);
    if (error.code === "authorization_changed")
      throw new RpcError(RpcErrorCodes.dispatchDenied, "dispatch_denied", data);
    if (["invalid_input", "outside_workplace"].includes(error.code))
      throw new RpcError(RpcErrorCodes.invalidParams, "Runner input rejected", data);
    // Keep the old coarse internal response for clients without the extension.
    throw new RpcError(RpcErrorCodes.internal, "Internal error", data);
  }
  throw error;
}

function registerSecretLease(options: RuntimeOptions, values: readonly string[]) {
  try {
    return options.registerSecrets(values);
  } catch {
    throw new RpcError(RpcErrorCodes.busy, "Runner secret redaction capacity exhausted");
  }
}

function streamOutput(stream: (chunk: unknown) => void, text: string) {
  const parts: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 128 * 1024 && parts.length) {
      stream({ kind: "output", text: parts.join("") });
      parts.length = 0;
      bytes = 0;
    }
    parts.push(character);
    bytes += size;
  }
  if (parts.length) stream({ kind: "output", text: parts.join("") });
}

function createRuntimeBackgrounds(options: RuntimeOptions) {
  const active = new Map<string, BackgroundJob>();
  const owners = new Map<string, string>();
  const terminal = new Map<string, { snapshot: BackgroundSnapshot; expiresAt: number }>();
  const pendingTasks = new Set<Promise<void>>();
  const healthFailures: unknown[] = [];
  let unhealthy = false;
  const ttlMs = 7 * 24 * 60 * 60 * 1000;
  const markUnhealthy = (error: unknown) => {
    unhealthy = true;
    if (healthFailures.length < 16) healthFailures.push(error);
  };
  const hold = (task: Promise<unknown>) => {
    let observed!: Promise<void>;
    observed = task
      .then(
        () => {},
        (error) => markUnhealthy(error),
      )
      .finally(() => pendingTasks.delete(observed));
    pendingTasks.add(observed);
  };
  const assertHealthy = () => {
    if (unhealthy) throw new RpcError(RpcErrorCodes.closed, "Runner runtime unhealthy");
  };
  const snapshot = (
    job: BackgroundJob,
    maxChars = 65536,
    ended: BackgroundEnd | null = null,
  ): BackgroundSnapshot =>
    RunnerBackgroundSnapshotSchema.parse({
      id: job.id,
      logPath: job.logPath,
      running: job.running,
      outputLines: job.outputLines,
      permissionOnly: job.permissionOnly,
      listeners: job.listeners,
      ports: job.ports(),
      output: job.output(maxChars),
      record: job.record(),
      ended,
    });
  const prune = () => {
    const now = Date.now();
    for (const [id, item] of terminal)
      if (item.expiresAt <= now) {
        terminal.delete(id);
        owners.delete(id);
      }
    while (terminal.size && terminal.size + active.size > 64) {
      const id = terminal.keys().next().value as string;
      terminal.delete(id);
      owners.delete(id);
    }
  };
  const rememberEnd = (job: BackgroundJob, ended: BackgroundEnd) => {
    const finalSnapshot = snapshot(job, 65536, ended);
    active.delete(job.id);
    terminal.delete(job.id);
    terminal.set(job.id, { snapshot: finalSnapshot, expiresAt: Date.now() + ttlMs });
    prune();
    // Keep a failed removal observable and unhealthy; the durable stale identity is then recovered
    // by pid + start-time on restart rather than silently forgotten.
    hold(options.jobs.remove(job.id));
  };
  return {
    assertHealthy,
    owns: (jobId: string, owner: string) => owners.get(jobId) === owner,
    async register(job: BackgroundJob, owner = "desktop") {
      try {
        assertHealthy();
        await options.jobs.track(job);
      } catch (error) {
        const capacityError = error instanceof RunnerJobCapacityError;
        if (!capacityError) markUnhealthy(error);
        try {
          await job.stop();
        } catch (stopError) {
          markUnhealthy(stopError);
          throw new AggregateError(
            [error, stopError],
            "Runner background admission and cleanup failed",
          );
        }
        if (capacityError)
          throw new RpcError(RpcErrorCodes.busy, "Runner background job capacity exhausted");
        throw error;
      }
      terminal.delete(job.id);
      active.set(job.id, job);
      owners.set(job.id, owner);
      prune();
      const completion = job.ended.then((ended) => rememberEnd(job, ended));
      hold(completion);
      if (!job.running) await completion;
      return this.inspect(job.id);
    },
    changed(job: BackgroundJob) {
      if (active.get(job.id) !== job) return;
      if (unhealthy) return;
      hold(
        options.jobs.track(job).catch(async (persistError) => {
          try {
            await job.stop();
          } catch (stopError) {
            throw new AggregateError(
              [persistError, stopError],
              "Runner background update and cleanup failed",
            );
          }
          throw persistError;
        }),
      );
    },
    inspect(jobId: string, maxChars = 65536): BackgroundSnapshot | undefined {
      prune();
      const job = active.get(jobId);
      if (job) return snapshot(job, maxChars);
      const ended = terminal.get(jobId)?.snapshot;
      return ended ? { ...ended, output: ended.output.slice(-maxChars) } : undefined;
    },
    async stop(jobId: string) {
      const job = active.get(jobId);
      if (!job) return this.inspect(jobId);
      await job.stop();
      const ended = await job.ended;
      // A concurrent inspect may acknowledge and remove the terminal cache while stop drains.
      // The owned job's real terminal receipt remains authoritative for this request.
      return this.inspect(jobId) ?? snapshot(job, 65536, ended);
    },
    list(maxChars = 65536, after?: string, owner?: string) {
      prune();
      const values = [
        ...[...active.values()].map((job) => snapshot(job, maxChars)),
        ...[...terminal.values()].map(({ snapshot: ended }) => ({
          ...ended,
          output: ended.output.slice(-maxChars),
        })),
      ].sort((a, b) => a.id.localeCompare(b.id));
      const remaining = values.filter(
        (item) => (!after || item.id > after) && (!owner || owners.get(item.id) === owner),
      );
      const items = remaining.slice(0, 8);
      return RunnerBackgroundPageSchema.parse({
        items,
        ...(remaining.length > items.length && items.length
          ? { nextCursor: (items[items.length - 1] as BackgroundSnapshot).id }
          : {}),
      });
    },
    ack(jobId: string) {
      if (terminal.delete(jobId)) owners.delete(jobId);
    },
    async drain() {
      while (pendingTasks.size) await Promise.all([...pendingTasks]);
      if (healthFailures.length)
        throw new AggregateError([...healthFailures], "Runner background runtime became unhealthy");
    },
  };
}

async function attachRunnerSession(options: SessionOptions, detached: () => void) {
  // An old client rejects extra keys in the RPC error envelope.
  let executionChecksEnabled = false;
  const mapped: (error: unknown) => never = (error) =>
    mapExecutionError(error, executionChecksEnabled);
  if (!options.port.sendStream)
    throw new RpcError(RpcErrorCodes.unsupported, "Runner port does not support streaming");
  const targetId = `runner:${RunnerIdSchema.parse(options.deviceId)}` as const;
  if (options.journal.targetId !== targetId || options.jobs.targetId !== targetId)
    throw new RpcError(RpcErrorCodes.invalidParams, "Runner registry identity mismatch");
  const uploads = new Map<string, Upload>();
  const downloads = new Map<string, Download>();
  let aggregateBytes = 0;
  let closing = false;
  let retiring = false;
  let inFlight = 0;
  let disposal: Promise<void> | undefined;
  const ownedRuns = new Set<string>();
  const phonePolicy = phonePolicyFacts(targetId, options.policyFacts);

  function release(id: string) {
    const transfer = uploads.get(id) ?? downloads.get(id);
    if (!transfer) return;
    clearTimeout(transfer.timer);
    aggregateBytes -= transfer.bytes.length;
    uploads.delete(id);
    downloads.delete(id);
  }
  function clearTransfers() {
    for (const id of [...uploads.keys(), ...downloads.keys()]) release(id);
  }
  function reserve(bytes: number) {
    if (
      bytes > RUNNER_TRANSFER_MAX_BYTES ||
      uploads.size + downloads.size >= MAX_ACTIVE_TRANSFERS ||
      aggregateBytes + bytes > MAX_AGGREGATE_BYTES
    )
      throw new RpcError(RpcErrorCodes.busy, "Runner transfer capacity exhausted");
    aggregateBytes += bytes;
  }
  function download(bytes: Uint8Array, capability = "runner.files", cleanupReceipt = false) {
    reserve(bytes.byteLength);
    const transferId = randomUUID();
    try {
      const body = Buffer.from(bytes);
      const timer = setTimeout(() => release(transferId), 60_000);
      downloads.set(transferId, { bytes: body, sequence: 0, timer, capability, cleanupReceipt });
      return {
        transferId,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    } catch (error) {
      aggregateBytes -= bytes.byteLength;
      throw error;
    }
  }
  function jsonDownload(value: unknown, capability = "runner.files", cleanupReceipt = false) {
    return download(Buffer.from(JSON.stringify(value), "utf8"), capability, cleanupReceipt);
  }
  async function once<T>(key: string, issuedAt: string, operation: () => Promise<T>): Promise<T> {
    options.backgrounds.assertHealthy();
    const admission = options.journal.admit(key, issuedAt);
    if (admission.status === "expired")
      throw new RpcError(RpcErrorCodes.idempotencyExpired, "idempotency_expired");
    if (admission.status === "busy")
      throw new RpcError(RpcErrorCodes.busy, "Runner idempotency registry full");
    if (admission.status === "existing")
      throw new RpcError(RpcErrorCodes.closed, "Runner result requires reconciliation");
    await admission.persisted;
    try {
      const result = await operation();
      await options.journal.done(key);
      return result;
    } catch (error) {
      // The journal carries the code so an `unknown` entry explains itself afterwards.
      await options.journal.unknown(key, errorCode(error));
      mapped(error);
    }
  }
  // Peer disposal stops admission and active requests, while the host owns final Port closure.
  const peerPort: Port = {
    post: (message, transfer) => options.port.post(message, transfer),
    onMessage: (listener) => options.port.onMessage(listener),
    postRequest: options.port.postRequest?.bind(options.port),
    cancelRequest: options.port.cancelRequest?.bind(options.port),
    onRequestCancel: options.port.onRequestCancel?.bind(options.port),
    sendStream: options.port.sendStream?.bind(options.port),
    onRequestStream: options.port.onRequestStream?.bind(options.port),
    onClose: options.port.onClose?.bind(options.port),
  };
  const peer = createPeer(peerPort, {
    methods: runnerMethods,
    events: runnerEvents,
    errorDataSchema: RunnerExecutionErrorSchema,
  });
  let enabled: Set<string> | undefined;
  const requireCapability = (id: string) => {
    if (
      (id === "runner.computer" && !enabled?.has(id)) ||
      (options.control && !options.control.grant.body.capabilities.includes(id as never)) ||
      (enabled && !enabled.has(id))
    )
      throw new RpcError(RpcErrorCodes.unsupported, "capability_off");
  };
  const capabilityFor = (method: string) => {
    if (method === "runner.policy.prepare") return undefined;
    if (method.startsWith("runner.computer.")) return "runner.computer";
    if (method.startsWith("runner.background.")) return "runner.background";
    if (method.startsWith("runner.command.") || method === "runner.git.entries")
      return "runner.exec";
    if (method === "runner.binary.read") return "runner.files";
    if (method.startsWith("runner.managedGit.")) return "runner.managed-git";
    return undefined;
  };
  // Cleanup/reconciliation remain reachable so a closed capability cannot strand owned work.
  const cleanupMethods = new Set([
    "runner.command.release",
    "runner.background.stop",
    "runner.background.ack",
    "runner.transfer.cancel",
  ]);
  const handle: typeof peer.handle = (method, handler) =>
    peer.handle(method, async (input, context) => {
      await options.ready;
      context.signal.throwIfAborted();
      if (closing) throw new RpcError(RpcErrorCodes.closed, "controller_retired");
      const continuingTransfer =
        method.startsWith("runner.transfer.") && method !== "runner.transfer.begin";
      if (
        retiring &&
        !cleanupMethods.has(method) &&
        !continuingTransfer &&
        method !== "runner.reconcile"
      )
        throw new RpcError(RpcErrorCodes.busy, "desktop_priority");
      if (options.control) {
        const value = input as { jobId?: string; runId?: string; request?: { kind?: string } };
        if (
          value.jobId &&
          method !== "runner.background.start" &&
          !options.backgrounds.owns(value.jobId, options.control.grant.body.phone)
        )
          throw new RpcError(RpcErrorCodes.dispatchDenied, "background_owner_mismatch");
        if (method === "runner.command.release" && !ownedRuns.has(value.runId ?? ""))
          throw new RpcError(RpcErrorCodes.dispatchDenied, "run_owner_mismatch");
      }
      if (options.control && !cleanupMethods.has(method)) {
        await options.phoneControls?.assert(options.control.grant);
        if (!options.phoneControls)
          throw new RpcError(RpcErrorCodes.unsupported, "phone_control_unsupported");
        if (
          (input as { request?: { kind?: string } }).request?.kind === "background_orphans" ||
          method === "runner.phoneAuthorizations.set" ||
          method === "runner.git.entries" ||
          // Phone control covers commands and files only; computer use and managed Git stay desktop-driven.
          method.startsWith("runner.computer.") ||
          method.startsWith("runner.managedGit.")
        )
          throw new RpcError(RpcErrorCodes.unsupported, "phone_control_operation_unsupported");
      }
      if (
        retiring &&
        !cleanupMethods.has(method) &&
        !continuingTransfer &&
        method !== "runner.reconcile"
      )
        throw new RpcError(RpcErrorCodes.busy, "desktop_priority");
      context.signal.throwIfAborted();
      inFlight++;
      try {
        const capability = capabilityFor(method);
        if (
          capability &&
          !cleanupMethods.has(method) &&
          !(
            method === "runner.computer.call" &&
            (input as { method: string }).method === "host.computer.grants.revoke"
          )
        )
          requireCapability(capability);
        if (method.startsWith("runner.transfer.") && method !== "runner.transfer.cancel") {
          const value = input as { transferId: string; request?: { kind: string } };
          const request = value.request ?? uploads.get(value.transferId)?.spec.request;
          const required =
            downloads.get(value.transferId)?.capability ??
            (request?.kind === "background_orphans" ? "runner.background" : "runner.files");
          // Only this server-owned stop receipt may drain after capability shutdown.
          // Ordinary downloads created before shutdown keep their original capability gate.
          if (
            !(method === "runner.transfer.pull" && downloads.get(value.transferId)?.cleanupReceipt)
          )
            requireCapability(required);
        }
        return await handler(input, context);
      } finally {
        inFlight--;
      }
    });
  handle("runner.phoneAuthorizations.set", async ({ grants }) => {
    if (!options.phoneControls || options.control)
      throw new RpcError(RpcErrorCodes.unsupported, "phone_control_unsupported");
    await options.phoneControls.update(grants);
    return { version: 1 as const };
  });
  let capabilityUpdate: Promise<void> = Promise.resolve();
  function serializeCapabilities<T>(action: () => Promise<T>): Promise<T> {
    const next = capabilityUpdate.then(() => {
      if (closing) throw new RpcError(RpcErrorCodes.closed, "Runner session closed");
      return action();
    });
    // A failed drain seals this generation; enabling cannot turn an unknown cleanup into idle.
    capabilityUpdate = next.then(() => {});
    void capabilityUpdate.catch(() => {});
    return next;
  }
  handle("runner.capabilities.negotiate", () =>
    serializeCapabilities(async () => {
      enabled = new Set();
      await options.computer?.revokeAll();
      const isolation = await options.target.isolationStatus();
      return {
        endpointKind: "runner" as const,
        platform: options.platform,
        appVersion: options.appVersion ?? "0.0.0",
        capabilities: Object.entries(RUNNER_CAPABILITY_VERSIONS)
          .filter(([id]) => id !== "runner.computer" || !!options.computer)
          .map(([id, version]) => ({
            id,
            version,
            availability:
              // Managed Git is offered only when the runner wired a managed Git port; the
              // recipes enforce their own isolation per platform.
              id === "runner.managed-git"
                ? options.managedGitPort
                  ? ("available" as const)
                  : ("unsupported" as const)
                : // A Windows runner runs commands unisolated behind a per-command
                  // confirmation, like the Windows desktop; only a broken sandbox makes them unsupported.
                  id !== "runner.files" &&
                    id !== "runner.computer" &&
                    !isolation.available &&
                    isolation.reason !== "windows_unisolated"
                  ? ("unsupported" as const)
                  : ("available" as const),
          })),
      };
    }),
  );
  handle("runner.capabilities.set", ({ capabilities }) =>
    serializeCapabilities(async () => {
      if (!enabled || capabilities.some((id) => !(id in RUNNER_CAPABILITY_VERSIONS)))
        throw new RpcError(RpcErrorCodes.invalidParams, "capability_list_invalid");
      enabled = new Set(capabilities);
      if (!enabled.has("runner.computer")) await options.computer?.revokeAll();
      return null;
    }),
  );
  let computerDrain: Promise<void> | undefined;
  const retireComputer = () => {
    computerDrain ??= Promise.resolve().then(() => options.computer?.revokeAll());
    return computerDrain;
  };
  const offClose =
    options.port.onClose?.(() => {
      // Retain the original drain for dispose; transport closure must revoke grants immediately.
      closing = true;
      enabled = new Set();
      void retireComputer().catch(() => {});
      clearTransfers();
    }) ?? (() => {});

  async function confirmDispatch(
    opId: string,
    signal: AbortSignal,
    capability = "runner.exec",
    cleanup = false,
  ) {
    if (options.control && !cleanup) await phonePolicy.assert(opId, signal);
    if (!cleanup) requireCapability(capability);
    if (options.control) await options.phoneControls?.assert(options.control.grant);
    const confirmation = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    try {
      await peer.call(
        "runner.dispatch.confirm",
        { opId },
        { signal: confirmation, timeoutMs: 10_000 },
      );
    } catch {
      throw new ExecError("authorization_changed");
    }
    if (!cleanup) requireCapability(capability);
    if (options.control) {
      await options.phoneControls?.assert(options.control.grant);
      if (!cleanup) await phonePolicy.assert(opId, signal);
    }
  }

  // Entry plans live where the repository is; the desktop only holds their ids.
  const entryPlans = new Map<string, { plan: GitEntryPlan; expiresAt: number }>();
  const ENTRY_PLAN_TTL_MS = 30 * 60 * 1000;
  const takeEntryPlan = (
    id: string | undefined,
    command: string,
    signal: AbortSignal,
  ): (() => void) => {
    if (id === undefined) return () => signal.throwIfAborted();
    const held = entryPlans.get(id);
    entryPlans.delete(id);
    if (!held || held.expiresAt < Date.now() || held.plan.command !== command)
      throw new RpcError(RpcErrorCodes.dispatchDenied, "dispatch_denied");
    const plan = held.plan;
    // The last check before spawn: every bound hook / config path must still be as scanned.
    return () => {
      signal.throwIfAborted();
      if (!gitEntryPlanCurrent(plan, { id: plan.callId, command }))
        throw new ExecError("authorization_changed");
    };
  };
  handle("runner.git.entries", async (input, context) => {
    const inspect = options.target.inspectGitEntries;
    if (!inspect) throw new RpcError(RpcErrorCodes.unsupported, "Runner operation unsupported");
    const result = await inspect.call(options.target, input, context.signal).catch(mapped);
    if (result.status === "unsupported") return { status: result.status, facts: result.facts };
    const now = Date.now();
    for (const [id, held] of entryPlans) if (held.expiresAt < now) entryPlans.delete(id);
    if (entryPlans.size >= 256) throw new RpcError(RpcErrorCodes.busy, "Runner busy");
    const planId = randomUUID();
    entryPlans.set(planId, { plan: result.plan, expiresAt: now + ENTRY_PLAN_TTL_MS });
    return {
      status: result.status,
      planId,
      ...(result.status === "confirmation-required" ? { facts: result.facts } : {}),
      ...(result.plan.windowsReadScopeVerified ? { windowsReadScopeVerified: true as const } : {}),
    };
  });
  const managedPlans = new Map<
    string,
    {
      operation: string;
      input: Parameters<ManagedGitPort["prepare"]>[0];
      filesHash?: string;
      expiresAt: number;
    }
  >();
  const managed = (): ManagedGitPort => {
    if (!options.managedGitPort)
      throw new RpcError(RpcErrorCodes.unsupported, "managed_git_unsupported");
    return options.managedGitPort;
  };
  handle("runner.managedGit.inspect", async (input, context) =>
    RunnerManagedGitInspectResultSchema.parse(await managed().inspect(input, context.signal)),
  );
  handle("runner.managedGit.prepare", async (input, context) => {
    const result = await managed().prepare(input, context.signal);
    if (!result.planId || !result.operation)
      throw new RpcError(RpcErrorCodes.invalidRequest, "managed_git_plan_missing");
    if (managedPlans.size >= 256) throw new RpcError(RpcErrorCodes.busy, "managed_git_busy");
    managedPlans.set(result.planId, {
      operation: result.operation,
      input,
      filesHash: result.filesHash,
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
    return RunnerManagedGitPrepareResultSchema.parse(result);
  });
  handle("runner.managedGit.execute", async (input, context) => {
    const { idempotencyKey, issuedAt, planId, dispatchOpId } = input;
    return once(idempotencyKey, issuedAt, async () => {
      const plan = managedPlans.get(planId);
      managedPlans.delete(planId);
      if (!plan || plan.expiresAt < Date.now())
        throw new RpcError(RpcErrorCodes.dispatchDenied, "managed_git_plan_expired");
      await confirmDispatch(dispatchOpId, context.signal, "runner.managed-git");
      if (input.filesHash !== plan.filesHash)
        throw new RpcError(RpcErrorCodes.dispatchDenied, "managed_git_files_changed");
      return RunnerManagedGitExecuteResultSchema.parse(
        await managed().execute({ ...input, prepared: plan.input }, context.signal),
      );
    });
  });
  handle("runner.policy.prepare", async (input, context) => {
    if (!options.control) throw new RpcError(RpcErrorCodes.unsupported, "phone_policy_only");
    requireCapability(
      input.request.category === "run_command"
        ? input.request.background
          ? "runner.background"
          : "runner.exec"
        : "runner.files",
    );
    return phonePolicy.prepare(input, context.signal);
  });
  handle("runner.executionChecks.enable", async () => {
    executionChecksEnabled = true;
    return null;
  });
  handle("runner.info", async () => ({
    targetId,
    platform: options.platform,
    isolation: await options.target.isolationStatus(),
  }));
  handle("runner.command.protection", async () => ({
    roots: [...(options.commandProtectionRoots ?? [])],
  }));
  handle("runner.folders.list", async ({ path }, context) => {
    requireCapability("runner.files");
    if (!options.target.listFolders)
      throw new RpcError(RpcErrorCodes.unsupported, "runner_folders_unsupported");
    return options.target
      .listFolders(path, context.signal)
      .catch((error: unknown) => mapped(error));
  });
  handle("runner.path.canonicalize", ({ path, cwd }, context) =>
    options.target.canonicalizePath(path, cwd, context.signal).catch((error: unknown) => {
      if (executionChecksEnabled) mapped(error);
      throw error;
    }),
  );
  handle(
    "runner.computer.call",
    async ({ method, input, blockedApps, idempotencyKey, issuedAt, dispatchOpId }, context) => {
      if (!options.computer)
        throw new RpcError(RpcErrorCodes.unsupported, "runner_computer_unsupported");
      const host = options.computer;
      const params = HostComputerMethods[method].params.parse(input);
      const cleanup = method === "host.computer.grants.revoke";
      const execute = async () => {
        await confirmDispatch(dispatchOpId, context.signal, "runner.computer", cleanup);
        host.setBlocklist(blockedApps);
        const result = await host.call(
          method,
          params as HostComputerParams[typeof method],
          context.signal,
        );
        return jsonDownload(
          HostComputerMethods[method].result.parse(result),
          "runner.computer",
          cleanup,
        );
      };
      return cleanup ? execute() : once(idempotencyKey, issuedAt, execute);
    },
  );
  handle("runner.command.run", async ({ idempotencyKey, issuedAt, dispatchOpId, input }, context) =>
    once(idempotencyKey, issuedAt, async () => {
      const phoneReadOnly = options.control
        ? phonePolicy.claim(
            dispatchOpId,
            {
              category: "run_command",
              command: input.command,
              cwd: input.cwd,
              ...(input.policyWritePaths ? { writePaths: input.policyWritePaths } : {}),
            },
            input,
          )
        : false;
      const { gitEntryPlanId, policyWritePaths: _policyWritePaths, ...command } = input;
      ownedRuns.add(input.runId);
      const assertEntries = takeEntryPlan(gitEntryPlanId, input.command, context.signal);
      const releaseSecrets = registerSecretLease(options, Object.values(input.secretEnv ?? {}));
      try {
        return await options.target.runCommand({
          ...command,
          ...(phoneReadOnly ? { windowsReadOnly: true as const } : {}),
          signal: context.signal,
          assertAuthorized: assertEntries,
          confirmDispatch: () => confirmDispatch(dispatchOpId, context.signal),
          assertDockerAuthorized: () => context.signal.throwIfAborted(),
          onOutput: (text) => streamOutput(context.stream as (chunk: unknown) => void, text),
        });
      } finally {
        releaseSecrets();
        phonePolicy.release(dispatchOpId);
      }
    }),
  );
  handle("runner.command.release", async ({ idempotencyKey, issuedAt, runId }, context) =>
    once(idempotencyKey, issuedAt, async () => {
      // A paused cleanup makes the release wait for its proof; the caller's deadline bounds it.
      await options.target.releaseRun(runId, context.signal);
      return null;
    }),
  );
  handle(
    "runner.background.start",
    async ({ idempotencyKey, issuedAt, dispatchOpId, input }, context) =>
      once(idempotencyKey, issuedAt, async () => {
        if (options.control)
          phonePolicy.claim(
            dispatchOpId,
            {
              category: "run_command",
              command: input.command,
              cwd: input.cwd,
              background: true,
              ...(input.policyWritePaths ? { writePaths: input.policyWritePaths } : {}),
            },
            input,
          );
        const { gitEntryPlanId, policyWritePaths: _policyWritePaths, ...command } = input;
        ownedRuns.add(input.runId);
        const assertEntries = takeEntryPlan(gitEntryPlanId, input.command, context.signal);
        const releaseSecrets = registerSecretLease(options, Object.values(input.secretEnv ?? {}));
        let job!: BackgroundJob;
        try {
          job = await options.target.startBackground({
            ...command,
            signal: context.signal,
            assertAuthorized: assertEntries,
            confirmDispatch: () =>
              confirmDispatch(dispatchOpId, context.signal, "runner.background"),
            assertDockerAuthorized: () => context.signal.throwIfAborted(),
            callbacks: {
              onChange: () => {
                if (job) options.backgrounds.changed(job);
              },
            },
          });
        } catch (error) {
          releaseSecrets();
          phonePolicy.release(dispatchOpId);
          throw error;
        }
        void job.ended.then(releaseSecrets, releaseSecrets);
        try {
          const value = await options.backgrounds.register(job, options.control?.grant.body.phone);
          if (!value) throw new RpcError(RpcErrorCodes.internal, "Runner job disappeared");
          return jsonDownload(value, "runner.background");
        } finally {
          phonePolicy.release(dispatchOpId);
        }
      }),
  );
  handle("runner.background.write", async (input, context) =>
    once(input.idempotencyKey, input.issuedAt, () =>
      options.target.writeBackground({
        jobId: input.jobId,
        runId: input.runId,
        text: input.text,
        eof: input.eof,
        rootIdentities: input.rootIdentities,
        signal: context.signal,
        assertAuthorized: async () => {
          context.signal.throwIfAborted();
          await confirmDispatch(input.dispatchOpId, context.signal, "runner.background");
          context.signal.throwIfAborted();
        },
      }),
    ),
  );
  handle("runner.background.inspect", async ({ jobId, maxChars }) => {
    const value = options.backgrounds.inspect(jobId, maxChars);
    return value ? jsonDownload(value, "runner.background") : null;
  });
  handle("runner.background.list", async ({ maxChars, after }) =>
    jsonDownload(
      options.backgrounds.list(maxChars, after, options.control?.grant.body.phone),
      "runner.background",
    ),
  );
  handle("runner.background.stop", async ({ idempotencyKey, issuedAt, jobId }) =>
    once(idempotencyKey, issuedAt, async () => {
      const value = await options.backgrounds.stop(jobId);
      if (!value) throw new RpcError(RpcErrorCodes.closed, "Runner job result unavailable");
      return jsonDownload(value, "runner.background", true);
    }),
  );
  handle("runner.background.ack", async ({ jobId }) => {
    options.backgrounds.ack(jobId);
    return null;
  });
  handle("runner.binary.read", async ({ path, context: file }, context) => {
    try {
      const result = await options.target.readBinary({ ...file, path, signal: context.signal });
      return { ...download(result.bytes), path: result.path };
    } catch (error) {
      mapped(error);
    }
  });
  handle("runner.transfer.begin", async (spec) => {
    options.backgrounds.assertHealthy();
    if (uploads.has(spec.transferId) || downloads.has(spec.transferId))
      throw new RpcError(RpcErrorCodes.busy, "Transfer already active");
    reserve(spec.bytes);
    try {
      const timer = setTimeout(() => release(spec.transferId), 60_000);
      uploads.set(spec.transferId, {
        spec,
        bytes: Buffer.alloc(spec.bytes),
        offset: 0,
        sequence: 0,
        timer,
      });
    } catch (error) {
      aggregateBytes -= spec.bytes;
      throw error;
    }
    return null;
  });
  handle("runner.transfer.chunk", async ({ transferId, sequence, data }, context) => {
    context.signal.throwIfAborted();
    const transfer = uploads.get(transferId);
    if (!transfer || transfer.sequence !== sequence) {
      if (transfer) release(transferId);
      throw new RpcError(RpcErrorCodes.invalidParams, "Invalid transfer sequence");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > CHUNK_BYTES || transfer.offset + bytes.length > transfer.bytes.length) {
      release(transferId);
      throw new RpcError(RpcErrorCodes.invalidParams, "Invalid transfer size");
    }
    bytes.copy(transfer.bytes, transfer.offset);
    transfer.offset += bytes.length;
    transfer.sequence++;
    return null;
  });
  handle("runner.transfer.commit", async ({ transferId }, context) => {
    const transfer = uploads.get(transferId);
    if (!transfer) throw new RpcError(RpcErrorCodes.invalidParams, "Transfer unavailable");
    try {
      if (
        transfer.offset !== transfer.bytes.length ||
        createHash("sha256").update(transfer.bytes).digest("hex") !== transfer.spec.sha256
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "Transfer digest mismatch");
      if (options.control && transfer.spec.request.kind !== "file")
        throw new RpcError(RpcErrorCodes.unsupported, "phone_file_operation_unsupported");
      if (transfer.spec.request.kind === "binary_write") {
        const binaryRequest = transfer.spec.request;
        if (!transfer.spec.idempotencyKey || !transfer.spec.issuedAt || !transfer.spec.dispatchOpId)
          throw new RpcError(RpcErrorCodes.invalidParams, "Idempotency key required");
        const publication = await once(transfer.spec.idempotencyKey, transfer.spec.issuedAt, () =>
          options.target.writeBinary({
            ...binaryRequest.context,
            path: binaryRequest.path,
            bytes: transfer.bytes,
            signal: context.signal,
            confirmDispatch: () =>
              confirmDispatch(
                transfer.spec.dispatchOpId as string,
                context.signal,
                transfer.spec.request.kind === "background_orphans"
                  ? "runner.background"
                  : "runner.files",
              ),
            revalidate: () =>
              confirmDispatch(
                transfer.spec.dispatchOpId as string,
                context.signal,
                transfer.spec.request.kind === "background_orphans"
                  ? "runner.background"
                  : "runner.files",
              ),
          }),
        );
        return jsonDownload(RunnerBinaryPublicationSchema.parse(publication));
      }
      if (transfer.spec.request.kind === "background_orphans") {
        if (!transfer.spec.idempotencyKey || !transfer.spec.issuedAt)
          throw new RpcError(RpcErrorCodes.invalidParams, "Idempotency key required");
        let records: ReturnType<typeof RunnerBackgroundOrphansSchema.parse>;
        try {
          records = RunnerBackgroundOrphansSchema.parse(
            JSON.parse(transfer.bytes.toString("utf8")),
          );
        } catch {
          throw new RpcError(RpcErrorCodes.invalidParams, "Invalid orphan cleanup transfer");
        }
        const remaining = await once(
          transfer.spec.idempotencyKey,
          transfer.spec.issuedAt,
          async () => {
            requireCapability("runner.background");
            const remaining = await options.target.background.killOrphans(records, context.signal);
            if (!remaining) await options.jobs.removeRecords(records);
            return remaining;
          },
        );
        return jsonDownload(
          RunnerBackgroundOrphanResultSchema.parse({ remaining }),
          "runner.background",
        );
      }
      let request: ReturnType<typeof RunnerFileRequestSchema.parse>;
      try {
        request = RunnerFileRequestSchema.parse(JSON.parse(transfer.bytes.toString("utf8")));
      } catch {
        throw new RpcError(RpcErrorCodes.invalidParams, "Invalid file transfer");
      }
      if (options.control) {
        const category =
          request.operation === "writeFile"
            ? "write_file"
            : request.operation === "readFile"
              ? "read_file"
              : request.operation === "listDir"
                ? "list_dir"
                : undefined;
        if (!category || !("path" in request.input))
          throw new RpcError(RpcErrorCodes.unsupported, "phone_file_operation_unsupported");
        phonePolicy.claim(
          request.input.policyOpId,
          { category, path: request.input.path, cwd: request.input.cwd },
          request.input,
        );
        await phonePolicy.assert(request.input.policyOpId as string, context.signal);
      }
      // A patch publishes files, so it needs the same dispatch idempotency as a write.
      if (
        options.control &&
        request.operation === "writeFile" &&
        transfer.spec.dispatchOpId !== request.input.policyOpId
      )
        throw new RpcError(RpcErrorCodes.dispatchDenied, "policy_preparation_changed");
      const write =
        request.operation === "writeFile" ||
        request.operation === "editFile" ||
        request.operation === "applyPatch";
      if (
        write !== !!transfer.spec.idempotencyKey ||
        write !== !!transfer.spec.issuedAt ||
        write !== !!transfer.spec.dispatchOpId
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "Invalid idempotency mode");
      const call = async () => {
        const common = {
          ...request.input,
          signal: context.signal,
          assertCurrent: () => {
            context.signal.throwIfAborted();
            requireCapability("runner.files");
          },
          confirmDispatch: transfer.spec.dispatchOpId
            ? () =>
                confirmDispatch(
                  transfer.spec.dispatchOpId as string,
                  context.signal,
                  transfer.spec.request.kind === "background_orphans"
                    ? "runner.background"
                    : "runner.files",
                )
            : undefined,
          authorizeRecovery: async () => {
            throw new RpcError(
              RpcErrorCodes.unsupported,
              "Remote recovery requires fresh authorization",
            );
          },
          authorizePath: async () => !context.signal.aborted,
        };
        const fn = options.target[request.operation] as (value: typeof common) => Promise<unknown>;
        if (!fn) throw new RpcError(RpcErrorCodes.unsupported, "workspace_files_unsupported");
        return fn(common);
      };
      const value = transfer.spec.idempotencyKey
        ? await once(transfer.spec.idempotencyKey, transfer.spec.issuedAt as string, call)
        : await call();
      return jsonDownload(runnerFileResultSchemas[request.operation].parse(value));
    } catch (error) {
      mapped(error);
    } finally {
      if (options.control && transfer.spec.request.kind === "file") {
        try {
          const value = JSON.parse(transfer.bytes.toString("utf8"));
          phonePolicy.release(value.input?.policyOpId);
        } catch {
          /* Invalid bodies have no admitted preparation. */
        }
      }
      release(transferId);
    }
  });
  handle("runner.transfer.pull", async ({ transferId, sequence }, context) => {
    context.signal.throwIfAborted();
    const transfer = downloads.get(transferId);
    if (!transfer || transfer.sequence !== sequence) {
      if (transfer) release(transferId);
      throw new RpcError(RpcErrorCodes.invalidParams, "Invalid transfer sequence");
    }
    const offset = sequence * CHUNK_BYTES;
    const data = transfer.bytes.subarray(offset, offset + CHUNK_BYTES).toString("base64");
    const done = offset + CHUNK_BYTES >= transfer.bytes.length;
    transfer.sequence++;
    if (done) release(transferId);
    return { data, done };
  });
  handle("runner.transfer.cancel", async ({ transferId }) => {
    release(transferId);
    return null;
  });
  handle("runner.reconcile", async ({ idempotencyKey, issuedAt }) => {
    const result = options.journal.inspect(idempotencyKey, issuedAt);
    return result.status === "started" || result.status === "done" || result.status === "unknown"
      ? {
          idempotencyKey,
          status: result.status,
          digest: result.item.digest,
          updatedAt: result.item.updatedAt,
        }
      : { idempotencyKey, status: result.status, updatedAt: new Date().toISOString() };
  });

  return {
    targetId,
    async retire() {
      retiring = true;
      // A transfer owns its whole begin/commit/pull lifecycle, including the gaps between RPCs.
      while (inFlight || uploads.size || downloads.size) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      await this.dispose();
    },
    dispose() {
      disposal ??= (async () => {
        closing = true;
        enabled = new Set();
        managedPlans.clear();
        await options.ready;
        peer.dispose();
        while (inFlight) await new Promise<void>((resolve) => setTimeout(resolve, 25));
        offClose();
        phonePolicy.dispose();
        const results = await Promise.allSettled([capabilityUpdate, retireComputer()]);
        clearTransfers();
        options.port.dispose?.();
        detached();
        const failed = results.filter((result) => result.status === "rejected");
        if (failed.length)
          throw new AggregateError(
            failed.map((result) => result.reason),
            "runner_computer_drain_failed",
          );
      })();
      return disposal;
    },
  };
}

export async function createRunnerRuntime(options: RuntimeOptions) {
  const targetId = `runner:${RunnerIdSchema.parse(options.deviceId)}` as const;
  if (options.journal.targetId !== targetId || options.jobs.targetId !== targetId)
    throw new RpcError(RpcErrorCodes.invalidParams, "Runner registry identity mismatch");
  await options.jobs.recover(options.target, AbortSignal.timeout(20_000));
  const backgrounds = createRuntimeBackgrounds(options);
  const sessions = new Set<Awaited<ReturnType<typeof attachRunnerSession>>>();
  let closing = false;
  let owner:
    | {
        kind: "desktop" | "phone";
        session: Promise<Awaited<ReturnType<typeof attachRunnerSession>>>;
      }
    | undefined;
  return {
    targetId,
    hasDesktop: () => owner?.kind === "desktop",
    async attach(port: Port, control?: Control) {
      if (closing) throw new RpcError(RpcErrorCodes.closed, "Runner runtime disposed");
      backgrounds.assertHealthy();
      if (control) {
        if (!options.phoneControls)
          throw new RpcError(RpcErrorCodes.unsupported, "phone_control_unsupported");
        await options.phoneControls.assert(control.grant);
        if (owner) throw new RpcError(RpcErrorCodes.busy, "controller_busy");
      } else if (owner?.kind === "desktop")
        throw new RpcError(RpcErrorCodes.busy, "controller_busy");
      const previous = owner;
      const ready = previous
        ? previous.session.then((session) => session.retire())
        : Promise.resolve();
      void ready.catch(() => {});
      let session!: Awaited<ReturnType<typeof attachRunnerSession>>;
      const pending = attachRunnerSession({ ...options, port, backgrounds, control, ready }, () => {
        sessions.delete(session);
        if (owner === next) owner = undefined;
      });
      const next = { kind: control ? ("phone" as const) : ("desktop" as const), session: pending };
      owner = next;
      session = await pending;
      sessions.add(session);
      return session;
    },
    async dispose() {
      if (closing) return;
      closing = true;
      const errors: unknown[] = [];
      for (const session of [...sessions]) {
        try {
          await session.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      sessions.clear();
      let targetStopped = false;
      try {
        await options.target.dispose();
        targetStopped = true;
      } catch (error) {
        errors.push(error);
      }
      if (targetStopped) {
        try {
          await backgrounds.drain();
        } catch (error) {
          errors.push(error);
        }
      }
      if (targetStopped) {
        try {
          await options.jobs.clear();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const cleanup of [
        options.journal.dispose(),
        options.jobs.dispose(),
        ...(options.computer ? [options.computer.dispose()] : []),
      ]) {
        try {
          await cleanup;
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Runner runtime cleanup failed");
    },
  };
}

export async function createRunnerHost(options: HostOptions) {
  const { port, ...runtimeOptions } = options;
  const runtime = await createRunnerRuntime(runtimeOptions);
  try {
    await runtime.attach(port);
  } catch (error) {
    await runtime.dispose().catch(() => {});
    throw error;
  }
  return { targetId: runtime.targetId, dispose: () => runtime.dispose() };
}
