import { dirname, join, resolve } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { parseArguments, usage } from "./args.ts";
import { prepareRunnerDataDir, runnerDataDir } from "./data-dir.ts";
import { runnerAppContents } from "./entry-paths.ts";
import { runnerExitCode, runnerFailure } from "./errors.ts";
import { installFatalHandlers, type RunnerLifecycle } from "./fatal.ts";
import { isolationFields } from "./isolation.ts";
import { createRunnerLogger, type RunnerLogger } from "./logger.ts";
import { runnerText } from "./messages.ts";
import { OFFICIAL_RUNNER_RELAY, validateRunnerRelay } from "./network.ts";
import { forgetPairedDesktop } from "./paired-desktop.ts";
import { takeEnvironmentPassphrase } from "./passphrase.ts";
import { createRunnerRedactor } from "./redactor.ts";
import { acquireRunnerLock, processAlive, readRunnerState, requestRunner } from "./state.ts";

declare const __PIBOT_RUNNER_VERSION__: string;

// Entry-file state: the fatal handlers and the last-resort failure line need the log file.
let logger: RunnerLogger | undefined;
const lifecycle: RunnerLifecycle = { stage: "starting" };

async function main(): Promise<number> {
  const invalidArguments = () => {
    const failure = runnerFailure(new Error("invalid_arguments"));
    if (process.stderr.isTTY)
      process.stderr.write(`${runnerText(failure.messageZh, failure.messageEn)}\n`);
    else process.stderr.write(`${usage()}\n`);
    return 2;
  };
  let args: ReturnType<typeof parseArguments>;
  try {
    const cli = process.argv.slice(2);
    args = parseArguments(
      cli.length === 0 &&
        isSea() &&
        (process.platform === "win32" || runnerAppContents(process.execPath, process.platform))
        ? ["tray"]
        : cli,
    );
  } catch {
    return invalidArguments();
  }
  if (args.kind === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.kind === "version") {
    process.stdout.write(`${__PIBOT_RUNNER_VERSION__}\n`);
    return 0;
  }
  const dataDir = args.dataDir ? resolve(args.dataDir) : runnerDataDir();
  if (args.relay) validateRunnerRelay(args.relay);
  if (args.proxy) {
    const { flagProxy } = await import("./proxy/route.ts");
    try {
      flagProxy(args.proxy);
    } catch {
      return invalidArguments();
    }
  }
  if (args.command === "tray") {
    const { runRunnerTray } = await import("./tray/index.ts");
    const { runnerInvocation } = await import("./linux-process.ts");
    const entry = runnerInvocation();
    const appContents = runnerAppContents(process.execPath, process.platform);
    await runRunnerTray({
      dataDir,
      executable: entry.executable,
      argsPrefix: entry.prefix,
      ownerArguments: [
        ...(args.name ? ["--name", args.name] : []),
        ...(args.relay ? ["--relay", args.relay] : []),
        ...(args.proxy ? ["--proxy", args.proxy] : []),
        ...(args.logLevel ? ["--log-level", args.logLevel] : []),
      ],
      resourcesDir: appContents
        ? join(appContents, "Resources")
        : join(
            isSea() ? dirname(process.execPath) : dirname(fileURLToPath(import.meta.url)),
            "resources",
          ),
    });
    return 0;
  }
  if (args.command === "install-service" || args.command === "uninstall-service") {
    const { configureLinuxService } = await import("./linux-service.ts");
    await configureLinuxService({
      install: args.command === "install-service",
      signal: AbortSignal.timeout(60_000),
      dataDir,
      arguments: [
        ...(args.name ? ["--name", args.name] : []),
        ...(args.relay ? ["--relay", args.relay] : []),
        ...(args.proxy ? ["--proxy", args.proxy] : []),
        ...(args.logLevel ? ["--log-level", args.logLevel] : []),
        ...(args.listen ?? []).flatMap((address) => ["--listen", address]),
      ],
    });
    return 0;
  }
  if (args.daemon) {
    await prepareRunnerDataDir(dataDir);
    const { startLinuxDaemon } = await import("./linux-process.ts");
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort(new Error("runner_daemon_start_cancelled"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const pid = await startLinuxDaemon(
        dataDir,
        process.argv.slice(2).filter((arg) => arg !== "--daemon"),
        AbortSignal.any([cancellation.signal, AbortSignal.timeout(180_000)]),
      );
      process.stdout.write(`${JSON.stringify({ running: true, pid })}\n`);
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
    return 0;
  }
  await prepareRunnerDataDir(dataDir);
  const redactor = createRunnerRedactor();
  const environmentPassphrase = takeEnvironmentPassphrase(redactor);
  logger = createRunnerLogger(
    join(dataDir, "logs"),
    redactor,
    args.json ? "stderr" : "stdout",
    args.command === "start" || args.command === "pair" ? (args.logLevel ?? "info") : "info",
  );
  installFatalHandlers(logger, lifecycle);
  if (args.command === "start" || args.command === "pair") {
    // Native bindings belong to the packaged resource graph, never an inherited override path.
    delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    delete process.env.NAPI_RS_FORCE_WASI;
    const { runRunner } = await import("./runtime.ts");
    const { resolveRunnerProxy } = await import("./proxy/index.ts");
    const proxy = await resolveRunnerProxy({
      flag: args.proxy,
      env: process.env,
      platform: process.platform,
      redactor,
      logger,
    });
    const { decodeRunnerPairCode } = await import("@pibot/link");
    if (args.code) {
      redactor.add(args.code);
      redactor.add(args.code.split("@")[0] ?? args.code);
    }
    const decoded = args.code ? decodeRunnerPairCode(args.code) : undefined;
    decoded?.psk.fill(0);
    decoded?.prologue.fill(0);
    if (decoded?.relay && args.relay && validateRunnerRelay(args.relay) !== decoded.relay)
      throw new Error("pairing_relay_mismatch");
    await runRunner({
      lifecycle,
      dataDir,
      environmentPassphrase,
      logger,
      redactor,
      pair: args.command === "pair",
      pairCode: args.code,
      deviceName: args.name,
      listen: args.listen,
      proxy,
      relay: validateRunnerRelay(
        decoded?.relay ?? args.relay ?? process.env.PIBOT_RUNNER_RELAY ?? OFFICIAL_RUNNER_RELAY,
      ),
      pairingOutput: (code) => {
        // Tray pairing reads the authenticated control port; losing its UI cannot break stdout.
        if (process.env.PIBOT_RUNNER_TRAY_PAIR !== "1")
          process.stdout.write(
            `${process.stdout.isTTY ? runnerText("配对码（10 分钟内有效，只能用一次）", "Pairing code (10 minutes, one use)") : "Pairing code (10 minutes, one use)"}: ${code}\n`,
          );
      },
    });
    return 0;
  }
  const state = await readRunnerState(dataDir);
  // A state file whose process is gone describes a crash, not a running owner: report and act on the
  // process that exists instead of a record that outlived it.
  if (!state || !processAlive(state.pid)) {
    if (args.json) process.stdout.write(`${JSON.stringify({ running: false })}\n`);
    if (state) logger.write("warn", `runner.${args.command}`, { running: false, staleState: true });
    if (args.command === "revoke") {
      const lock = await acquireRunnerLock(dataDir);
      try {
        await forgetPairedDesktop(dataDir);
        logger.write("info", "runner.pairing", { outcome: "revoked" });
      } finally {
        await lock.release();
      }
    }
    if (!state) logger.write("info", `runner.${args.command}`, { running: false });
    return args.command === "status" ? 3 : 0;
  }
  if (state.status === "drain_incomplete") {
    if (args.json)
      process.stdout.write(
        `${JSON.stringify({ running: false, status: "drain_incomplete", pid: state.pid })}\n`,
      );
    logger.write("error", `runner.${args.command}`, {
      running: false,
      status: "drain_incomplete",
      pid: state.pid,
    });
    return args.command === "status" ? 3 : 1;
  }
  try {
    const response = await requestRunner(state, args.command);
    if (args.command === "stop") {
      const { waitRunnerExit } = await import("./linux-process.ts");
      await waitRunnerExit(state, AbortSignal.timeout(120_000));
    }
    if (args.json) process.stdout.write(`${JSON.stringify(response)}\n`);
    const { lastSeenAt, connection, isolation, ...value } = response;
    logger.write("info", `runner.${args.command}`, {
      ...value,
      ...(args.command === "stop" ? { running: false } : {}),
      // `status` only, and only what the runner could tell: a runner from an older build sends no
      // link details, and an invented "connecting" would read as a fact.
      ...(args.command === "status"
        ? { connection: connection ?? "unknown", lastSeenAt: lastSeenAt ?? "never" }
        : {}),
      ...(isolation ? isolationFields(isolation) : {}),
    });
    return 0;
  } catch {
    if (args.json)
      process.stdout.write(`${JSON.stringify({ running: false, staleState: true })}\n`);
    logger.write("warn", `runner.${args.command}`, { running: false, staleState: true });
    return args.command === "status" ? 3 : 1;
  }
}

/** A socket or child handle that outlived its owner must not keep the runner alive: `status` and
 * the state file would then disagree with the actual process. Flush the console first. */
function finish(code: number) {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

main()
  .then(finish)
  .catch((error: unknown) => {
    const redactor = createRunnerRedactor();
    const environmentPassphrase = takeEnvironmentPassphrase(redactor);
    if (environmentPassphrase) redactor.add(environmentPassphrase);
    const failure = runnerFailure(error);
    // A hidden (wscript / service) runner has no console: the log file is the only witness.
    try {
      logger?.write("error", "runner.failed", { code: failure.code, stage: lifecycle.stage });
    } catch {
      // The console line below still carries the code.
    }
    const line = process.stderr.isTTY
      ? runnerText(failure.messageZh, failure.messageEn)
      : JSON.stringify({ level: "error", event: "runner.failed", ...failure });
    const report = () => process.stderr.write(`${line}\n`, () => finish(runnerExitCode(error)));
    if (process.env.PIBOT_RUNNER_TRAY_PAIR === "1" && process.connected && process.send)
      process.send({ code: failure.code }, report);
    else report();
  });
