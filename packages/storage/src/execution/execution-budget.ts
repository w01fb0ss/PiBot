import type { DatabaseSync } from "node:sqlite";
import {
  type BudgetSnapshot,
  BudgetSnapshotSchema,
  type ExecutionLimits,
  IdSchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

export class BudgetLimitError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export class BudgetRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(rootRunId: string): BudgetSnapshot | undefined {
    const row = this.db
      .prepare("SELECT snapshot_json FROM execution_budgets WHERE root_run_id=?")
      .get(IdSchema.parse(rootRunId));
    return row ? BudgetSnapshotSchema.parse(JSON.parse(String(row.snapshot_json))) : undefined;
  }
  /** In-flight requests are not evidence of a settled unknown charge. */
  pendingModelRequests(rootRunId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM budget_events WHERE root_run_id=? AND kind='model' AND settled=0",
      )
      .get(IdSchema.parse(rootRunId));
    return Number(row?.count ?? 0);
  }
  ensure(rootRunId: string, limits: ExecutionLimits): BudgetSnapshot {
    return transaction(this.db, () => {
      const previous = this.get(rootRunId);
      if (previous) return previous;
      const result = BudgetSnapshotSchema.parse({
        rootRunId,
        limits,
        activeMillis: 0,
        tools: 0,
        requests: 0,
        childTasks: 0,
        activeChildren: 0,
        maxDepth: 0,
        observedTokens: 0,
        knownCostUsd: 0,
        unknownUsageRequests: 0,
        unknownCostRequests: 0,
        exhaustedReason: null,
        version: 0,
      });
      this.write(result);
      return result;
    });
  }
  private write(snapshot: BudgetSnapshot) {
    const next = BudgetSnapshotSchema.parse(snapshot);
    this.db
      .prepare(`INSERT INTO execution_budgets(root_run_id,snapshot_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(root_run_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`)
      .run(next.rootRunId, JSON.stringify(next), new Date().toISOString());
  }
  change(rootRunId: string, change: (snapshot: BudgetSnapshot) => void): BudgetSnapshot {
    return transaction(this.db, () => {
      const value = this.get(rootRunId);
      if (!value) throw new Error("budget_missing");
      change(value);
      value.version++;
      this.write(value);
      return value;
    });
  }
  reserve(
    rootRunId: string,
    eventId: string,
    kind: "tool" | "model" | "child",
    options: {
      pricingKnown?: boolean;
      depth?: number;
    } = {},
  ) {
    return transaction(this.db, () => {
      if (
        this.db
          .prepare("SELECT 1 FROM budget_events WHERE root_run_id=? AND event_id=?")
          .get(rootRunId, eventId)
      )
        return this.get(rootRunId) as BudgetSnapshot;
      const snapshot = this.get(rootRunId);
      if (!snapshot) throw new Error("budget_missing");
      const reason =
        this.reason(snapshot) ??
        (kind === "tool" && snapshot.tools >= snapshot.limits.toolCalls ? "tool_calls" : null) ??
        (kind === "model" && snapshot.requests >= snapshot.limits.modelRequests
          ? "model_requests"
          : null) ??
        (kind === "model" && snapshot.limits.costUsd !== null && !options.pricingKnown
          ? "price_unknown"
          : null) ??
        (kind === "child" && snapshot.childTasks >= snapshot.limits.childTasks
          ? "child_tasks"
          : null) ??
        (kind === "child" && (options.depth ?? 1) > snapshot.limits.childDepth
          ? "child_depth"
          : null);
      // Persist the failed admission outside a thrown transaction so recovery sees the real stop.
      if (reason) return { reason };
      this.db
        .prepare("INSERT INTO budget_events(root_run_id,event_id,kind,updated_at) VALUES(?,?,?,?)")
        .run(rootRunId, eventId, kind, new Date().toISOString());
      return this.change(rootRunId, (value) => {
        if (kind === "tool") value.tools++;
        if (kind === "model") {
          value.requests++;
          value.unknownUsageRequests++;
          value.unknownCostRequests++;
        }
        if (kind === "child") {
          value.childTasks++;
          value.maxDepth = Math.max(value.maxDepth, options.depth ?? 1);
        }
      });
    });
  }
  claimChild(rootRunId: string): boolean {
    return transaction(this.db, () => {
      const snapshot = this.get(rootRunId);
      if (
        !snapshot ||
        this.reason(snapshot) ||
        snapshot.activeChildren >= snapshot.limits.childConcurrency
      )
        return false;
      this.change(rootRunId, (value) => {
        value.activeChildren++;
      });
      return true;
    });
  }
  settleModel(rootRunId: string, eventId: string, usage?: { tokens?: number; costUsd?: number }) {
    // An explicit zero is a known observation (e.g. an attested no-output transient failure).
    // Missing usage stays unknown; completion/error status alone cannot forgive that charge.
    return transaction(this.db, () => {
      const result = this.db
        .prepare(`UPDATE budget_events SET settled=1,updated_at=?
        WHERE root_run_id=? AND event_id=? AND kind='model' AND settled=0`)
        .run(new Date().toISOString(), rootRunId, eventId);
      if (!result.changes) return this.get(rootRunId);
      return this.change(rootRunId, (value) => {
        if (usage?.tokens !== undefined) {
          value.observedTokens += usage.tokens;
          value.unknownUsageRequests--;
        }
        if (usage?.costUsd !== undefined) {
          // A negative "cost" is an unknown price leaking through, never a refund to the budget.
          value.knownCostUsd += Number.isFinite(usage.costUsd) ? Math.max(0, usage.costUsd) : 0;
          value.unknownCostRequests--;
        }
        if (value.limits.costUsd !== null && usage?.costUsd === undefined)
          value.exhaustedReason ??= "cost_unknown";
        value.exhaustedReason ??= this.reason(value);
      });
    });
  }
  /**
   * Raises a root stopped at its cost cap by `share` of the cap it started with and clears
   * the stop, so a resume can go on from the same ledger. Undefined (nothing changed) when the
   * root did not stop at a cost cap or already had `max` raises; the caller checks first and this
   * re-checks inside the transaction.
   */
  raiseCost(
    rootRunId: string,
    share: number,
    max: number,
  ): { costUsd: number; amountUsd: number; used: number } | undefined {
    return transaction(this.db, () => {
      const value = this.get(rootRunId);
      const plan = value && costRaise(value, share, max);
      if (!plan) return undefined;
      this.change(rootRunId, (next) => {
        next.limits.costUsd = plan.costUsd;
        next.costRaises = { count: plan.used, baseUsd: plan.baseUsd };
        next.exhaustedReason = null;
      });
      return { costUsd: plan.costUsd, amountUsd: plan.amountUsd, used: plan.used };
    });
  }
  reason(value: BudgetSnapshot): string | null {
    return (
      value.exhaustedReason ??
      (value.activeMillis >= value.limits.activeSeconds * 1_000 ? "active_time" : null) ??
      (value.observedTokens >= value.limits.tokens ? "tokens" : null) ??
      (value.limits.costUsd !== null && value.knownCostUsd >= value.limits.costUsd ? "cost" : null)
    );
  }
  recover() {
    transaction(this.db, () => {
      this.db.prepare("UPDATE budget_events SET settled=1 WHERE kind='model' AND settled=0").run();
      // Active leases do not survive a process restart; unknown observations do survive it.
      for (const row of this.db
        .prepare(
          "SELECT root_run_id FROM execution_budgets WHERE json_extract(snapshot_json,'$.activeChildren')>0",
        )
        .iterate())
        this.change(String(row.root_run_id), (value) => {
          value.activeChildren = 0;
        });
    });
  }
}

/**
 * What one more 「加预算继续」 would do to a root's snapshot, or undefined when it cannot
 * be raised (no cost stop, or `max` raises already). Shared by the receipt (shows the offer) and
 * `BudgetRepo.raiseCost` (applies it), so both name the same amounts.
 */
export function costRaise(value: BudgetSnapshot, share: number, max: number) {
  const cap = value.limits.costUsd;
  if (value.exhaustedReason !== "cost" || cap === null) return undefined;
  const done = value.costRaises?.count ?? 0;
  if (done >= max) return undefined;
  const baseUsd = value.costRaises?.baseUsd ?? cap;
  // Cents: the cap is shown and audited in dollars; float noise must not leak into either.
  const requested = Math.round(baseUsd * share * 100) / 100 || 0.01;
  const costUsd = Math.min(10_000, Math.round((cap + requested) * 100) / 100);
  if (costUsd <= cap) return undefined;
  // The last raise may hit the absolute ceiling; the offer and audit name the actual delta.
  const [mantissa, exponent = "0"] = String(cap).split("e");
  const decimals = Math.max(2, (mantissa?.split(".")[1]?.length ?? 0) - Number(exponent));
  const amountUsd = Number((costUsd - cap).toFixed(Math.min(20, decimals)));
  return {
    capUsd: cap,
    baseUsd,
    amountUsd,
    costUsd,
    used: done + 1,
  };
}
