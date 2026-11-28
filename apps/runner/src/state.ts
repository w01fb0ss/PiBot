import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, open, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { IsolationStatus } from "@pibot/execution";
import { sameFile as sameEntity } from "@pibot/execution/file-identity";
import { type ComputerStatus, ComputerStatusSchema } from "@pibot/protocol-base";
import { parseIsolation } from "./isolation.ts";

type StateBase = {
  version: 1;
  pid: number;
  startedAt: string;
  deviceId: string;
};
export type RunningState = StateBase & {
  status?: "running";
  port: number;
  token: string;
};
type DrainIncompleteState = StateBase & { status: "drain_incomplete" };
type State = RunningState | DrainIncompleteState;

type Lock = { version: 1; pid: number; startedAt: string; token: string };

/**
 * What the running process knows about its link to the desktop. `status` reports it so a paired
 * but unreachable runner is distinguishable from a connected one; `lastSeenAt` is the last time a
 * session was admitted (not written to disk — a restarted runner has not been seen yet).
 */
export type RunnerConnection = "connecting" | "online" | "reconnecting";
export interface RunnerLinkStatus {
  connection: RunnerConnection;
  lastSeenAt?: string;
  pairedComputerName?: string;
  path?: "lan" | "address" | "punched" | "relay";
  runningCommands?: number;
  backgroundTasks?: number;
}

const STATE_MAX_BYTES = 4096;
const LOCK_MAX_BYTES = 1024;
const MAX_CONTROL_CONNECTIONS = 16;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function parseState(value: unknown): State {
  const status = value && typeof value === "object" && "status" in value ? value.status : undefined;
  const incomplete = status === "drain_incomplete";
  if (
    !exact(value, [
      "version",
      "pid",
      "startedAt",
      "deviceId",
      ...(incomplete ? ["status"] : ["port", "token", ...(status === undefined ? [] : ["status"])]),
    ]) ||
    (status !== undefined && status !== "running" && !incomplete) ||
    value.version !== 1 ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.startedAt !== "string" ||
    (!incomplete &&
      (!Number.isInteger(value.port) ||
        (value.port as number) < 1 ||
        (value.port as number) > 65535 ||
        typeof value.token !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.token))) ||
    typeof value.deviceId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.deviceId)
  )
    throw new Error("invalid_state");
  return value as State;
}

function parseLock(value: unknown): Lock {
  if (
    !exact(value, ["version", "pid", "startedAt", "token"]) ||
    value.version !== 1 ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.startedAt !== "string" ||
    typeof value.token !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.token)
  )
    throw new Error("invalid_lock");
  return value as Lock;
}

/** `status` and lock takeover must answer for the process that is actually running. */
export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function atomic(path: string, body: string) {
  const temporary = `${path}.${process.pid}.next`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readBounded(path: string, maximum: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maximum ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())))
    )
      throw new Error("invalid_private_file");
    const body = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset <= maximum) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maximum) throw new Error("private_file_too_large");
    return body.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readJson(path: string, maximum: number) {
  return JSON.parse(await readBounded(path, maximum)) as unknown;
}

async function sameFile(first: string, second: string) {
  try {
    const [left, right] = await Promise.all([
      open(first, constants.O_RDONLY | constants.O_NOFOLLOW),
      open(second, constants.O_RDONLY | constants.O_NOFOLLOW),
    ]);
    try {
      // Bigint stats: NTFS file IDs exceed a double, so number identities can alias.
      const [leftInfo, rightInfo] = await Promise.all([
        left.stat({ bigint: true }),
        right.stat({ bigint: true }),
      ]);
      return sameEntity(leftInfo, rightInfo);
    } finally {
      await Promise.all([left.close(), right.close()]);
    }
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function waitForClaim() {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

async function acquireMutationClaim(path: string, token: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${token}\n`, "utf8");
        await handle.sync();
        return handle;
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await waitForClaim();
    }
  }
  // A process crash inside the tiny takeover window leaves this guard behind. Fail closed instead
  // of guessing that it is stale and recreating the same delete-a-successor race recursively.
  throw new Error("runner_lock_recovery_busy");
}

async function releaseMutationClaim(path: string, handle: Awaited<ReturnType<typeof open>>) {
  await handle.close();
  await unlink(path);
}

export async function acquireRunnerLock(dataDir: string) {
  const path = join(dataDir, "runner.lock");
  const claimPath = join(dataDir, "runner.lock.claim");
  const token = randomBytes(16).toString("hex");
  const ownerPath = join(dataDir, `runner.lock.owner-${token}`);
  const value: Lock = {
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  };
  const owner = await open(ownerPath, "wx", 0o600);
  try {
    await owner.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await owner.sync();
  } catch (error) {
    await owner.close().catch(() => {});
    await unlink(ownerPath).catch(() => {});
    throw error;
  }
  let acquired = false;
  try {
    const claim = await acquireMutationClaim(claimPath, token);
    try {
      try {
        await link(ownerPath, path);
        acquired = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      if (!acquired) {
        let existing: Lock;
        try {
          existing = parseLock(await readJson(path, LOCK_MAX_BYTES));
        } catch {
          throw new Error("runner_lock_invalid");
        }
        if (processAlive(existing.pid)) throw new Error("runner_already_running");
        await unlink(path);
        await unlink(join(dataDir, `runner.lock.owner-${existing.token}`)).catch((error) => {
          if (!missing(error)) throw error;
        });
        await link(ownerPath, path);
        acquired = true;
      }
    } finally {
      await releaseMutationClaim(claimPath, claim);
    }
    if (!acquired) throw new Error("runner_already_running");
  } catch (error) {
    await owner.close().catch(() => {});
    await unlink(ownerPath).catch(() => {});
    throw error;
  }
  let released = false;
  return {
    startedAt: value.startedAt,
    async retain() {
      if (released) return;
      released = true;
      // Closing our descriptor is safe; the canonical hardlink continues to exclude another owner.
      await owner.close();
    },
    async release() {
      if (released) return;
      released = true;
      let claim: Awaited<ReturnType<typeof open>> | undefined;
      try {
        claim = await acquireMutationClaim(claimPath, token);
        const claimed = parseLock(await readJson(path, LOCK_MAX_BYTES));
        if (claimed.token !== token || !(await sameFile(ownerPath, path)))
          throw new Error("runner_lock_lost");
        await unlink(path);
      } finally {
        if (claim) await releaseMutationClaim(claimPath, claim).catch(() => {});
        await owner.close().catch(() => {});
        await unlink(ownerPath).catch(() => {});
      }
    },
  };
}

export async function readRunnerState(dataDir: string): Promise<State | undefined> {
  try {
    return parseState(await readJson(join(dataDir, "runner-state.json"), STATE_MAX_BYTES));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeRunnerState(
  dataDir: string,
  value: Omit<RunningState, "version"> | Omit<DrainIncompleteState, "version">,
): Promise<void> {
  await atomic(join(dataDir, "runner-state.json"), `${JSON.stringify({ version: 1, ...value })}\n`);
}

export async function removeRunnerState(dataDir: string) {
  await unlink(join(dataDir, "runner-state.json")).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
}

/** Secrets use a separate operation: ordinary status is safe to include in CLI logs. */
export async function requestRunnerPairingCode(state: RunningState): Promise<string | undefined> {
  const response = JSON.parse(await controlRequest(state, "pairing-code")) as Record<
    string,
    unknown
  >;
  if (response.ok !== true) throw new Error("runner_control_denied");
  if (response.code === null) return undefined;
  if (typeof response.code !== "string" || !/^[A-Z2-9-]{20,64}$/.test(response.code))
    throw new Error("runner_control_invalid");
  return response.code;
}

async function controlRequest(
  state: RunningState,
  operation: "status" | "stop" | "revoke" | "pairing-code" | "computer-permissions",
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: state.port });
    let body = "";
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(body);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("runner_control_timeout"));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.end(`${JSON.stringify({ operation, token: state.token })}\n`),
    );
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) socket.destroy(new Error("runner_control_invalid"));
    });
    socket.on("error", finish);
    socket.on("end", () => finish());
  });
}

export async function requestRunner(
  state: RunningState,
  operation: "status" | "stop" | "revoke",
): Promise<
  {
    running: true;
    pid: number;
    startedAt: string;
    deviceId: string;
  } & Partial<RunnerLinkStatus> & {
      isolation?: IsolationStatus;
    }
> {
  const response = await controlRequest(state, operation);
  const value = JSON.parse(response) as Record<string, unknown>;
  if (value.ok !== true) throw new Error("runner_control_denied");
  // Only a runner that reported link details gets them back. Filling in a default would make
  // `stop` / `revoke` look like a `status` that found the link "connecting".
  const connection = ["connecting", "online", "reconnecting"].includes(String(value.connection))
    ? (value.connection as RunnerConnection)
    : undefined;
  const lastSeenAt =
    typeof value.lastSeenAt === "string" && !Number.isNaN(Date.parse(value.lastSeenAt))
      ? value.lastSeenAt
      : undefined;
  const isolation = parseIsolation(value.isolation);
  return {
    running: true,
    pid: state.pid,
    startedAt: state.startedAt,
    deviceId: state.deviceId,
    ...(connection ? { connection } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(typeof value.pairedComputerName === "string" && value.pairedComputerName.length <= 200
      ? { pairedComputerName: value.pairedComputerName }
      : {}),
    ...(["lan", "address", "punched", "relay"].includes(String(value.path))
      ? { path: value.path as RunnerLinkStatus["path"] }
      : {}),
    ...(Number.isSafeInteger(value.runningCommands) && (value.runningCommands as number) >= 0
      ? { runningCommands: value.runningCommands as number }
      : {}),
    ...(Number.isSafeInteger(value.backgroundTasks) && (value.backgroundTasks as number) >= 0
      ? { backgroundTasks: value.backgroundTasks as number }
      : {}),
    ...(isolation ? { isolation } : {}),
  };
}

/** Permission facts only, queried in the actual runner process; never inspect the UI helper's TCC. */
export async function requestRunnerComputerPermissions(
  state: RunningState,
): Promise<ComputerStatus["permissions"]> {
  const response = JSON.parse(await controlRequest(state, "computer-permissions")) as Record<
    string,
    unknown
  >;
  if (response.ok !== true) throw new Error("runner_control_denied");
  return ComputerStatusSchema.shape.permissions.parse(response.permissions);
}

export async function createRunnerControl(
  startedAt: string,
  deviceId: string,
  stop: () => void,
  revoke?: () => Promise<void>,
  status?: () => RunnerLinkStatus,
  // `status` answers with the cached probe so a caller never waits for a cold sandbox.
  isolation?: () => IsolationStatus | undefined,
  pairingCode?: () => string | undefined,
  computerPermissions?: () => Promise<ComputerStatus["permissions"]>,
) {
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const actions = new Set<Promise<void>>();
  let server!: Server;
  server = createServer({ allowHalfOpen: true }, (socket) => {
    if (sockets.size >= MAX_CONTROL_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setEncoding("utf8");
    let body = "";
    const timer = setTimeout(() => socket.destroy(), 2_000);
    const clear = () => {
      clearTimeout(timer);
      sockets.delete(socket);
    };
    socket.once("close", clear);
    socket.once("error", clear);
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) socket.destroy();
    });
    socket.on("end", () => {
      try {
        const value = JSON.parse(body) as Record<string, unknown>;
        if (
          value.token !== token ||
          ![
            "status",
            "stop",
            ...(revoke ? ["revoke"] : []),
            ...(pairingCode ? ["pairing-code"] : []),
            ...(computerPermissions ? ["computer-permissions"] : []),
          ].includes(String(value.operation))
        )
          throw new Error("denied");
        if (value.operation === "computer-permissions" && computerPermissions) {
          const action = computerPermissions().then(
            (permissions) => {
              socket.end(`${JSON.stringify({ ok: true, permissions })}\n`);
            },
            () => {
              socket.end('{"ok":false}\n');
            },
          );
          actions.add(action);
          void action
            .finally(() => actions.delete(action))
            .catch(() => {
              // Socket loss does not cancel the runner-owned native permission read.
            });
          return;
        }
        if (value.operation === "pairing-code" && pairingCode) {
          socket.end(`${JSON.stringify({ ok: true, code: pairingCode() ?? null })}\n`);
          return;
        }
        if (value.operation === "revoke" && revoke) {
          const action = revoke()
            .then(
              () => {
                socket.end('{"ok":true}\n');
                setImmediate(stop);
              },
              () => socket.end('{"ok":false}\n'),
            )
            .then(() => {});
          actions.add(action);
          void action
            .finally(() => actions.delete(action))
            .catch(() => {
              // A disconnected control client cannot retain a completed revocation action.
            });
          return;
        }
        // The link facts and the cached isolation probe belong to `status` only; a stop/revoke
        // answer stays minimal.
        const link = value.operation === "status" ? status?.() : undefined;
        const probe = value.operation === "status" ? isolation?.() : undefined;
        socket.end(
          `${JSON.stringify({
            ok: true,
            ...link,
            ...(probe ? { isolation: probe } : {}),
          })}\n`,
        );
        if (value.operation === "stop") setImmediate(stop);
      } catch {
        socket.end('{"ok":false}\n');
      }
    });
  });
  server.maxConnections = MAX_CONTROL_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("runner_control_failed");
  return {
    state: { pid: process.pid, startedAt, port: address.port, token, deviceId },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      });
      await Promise.allSettled([...actions]);
    },
  };
}
