// Sandbox host: one process per long-running sandboxed command.
//
// Why a process: SRT's SandboxManager is a module singleton whose proxy filters every request
// against the *current* global config, so two commands wrapped by one manager share whatever
// allowlist was installed last (measured on macOS). A process
// of its own gives this command its own manager, proxy, auth token and allowlist.
//
// Protocol with exec (background-host.ts): stdin carries one JSON line, then stays open as a
// liveness signal; fd 3 receives `ready` once the command runs or `failed` before exit. The host
// is its process group's leader (spawned detached), and the command stays in that group.
//
// Loaded from source under plain Node in development: keep to erasable TypeScript syntax and
// import nothing from exec that is not (types.ts uses parameter properties).
import { spawn, spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { fixedHostSshCommand } from "../ssh/ssh-command.ts";
import {
  ConnectorNetworkAnswerSchema,
  type ConnectorNetworkFilter,
  ConnectorNetworkRequestSchema,
} from "./connector-network.ts";
import { type IsolationProbeStage, isolationProbeStderr } from "./isolation-probe.ts";
import { createSandboxNetwork } from "./network-proxy.ts";
import {
  sandboxEnvironmentSetup,
  sandboxInput,
  sandboxLauncherPath,
  writeSandboxInput,
} from "./sandbox-environment.ts";
import { parseSandboxPayload, SANDBOX_PAYLOAD_BYTES } from "./sandbox-host-payload.ts";
import { sandboxProxySetup, validProxyPort } from "./sandbox-proxy-setup.ts";
import { waitForSessionChildren } from "./sandbox-session-drain.ts";
import { violationsLine } from "./violation-report.ts";

const STOP_GRACE_MS = 3000;
/** Synchronous: a quick command may end the host right after `ready`, before an async flush. */
function report(
  line:
    | "prepared"
    | "ready"
    | "failed"
    | `exited ${number | "null"}`
    | `violations ${string}`
    | `probe ${IsolationProbeStage}`
    | `network ${string}`
    | `network-cancel ${number}`,
) {
  try {
    writeSync(3, `${line}\n`);
  } catch {
    // exec stopped listening (it closed the job); the host's exit status still tells it.
  }
}

/** Processes still in this group, other than the host and its own helpers (Linux socat). */
function groupMembers(timeout = 2000): number {
  const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid="], {
    encoding: "utf8",
    timeout,
  });
  if (ps.status !== 0) return 1;
  let count = 0;
  for (const line of ps.stdout.split("\n")) {
    const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
    if (group === process.pid && pid !== process.pid && parent !== process.pid) count++;
  }
  return count;
}

let exiting = false;
let reportViolations = false;
let network: Awaited<ReturnType<typeof createSandboxNetwork>> | undefined;
/**
 * Proxy refusals live only in this host's SRT store (the proxy is the one component that
 * knows the refused host). Exec cannot see them otherwise once output is piped away or exit is 0.
 * SRT already strips query strings and credentials from the URLs; exec keeps only host:port.
 */
function reportProxyViolations() {
  const line = violationsLine(
    SandboxManager.getSandboxViolationStore()
      .getViolations()
      .map((violation) => violation.line)
      .filter((line) => line.startsWith("deny ")),
  );
  if (line) report(line as `violations ${string}`);
}
async function exit(code: number, signal?: NodeJS.Signals) {
  if (exiting) return;
  exiting = true;
  if (reportViolations) reportProxyViolations();
  await network?.close();
  SandboxManager.cleanupAfterCommand();
  // A stuck reset must not keep the job alive: the proxy dies with the process anyway.
  await Promise.race([
    SandboxManager.reset().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (signal) {
    // Same end as an unhosted job: a signalled command reports exit code null, not 128+n.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  process.exit(code);
}

let stopping = false;
const lifetime = new AbortController();
/** Parent gone or stop requested: stop the whole group, the host last. */
function stopGroup() {
  if (stopping) return;
  stopping = true;
  lifetime.abort();
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {
    // The group is already empty apart from the host.
  }
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(137);
    }
  }, STOP_GRACE_MS).unref();
}

async function main() {
  // A group SIGTERM (exec stopping the job) reaches the command directly; the host stays until
  // the command is gone so its exit status is reported. SRT's own handler releases the proxy.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {});
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  let inputBytes = 0;
  const countPayload = (chunk: Buffer) => {
    inputBytes += chunk.length;
    if (inputBytes > SANDBOX_PAYLOAD_BYTES + 16) {
      report("failed");
      input.close();
      process.stdin.destroy();
      stopGroup();
    }
  };
  process.stdin.on("data", countPayload);
  const first = await new Promise<string | undefined>((resolve) => {
    input.once("line", resolve);
    input.once("close", () => resolve(undefined));
  });
  process.stdin.off("data", countPayload);
  if (first === undefined) return exit(1);
  // Later EOF means exec closed the channel or died: never leave an unowned sandbox running.
  process.stdin.once("end", stopGroup);
  process.stdin.once("close", stopGroup);
  let child: ReturnType<typeof spawn>;
  let foreground = false;
  let stdioServer = false;
  let probing = false;
  const probe = (stage: IsolationProbeStage) => {
    if (probing) report(`probe ${stage}`);
  };
  try {
    const payload = parseSandboxPayload(first);
    probing = payload.isolationProbe === true;
    foreground = payload.foreground === true;
    stdioServer = payload.stdioServer === true;
    const allowAll = payload.allowAll;
    probe("setup_network");
    let connectorFilter: ConnectorNetworkFilter | undefined;
    if (payload.stdioServer && payload.connectorNetwork) {
      let next = 0;
      const waiting = new Map<number, (allow: boolean) => void>();
      input.on("line", (line) => {
        if (line.length > 128) return;
        try {
          const { id, allow } = ConnectorNetworkAnswerSchema.parse(JSON.parse(line));
          waiting.get(id)?.(allow);
        } catch {
          // Ignore malformed answers and let the pending request fail closed on timeout.
        }
      });
      connectorFilter = (attempt, signal) => {
        if (signal.aborted || waiting.size >= 32) return Promise.resolve(false);
        const parsed = ConnectorNetworkRequestSchema.safeParse({ ...attempt, id: ++next });
        if (!parsed.success) return Promise.resolve(false);
        const { id } = parsed.data;
        return new Promise((resolve) => {
          const abort = () => {
            report(`network-cancel ${id}`);
            finish(false);
          };
          const finish = (allow: boolean) => {
            waiting.delete(id);
            signal.removeEventListener("abort", abort);
            resolve(allow);
          };
          waiting.set(id, finish);
          signal.addEventListener("abort", abort, { once: true });
          report(`network ${JSON.stringify(parsed.data)}`);
        });
      };
    }
    network = await createSandboxNetwork(
      payload.config,
      payload.privateNetworkHosts,
      connectorFilter,
    );
    payload.config = network.config;
    probe("initialize_runtime");
    await SandboxManager.initialize(payload.config, network.authorize(allowAll), false);
    const http = SandboxManager.getProxyPort();
    const socks = SandboxManager.getSocksProxyPort();
    if (process.platform === "darwin" && (!validProxyPort(http) || !validProxyPort(socks)))
      throw new Error("proxy_unavailable");
    if (
      payload.hostSsh &&
      (process.platform !== "darwin" || payload.stdioServer || payload.stdinPipe)
    )
      throw new Error("unsupported_recipe");
    if (payload.hostSsh) {
      const token = SandboxManager.getProxyAuthToken();
      if (!token) throw new Error("proxy_unavailable");
      // Per-host proxy capability, never argv, payload, logs, model input or remote SendEnv.
      payload.env.PIBOT_HOST_SSH_PROXY_AUTH = Buffer.from(`pibot:${token}`).toString("base64");
    }
    const command = payload.hostSsh
      ? fixedHostSshCommand(payload.hostSsh, http as number)
      : payload.command;
    const guestInput = sandboxInput(payload.env, payload.config.credentials);
    const proxySetup =
      process.platform === "darwin" ? sandboxProxySetup(http as number, socks as number) : "";
    const prepared = `${sandboxEnvironmentSetup}\n${proxySetup}\n${command}`;
    probe("wrap_command");
    const wrapped = await SandboxManager.wrapWithSandbox(
      prepared,
      "/bin/bash",
      payload.config,
      undefined,
      { commandId: payload.commandId, commandText: payload.commandText ?? payload.command },
    );
    if (wrapped === prepared) throw new Error("sandbox_not_applied");
    if (payload.foreground || payload.waitForDispatch) {
      // Revalidate workspace/Git ownership in exec after SRT startup, immediately before spawn.
      // The command cannot run merely because a host with an old payload became ready.
      report("prepared");
      const go = await new Promise<string | undefined>((resolve) => {
        input.once("line", resolve);
        input.once("close", () => resolve(undefined));
      });
      if (go !== "go" || stopping) return exit(125);
    }
    if (stopping) return exit(125);
    probe("spawn_command");
    const forwardsStdin = payload.stdioServer === true || payload.stdinPipe === true;
    child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", wrapped], {
      cwd: payload.cwd,
      env: { PATH: sandboxLauncherPath(process.platform) },
      // Prepend the guest environment to stdin, then forward any input from fd 4.
      // Stdio server responses still go straight to the caller on fd 5.
      stdio: ["pipe", stdioServer ? 5 : "inherit", "inherit"],
    });
    if (child.stdin) writeSandboxInput(child.stdin, guestInput, forwardsStdin);
  } catch (error) {
    if (probing && error instanceof Error) {
      // The runtime may include paths and credentials in initialization errors.
      const stderr = isolationProbeStderr(error.message);
      if (stderr) writeSync(2, `${stderr}\n`);
    }
    report("failed");
    return exit(125);
  }
  child.once("error", () => {
    report("failed");
    void exit(125);
  });
  child.once("spawn", () => {
    report("ready");
    // Only after `ready`: exec accepts the line from a running foreground command alone, and
    // from a stdio MCP server whose start it diagnoses.
    reportViolations = foreground || stdioServer;
  });
  child.once("exit", (code, signal) => {
    if (foreground) report(`exited ${code}`);
    // Keep this session's proxy and denial attribution alive while short-lived children finish.
    // The grace is diagnostic only: afterwards the original group-kill/drain contract still owns
    // any server left behind; it must never be reported as a cleanly completed command.
    void finishCommand(code, signal);
  });
  async function finishCommand(code: number | null, signal: NodeJS.Signals | null) {
    if (
      foreground &&
      (signal ? groupMembers() > 0 : !(await waitForSessionChildren(groupMembers, lifetime.signal)))
    )
      stopGroup();
    // Commands that left processes behind (`server &`) still need this host's proxy.
    const drain = () => {
      if (groupMembers() === 0) void exit(code ?? 1, signal ?? undefined);
      else setTimeout(drain, 2000);
    };
    drain();
  }
}

void main().catch(() => exit(1));
