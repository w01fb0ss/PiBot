import { type createTranslator, failureReasonKey, type TranslationKey } from "@pibot/i18n";
import {
  CHATGPT_CODEX_PROVIDER,
  CHATGPT_PLAN_PROVIDER,
  type DeliveryItem,
  type GroupExecutionReceipt,
  type ReceiptBuckets,
  type RunReceipt,
} from "@pibot/protocol";
import { toolDisplayName } from "../tools/presentation.ts";

/**
 * Receipt text shared by the desktop and the phone: the compact chips under a reply and the
 * expanded sections. Everything shown comes from the receipt, itself built from records.
 */
type T = ReturnType<typeof createTranslator>;
export function groupExecutionText(fact: GroupExecutionReceipt, t: T): string {
  return fact.kind === "plan"
    ? [
        t(fact.inProgress ? "receipt.groupExecution.ongoing" : "receipt.groupExecution.plan", {
          count: fact.steps,
        }),
        ...(fact.coordinatorWorked ? [t("receipt.groupExecution.coordinatorWorked")] : []),
        ...(fact.acceptanceRelaxed
          ? [t("receipt.groupExecution.relaxed")]
          : fact.relaxations?.length
            ? [t("receipt.groupExecution.changed")]
            : []),
      ].join(" · ")
    : t(
        fact.completed === false
          ? "receipt.groupExecution.unassigned"
          : "receipt.groupExecution.solo",
      );
}
export type ReceiptTone = "muted" | "ok" | "warn" | "danger";
export interface ReceiptChip {
  id: string;
  text: string;
  tone: ReceiptTone;
}
export interface ReceiptRow {
  /** A recorded output lookup key, never inferred from the formatted value. */
  filePath?: string;
  /** Stable within its section (labels repeat, e.g. one row per changed file). */
  key: string;
  label: string;
  value: string;
  tone?: ReceiptTone;
  /** Paths, folders and domains: shown in a monospace face. */
  code?: boolean;
}
type Row = Omit<ReceiptRow, "key">;
export interface ReceiptSection {
  id:
    | "outcome"
    | "delivery"
    | "uncertain"
    | "inputs"
    | "outputs"
    | "approvals"
    | "actions"
    | "cost"
    | "unverified";
  title: string;
  rows: ReceiptRow[];
  /** Shown instead of rows when there are none. */
  empty: string;
}

const inputTotal = (r: RunReceipt) =>
  r.inputs.files.total +
  r.inputs.web.total +
  r.inputs.searches.total +
  r.inputs.connectors.total +
  r.inputs.phone.total;
/**
 * Mac acceptance 2026-11-20: files attached to the user's own chat were counted as "sent out".
 * Only what left Pi Bot (sent drafts) is "sent out"; attachments are files delivered to the user.
 */
const sentTotal = (r: RunReceipt) => r.actions.sentDrafts;
/** Items a person should look at before trusting the result. */
export function receiptAttention(r: RunReceipt) {
  const delivery = r.delivery?.items.filter((item) => item.status !== "pass").length ?? 0;
  return (
    r.unverified.total +
    (r.unverified.failedCheck ? 1 : 0) +
    r.unverified.openTodos +
    delivery +
    (r.uncertain?.total ?? 0)
  );
}
export function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}
function grouped(value: number) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export function formatReceiptDuration(ms: number, t: T) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? t("receipt.seconds", { count: seconds })
    : t("receipt.minutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

/** Desktop's one-line summary; keep the full sections and the phone's chips independent. */
export function receiptSummaryChips(r: RunReceipt, t: T): ReceiptChip[] {
  const chips: ReceiptChip[] = [];
  if (r.outcome !== "done")
    chips.push({
      id: "outcome",
      text: t(`receipt.outcome.${r.outcome}`),
      tone: r.outcome === "failed" ? "danger" : "warn",
    });
  else if (r.delivery?.status === "failed")
    chips.push({ id: "outcome", text: t("receipt.chip.deliveryFailed"), tone: "danger" });
  else if (r.delivery?.status === "manual")
    chips.push({ id: "outcome", text: t("receipt.chip.waiting"), tone: "warn" });

  if (r.groupExecution?.kind === "plan" && r.groupExecution.acceptanceRelaxed)
    chips.push({
      id: "acceptanceRelaxed",
      text: t("receipt.groupExecution.relaxed"),
      tone: "warn",
    });

  const attention = Math.max(
    receiptAttention(r),
    r.delivery && r.delivery.status !== "passed" ? 1 : 0,
  );
  if (r.delivery?.status === "passed")
    chips.push({ id: "delivery", text: t("receipt.chip.deliveryPassed"), tone: "ok" });
  else if (attention)
    chips.push({
      id: "attention",
      text: t("receipt.chip.attention", { count: grouped(attention) }),
      tone: "warn",
    });

  // Maintainers 2026-11-13: what the run did, like the phone's chips; only counts with a value.
  // A plain number below 1,000 lets the translator pick the singular ("1 approval").
  const add = (id: string, count: number, key: TranslationKey) => {
    if (count > 0)
      chips.push({
        id,
        text: t(key, { count: count < 1000 ? count : grouped(count) }),
        tone: "muted",
      });
  };
  add("files", r.outputs.filesTotal, "receipt.chip.files");
  add("commands", r.actions.commands, "receipt.chip.commands");
  add("approvals", r.approvals.asked, "receipt.chip.approvals");
  add("delivered", r.outputs.attachments, "receipt.chip.delivered");
  add("sent", sentTotal(r), "receipt.chip.sent");
  if (r.budgetRaise)
    chips.push({
      id: "budget",
      text: t("receipt.budgetRaise.stopped", { cap: `$${budgetAmount(r.budgetRaise.capUsd)}` }),
      tone: "warn",
    });
  const took =
    r.startedAt && r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : -1;
  if (Number.isFinite(took) && took >= 0)
    chips.push({ id: "time", text: formatReceiptDuration(took, t), tone: "muted" });
  const cost = r.cost;
  chips.push({
    id: "cost",
    text:
      cost?.costUsd == null
        ? t(
            r.outcome === "stopped"
              ? "receipt.chip.costPartialUnknown"
              : "receipt.chip.costUnknown",
          )
        : cost.unknownCostRequests || r.outcome === "stopped"
          ? t("receipt.chip.costPartial", { cost: formatUsd(cost.costUsd) })
          : formatUsd(cost.costUsd),
    tone: "muted",
  });
  return chips;
}

export function receiptChips(r: RunReceipt, t: T): ReceiptChip[] {
  const chips: ReceiptChip[] = [];
  if (r.groupExecution)
    chips.push({
      id: "groupExecution",
      text: groupExecutionText(r.groupExecution, t),
      tone:
        r.groupExecution.kind === "plan" && r.groupExecution.acceptanceRelaxed ? "warn" : "muted",
    });
  if (r.outcome !== "done")
    chips.push({
      id: "outcome",
      text: t(`receipt.outcome.${r.outcome}`),
      tone: r.outcome === "failed" ? "danger" : "warn",
    });
  const add = (id: string, count: number, key: TranslationKey, tone: ReceiptTone = "muted") => {
    if (count > 0)
      chips.push({ id, text: t(key, { count: count < 1000 ? count : grouped(count) }), tone });
  };
  // The delivery verdict goes first, it is what a workflow run is judged by.
  if (r.delivery) {
    const manual = r.delivery.items.filter((item) => item.status === "manual").length;
    chips.push(
      r.delivery.status === "failed"
        ? { id: "delivery", text: t("receipt.chip.deliveryFailed"), tone: "danger" }
        : r.delivery.status === "manual"
          ? {
              id: "delivery",
              text: t("receipt.chip.deliveryManual", { count: grouped(manual) }),
              tone: "warn",
            }
          : { id: "delivery", text: t("receipt.chip.deliveryPassed"), tone: "ok" },
    );
  }
  add("uncertain", r.uncertain?.total ?? 0, "receipt.chip.uncertain", "warn");
  add("inputs", inputTotal(r), "receipt.chip.inputs");
  add(
    "memories",
    r.memories?.total ?? 0,
    r.memories?.total === 1 ? "receipt.chip.memory" : "receipt.chip.memories",
  );
  add("files", r.outputs.filesTotal, "receipt.chip.files");
  add("commands", r.actions.commands, "receipt.chip.commands");
  add("approvals", r.approvals.asked, "receipt.chip.approvals");
  add("delivered", r.outputs.attachments, "receipt.chip.delivered");
  add("sent", sentTotal(r), "receipt.chip.sent");
  if (r.budgetRaise)
    chips.push({ id: "budget", text: t("receipt.chip.budgetStopped"), tone: "warn" });
  if (r.cost?.costUsd != null && r.cost.costUsd > 0)
    chips.push({ id: "cost", text: formatUsd(r.cost.costUsd), tone: "muted" });
  else add("requests", r.cost?.requests ?? 0, "receipt.chip.requests");
  add("unverified", r.unverified.total, "receipt.chip.unverified", "warn");
  if (r.unverified.failedCheck)
    chips.push({ id: "check", text: t("receipt.chip.checkFailed"), tone: "danger" });
  add("todos", r.unverified.openTodos, "receipt.chip.openTodos", "warn");
  return chips;
}

/**
 * The 「预算用完 · 加预算继续」 line of a workflow run stopped at its cost cap. `action` is
 * the button text when a raise is possible; otherwise `note` says why not. The button calls
 * `runs.resume` with `raiseBudget: true`.
 */
export function receiptBudgetRaise(
  r: RunReceipt,
  t: T,
): { text: string; action?: string; note?: string } | undefined {
  const offer = r.budgetRaise;
  if (!offer) return undefined;
  const text = [
    t("receipt.budgetRaise.stopped", { cap: `$${budgetAmount(offer.capUsd)}` }),
    ...(offer.used ? [t("receipt.budgetRaise.used", { used: offer.used, max: offer.max })] : []),
  ].join(" · ");
  if (offer.available)
    return {
      text,
      action: t("receipt.budgetRaise.action", { amount: `$${budgetAmount(offer.raiseUsd)}` }),
    };
  return {
    text,
    note:
      offer.used >= offer.max
        ? t("receipt.budgetRaise.limit", { max: offer.max })
        : t("receipt.budgetRaise.superseded"),
  };
}

function bucketRows(
  label: string,
  buckets: ReceiptBuckets,
  t: T,
  name = (key: string) => key,
): Row[] {
  if (!buckets.total) return [];
  const parts = buckets.items.map((item) => `${name(item.key)} ${grouped(item.count)}`);
  if (buckets.others) parts.push(t("receipt.others", { count: buckets.others }));
  return [{ label: `${label} · ${grouped(buckets.total)}`, value: parts.join(" · "), code: true }];
}
/** One row per acceptance item: what was checked and, when it failed, what is missing. */
function deliveryRows(r: RunReceipt, t: T): Row[] {
  const delivery = r.delivery;
  if (!delivery) return [];
  const rows: Row[] = [
    {
      label: delivery.version
        ? t("receipt.delivery.workflowVersion", {
            name: delivery.workflow,
            version: delivery.version,
          })
        : delivery.workflow,
      value: t(`receipt.delivery.status.${delivery.status}`),
      tone: delivery.status === "passed" ? "ok" : delivery.status === "failed" ? "danger" : "warn",
    },
  ];
  if (delivery.fixRounds)
    rows.push({
      label: t("receipt.delivery.fixRounds"),
      value: `${delivery.fixRounds} / ${delivery.maxFixRounds}`,
    });
  if (delivery.folder)
    rows.push({ label: t("receipt.delivery.folder"), value: delivery.folder, code: true });
  for (const item of delivery.items) rows.push(deliveryItemRow(item, t));
  return rows;
}
/** One checked item as a row: delivery receipts and hand-off checks share the wording. */
export function deliveryItemRow(item: DeliveryItem, t: T): Omit<ReceiptRow, "key"> {
  return {
    label:
      item.text ??
      `${t(`receipt.delivery.check.${item.check}`)}${item.deliverable ? ` · ${item.deliverable}` : ""}`,
    value: deliveryValue(item, t),
    tone: item.status === "pass" ? "ok" : item.status === "fail" ? "danger" : "warn",
  };
}
function deliveryValue(item: DeliveryItem, t: T) {
  if (item.status === "pass") return t("receipt.delivery.pass");
  if (!item.reason) return t("receipt.delivery.manual");
  const missing = item.missing.join(t("receipt.delivery.separator"));
  return t(`receipt.delivery.reason.${item.reason}`, {
    missing,
    expected: item.location?.expected ?? "",
    actual: item.location?.actual ?? "",
  });
}

const phoneKeys: Record<string, TranslationKey> = {
  media: "receipt.phone.media",
  media_get: "receipt.phone.media_get",
  sms_code: "receipt.phone.sms_code",
  calls: "receipt.phone.calls",
  notifications: "receipt.phone.notifications",
};

export function receiptSections(
  r: RunReceipt,
  t: T,
  options: { files?: boolean } = {},
): ReceiptSection[] {
  const count = (label: TranslationKey, value: number, tone?: ReceiptTone): Row[] =>
    value > 0 ? [{ label: t(label), value: grouped(value), ...(tone ? { tone } : {}) }] : [];
  const outcome: Row[] = [
    {
      label: t(`receipt.outcome.${r.outcome}`),
      value:
        r.startedAt && r.finishedAt
          ? t("receipt.outcome.duration", {
              duration: formatReceiptDuration(
                Date.parse(r.finishedAt) - Date.parse(r.startedAt),
                t,
              ),
            })
          : "",
      tone: r.outcome === "done" ? "ok" : r.outcome === "failed" ? "danger" : "warn",
    },
  ];
  if (r.groupExecution) outcome.push({ label: "", value: groupExecutionText(r.groupExecution, t) });
  if (r.reasonCode || r.outcome === "failed") {
    outcome.push({
      label: t("receipt.outcome.reason"),
      value: t(
        (r.reasonCode !== "permission_denied" && r.reasonCode && failureReasonKey(r.reasonCode)) ||
          "receipt.failureUnknown",
      ),
    });
  }
  const inputs = [
    ...(r.codeAnalysis
      ? [{ label: t("tool.syntaxApproximate"), value: t("tool.syntaxApproximateNote") }]
      : []),
    ...(r.projectNotesChanged ? [{ label: "", value: t("receipt.projectNotesChanged") }] : []),
    ...bucketRows(t("receipt.inputs.files"), r.inputs.files, t),
    ...bucketRows(t("receipt.inputs.web"), r.inputs.web, t),
    ...bucketRows(t("receipt.inputs.searches"), r.inputs.searches, t),
    ...bucketRows(t("receipt.inputs.connectors"), r.inputs.connectors, t),
    ...bucketRows(t("receipt.inputs.phone"), r.inputs.phone, t, (key) =>
      phoneKeys[key] ? t(phoneKeys[key]) : key,
    ),
    ...count("receipt.inputs.messages", r.inputs.messages),
    ...count("receipt.inputs.browser", r.inputs.browser),
    // Which saved notes the Bot was given; the text is the note as it is now.
    ...(r.memories
      ? [
          { label: t("receipt.memories.title"), value: grouped(r.memories.total) },
          ...r.memories.items.map((item) => ({
            label: item.scope ? t(`receipt.memories.scope.${item.scope}`) : "",
            value: item.text ?? t("receipt.memories.deleted"),
          })),
          ...(r.memories.total > r.memories.items.length
            ? [
                {
                  label: "",
                  value: t("receipt.outputs.more", {
                    count: grouped(r.memories.total - r.memories.items.length),
                  }),
                },
              ]
            : []),
        ]
      : []),
  ];
  const outputs: Row[] = [];
  if (r.outputs.filesTotal) {
    outputs.push({
      label: `${t("receipt.outputs.files")} · ${grouped(r.outputs.filesTotal)}`,
      value: t("receipt.outputs.lines", {
        added: grouped(r.outputs.added),
        removed: grouped(r.outputs.removed),
      }),
    });
    if (options.files !== false) {
      for (const file of r.outputs.files)
        outputs.push({
          label: t(`receipt.kind.${file.kind}`),
          value:
            file.added === null && file.removed === null
              ? file.path
              : `${file.path}  +${file.added ?? 0} −${file.removed ?? 0}`,
          code: true,
          filePath: file.path,
        });
      const more = r.outputs.filesTotal - r.outputs.files.length;
      if (more > 0)
        outputs.push({ label: "", value: t("receipt.outputs.more", { count: grouped(more) }) });
    }
  }
  outputs.push(...count("receipt.outputs.attachments", r.outputs.attachments));
  outputs.push(...count("receipt.outputs.images", r.outputs.images));
  const approvals = [
    ...count("receipt.approvals.allowed", r.approvals.allowed, "ok"),
    ...count("receipt.approvals.denied", r.approvals.denied, "danger"),
    ...count("receipt.approvals.unanswered", r.approvals.unanswered, "warn"),
    ...count("receipt.approvals.automatic", r.approvals.automatic),
  ];
  const actions: Row[] = [];
  if (r.actions.commands)
    actions.push({
      label: t("receipt.actions.commands"),
      value: r.actions.failedCommands
        ? t("receipt.actions.failed", {
            count: grouped(r.actions.commands),
            failed: grouped(r.actions.failedCommands),
          })
        : grouped(r.actions.commands),
      ...(r.actions.failedCommands ? { tone: "warn" as const } : {}),
    });
  actions.push(...count("receipt.actions.drafts", r.actions.sentDrafts));
  actions.push(...count("receipt.outputs.attachments", r.outputs.attachments));
  actions.push(...count("receipt.actions.delegated", r.actions.delegated));
  actions.push(...count("receipt.actions.blocked", r.actions.blocked, "warn"));
  if (r.childTasks.total)
    actions.push({
      label: t("receipt.actions.children"),
      value: t("receipt.actions.childCounts", {
        total: r.childTasks.total,
        done: r.childTasks.done,
        failed: r.childTasks.failed,
        running: r.childTasks.running,
      }),
      ...(r.childTasks.failed ? { tone: "warn" as const } : {}),
    });
  const cost: Row[] = [];
  // A plan model shares its id with the OpenAI API model; name the plan so the two never blur.
  const modelText = (model: { provider: string; id: string }) =>
    model.provider === CHATGPT_PLAN_PROVIDER
      ? `${t("chatgpt.title")} · ${model.id}`
      : model.provider === CHATGPT_CODEX_PROVIDER
        ? `${t("chatgpt.codex.title")} · ${model.id}`
        : model.id;
  if (r.model) cost.push({ label: t("receipt.cost.model"), value: modelText(r.model), code: true });
  if (r.childModels?.length)
    cost.push({
      label: t("receipt.cost.childModels"),
      value: r.childModels.map(modelText).join(" · "),
      code: true,
    });
  if (r.cost) {
    const c = r.cost;
    cost.push(...count("receipt.cost.requests", c.requests));
    cost.push(...count("receipt.cost.tokens", c.tokens));
    if (r.outputContinuations)
      cost.push({ label: t("receipt.cost.continuations"), value: grouped(r.outputContinuations) });
    if (c.requests)
      cost.push({
        label: t("receipt.cost.cost"),
        value:
          c.costUsd === null
            ? t(r.outcome === "stopped" ? "receipt.cost.partialUnknown" : "receipt.cost.unknown", {
                count: c.unknownCostRequests,
              })
            : c.unknownCostRequests
              ? t("receipt.cost.partial", {
                  cost: formatUsd(c.costUsd),
                  count: c.unknownCostRequests,
                })
              : formatUsd(c.costUsd),
      });
    if (c.activeMs)
      cost.push({ label: t("receipt.cost.active"), value: formatReceiptDuration(c.activeMs, t) });
    if (c.exhaustedReason)
      cost.push({
        label: t("receipt.cost.exhausted"),
        value: c.exhaustedReason,
        tone: "warn",
      });
    if (c.shared) cost.push({ label: "", value: t("receipt.cost.shared") });
  }
  const unverified: Row[] = r.unverified.items.map((item) => ({
    label: t(item.source === "user" ? "receipt.unverified.user" : "receipt.unverified.agent"),
    value: item.label,
    tone: "warn",
  }));
  const hidden = r.unverified.total - r.unverified.items.length;
  if (hidden > 0)
    unverified.push({ label: "", value: t("receipt.unverified.more", { count: hidden }) });
  if (r.unverified.failedCheck)
    unverified.push({
      label: t(`receipt.unverified.${r.unverified.failedCheck}`),
      value: "",
      tone: "danger",
    });
  if (r.unverified.openTodos)
    unverified.push({
      label: t("receipt.unverified.todos"),
      value: t("receipt.unverified.todoCounts", {
        open: r.unverified.openTodos,
        total: r.unverified.todoTotal,
      }),
      tone: "warn",
    });
  const evidence = r.evidence.commands + r.evidence.screenshots + r.evidence.reviews;
  if (evidence)
    unverified.push({
      label: t("receipt.unverified.evidence"),
      value: t("receipt.unverified.evidenceCounts", r.evidence),
    });
  const uncertain: Row[] =
    r.uncertain?.items.map((item) => ({
      label: toolDisplayName(item.tool, t),
      value: t("receipt.uncertain.item", {
        effect: t(`receipt.uncertain.effect.${item.effectClass}`),
        time: item.createdAt,
      }),
      tone: "warn",
    })) ?? [];
  const hiddenUncertain = (r.uncertain?.total ?? 0) - uncertain.length;
  if (hiddenUncertain > 0)
    uncertain.push({
      label: "",
      value: t("receipt.uncertain.more", { count: grouped(hiddenUncertain) }),
      tone: "warn",
    });
  const sections: [ReceiptSection["id"], Row[], string][] = [
    ["outcome", outcome, ""],
    ...(r.delivery
      ? [["delivery", deliveryRows(r, t), ""] as [ReceiptSection["id"], Row[], string]]
      : []),
    ...(r.uncertain ? [["uncertain", uncertain, ""] as [ReceiptSection["id"], Row[], string]] : []),
    ["unverified", unverified, t("receipt.unverified.none")],
    ["inputs", inputs, t("receipt.inputs.none")],
    ["outputs", outputs, t("receipt.outputs.none")],
    ["approvals", approvals, t("receipt.approvals.none")],
    ["actions", actions, t("receipt.actions.none")],
    ["cost", cost, t("receipt.cost.none")],
  ];
  // Sections with nothing in them are left out (maintainers 2026-10-22: a plain reply listed six empty
  // headings); a run that only replied says so once under its outcome instead.
  const always = new Set<ReceiptSection["id"]>(["outcome", "cost"]);
  const shown = sections.filter(([id, rows]) => always.has(id) || rows.length);
  if (shown.length === sections.filter(([id]) => always.has(id)).length)
    outcome.push({ label: "", value: t("receipt.quiet") });
  return shown.map(([id, rows, empty]) => ({
    id,
    title: t(`receipt.section.${id}`),
    rows: rows.map((row, n) => ({ ...row, key: `${id}-${n}` })),
    empty,
  }));
}

/** Keep sub-cent caps visible; rounding them to cents would hide the user's actual limit. */
export function budgetAmount(value: number): string {
  return value > 0 && value < 1 ? Number(value.toPrecision(3)).toString() : value.toFixed(2);
}
