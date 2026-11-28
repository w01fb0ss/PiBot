// Dispatches and settles one leased extraction, including its fixed-code health and audit receipts.
import type { DatabaseSync } from "node:sqlite";
import type { MemoryDraftRequest, MemoryDraftResult } from "@pibot/agent";
import type { BrainRedactor } from "@pibot/brain/kit";
import {
  type Message,
  memoryFailureNeedsSettings,
  memoryFailureReason,
} from "@pibot/protocol-base";
import {
  BackgroundTaskHealthRepo,
  BotsRepo,
  correctionTopic,
  memoryBudgetDayStart as dayStart,
  type MemoryExtraction,
  type MemoryExtractionsRepo,
  memoryMaintenanceUsage,
  SettingsRepo,
  transaction,
} from "@pibot/storage";
import { correctionBody, correctionSource, ordinarySource } from "./memory-correction.ts";
import {
  type ExtractionSource,
  extractionPrompt,
  groupExtractionInstruction,
} from "./memory-extraction.ts";
import { extractionErrorCode } from "./memory-extraction-result.ts";
import { settleExtraction } from "./memory-extraction-settlement.ts";
import { logMemoryAttempt, logMemoryFallback } from "./memory-maintenance-log.ts";
import { memoryModelRoute } from "./memory-organization-model.ts";
import type { MemoryService } from "./memory-service.ts";

export interface MemoryExtractionAttemptDeps {
  db: DatabaseSync;
  redactor: BrainRedactor;
  logger: { warn(message: string): void; info?(message: string): void };
  memory: MemoryService;
  healthChanged?(): void;
  statusChanged?(botId: string): void;
  isBotIdle(botId: string, correction?: boolean): boolean;
  publishReply?(message: Message, botId: string): void;
  isPaused(): boolean;
  draftMemories?: (request: MemoryDraftRequest) => Promise<MemoryDraftResult>;
}

export { dayStart };

export class MemoryExtractionAttempt {
  private readonly bots: BotsRepo;
  private readonly settings: SettingsRepo;
  private readonly health: BackgroundTaskHealthRepo;
  constructor(
    private readonly deps: MemoryExtractionAttemptDeps,
    private readonly repo: MemoryExtractionsRepo,
  ) {
    this.bots = new BotsRepo(deps.db);
    this.settings = new SettingsRepo(deps.db);
    this.health = new BackgroundTaskHealthRepo(deps.db, deps.healthChanged);
  }
  limit() {
    const settings = this.settings.get();
    return {
      costUsd: settings.memoryExtractionDailyCostUsd ?? 0.5,
      tokens: settings.memoryExtractionDailyTokens ?? 2_000_000,
    };
  }
  private permitted(row: MemoryExtraction): boolean {
    const bot = this.bots.get(row.botId);
    // An external agent keeps its own memory; its chats never go to Pi Bot's model.
    if (!bot || bot.archivedAt || !bot.memoryExtraction || bot.kind === "agent") return false;
    const topic = this.deps.db
      .prepare(`SELECT bot_id,group_id FROM conversations WHERE id=?`)
      .get(row.conversationId);
    if (!topic || topic.group_id !== row.groupId) return false;
    return row.groupId
      ? !!this.deps.db
          .prepare(
            `SELECT 1 FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.group_id=? AND gm.bot_id=? AND gm.left_at IS NULL AND g.coordinator_bot_id=? AND g.archived_at IS NULL`,
          )
          .get(row.groupId, row.botId, row.botId)
      : topic.bot_id === row.botId;
  }
  async process(row: MemoryExtraction, signal: AbortSignal) {
    const start = performance.now();
    try {
      await this.extract(row, signal);
    } catch (error) {
      this.failed(row, signal, error);
    } finally {
      logMemoryAttempt(this.deps, "extraction", row, start);
    }
  }
  private async extract(row: MemoryExtraction, signal: AbortSignal) {
    const skip = (error: string, coverageMessageId?: string) =>
      this.repo.finish(row.id, { status: "skipped", error, coverageMessageId });
    if (!this.permitted(row)) {
      skip("extraction_disabled_or_scope_changed");
      return;
    }
    const automated = this.repo.automatedReason(row.conversationId);
    if (automated) {
      skip(automated, this.repo.watermark(row.conversationId)?.messageId);
      return;
    }
    const urgent = row.reason === "correction";
    const correction =
      urgent &&
      row.sourceMessageId &&
      correctionTopic(this.deps.db, row.conversationId, row.sourceMessageId)
        ? correctionSource(
            this.deps.db,
            row.conversationId,
            row.sourceMessageId,
            row.botId,
            row.groupId,
          )
        : undefined;
    if (urgent && !correction) {
      skip("correction_source_unavailable");
      return;
    }
    const newest = this.repo.watermark(row.conversationId);
    if (
      row.reason !== "correction" &&
      newest &&
      this.repo.covered(row.conversationId, newest.messageId)
    ) {
      skip("already_covered");
      return;
    }
    const source = correction ?? ordinarySource(this.deps.db, row);
    if (!source) {
      skip("no_new_human_content");
      return;
    }
    const route = memoryModelRoute(this.deps.db, row.botId);
    const draftMemories = this.deps.draftMemories;
    if (!route || !draftMemories) {
      // A missing model used to be silent forever; a streak makes the inbox say it.
      this.health.fail("memory_extraction", row.botId, "no_model");
      skip("no_model");
      return;
    }
    const result = await this.draft(row, source, route, draftMemories, signal);
    signal.throwIfAborted();
    if (!this.deps.isBotIdle(row.botId, urgent)) {
      this.repo.defer(row, "bot_busy");
      return;
    }
    if (!this.permitted(row)) {
      skip("extraction_disabled_or_scope_changed");
      return;
    }
    this.finish(row, source, result, correction);
  }
  private finish(
    row: MemoryExtraction,
    source: ExtractionSource,
    result: MemoryDraftResult,
    correction?: ReturnType<typeof correctionSource>,
  ) {
    if (correction) {
      const current = correctionSource(
        this.deps.db,
        row.conversationId,
        correction.subjectMessageId,
        row.botId,
        row.groupId,
      );
      if (current?.replyId !== correction.replyId || current.text !== correction.text) {
        this.repo.defer(row, "source_changed");
        return;
      }
      const message = transaction(this.deps.db, () =>
        settleExtraction(
          this.deps,
          this.repo,
          this.health,
          row,
          source,
          result,
          correction.replyId,
        ),
      );
      if (message) this.publishReply(message, row.botId);
    } else {
      if (this.repo.watermark(row.conversationId)?.messageId !== source.watermarkId) {
        this.repo.defer(row, "source_changed");
        return;
      }
      transaction(this.deps.db, () =>
        settleExtraction(this.deps, this.repo, this.health, row, source, result),
      );
    }
  }
  private publishReply(message: Message, botId: string) {
    try {
      this.deps.publishReply?.(message, botId);
    } catch {
      // The receipt is already durable and can be recovered by reading history.
      this.deps.logger.warn(
        JSON.stringify({ module: "memory", reasonCode: "memory_receipt_publish_failed" }),
      );
    }
  }
  private draft(
    row: MemoryExtraction,
    source: ExtractionSource,
    route: NonNullable<ReturnType<typeof memoryModelRoute>>,
    draftMemories: NonNullable<MemoryExtractionAttemptDeps["draftMemories"]>,
    signal: AbortSignal,
  ) {
    const catalog = this.deps.memory.extractionCatalog(row.botId, row.groupId);
    const redact = (value: string) => this.deps.redactor.redact(value);
    const text =
      row.reason === "correction"
        ? correctionBody(redact(source.text), redact(catalog))
        : redact(extractionPrompt(catalog, source.text, source.truncated));
    const used = memoryMaintenanceUsage(this.deps.db, dayStart());
    const limit = this.limit();
    return draftMemories({
      ...route,
      text,
      ...(row.groupId ? { instruction: groupExtractionInstruction() } : {}),
      signal,
      budget: {
        tokens: Math.max(0, limit.tokens - used.tokens),
        costUsd: Math.max(0, limit.costUsd - used.costUsd),
      },
      onUsage: (usage) => this.repo.recordUsage(row.id, usage),
      onFallback: logMemoryFallback(this.deps, row.botId),
    });
  }
  private failed(row: MemoryExtraction, signal: AbortSignal, error: unknown) {
    const code = extractionErrorCode(error);
    if (signal.aborted) {
      this.repo.defer(row, this.deps.isPaused() ? "worker_stopped" : "bot_preempted");
      return;
    }
    if (code === "budget_exhausted") {
      this.repo.defer(row, code);
      return;
    }
    const reason = memoryFailureReason(code);
    this.health.fail("memory_extraction", row.botId, reason);
    this.repo.finish(row.id, {
      status: memoryFailureNeedsSettings(reason) ? "skipped" : "failed",
      error: code,
    });
  }
}
