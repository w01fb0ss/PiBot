// Read-only ACP session replay for conversation import: launches the agent inside the same
// sandbox as live turns, inspects `initialize` capabilities, and replays selected conversations
// via `session/load` without ever sending a prompt or approving permissions.
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ACP_CLIENT_PROTOCOL_VERSION,
  initializeResult,
  loadSessionResult,
  type SessionUpdate,
  sessionNotification,
} from "@pibot/acp-schemas";
import type {
  AgentReplayCapabilities,
  ExternalAgentReplayPort,
  ReplayedMessage,
  ReplayedSession,
  ReplaySessionRequest,
  ReplaySessionsResult,
} from "@pibot/brain/kit";
import { agentDescriptor, type KnownAgentId } from "@pibot/external-agents-contract";
import type { Logger } from "@pibot/observability";
import { confirmationSubject, type ExternalAgentConfirmationsRepo } from "../../store/index.ts";
import {
  type AdapterAgent,
  type AdapterStore,
  isAdapterAgent,
} from "../adapters/adapter-install.ts";
import { CODEX_PROFILE_MODE, codexLauncher } from "../adapters/codex-launch.ts";
import { findAgentProgram } from "../detect/detect.ts";
import { AcpClosedError, AcpConnection, AcpRemoteError } from "./acp-connection.ts";
import { type LaunchDeps, type LaunchInput, launchAgent } from "./launch.ts";
import { AUTH_REQUIRED } from "./session-open.ts";

const INITIALIZE_MS = { default: 30_000, win32: 120_000 } as const;
const LOAD_MS = { default: 60_000, win32: 120_000 } as const;
const CLOSE_MS = 5_000;
const MAX_MESSAGE_CHARS = 8 * 1024 * 1024;
const MAX_TOTAL_CHARS = 64 * 1024 * 1024;

const limit = (table: { default: number; win32: number }, platform: NodeJS.Platform) =>
  platform === "win32" ? table.win32 : table.default;

export interface SessionReplayDeps {
  launch: LaunchDeps;
  version: string;
  adapters: AdapterStore;
  confirmations: ExternalAgentConfirmationsRepo;
  logger: Logger;
}

type PreparedLaunch =
  | {
      ok: true;
      isolation: "sandbox" | "unisolated";
      program: string;
      target: LaunchInput["target"];
      env: Record<string, string>;
    }
  | { ok: false; status: "unavailable" | "unconfirmed" | "unsupported" };

/** Collects replayed `session/update` chunks into ordered user/assistant messages. */
export class ReplayCollector {
  readonly messages: ReplayedMessage[] = [];
  private current?: ReplayedMessage;
  private totalChars = 0;

  push(update: SessionUpdate) {
    if (this.totalChars >= MAX_TOTAL_CHARS) return;
    if (update.sessionUpdate === "user_message_chunk") {
      if (update.content.type === "text" && typeof update.content.text === "string")
        this.append("user", update.content.text);
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text" && typeof update.content.text === "string")
        this.append("assistant", update.content.text);
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      const title = (update.title ?? "").replace(/\s+/gu, " ").trim().slice(0, 300);
      const kind = update.kind ?? "tool";
      const line = title ? `[${kind}] ${title}` : `[${kind}] ${update.toolCallId}`;
      const prefix =
        this.current?.role === "assistant" &&
        this.current.text.length > 0 &&
        !this.current.text.endsWith("\n")
          ? "\n"
          : "";
      this.append("assistant", `${prefix}${line}\n`);
    }
  }

  finish(): ReplayedMessage[] {
    this.flush();
    return this.messages;
  }

  private append(role: "user" | "assistant", chunk: string) {
    if (!chunk) return;
    if (this.current && this.current.role !== role) this.flush();
    if (!this.current) this.current = { role, text: "" };
    const remainingTotal = MAX_TOTAL_CHARS - this.totalChars;
    const remainingMessage = MAX_MESSAGE_CHARS - this.current.text.length;
    const allowed = Math.min(remainingTotal, remainingMessage);
    if (allowed <= 0) return;
    const slice = chunk.length > allowed ? chunk.slice(0, allowed) : chunk;
    this.current.text += slice;
    this.totalChars += slice.length;
  }

  private flush() {
    if (!this.current) return;
    const text = this.current.text.trim();
    if (text) this.messages.push({ role: this.current.role, text });
    this.current = undefined;
  }
}

async function prepareLaunch(
  deps: SessionReplayDeps,
  agentId: KnownAgentId,
): Promise<PreparedLaunch> {
  const { platform } = deps.launch;
  let isolation: "sandbox" | "unisolated";
  if (platform === "win32") {
    const confirmed = deps.confirmations.confirmed(confirmationSubject({ agentId, custom: null }));
    if (!confirmed) return { ok: false, status: "unconfirmed" };
    isolation = "unisolated";
  } else if (platform === "darwin" || platform === "linux") {
    isolation = "sandbox";
  } else {
    return { ok: false, status: "unsupported" };
  }
  const program = await findAgentProgram(agentId, deps.launch);
  if (!program) return { ok: false, status: "unavailable" };
  const descriptor = agentDescriptor(agentId);
  if (descriptor.launch.kind === "native") {
    return {
      ok: true,
      isolation,
      program,
      target: { kind: "program", path: program, args: descriptor.launch.args },
      env: {},
    };
  }
  const adapterId = agentId as AdapterAgent;
  if (!isAdapterAgent(agentId) || !(await deps.adapters.installed(adapterId)))
    return { ok: false, status: "unavailable" };
  const env: Record<string, string> = { [descriptor.launch.adapter.programEnv]: program };
  const readRoots: string[] = [];
  if (agentId === "codex" && platform !== "win32") {
    const launcher = await codexLauncher(deps.launch.dataDir, program);
    env[descriptor.launch.adapter.programEnv] = launcher.path;
    env.INITIAL_AGENT_MODE = CODEX_PROFILE_MODE;
    readRoots.push(launcher.folder);
  }
  return {
    ok: true,
    isolation,
    program,
    target: {
      kind: "adapter",
      entry: deps.adapters.entry(adapterId),
      folder: deps.adapters.folder(adapterId),
      ...(readRoots.length ? { readRoots } : {}),
    },
    env,
  };
}

function replayFailureReason(error: unknown) {
  if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError")
    return "timeout" as const;
  if (error instanceof AcpRemoteError && error.code === AUTH_REQUIRED)
    return "agent_login_required" as const;
  if (error instanceof AcpClosedError) return "failed" as const;
  return "failed" as const;
}

export function createExternalAgentReplayPort(deps: SessionReplayDeps): ExternalAgentReplayPort {
  const capabilityCache = new Map<string, { loadSession: boolean; closeSession: boolean }>();

  async function cacheKey(agentId: KnownAgentId, program: string) {
    const info = await stat(program).catch(() => undefined);
    return info
      ? `${agentId}|${program}|${info.size}|${Math.trunc(info.mtimeMs)}|${info.ino}`
      : undefined;
  }

  async function initializeAgent(
    agentId: KnownAgentId,
    prepared: Extract<PreparedLaunch, { ok: true }>,
    tempFolder: string,
    offline: boolean,
    signal: AbortSignal,
  ) {
    const stream = await launchAgent(
      { ...deps.launch, bridge: undefined },
      {
        agent: { id: agentId, custom: null },
        target: prepared.target,
        env: prepared.env,
        cwd: tempFolder,
        writeRoots: [tempFolder],
        isolation: prepared.isolation,
        offline,
        signal,
      },
    );
    const connection = new AcpConnection(stream, (entry) =>
      deps.logger.info(JSON.stringify({ module: "external-agents", ...entry, agentId })),
    );
    // Replay must never grant permissions or execute tools on behalf of the user.
    connection.onRequest("session/request_permission", async () => ({
      outcome: { outcome: "cancelled" },
    }));
    const initDeadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(limit(INITIALIZE_MS, deps.launch.platform)),
    ]);
    try {
      const info = initializeResult.parse(
        await connection.request(
          "initialize",
          {
            protocolVersion: ACP_CLIENT_PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "pibot", title: "Pi Bot", version: deps.version },
          },
          initDeadline,
        ),
      );
      if (info.protocolVersion !== ACP_CLIENT_PROTOCOL_VERSION) {
        throw new Error("acp_protocol_mismatch");
      }
      return { connection, info };
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  return {
    async probeCapabilities(
      agentId: KnownAgentId,
      signal: AbortSignal,
    ): Promise<AgentReplayCapabilities> {
      signal.throwIfAborted();
      const prepared = await prepareLaunch(deps, agentId);
      if (!prepared.ok) return { status: prepared.status };
      const key = await cacheKey(agentId, prepared.program);
      const cached = key ? capabilityCache.get(key) : undefined;
      if (cached) return { status: "ready", ...cached };
      const tempFolder = await realpath(
        await mkdtemp(join(await realpath(deps.launch.tempDir), "agent-import-probe-")),
      );
      try {
        const { connection, info } = await initializeAgent(
          agentId,
          prepared,
          tempFolder,
          true,
          signal,
        );
        try {
          const loadSession = info.agentCapabilities?.loadSession === true;
          const closeSession = Boolean(
            (info.agentCapabilities?.sessionCapabilities as { close?: unknown } | undefined)?.close,
          );
          if (key) {
            if (capabilityCache.size >= 16) {
              const oldest = capabilityCache.keys().next().value;
              if (oldest) capabilityCache.delete(oldest);
            }
            capabilityCache.set(key, { loadSession, closeSession });
          }
          deps.logger.info(
            JSON.stringify({
              module: "external-agents",
              event: "import_replay_probe",
              agentId,
              loadSession,
            }),
          );
          return { status: "ready", loadSession, closeSession };
        } finally {
          await connection.close().catch(() => undefined);
        }
      } catch (error) {
        signal.throwIfAborted();
        deps.logger.warn(
          JSON.stringify({
            module: "external-agents",
            event: "import_replay_probe_failed",
            agentId,
            reason: replayFailureReason(error),
          }),
        );
        return { status: "unavailable" };
      } finally {
        await rm(tempFolder, { recursive: true, force: true });
      }
    },

    async replaySessions(
      agentId: KnownAgentId,
      requests: readonly ReplaySessionRequest[],
      signal: AbortSignal,
    ): Promise<ReplaySessionsResult> {
      signal.throwIfAborted();
      const prepared = await prepareLaunch(deps, agentId);
      if (!prepared.ok) {
        const reason =
          prepared.status === "unconfirmed"
            ? "agent_unconfirmed"
            : prepared.status === "unsupported"
              ? "unsupported"
              : "agent_unavailable";
        return { ok: false, reason };
      }
      if (!requests.length) return { ok: true, sessions: [] };
      const tempFolder = await realpath(
        await mkdtemp(join(await realpath(deps.launch.tempDir), "agent-import-replay-")),
      );
      let connection: AcpConnection | undefined;
      try {
        const initialized = await initializeAgent(agentId, prepared, tempFolder, false, signal);
        connection = initialized.connection;
        const { info } = initialized;
        if (info.agentCapabilities?.loadSession !== true) {
          return { ok: false, reason: "no_load_session" };
        }
        const closeSession = Boolean(
          (info.agentCapabilities?.sessionCapabilities as { close?: unknown } | undefined)?.close,
        );
        let activeSessionId: string | undefined;
        let activeCollector: ReplayCollector | undefined;
        connection.onNotification("session/update", (params) => {
          const parsed = sessionNotification.safeParse(params);
          if (!parsed.success) return;
          if (parsed.data.sessionId === activeSessionId && activeCollector) {
            activeCollector.push(parsed.data.update);
          }
        });

        const sessions: ReplayedSession[] = [];
        const claudeMeta =
          agentId === "claude"
            ? {
                claudeCode: {
                  options: { sandbox: { enabled: false }, allowDangerouslySkipPermissions: false },
                },
              }
            : undefined;

        for (const req of requests) {
          signal.throwIfAborted();
          const loadCwd =
            req.cwd &&
            (await stat(req.cwd).then(
              (s) => s.isDirectory(),
              () => false,
            ))
              ? req.cwd
              : tempFolder;
          const collector = new ReplayCollector();
          activeSessionId = req.sessionId;
          activeCollector = collector;
          const loadDeadline = AbortSignal.any([
            signal,
            AbortSignal.timeout(limit(LOAD_MS, deps.launch.platform)),
          ]);
          try {
            loadSessionResult.parse(
              (await connection.request(
                "session/load",
                {
                  sessionId: req.sessionId,
                  cwd: loadCwd,
                  mcpServers: [],
                  ...(claudeMeta ? { _meta: claudeMeta } : {}),
                },
                loadDeadline,
              )) ?? {},
            );
          } finally {
            activeSessionId = undefined;
            activeCollector = undefined;
          }
          sessions.push({ sessionId: req.sessionId, messages: collector.finish() });
          if (closeSession && !connection.isClosed && !signal.aborted) {
            // Best-effort close so the agent can release per-session memory before the next load.
            await connection
              .request(
                "session/close",
                { sessionId: req.sessionId },
                AbortSignal.any([signal, AbortSignal.timeout(CLOSE_MS)]),
              )
              .catch(() => undefined);
          }
        }
        return { ok: true, sessions };
      } catch (error) {
        if (signal.aborted) throw error;
        const reason = replayFailureReason(error);
        deps.logger.warn(
          JSON.stringify({
            module: "external-agents",
            event: "import_replay_failed",
            agentId,
            reason,
          }),
        );
        return { ok: false, reason };
      } finally {
        await connection?.close().catch(() => undefined);
        await rm(tempFolder, { recursive: true, force: true });
      }
    },
  };
}
