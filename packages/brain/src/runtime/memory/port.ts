// Defines the capability ports consumed by the brain without importing memory.
import type { MemoryDraftQuote } from "@pibot/agent";
import type { Bot, Memory, MemoryProposal, MemoryRecallSnapshot } from "@pibot/protocol-base";

export interface MemoryPromptRequest {
  query: string;
  /** Trusted active run identity; refreshes count once per run/note pair. */
  runId?: string;
  /** The run lifetime, which outlives a prompt preparation deadline. */
  runSignal?: AbortSignal;
  signal: AbortSignal;
  /** Canonical path of this run's local primary project folder; absent for a Bot's own folder. */
  project?: string;
  /** Receives the ids injected into this prompt so the run's receipt can list them. */
  onUsed?(ids: readonly string[]): void;
}

/** The narrow memory surface used by L3 run and profile orchestration. */
export interface PersonalMemoryPort {
  active(botId: string): Bot;
  writeTarget(
    botId: string,
    id: string,
    scope?: Memory["scope"],
    groupId?: string,
    project?: string,
  ): Pick<Memory, "text" | "scope" | "updatedAt"> | undefined;
  prompt(botId: string, request?: MemoryPromptRequest): string;
  /** Explicit Agent sharing, user scope only; records the included notes once. */
  sharedUser?(botId: string, signal: AbortSignal): string;
  /**
   * The notes a phone may carry offline for this Bot (user + this Bot's own, the resident
   * set the prompt would show), cut to `maxChars`. Reading them is not a use of the notes.
   */
  curated?(botId: string, request: { maxChars: number; signal: AbortSignal }): string;
  /**
   * A note a phone's offline reply proposed; it only becomes a pending proposal, never an
   * applied note. Undefined when an equal note already exists.
   */
  proposeOffline?(
    botId: string,
    messageId: string,
    input: {
      text: string;
      category: NonNullable<Memory["category"]>;
      why?: string;
      how?: string;
    },
  ): { proposalId: string } | undefined;
  /** Bounded ephemeral observations; implementations must never persist reply/tool text. */
  observeRecall?(runId: string, observation: MemoryRecallObservation): void;
  finishRecall?(runId: string): void;
  /** Null counters mean unavailable; consumers must not treat them as zero. */
  recallSnapshot?(botId: string, request: MemoryRecallRequest): MemoryRecallSnapshot[];
  list(botId: string): Memory[];
  proposals(botId: string): MemoryProposal[];
  undoable(botId: string): MemoryProposal[];
}

export type MemoryRecallObservation =
  | { kind: "reply"; text: string }
  | { kind: "replyEnd" }
  | { kind: "tool"; value: unknown };

export interface MemoryRecallRequest {
  ids: readonly string[];
  groupId?: string;
  project?: string;
  signal: AbortSignal;
}

/** Group orchestration only consumes the prompt; mutation stays inside the memory capability. */
export interface GroupMemoryPort {
  prompt(groupId: string, botId?: string, request?: MemoryPromptRequest): string;
}

/** In-process producers carry trusted IDs; the capability decides whether a topic is eligible. */
export interface MemoryExtractionPort {
  boundary(conversationId: string): void;
  recordRunReceipt(botId: string, replyId: string): void;
  correction(conversationId: string, sourceMessageId: string): void;
  waitForCorrection(
    botId: string,
    destinationConversationId: string | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  pause(): void;
  saveOnExit(): Promise<void>;
  resume(): void;
}

export interface MemoryPort {
  extraction?: MemoryExtractionPort;
  importDistillation?: ImportDistillationPort;
  personal: PersonalMemoryPort;
  group: GroupMemoryPort;
}

export interface ImportDistillationPort {
  estimate(botId: string, signal: AbortSignal): Promise<MemoryDraftQuote | undefined>;
  run(
    request: {
      botId: string;
      quote: MemoryDraftQuote;
      text: string;
      budget: { tokens: number; costUsd: number };
      onUsage(usage: { tokens: number; costUsd?: number }): void;
    },
    signal: AbortSignal,
  ): Promise<Array<{ text: string; category: NonNullable<Memory["category"]> }>>;
}
