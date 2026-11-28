import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { createExec } from "../command/command.ts";
import { commandEnvironment } from "../command/environment.ts";
import { ExecError, type ExecOptions, type NetworkSettings } from "../core/types.ts";
import { childNodeRuntime } from "../runtime/child-node.ts";
import { isolationProbeStderr } from "../sandbox/isolation-probe.ts";
import { directoryIdentity } from "../sandbox/workspace.ts";
import { diagnosticCommand, diagnosticSignatures, type SandboxDiagnosticRow } from "./report.ts";

export interface SandboxDiagnosticOptions {
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  systemHome: string;
  tempDir: string;
  resourcesDir?: string;
  signal: AbortSignal;
}

export interface SandboxDiagnosticCheck {
  tool: string;
  command?: string;
  skip?: string;
  network?: NetworkSettings;
  deniedKind?: string;
  timeoutSec?: number;
  expectedExitCode?: number;
  verify?(): Promise<boolean>;
}

/** A paused cleanup gets the automatic checks' first round, then the row reports it unconfirmed. */
const RELEASE_WAIT_MS = 45_000;
const diagnosticError = (error: unknown) =>
  error instanceof ExecError
    ? error.reason === "cleanup_failed"
      ? "cleanup_unconfirmed"
      : error.code
    : "diagnostic_failed";

/** Owns only disposable fixtures; no database, settings, logins or user workspace are opened. */
export async function createSandboxDiagnosticSession(options: SandboxDiagnosticOptions) {
  options.signal.throwIfAborted();
  const base = await realpath(await mkdtemp(join(options.tempDir, "pibot-doctor-")));
  let exec: ReturnType<typeof createExec> | undefined;
  let retain = false;
  const dataDir = join(base, "data");
  const home = join(dataDir, "bots", randomUUID(), "home");
  const project = join(base, "workspace");
  const temp = join(base, "tmp");
  try {
    for (const dir of [home, project, temp]) await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(project, ".bashrc"), "doctor fixture\n", { mode: 0o600 });
    // No ambient token, proxy URL or credential pointer is inherited, even on Windows.
    const env = {
      PATH: options.env.PATH ?? options.env.Path,
      SystemRoot: options.env.SystemRoot ?? options.env.SYSTEMROOT,
      LANG: "en_US.UTF-8",
    };
    const signatures = new Set<string>();
    let probingIsolation = true;
    exec = createExec({
      ...options,
      env,
      tempDir: temp,
      redactor: {
        redact: () => "[diagnostic output withheld]",
        stream: () => {
          let tail = "";
          return {
            push(text) {
              tail = (tail + text).slice(-8192);
              for (const feature of diagnosticSignatures(tail)) signatures.add(feature);
              return "";
            },
            finish() {
              // The shared isolation probe sees only redacted stderr. Preserve the canonical
              // diagnosis here so the doctor can identify the missing host dependency.
              const feature = probingIsolation ? isolationProbeStderr(tail) : undefined;
              return feature ? `${feature}\n` : "";
            },
          };
        },
      },
    } satisfies ExecOptions);
    const runner = exec;
    // Raw output never reaches execution logs; only fixed features remain in this report.
    // Negative checks use kernel/proxy evidence or an independently verified fixture receipt.
    const identities = [await directoryIdentity(project), await directoryIdentity(home)];
    const isolation = await runner.isolationStatus(options.signal);
    probingIsolation = false;
    const search = commandEnvironment(options.platform, env, home, temp).PATH ?? "";
    const executable = async (name: string): Promise<string | undefined> => {
      const names =
        options.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
      for (const dir of search.split(delimiter))
        for (const candidate of names) {
          const path = join(dir, candidate);
          try {
            if (isAbsolute(path) && (await stat(path)).isFile()) {
              await access(path, options.platform === "win32" ? constants.F_OK : constants.X_OK);
              return path;
            }
          } catch {
            // Missing programs and stale PATH entries are reported as skips, without paths.
          }
        }
      return undefined;
    };
    let scriptId = 0;
    let running = false;
    let closed = false;
    const script = async (source: string) => {
      const path = join(project, `doctor-${++scriptId}.cjs`);
      // Native fetch ignores HTTP_PROXY unless opted in. The pinned helper Node exposes this
      // API for fetch and http(s); use SRT's own proxy, never loosen its domain allowlist.
      await writeFile(path, `require('node:http').setGlobalProxyFromEnv();\n${source}`, {
        mode: 0o600,
      });
      return diagnosticCommand(options.platform, [childNodeRuntime().executable, path]);
    };
    const row = (
      tool: string,
      status: SandboxDiagnosticRow["status"],
      reason: string,
    ): SandboxDiagnosticRow => ({
      tool,
      status,
      reason,
      durationMs: 0,
      kinds: [],
      rules: [],
      signatures: [],
    });
    return {
      project,
      home,
      isolation,
      executable,
      script,
      async run(check: SandboxDiagnosticCheck): Promise<SandboxDiagnosticRow> {
        options.signal.throwIfAborted();
        if (closed || running) return row(check.tool, "failed", closed ? "closed" : "busy");
        if (retain) return row(check.tool, "skipped", "cleanup_unconfirmed");
        if (check.skip || !check.command)
          return row(check.tool, "skipped", check.skip ?? "tool_not_installed");
        if (!isolation.available && options.platform !== "win32")
          return row(check.tool, "skipped", "isolation_unavailable");
        if (check.deniedKind && options.platform === "win32")
          return row(check.tool, "skipped", "windows_unisolated");
        running = true;
        signatures.clear();
        const runId = randomUUID();
        const started = performance.now();
        let result: SandboxDiagnosticRow;
        try {
          const output = await runner.runCommand({
            command: check.command,
            cwd: project,
            dataDir,
            botHome: home,
            runId,
            writeRoots: [project, home],
            rootIdentities: identities,
            network:
              options.platform === "win32"
                ? { allowAll: true, domains: [] }
                : (check.network ?? { allowAll: false, domains: [] }),
            allowUnisolated: options.platform === "win32",
            signal: options.signal,
            timeoutSec: check.timeoutSec ?? 20,
          });
          const passed =
            !output.timedOut &&
            !output.stopped &&
            (check.deniedKind
              ? output.exitCode !== 0 &&
                output.sandboxBlock?.kinds.some((kind) => kind === check.deniedKind)
              : output.exitCode === (check.expectedExitCode ?? 0) &&
                ((check.expectedExitCode !== undefined && check.expectedExitCode !== 0) ||
                  !output.sandboxBlock)) &&
            (!check.verify || (await check.verify()));
          result = {
            ...row(
              check.tool,
              passed ? "passed" : "failed",
              output.timedOut
                ? "timeout"
                : output.stopped
                  ? "cancelled"
                  : passed
                    ? check.deniedKind
                      ? "expected_denial"
                      : "completed"
                    : check.deniedKind
                      ? "expected_denial_not_proven"
                      : "command_failed",
            ),
            kinds: output.sandboxBlock?.kinds ?? [],
            rules: [...new Set(output.sandboxBlock?.items.map((item) => item.rule) ?? [])],
            signatures: [...signatures],
          };
        } catch (error) {
          retain = error instanceof ExecError && error.reason === "cleanup_failed";
          result = row(check.tool, "failed", diagnosticError(error));
        } finally {
          try {
            // A self-test must not wait for a paused cleanup the way a run does: it reports it.
            await runner.releaseRun(runId, AbortSignal.timeout(RELEASE_WAIT_MS));
          } catch {
            retain = true;
          }
          running = false;
        }
        if (retain) result = row(check.tool, "failed", "cleanup_unconfirmed");
        return { ...result, durationMs: Math.round(performance.now() - started) };
      },
      async close() {
        closed = true;
        await runner.dispose();
        if (!retain) await rm(base, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // A failed dispose must retain its files: another owner may still be using them.
    if (exec) await exec.dispose();
    await rm(base, { recursive: true, force: true });
    throw error;
  }
}
