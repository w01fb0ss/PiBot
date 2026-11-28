import type { Bot, ImageContent } from "@pibot/protocol-base";
import type { ImageRunHost } from "../media/images-port.ts";
import type { ChatRun } from "../queue/chat-run.ts";

/** The host services an external-agent run settles with; same set an image run gets. */
export type ExternalAgentRunHost = ImageRunHost;

/**
 * A Bot of kind "agent" thinks in an external coding agent (Codex, Claude Agent,
 * …) over ACP. The run queue keeps admission, the topic slot and stop; the external-agents
 * capability owns the agent process, the session and the translation of its updates.
 */
export interface ExternalAgentsPort {
  run(
    deps: ExternalAgentRunHost,
    run: ChatRun,
    text: string,
    bot: Bot,
    images: ImageContent[],
  ): Promise<void>;
  /** The configured adapter label, from local Bot metadata. */
  kind?(botId: string): string | undefined;
  /**
   * Whether this agent Bot can take a group plan step here: "ok", "unconfirmed" (Windows: the
   * user has not confirmed running it unisolated) or "unavailable" (no program / no isolation).
   */
  stepReadiness?(botId: string): "ok" | "unconfirmed" | "unavailable";
}

/** Capability port name used by `@pibot/import` to replay external agent conversations over ACP. */
export const EXTERNAL_AGENT_REPLAY_PORT = "external-agents.replay";

export type ReplayAgentId = "codex" | "claude" | "cursor" | "opencode" | "antigravity";

export type AgentReplayCapabilities =
  | { status: "ready"; loadSession: boolean; closeSession: boolean }
  | { status: "unavailable" | "unconfirmed" | "unsupported" };

export interface ReplaySessionRequest {
  sessionId: string;
  /** Optional working directory from the agent's metadata; used as ACP `cwd` only when valid. */
  cwd?: string;
}

export interface ReplayedMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ReplayedSession {
  sessionId: string;
  messages: ReplayedMessage[];
}

export type ReplaySessionsResult =
  | { ok: true; sessions: ReplayedSession[] }
  | {
      ok: false;
      reason:
        | "no_load_session"
        | "agent_unavailable"
        | "agent_unconfirmed"
        | "agent_login_required"
        | "unsupported"
        | "timeout"
        | "failed";
    };

/**
 * Read-only ACP replay port exposed by `@pibot/external-agents` so `@pibot/import` can inspect
 * `initialize` capabilities and replay selected sessions via `session/load` without spawning any
 * command outside `@pibot/execution` or sending prompts to the agent.
 */
export interface ExternalAgentReplayPort {
  probeCapabilities(agentId: ReplayAgentId, signal: AbortSignal): Promise<AgentReplayCapabilities>;
  replaySessions(
    agentId: ReplayAgentId,
    requests: readonly ReplaySessionRequest[],
    signal: AbortSignal,
  ): Promise<ReplaySessionsResult>;
}
