import {
  connectorEffectClass,
  type LocalToolResult,
  type ToolEffectClass,
  toolEffectClass,
} from "@pibot/agent";
import {
  knownConfigurationFileMatches,
  knownConfigurationFileRequestMatches,
} from "@pibot/execution";
import type { AuditKind } from "@pibot/protocol-base";
import {
  type JournalEffectClass,
  TOOL_JOURNAL_IDENTITY_LIMIT,
  type ToolJournalEntry,
  ToolJournalRepo,
  transaction,
} from "@pibot/storage";
import type { PreparedTool, ToolRunContext } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";
import { capabilityConnectorEffect } from "../connectors/capability-adapter.ts";
import { journalAudit, recoverJournal } from "./journal-audit.ts";
import { argsDigest, idempotencyKey, replayResult, settledOutcome } from "./journal-outcome.ts";
import { targetMatches } from "./journal-verify.ts";

/** Journalling failed before dispatch; the call was not executed. */
const attemptScope = (rootRunId: string, attemptId: string, sendsByLedger: boolean) => ({
  rootRunId,
  attemptId,
  attempts: true,
  sendsByLedger,
});

export class ToolJournalError extends Error {}

/**
 * Where replay detection looks. A resumable unit spans its attempts, and the n-th identical call
 * of one attempt is the n-th of every attempt: a routine occurrence across its resumes, and
 * a chat run's budget root across the user's 「继续」 runs. Elsewhere the budget root (a
 * chat run, its continuations and child tasks) is one scope without attempts, so a repeated
 * identical call there is a deliberate repeat unless the class says otherwise.
 */
export interface JournalScope {
  rootRunId: string;
  attemptId: string;
  attempts: boolean;
  /**
   * Ownership: across attempts of a routine occurrence the draft ledger decides a
   * connector send (duplicate receipt, ledger row, audit). A chat resume has no such ledger.
   */
  sendsByLedger: boolean;
}

type Decision =
  | { kind: "bypass" }
  | { kind: "execute"; entry: ToolJournalEntry }
  | { kind: "replayed"; entry: ToolJournalEntry }
  | { kind: "blocked"; entry: ToolJournalEntry; reason: "running" | "unknown" };

interface Identity {
  context: ToolRunContext;
  prepared: PreparedTool;
  effectClass: JournalEffectClass;
  scope: JournalScope;
  digest: string;
  /** write_file only: the target already holds the intended content (undefined: not checked). */
  matches: boolean | undefined;
}

/**
 * The execution journal around every non-read tool call, on the single dispatch path
 * (`executeStep`), after the policy decision and all re-checks, before execution. The look-up and
 * the `started` write share one transaction; the terminal state is written after execution. Read
 * calls pass straight through (no journal row, no overhead), and keep their ordinary audit.
 */
export class ToolJournal {
  readonly repo: ToolJournalRepo;
  /** Entries this process is executing right now; any other `started` row was left by a crash. */
  private readonly live = new Set<string>();
  /** run:toolCall → idempotency key of the execution in flight (MCP request `_meta`). */
  private readonly keys = new Map<string, string>();
  constructor(private readonly local: LocalService) {
    this.repo = new ToolJournalRepo(local.deps.db);
    recoverJournal(local, this.repo);
  }

  effectClass(prepared: PreparedTool): ToolEffectClass {
    const { tool, input } = prepared.call;
    const configuration = prepared.gitConfiguration;
    if (
      tool === "write_file" &&
      configuration &&
      typeof input.path === "string" &&
      typeof input.content === "string" &&
      knownConfigurationFileMatches(configuration.input?.knownFile, configuration.facts) &&
      knownConfigurationFileRequestMatches(configuration.input?.knownFile, {
        callId: prepared.call.id,
        path: input.path,
        content: input.content,
      })
    )
      // A config CAS outcome is state-dependent; unknown can never be a generic byte-write redo.
      return "local_effect";
    const capability = capabilityConnectorEffect(prepared);
    if (capability) return capability;
    if (tool !== "connector_call") return toolEffectClass(tool, input);
    // The persisted server declarations are untrusted and can only make the user's read-only
    // classification stricter. Without a resolved target the call cannot dispatch; classify it
    // strictly anyway.
    return prepared.connector
      ? connectorEffectClass(prepared.connector.tool.readOnly, prepared.connector.tool)
      : "external";
  }

  scope(context: ToolRunContext): JournalScope {
    if (context.routineRunId) {
      const owner = this.local.unattended;
      // Without the owner the occurrence is unknown; the attempt alone is the narrower scope.
      const occurrence = owner
        ? (owner.run(context.routineRunId).occurrenceId ?? context.routineRunId)
        : context.routineRunId;
      return attemptScope(occurrence, context.routineRunId, true);
    }
    const root = this.local.budgets.root(context);
    // A resume carries the interrupted run's root (`budgetRootRunId`), so it sees its journal.
    if (context.resumedFromRunId) return attemptScope(root, context.runId, false);
    return { rootRunId: root, attemptId: root, attempts: false, sendsByLedger: false };
  }

  /** The idempotency key of a call this process is executing (connector sends carry it). */
  keyFor(runId: string, toolCallId: string): string | undefined {
    return this.keys.get(`${runId}:${toolCallId}`);
  }

  /**
   * Runs `execute` at most once per idempotency key, or answers from the journal. `executed`
   * is false when the result is a replay answer or a refusal, so callers do not count it as
   * progress.
   */
  async run(
    context: ToolRunContext,
    prepared: PreparedTool,
    signal: AbortSignal,
    execute: () => Promise<LocalToolResult>,
    originalInput = prepared.call.input,
  ): Promise<{ result: LocalToolResult; executed: boolean }> {
    const effectClass = this.effectClass(prepared);
    if (effectClass === "read") return { result: await execute(), executed: true };
    const { call } = prepared;
    let identity: Identity;
    let decision: Decision;
    try {
      const scope = this.scope(context);
      // Replays use the Bot's arguments even when the approval chose a different model.
      const digest = argsDigest(originalInput);
      const matches =
        effectClass === "idempotent" &&
        this.repo
          .identity(scope.rootRunId, call.tool, digest)
          .some((entry) => entry.state !== "failed")
          ? await this.verify(prepared, signal)
          : undefined;
      identity = { context, prepared, effectClass, scope, digest, matches };
      decision = transaction(this.local.deps.db, () => this.decide(identity));
    } catch (error) {
      if (signal.aborted) throw error;
      this.local.deps.logger.error(
        JSON.stringify({ module: "tool-journal", event: "begin_failed", runId: context.runId }),
      );
      throw new ToolJournalError("Tool journal unavailable");
    }
    if (decision.kind === "bypass") return { result: await execute(), executed: true };
    if (decision.kind === "replayed")
      return {
        result: replayResult(call.tool, "done", decision.entry.resultSummary),
        executed: false,
      };
    if (decision.kind === "blocked")
      return {
        result: replayResult(call.tool, decision.reason, null),
        executed: false,
      };
    return {
      result: await this.execute(identity, decision.entry, signal, execute),
      executed: true,
    };
  }

  private async execute(
    identity: Identity,
    entry: ToolJournalEntry,
    signal: AbortSignal,
    execute: () => Promise<LocalToolResult>,
  ): Promise<LocalToolResult> {
    const { context, prepared } = identity;
    const callKey = `${context.runId}:${prepared.call.id}`;
    this.live.add(entry.id);
    this.keys.set(callKey, entry.idempotencyKey);
    try {
      let result: LocalToolResult;
      try {
        result = await execute();
      } catch (error) {
        // Whatever was dispatched before the throw may have taken effect.
        this.settle(identity, entry, "unknown", null);
        throw error;
      }
      const outcome = settledOutcome(prepared.call.tool, result, signal.aborted, (text) =>
        this.local.deps.redactor.redact(text),
      );
      this.settle(identity, entry, outcome.state, outcome);
      return result;
    } finally {
      this.live.delete(entry.id);
      this.keys.delete(callKey);
    }
  }

  /**
   * After execution the action happened (or not) regardless of the journal: a failed terminal
   * write is logged and the row stays `started`, which every later look-up and the next start
   * treat as unknown, so nothing is repeated.
   */
  private settle(
    identity: Identity,
    entry: ToolJournalEntry,
    state: "done" | "failed" | "unknown",
    outcome: { summary: string; digest: string } | null,
  ) {
    try {
      transaction(this.local.deps.db, () => {
        this.repo.finish(
          entry.id,
          state,
          outcome ? { digest: outcome.digest, summary: outcome.summary } : undefined,
        );
        this.audit(
          identity,
          entry,
          state === "unknown" ? "tool.journal.unknown" : "tool.journal.finished",
          `journal_${state}`,
        );
      });
    } catch {
      this.local.deps.logger.error(
        JSON.stringify({
          module: "tool-journal",
          event: "settle_failed",
          runId: identity.context.runId,
          tool: identity.prepared.call.tool,
        }),
      );
    }
  }

  private decide(identity: Identity): Decision {
    const { context, prepared, effectClass, scope, digest, matches } = identity;
    const call = prepared.call;
    const rows = this.repo.identity(scope.rootRunId, call.tool, digest);
    if (rows.length > TOOL_JOURNAL_IDENTITY_LIMIT) throw new ToolJournalError("Identity limit");
    // The same call dispatched again (a runtime replay keeps its tool call id).
    const same = rows.find((r) => r.runId === context.runId && r.toolCallId === call.id);
    if (same) return this.fromEntry(identity, same);
    // Ownership: across attempts of an occurrence the draft ledger decides a connector
    // send (duplicate receipt, ledger row, audit), so the journal does not answer for it.
    if (
      call.tool === "connector_call" &&
      scope.sendsByLedger &&
      rows.some((r) => r.runId !== context.runId)
    )
      return { kind: "bypass" };
    const uncertain = rows.filter((r) => r.state === "started" || r.state === "unknown").at(-1);
    if (uncertain) return this.fromEntry(identity, uncertain);
    if (effectClass === "external") {
      const done = rows.find((r) => r.state === "done");
      if (done) return this.replay(identity, done);
      const failed = rows.find((r) => r.state === "failed");
      if (failed) return this.restart(identity, failed, "journal_retry");
      return this.create(identity, 1);
    }
    const lastDone = rows.filter((r) => r.state === "done").at(-1);
    if (effectClass === "idempotent" && matches === true && lastDone)
      return this.replay(identity, lastDone, "journal_replay_verified");
    if (!scope.attempts) return this.create(identity, (rows.at(-1)?.ordinal ?? 0) + 1);
    const ordinal = rows.filter((r) => r.attemptId === scope.attemptId).length + 1;
    const counterpart = rows.find((r) => r.ordinal === ordinal);
    if (!counterpart) return this.create(identity, ordinal);
    if (counterpart.state === "failed" || (effectClass === "idempotent" && matches === false))
      return this.restart(identity, counterpart, "journal_retry");
    this.repo.claim(counterpart.id, scope.attemptId);
    return this.replay(identity, counterpart);
  }

  /** An entry of this identity that is unfinished, unknown, or this very call's own row. */
  private fromEntry(identity: Identity, entry: ToolJournalEntry): Decision {
    if (entry.state === "done") return this.replay(identity, entry);
    if (entry.state === "failed") return this.restart(identity, entry, "journal_retry");
    if (this.live.has(entry.id)) return this.block(identity, entry, "running");
    if (identity.effectClass === "idempotent") {
      // The target already holds this content → record the outcome; otherwise redo it.
      if (identity.matches === true) {
        this.repo.finish(entry.id, "done");
        return this.replay(identity, { ...entry, state: "done" }, "journal_replay_verified");
      }
      return this.restart(identity, entry, "journal_redo");
    }
    return this.block(identity, entry, "unknown");
  }

  private create(identity: Identity, ordinal: number): Decision {
    const { context, prepared, effectClass, scope, digest } = identity;
    const entry = this.repo.create({
      botId: context.botId,
      runId: context.runId,
      rootRunId: scope.rootRunId,
      attemptId: scope.attemptId,
      toolCallId: prepared.call.id,
      tool: prepared.call.tool,
      effectClass,
      argsDigest: digest,
      ordinal,
      idempotencyKey: idempotencyKey(scope.rootRunId, prepared.call.tool, digest, ordinal),
    });
    this.audit(identity, entry, "tool.journal.started", "journal_started");
    return { kind: "execute", entry };
  }

  private restart(identity: Identity, entry: ToolJournalEntry, reason: string): Decision {
    const restarted = this.repo.restart(entry.id, {
      runId: identity.context.runId,
      toolCallId: identity.prepared.call.id,
      attemptId: identity.scope.attemptId,
    });
    this.audit(identity, restarted, "tool.journal.started", reason);
    return { kind: "execute", entry: restarted };
  }

  private replay(identity: Identity, entry: ToolJournalEntry, reason = "journal_replay_done") {
    this.audit(identity, entry, "tool.journal.replay_blocked", reason);
    return { kind: "replayed", entry } as const;
  }

  private block(identity: Identity, entry: ToolJournalEntry, reason: "running" | "unknown") {
    this.audit(identity, entry, "tool.journal.replay_blocked", `journal_replay_${reason}`);
    return { kind: "blocked", entry, reason } as const;
  }

  private async verify(prepared: PreparedTool, signal: AbortSignal) {
    try {
      return await targetMatches(prepared, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // Unverifiable is "not the intended content": an idempotent write is then simply redone.
      this.local.deps.logger.warn(
        JSON.stringify({
          module: "tool-journal",
          event: "verify_failed",
          tool: prepared.call.tool,
        }),
      );
      return false;
    }
  }

  private audit(identity: Identity, entry: ToolJournalEntry, kind: AuditKind, reasonCode: string) {
    journalAudit(this.local, identity.context, identity.prepared.call, entry, kind, reasonCode);
  }
}
