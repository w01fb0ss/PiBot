import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { ExecError, type ExecOptions, type RunCommandOptions } from "../core/types.ts";
import { type BackgroundJob, createBackgroundJobs } from "./background.ts";
import { createExec } from "./command.ts";
import { runPromotableCommand } from "./foreground-promotion.ts";
import { executeProcess, ProcessCleanupError, type ProcessControl } from "./process.ts";
import { commandDeadline } from "./run-deadline.ts";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  members: vi.fn(async () => []),
}));
vi.mock("./command-run.ts", () => ({ createCommandRunner: () => mocks.run }));
vi.mock("./process-tree.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-tree.ts")>()),
  snapshot: async () => [],
  trackProcessTree: () => ({
    members: mocks.members,
    record: () => ({ group: 1, processes: [] }),
    dispose: async () => {},
  }),
}));

const redactor = {
  redact: (text: string) => text,
  stream: () => ({ push: (text: string) => text, finish: () => "" }),
};
const command = (runId: string): RunCommandOptions => ({
  runId,
  command: "Write-Output QA",
  cwd: "C:\\QA",
  botHome: "C:\\QA",
  dataDir: "C:\\QA",
  writeRoots: ["C:\\QA"],
  network: { allowAll: true, domains: [] },
  signal: new AbortController().signal,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("keeps unrelated Windows commands and run retirement available during cleanup", async () => {
  const onBackgroundDrain = vi.fn();
  const exec = createExec({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    systemHome: "C:\\Users\\QA",
    tempDir: tmpdir(),
    redactor,
    onBackgroundDrain,
  } satisfies ExecOptions);
  const failed = new ProcessCleanupError({ group: 123, processes: [], spawnedAt: Date.now() });
  const success = { exitCode: 0, truncatedOutput: "QA" };
  mocks.run.mockRejectedValueOnce(failed).mockResolvedValue(success);
  try {
    await expect(exec.runCommand(command("affected"))).rejects.toBe(failed);
    expect(exec.commandPause()).toBeNull();
    expect(exec.windowsCommandCleanupPending()).toBe(true);
    expect(exec.windowsCommandCleanupPending("affected")).toBe(true);
    expect(exec.windowsCommandCleanupPending("other")).toBe(false);
    expect(onBackgroundDrain).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "affected", phase: "paused" }),
    );
    await expect(exec.isolationStatus()).resolves.toMatchObject({ available: false });
    await expect(exec.runCommand(command("affected"))).resolves.toEqual(success);
    await expect(exec.runCommand(command("other"))).resolves.toEqual(success);
    await exec.releaseRun("other");
    const draining = vi.fn();
    const affected = exec.releaseRun("affected").then(draining);
    await Promise.resolve();
    expect(draining).not.toHaveBeenCalled();
    await exec.recheckCommandPause();
    await affected;
    expect(exec.windowsCommandCleanupPending()).toBe(false);
  } finally {
    await exec.dispose();
  }
});

it("ends a promoted job after its Windows cleanup is confirmed", async () => {
  const id = "test-job";
  const request = new AbortController();
  const ready = deferred<BackgroundJob>();
  const cleanup = deferred<void>();
  const work = deferred<never>();
  const control: ProcessControl = {
    record: () => ({ group: 123, processes: [] }),
    output: () => "",
    lines: () => 0,
    running: () => true,
    drained: () => false,
  };
  const waitForForegroundCleanup = vi.fn(() => cleanup.promise);
  const result = runPromotableCommand(
    {
      lifetime: new AbortController(),
      adoptForeground: vi.fn(),
      retainCommand: vi.fn(),
      waitForForegroundCleanup,
    },
    {
      ...command("affected"),
      promotion: {
        id,
        request: request.signal,
        ready: ready.resolve,
        promote: () => true,
        callbacks: {},
      },
    },
    async (_signal, publish) => {
      publish(control, "job.log");
      return work.promise;
    },
  );
  const job = await ready.promise;
  request.abort();
  await expect(result).resolves.toMatchObject({ promoted: { id } });
  const failure = new ProcessCleanupError({ ...control.record(), spawnedAt: Date.now() });
  const ended = vi.fn();
  const completion = job.ended.then(ended);
  work.reject(failure);
  await vi.waitFor(() =>
    expect(waitForForegroundCleanup).toHaveBeenCalledWith(failure, "affected", control.record()),
  );
  expect(ended).not.toHaveBeenCalled();
  cleanup.resolve();
  await completion;
  expect(ended).toHaveBeenCalledWith({ exitCode: null, reason: "failed" });
});

it("retains the POSIX admission pause when cleanup fails", async () => {
  const jobs = createBackgroundJobs({ platform: "linux", env: () => ({}), redactor });
  const failed = new ExecError("command_failed", "cleanup_failed");
  jobs.failDrain(failed, undefined, undefined, "other");
  expect(() => jobs.assertHealthy()).toThrow(failed);
  expect(jobs.pauseState()).toBe("retrying");
  await expect(jobs.dispose()).rejects.toBe(failed);
});

it("uses one fresh Windows snapshot when an exited shell has no descendants", async () => {
  mocks.members.mockClear();
  const result = await executeProcess({
    shell: process.execPath,
    args: ["-e", "console.log('QA')"],
    cwd: tmpdir(),
    env: {},
    platform: "win32",
    signal: new AbortController().signal,
    log: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    redactor,
  });
  expect(result.exitCode).toBe(0);
  expect(result.truncatedOutput).toContain("QA");
  expect(mocks.members.mock.calls).toEqual([[true]]);
});

it("allows Windows cleanup beyond the old grace while retaining a hard deadline", async () => {
  vi.useFakeTimers();
  try {
    const lifetime = new AbortController();
    const cleanup = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 12_000));
    const result = commandDeadline(cleanup, 1, lifetime.signal, lifetime, 32_000);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(result).resolves.toBe("done");

    const hung = commandDeadline(new Promise(() => {}), 1, lifetime.signal, lifetime, 32_000);
    const timeout = expect(hung).rejects.toMatchObject({
      code: "command_failed",
      reason: "timeout",
    } satisfies Partial<ExecError>);
    await vi.advanceTimersByTimeAsync(33_000);
    await timeout;
    expect(lifetime.signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
