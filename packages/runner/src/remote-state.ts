import { randomUUID } from "node:crypto";
import type {
  BackgroundJob,
  ExecutionTarget,
  FileContext,
  RunCommandOptions,
} from "@pibot/execution";
import { ExecError } from "@pibot/execution";
import {
  type Params,
  type Peer,
  type Result,
  RpcError,
  RpcErrorCodes,
  type RunnerBackgroundSnapshotSchema,
  RunnerCommandInputSchema,
  type RunnerEvents,
  type RunnerMethods,
} from "@pibot/protocol-base";

export type Call = Peer<RunnerMethods, RunnerEvents>["call"];
export type Snapshot = ReturnType<typeof RunnerBackgroundSnapshotSchema.parse>;
export type BackgroundEnd = NonNullable<Snapshot["ended"]>;
export type IssuedKey = { idempotencyKey: string; issuedAt: string };
export type Reconciliation = IssuedKey & {
  operation: string;
  jobId?: string;
  state: "pending" | "unknown" | "detached";
};
export type DetachedJob = { jobId: string; runId: string };
export type BeginParams = Params<RunnerMethods, "runner.transfer.begin">;
export type RemoteTarget = ExecutionTarget & {
  readonly targetId: `runner:${string}`;
  syncPhoneAuthorizations(
    grants: import("@pibot/protocol-base").PhoneControlGrant[],
    signal: AbortSignal,
  ): Promise<void>;
  readonly platform: "darwin" | "win32" | "linux";
  reconcile(
    key: IssuedKey,
    signal?: AbortSignal,
  ): Promise<Result<RunnerMethods, "runner.reconcile">>;
  acknowledgeReconciliation(key: IssuedKey): boolean;
  pendingReconciliations(): ReadonlyArray<Reconciliation>;
  detachedBackgroundJobs(): ReadonlyArray<DetachedJob>;
  listBackground(signal?: AbortSignal): Promise<ReadonlyArray<Snapshot>>;
  adoptBackground(
    jobId: string,
    runId: string,
    rootIdentities: RunCommandOptions["rootIdentities"],
    signal?: AbortSignal,
  ): Promise<BackgroundJob | undefined>;
};
/**
 * The parts every channel needs: the single link, the shared background-job bookkeeping and the
 * one place a call crosses the wire. Passing them keeps each channel a pure move of the methods
 * that used to close over the same factory scope.
 */
export interface TransferChannel {
  pull(
    descriptor: Result<RunnerMethods, "runner.transfer.commit">,
    signal: AbortSignal,
  ): Promise<Buffer>;
  upload(
    bytes: Uint8Array,
    request: BeginParams["request"],
    signal: AbortSignal,
    key?: IssuedKey,
    dispatchOpId?: string,
  ): Promise<Result<RunnerMethods, "runner.transfer.commit">>;
  pullJson<T>(
    descriptor: Result<RunnerMethods, "runner.transfer.commit">,
    signal: AbortSignal,
    parse: (value: unknown) => T,
  ): Promise<T>;
  cancel(transferId: string): Promise<void>;
  clear(): void;
}
export interface RemoteDeps {
  readonly link: AbortSignal;
  readonly jobs: Map<string, BackgroundJob>;
  readonly jobCleanups: Map<string, { detach: () => void }>;
  readonly detachedJobs: Map<string, DetachedJob>;
  readonly reconciliation: Map<string, Omit<Reconciliation, "idempotencyKey">>;
  readonly transfer: TransferChannel;
  readonly call: Call;
  callSignal(signal: AbortSignal): AbortSignal;
  isDisconnected(): boolean;
  withDispatch<T>(
    confirm: () => void | Promise<void>,
    work: (dispatchOpId: string) => Promise<T>,
  ): Promise<T>;
  tracked<T>(
    key: IssuedKey,
    operation: string,
    work: () => Promise<T>,
    details?: { jobId?: string },
  ): Promise<T>;
}

export function issueKey(): IssuedKey {
  return { idempotencyKey: randomUUID(), issuedAt: new Date().toISOString() };
}

export function requireDispatch(confirm: (() => void | Promise<void>) | undefined) {
  if (!confirm) throw new RpcError(RpcErrorCodes.dispatchDenied, "dispatch_denied");
  return confirm;
}

/** The wire schema intentionally stays two-role while extra writable folders are local-only. */
export function runnerRootIdentities(roots: RunCommandOptions["rootIdentities"]) {
  return roots?.map((root) => {
    if (root.role === "writable")
      throw new RpcError(RpcErrorCodes.unsupported, "runner_writable_unsupported");
    // Brain workspace snapshots also carry id/path; the strict runner wire accepts identity only.
    return {
      canonicalPath: root.canonicalPath,
      device: root.device,
      inode: root.inode,
      ...(root.role ? { role: root.role } : {}),
    };
  });
}

export function commandInput(
  input: RunCommandOptions,
): Params<RunnerMethods, "runner.command.run">["input"] {
  input.assertAuthorized?.();
  input.assertDockerAuthorized?.();
  if (input.docker) throw new ExecError("docker_unsupported", "unsupported_platform");
  // Pins name files brain read on this machine; a runner cannot re-check them, so a pinned run
  // never goes remote (policy reads scripts only for local targets, so this is a backstop).
  if (input.scriptPins?.length) throw new ExecError("invalid_input");
  const {
    scriptPins: _scriptPins,
    // N2: the runner's PATH is not known here, and the runner wire has no field for it; a runner
    // run's interpreter is bounded by that machine's own sandbox (see the runner follow-up).
    scriptInterpreters: _scriptInterpreters,
    signal: _signal,
    skillPackageIds: _localSkillPackages,
    onOutput: _output,
    assertAuthorized: _auth,
    assertDockerAuthorized: _docker,
    confirmDispatch: _confirm,
    docker: _dockerConfig,
    // The fixed local `git init` recipe holds callbacks and host roots; a runner has neither, and
    // the strict wire schema rejected every literal Git command that carried it.
    gitInitialization: _gitInit,
    ...serializable
  } = input as typeof input & { gitInitialization?: unknown };
  // Only fields the runner wire declares travel. Local-only grants the desktop adds for its own
  // sandbox (private network hosts, system or local services, credential helpers) widen access,
  // so leaving them out never loosens the runner; sending them made the strict schema reject
  // every runner command.
  const wire = Object.fromEntries(
    Object.entries(serializable).filter(([key]) => key in RunnerCommandInputSchema.shape),
  ) as Params<RunnerMethods, "runner.command.run">["input"];
  return {
    ...wire,
    rootIdentities: runnerRootIdentities(input.rootIdentities),
  };
}
export function fileInput<T extends FileContext>(input: T) {
  input.signal.throwIfAborted();
  input.assertCurrent?.();
  const {
    signal: _signal,
    assertCurrent: _current,
    confirmDispatch: _confirm,
    authorizeRecovery: _recovery,
    // Search authorization is a brain-side callback that re-checks each visited path; a function
    // cannot cross the wire, and the runner host supplies its own `authorizePath` per call.
    authorizePath: _authorize,
    ...serializable
  } = input as T & { authorizePath?: unknown };
  return {
    ...serializable,
    rootIdentities: runnerRootIdentities(input.rootIdentities),
  };
}
export function fileContext(input: FileContext) {
  return {
    cwd: input.cwd,
    writeRoots: input.writeRoots,
    ...(input.denyWriteRoots ? { denyWriteRoots: input.denyWriteRoots } : {}),
    ...(input.rootIdentities ? { rootIdentities: runnerRootIdentities(input.rootIdentities) } : {}),
    ...(input.expectedPath ? { expectedPath: input.expectedPath } : {}),
  };
}
