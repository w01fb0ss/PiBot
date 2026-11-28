import { budgetAmount } from "@pibot/client-core";
import { localizedPlanStepTitle } from "@pibot/i18n";
import {
  type GroupPlanCard as GroupPlanCardData,
  GroupPlanCardSchema,
  type GroupPlanProgress,
  type Message,
} from "@pibot/protocol";
import { visibleTaskText } from "@pibot/protocol-base";
import { BotAvatar, useRpc, useSettings, useT } from "@pibot/renderer-kit";
import { Button, Chip } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../chat/messages/Markdown.tsx";
import { RelaxationDetails } from "../../receipt/RelaxationDetails.tsx";
import type { GroupSnapshot } from "../data.ts";
import { GroupPlanProgressView } from "./GroupPlanProgress.tsx";
import styles from "./group-plan.module.css";

/** Group steps into dependency layers so the card shows what runs at the same time. */
function layers<T extends { id: string; dependsOn: string[] }>(steps: readonly T[]): T[][] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();
  const visit = (step: T, seen: Set<string>): number => {
    const known = depth.get(step.id);
    if (known !== undefined) return known;
    // A cycle is rejected by validation; stop recursing so a malformed card still renders.
    if (seen.has(step.id)) return 0;
    seen.add(step.id);
    const level = step.dependsOn.reduce((max, id) => {
      const dependency = byId.get(id);
      return dependency ? Math.max(max, visit(dependency, seen) + 1) : max;
    }, 0);
    depth.set(step.id, level);
    return level;
  };
  const levels: T[][] = [];
  for (const step of steps) {
    const level = visit(step, new Set());
    levels[level] ||= [];
    levels[level].push(step);
  }
  return levels.filter((level) => level.length > 0);
}

/** Bullets and lines joined into one plain line (Markdown list marks dropped). */
function taskLine(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .join(" · ");
}

function StepItem({
  step,
  bots,
  owners,
  titles,
  oneLine = false,
}: {
  step: GroupPlanCardData["plan"]["steps"][number];
  bots: Map<string, GroupSnapshot["bots"][number]>;
  owners: Map<string, string>;
  titles: Map<string, string>;
  /** A started plan: each member's task on one line; the full text is in that task's 说明 tab. */
  oneLine?: boolean;
}) {
  const t = useT();
  const owner = bots.get(owners.get(step.id) ?? "");
  const task = visibleTaskText(step.task);
  return (
    <li className={styles.step}>
      {/* The step's owner avatar marks the timeline. */}
      <BotAvatar
        className={styles.owner}
        bot={owner}
        unknown={!owner}
        label={owner?.name ?? t("group.member")}
        size={22}
      />
      <b>{titles.get(step.id) ?? t("group.plan.step.untitled")}</b> ·{" "}
      {owner?.name ?? t("group.member")}
      {oneLine ? (
        <p className={styles.stepTaskLine} title={task}>
          {taskLine(task)}
        </p>
      ) : (
        <div className={styles.stepTask}>
          <Markdown text={task} />
        </div>
      )}
      {!!step.dependsOn.length && (
        <p>
          {t("group.plan.depends", {
            steps: step.dependsOn
              .map((id) => titles.get(id) ?? t("group.plan.step.untitled"))
              .join(" · "),
          })}
        </p>
      )}
      <p>
        {t("group.plan.outputs", {
          files: step.deliverables.map((item) => item.path).join(" · "),
        })}
      </p>
      <ul>
        {step.acceptance.map((item) => (
          <li key={item.id}>
            {t(`group.plan.check.${item.check}`)}
            {item.text ? ` · ${item.text}` : ""}
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * A started card's badge reads the live plan, not the card's stored 「已登记执行」: a finished plan
 * in the Tasks panel says it finished, a stopped one that it stopped.
 */
function RunChip({ run }: { run: Pick<GroupPlanProgress, "status" | "choice"> }) {
  const t = useT();
  const live = run.status === "running" || run.status === "waiting";
  if (live && run.choice) return <Chip tone="warn">{t("group.plan.choice.title")}</Chip>;
  if (live) return <Chip tone="teal">{t("group.plan.run.running")}</Chip>;
  if (run.status === "passed") return <Chip tone="ok">{t("group.plan.run.passed")}</Chip>;
  return (
    <Chip tone="neutral">
      {t(run.status === "cancelled" ? "group.plan.run.cancelled" : "group.plan.run.stopped")}
    </Chip>
  );
}

/** Persisted program facts, not a plan parsed from the assistant's prose. */
export function GroupPlanCard({
  message,
  bots,
  sendChanges,
  fillComposer,
  embedded = false,
}: {
  message: Pick<Message, "id"> & { usage?: unknown };
  bots: GroupSnapshot["bots"];
  /** Inside another card (the inbox): no frame or tinted surface of its own. */
  embedded?: boolean;
  /** GroupSession owns send cancellation; the card only guards its local form updates. */
  sendChanges?(text: string): Promise<boolean>;
  /** Puts text in the group's input for the user to edit (「新开计划」 fills the old goal). */
  fillComposer?(text: string): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const { language } = useSettings();
  const active = useRef<AbortController | undefined>(undefined);
  const [run, setRun] = useState<Pick<GroupPlanProgress, "status" | "choice">>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [note, setNote] = useState("");
  const [modifying, setModifying] = useState(false);
  const usage = message.usage;
  const parsed = GroupPlanCardSchema.safeParse(
    usage && typeof usage === "object" && !Array.isArray(usage) && "groupPlan" in usage
      ? usage.groupPlan
      : undefined,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different message owns independent requests and form state.
  useEffect(() => {
    setBusy(false);
    setError(false);
    setModifying(false);
    setNote("");
    setRun(undefined);
    return () => {
      active.current?.abort();
      active.current = undefined;
    };
  }, [message.id]);
  if (!parsed.success) return null;
  const card = parsed.data;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const owners = new Map(card.owners.map((owner) => [owner.stepId, owner.botId]));
  const titles = new Map(
    card.plan.steps.map((step) => [step.id, localizedPlanStepTitle(step.title, language)]),
  );
  const resolve = async (decision: "start" | "start_relaxed" | "modify" | "check") => {
    if (!peer || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(false);
    try {
      await peer.call(
        "groups.plan.resolve",
        {
          groupId: card.groupId,
          messageId: message.id,
          decision,
        },
        { signal: controller.signal, timeoutMs: 35_000 },
      );
      if (controller.signal.aborted) return;
      if (decision === "modify") setModifying(true);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  };
  return (
    <section
      className={embedded ? `${styles.card} ${styles.embedded}` : styles.card}
      aria-label={t("group.plan.title")}
    >
      <div className={styles.head}>
        <b>
          {t("group.plan.title")} · {card.plan.name}
        </b>
        {card.status === "started" && run ? (
          <RunChip run={run} />
        ) : (
          <Chip
            tone={
              card.status === "started" ? "teal" : card.status === "pending" ? "warn" : "neutral"
            }
          >
            {t(`group.plan.status.${card.status}`)}
          </Chip>
        )}
      </div>
      {card.startFailure && (
        <div className={styles.warning} role="alert">
          <p>
            {t(
              card.startFailure.input
                ? "group.plan.startFailure.inputs"
                : card.startFailure.code === "group_plan_start_cancelled"
                  ? "group.plan.startFailure.cancelled"
                  : card.startFailure.code === "group_plan_method_unavailable"
                    ? "group.plan.startFailure.method"
                    : "group.plan.startFailure.conditions",
            )}
          </p>
          {card.startFailure.input && (
            <p>
              {t("group.plan.inputFailure", {
                name: card.startFailure.input.name,
                expected: card.startFailure.input.expected,
                found: card.startFailure.input.found.join(" · ") || t("group.plan.noInputs"),
              })}
            </p>
          )}
        </div>
      )}
      <p>{t("group.plan.estimate", { cost: budgetAmount(card.plan.estimatedCostUsd) })}</p>
      {!!card.droppedDependencies && (
        <p>{t("group.plan.droppedDeps", { count: String(card.droppedDependencies) })}</p>
      )}
      {!!card.delivery?.rewrites.length && <p>{t("group.plan.pathsRelative")}</p>}
      {card.disposition && (
        <p>{t("group.plan.dispositionReason", { reason: card.disposition.reason })}</p>
      )}
      {!!card.relaxations?.length && (
        <div className={styles.warning} role="note">
          <strong>{t("group.plan.relaxedWarning")}</strong>
          <RelaxationDetails items={card.relaxations} />
        </div>
      )}
      <ol className={styles.steps}>
        {layers(card.plan.steps).map((layer) => {
          const [first] = layer;
          if (!first) return null;
          return layer.length > 1 ? (
            // The engine dispatches a whole ready layer at once; say so on the card so a
            // serial-looking plan still reads as parallel work.
            <li key={first.id}>
              <b>
                {t("group.plan.parallel", {
                  steps: layer
                    .map((step) => titles.get(step.id) ?? t("group.plan.step.untitled"))
                    .join(" · "),
                })}
              </b>
              {layer.map((step) => (
                <StepItem
                  key={step.id}
                  step={step}
                  bots={byId}
                  owners={owners}
                  titles={titles}
                  oneLine={card.status === "started"}
                />
              ))}
            </li>
          ) : (
            <StepItem
              key={first.id}
              step={first}
              bots={byId}
              owners={owners}
              titles={titles}
              oneLine={card.status === "started"}
            />
          );
        })}
      </ol>
      {card.status === "started" && (
        <GroupPlanProgressView
          card={card}
          titles={titles}
          bots={byId}
          fillComposer={fillComposer}
          onProgress={(value) =>
            setRun((old) =>
              old?.status === value.status && old.choice?.kind === value.choice?.kind
                ? old
                : { status: value.status, choice: value.choice },
            )
          }
        />
      )}
      {(card.status === "pending" || card.status === "ready" || card.status === "starting") && (
        <div className={styles.actions}>
          <Button
            title={!sendChanges ? t("group.plan.modifyInChatHint") : undefined}
            disabled={busy || !peer || !sendChanges || card.status === "starting"}
            onClick={() => void resolve("modify")}
          >
            {t("group.plan.modify")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!peer}
            onClick={() =>
              void resolve(
                card.status === "starting"
                  ? "check"
                  : card.relaxations?.length
                    ? "start_relaxed"
                    : "start",
              )
            }
          >
            {t(
              card.status === "starting"
                ? "group.plan.checkStart"
                : card.relaxations?.length
                  ? "group.plan.startRelaxed"
                  : "group.plan.start",
            )}
          </Button>
        </div>
      )}
      {!sendChanges && ["pending", "ready", "modify"].includes(card.status) && (
        <p className={styles.note}>{t("group.plan.modifyInChatHint")}</p>
      )}
      {(modifying || card.status === "modify") && (
        <div className={styles.modify}>
          <p>{t("group.plan.modifyHint")}</p>
          <textarea
            value={note}
            maxLength={2000}
            aria-label={t("group.plan.modify")}
            disabled={busy}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
          <Button
            disabled={busy || !peer || !sendChanges || !note.trim()}
            onClick={async () => {
              if (!peer || !sendChanges || active.current) return;
              const controller = new AbortController();
              active.current = controller;
              setBusy(true);
              setError(false);
              try {
                const sent = await sendChanges(note.trim());
                if (!controller.signal.aborted) {
                  if (sent) setNote("");
                  else setError(true);
                }
              } catch {
                if (!controller.signal.aborted) setError(true);
              } finally {
                if (active.current === controller) {
                  active.current = undefined;
                  if (!controller.signal.aborted) setBusy(false);
                }
              }
            }}
          >
            {t("group.plan.sendChanges")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t("group.plan.failed")}
        </p>
      )}
    </section>
  );
}
