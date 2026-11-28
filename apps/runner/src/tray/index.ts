import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { decodeRunnerPairCode } from "@pibot/link";
import { prepareRunnerDataDir } from "../data-dir.ts";
import { RUNNER_FATAL_EXIT } from "../fatal.ts";
import { isRunnerMessageCode, type RunnerMessageCode, runnerMessages } from "../messages.ts";
import { readPairedDesktop } from "../paired-desktop.ts";
import {
  acquireRunnerLock,
  processAlive,
  readRunnerState,
  requestRunner,
  requestRunnerComputerPermissions,
  requestRunnerPairingCode,
} from "../state.ts";

import { endRunnerProcess, isStateRunner } from "./force-stop.ts";
import { runnerLoginEnabled, toggleRunnerLogin } from "./login.ts";

export interface RunnerTrayOptions {
  dataDir: string;
  resourcesDir: string;
  executable: string;
  argsPrefix: readonly string[];
  ownerArguments?: readonly string[];
}

/** The tray owns its UI only. A crashed UI must never terminate the execution owner. */
export async function runRunnerTray(options: RunnerTrayOptions): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "win32")
    throw new Error("runner_tray_unsupported");
  const ownerDir = join(options.dataDir, "tray");
  await prepareRunnerDataDir(ownerDir);
  const owner = await acquireRunnerLock(ownerDir);
  const packaged = join(
    options.resourcesDir,
    "tray",
    process.platform === "win32" ? "windows.ps1" : "mac.js",
  );
  const script = existsSync(packaged)
    ? packaged
    : fileURLToPath(
        new URL(process.platform === "win32" ? "./windows.ps1" : "./mac.js", import.meta.url),
      );
  // Windows: -File is refused under the default execution policy (Restricted) and reads a
  // BOM-less script as ANSI, which garbles the Chinese menu text; an encoded command avoids both
  // (round-1 VM 2026-11-12: the tray never started).
  const ui = spawn(
    process.platform === "win32" ? "powershell.exe" : "/usr/bin/osascript",
    process.platform === "win32"
      ? [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-EncodedCommand",
          Buffer.from(await readFile(script, "utf8"), "utf16le").toString("base64"),
        ]
      : ["-l", "JavaScript", script],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  const uiExited = new Promise<void>((resolve, reject) => {
    ui.once("error", reject);
    ui.once("exit", (exit) => (exit === 0 ? resolve() : reject(new Error("runner_tray_failed"))));
  });
  // Install a rejection handler before any asynchronous owner read can fail.
  void uiExited.catch(() => {});
  let closing = false;
  let pairing: "generate" | "connect" | undefined;
  let pairingChild: ChildProcess | undefined;
  let code: string | undefined;
  let pending = Promise.resolve();
  let actionPending = false;
  let output = "";
  const send = (value: object) => {
    if (!ui.stdin?.destroyed && (ui.stdin?.writableLength ?? 0) < 32768)
      ui.stdin?.write(`${JSON.stringify(value)}\n`);
  };
  const showError = (error: RunnerMessageCode) => {
    send({ error: runnerMessages[error] });
  };
  ui.stdin?.on("error", () => {
    /* UI loss never terminates the runner. */
  });
  // The runner this tray started is restarted after a crash with the rule the owner set for
  // pibot-start.vbs (2026-11-11): only the fatal-crash exit 70, 5 s doubling to 60 s, and five
  // crashes within ten minutes stop it. Without this a crash left it offline until next sign-in.
  const crashes: number[] = [];
  let restart: ReturnType<typeof setTimeout> | undefined;
  const supervise = (child: ChildProcess) =>
    child.once("exit", (exit) => {
      if (exit !== RUNNER_FATAL_EXIT || closing) return;
      const now = Date.now();
      while (crashes.length && now - (crashes[0] ?? now) > 600_000) crashes.shift();
      crashes.push(now);
      if (crashes.length >= 5) return showError("runner_start_failed");
      restart = setTimeout(
        () => {
          restart = undefined;
          if (!closing) launch("start");
        },
        Math.min(60_000, 5_000 * 2 ** (crashes.length - 1)),
      );
    });
  const launch = (command: "start" | "pair", pairCode?: string) => {
    // Pairing reports only a fixed failure code over IPC. The owner never needs the tray to live.
    const child = spawn(
      options.executable,
      [
        ...options.argsPrefix,
        "runner",
        command,
        ...(pairCode ? [pairCode] : []),
        ...(options.ownerArguments ?? []),
      ],
      {
        detached: true,
        windowsHide: true,
        env: {
          ...process.env,
          PIBOT_DATA_DIR: options.dataDir,
          ...(command === "pair" ? { PIBOT_RUNNER_TRAY_PAIR: "1" } : {}),
        },
        stdio: command === "pair" ? ["ignore", "ignore", "ignore", "ipc"] : "ignore",
      },
    );
    child.unref();
    supervise(child);
    if (command === "pair") {
      pairingChild = child;
      let failure: RunnerMessageCode = "runner_pair_failed";
      child.on("message", (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "code" in message &&
          isRunnerMessageCode(message.code)
        )
          failure = message.code;
      });
      child.channel?.unref();
      child.once("close", (exit) => {
        if (pairingChild !== child) return;
        if (exit !== 0) showError(failure);
        finishPairing();
      });
    }
    child.once("error", () => {
      if (pairingChild === child) finishPairing();
      showError("runner_start_failed");
    });
    return child;
  };
  const finishPairing = () => {
    pairing = undefined;
    pairingChild = undefined;
    code = undefined;
    send({ connecting: false, pairing: null });
  };
  const stopOwner = async (operation: "stop" | "revoke" = "stop") => {
    const state = await readRunnerState(options.dataDir);
    if (!state || !processAlive(state.pid)) {
      if (operation === "revoke") {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(options.executable, [...options.argsPrefix, "runner", "revoke"], {
            windowsHide: true,
            stdio: "ignore",
            env: { ...process.env, PIBOT_DATA_DIR: options.dataDir },
            signal: AbortSignal.timeout(20_000),
          });
          child.once("error", reject);
          child.once("close", (value) =>
            value === 0 ? resolve() : reject(new Error("runner_revoke_failed")),
          );
        });
      }
      return;
    }
    if (state.status === "drain_incomplete") throw new Error("runner_drain_incomplete");
    try {
      await requestRunner(state, operation);
    } catch (error) {
      // Quit reaches the runner through its control port; a runner that no longer answers there is
      // ended directly (force-stop.ts), so the tray can still close. Revoking needs the runner.
      if (operation !== "stop" || !(await isStateRunner(state))) throw error;
      await endRunnerProcess(state.pid);
      return;
    }
    // A stop acknowledgement means admission closed, not that processes have drained.
    const deadline = Date.now() + 120_000;
    while (processAlive(state.pid)) {
      if (Date.now() >= deadline) throw new Error("runner_stop_timeout");
      await delay(100);
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const initial = await readRunnerState(options.dataDir);
    if (!initial || !processAlive(initial.pid)) launch("start");
    const refresh = async () => {
      const currentPairingChild = pairingChild;
      const paired = await readPairedDesktop(options.dataDir);
      const state = await readRunnerState(options.dataDir);
      const status =
        state && state.status !== "drain_incomplete" && processAlive(state.pid)
          ? await requestRunner(state, "status")
          : undefined;
      if (currentPairingChild && currentPairingChild === pairingChild && paired) {
        finishPairing();
      } else if (pairing === "generate" && state && state.status !== "drain_incomplete" && status) {
        const child = pairingChild;
        const nextCode = await requestRunnerPairingCode(state);
        if (pairingChild === child && nextCode && nextCode !== code) {
          code = nextCode;
          send({ connecting: false, pairing: code });
        }
      }
      send({
        ...(process.platform === "darwin"
          ? {
              permissions:
                state && state.status !== "drain_incomplete" && processAlive(state.pid)
                  ? await requestRunnerComputerPermissions(state)
                  : {
                      accessibility: "unknown",
                      screenRecording: "unknown",
                      automation: "ask_per_app",
                    },
            }
          : {}),
        status: {
          paired: !!paired,
          name: paired?.name ?? "",
          connection: status?.connection ?? "offline",
          ...status,
        },
        ...(process.platform === "darwin" ? { loginEnabled: await runnerLoginEnabled() } : {}),
        icon: join(
          options.resourcesDir,
          process.platform === "darwin" ? "trayTemplate.png" : "tray-color-32.png",
        ),
      });
    };
    const action = async (value: string) => {
      if (closing) return;
      if (value === "quit") {
        closing = true;
        try {
          await stopOwner();
          send({ close: true });
        } catch {
          closing = false;
          showError("runner_stop_failed");
        }
      } else if (value === "unpair" && !pairing) {
        try {
          await stopOwner("revoke");
          launch("start");
        } catch {
          showError("runner_revoke_failed");
        }
      } else if ((value === "pair" || value.startsWith("pair-code:")) && !pairing) {
        const pairCode = value.startsWith("pair-code:") ? value.slice(10).trim() : undefined;
        if (pairCode !== undefined) {
          let decoded: ReturnType<typeof decodeRunnerPairCode>;
          try {
            decoded = decodeRunnerPairCode(pairCode);
          } catch {
            // Checked before the current pairing is revoked: a mistyped code changes nothing.
            showError("invalid_pairing");
            return;
          }
          decoded.psk.fill(0);
          decoded.prologue.fill(0);
        }
        await stopOwner((await readPairedDesktop(options.dataDir)) ? "revoke" : "stop");
        // Re-pairing requires explicit confirmation in the native UI before revocation.
        pairing = pairCode ? "connect" : "generate";
        send({ connecting: true });
        launch("pair", pairCode);
      } else if (value === "login" && process.platform === "darwin") {
        await toggleRunnerLogin(options.executable);
      } else if (value === "logs") {
        const child: ChildProcess = spawn(
          process.platform === "darwin" ? "/usr/bin/open" : "explorer.exe",
          [join(options.dataDir, "logs")],
          { windowsHide: true, stdio: "ignore" },
        );
        child.once("error", () => showError("runner_logs_failed"));
      }
    };
    ui.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 8192) {
        ui.kill();
        return;
      }
      let end = output.indexOf("\n");
      while (end >= 0) {
        const line = output.slice(0, end).trim();
        output = output.slice(end + 1);
        if (
          (["pair", "unpair", "quit", "logs", "login"].includes(line) ||
            (line.startsWith("pair-code:") && line.length <= 1162)) &&
          !actionPending
        ) {
          actionPending = true;
          pending = pending
            .then(() => action(line))
            .catch(() =>
              showError(line === "login" ? "runner_login_failed" : "runner_control_failed"),
            )
            .finally(() => {
              actionPending = false;
            });
        }
        end = output.indexOf("\n");
      }
    });
    let refreshing = false;
    const tick = () => {
      if (refreshing || closing) return;
      refreshing = true;
      void refresh()
        .catch(() => send({ statusUnavailable: true }))
        .finally(() => {
          refreshing = false;
        });
    };
    timer = setInterval(tick, 1000);
    tick();
    await uiExited;
  } finally {
    clearInterval(timer);
    clearTimeout(restart);
    if (ui.exitCode === null) ui.kill();
    ui.stdin?.destroy();
    await pending;
    await owner.release();
    // Intentionally leave the independent runner alive on a UI crash.
  }
}
