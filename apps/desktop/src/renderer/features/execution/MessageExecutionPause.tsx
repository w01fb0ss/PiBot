import type { Message } from "@pibot/protocol";
import { ExecutionStallSchema, UserQuestionPauseSchema } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import styles from "./execution.module.css";
import { UserQuestionCard } from "./UserQuestionCard.tsx";

const reasons = [
  "approval",
  "blocked",
  "needs_user",
  "review",
  "checkpoint",
  "no_progress",
  "round_limit",
  "waiting_tasks",
  "check_blocked",
  "review_summary",
] as const;
export function MessageExecutionPause({ message }: { message: Message }) {
  const t = useT();
  const usage = message.usage;
  if (message.role !== "assistant" || !usage || typeof usage !== "object" || Array.isArray(usage))
    return null;
  // A reply that was plain chat closed its task quietly, so its pause is not unfinished work.
  if (usage.quietChat === true) return null;
  const pause = usage.executionPause;
  if (!pause || typeof pause !== "object" || Array.isArray(pause)) return null;
  const question = UserQuestionPauseSchema.safeParse(pause);
  if (question.success) return <UserQuestionCard message={message} pause={question.data} />;
  const reason = reasons.find((value) => value === pause.reason);
  if (!reason) return null;
  // An out-of-date pause is no longer waiting; its card already says why and what to do.
  if (reason === "approval" && pause.superseded === true) return null;
  const stall = ExecutionStallSchema.safeParse(pause.stall);
  const summary =
    reason === "checkpoint" &&
    typeof pause.groupPlanId === "string" &&
    pause.summary === "Group plan handed to the program / 群计划已交给程序"
      ? t("group.plan.handedToProgram")
      : typeof pause.summary === "string"
        ? pause.summary
        : "";
  // A pause is a band; stalls and hard stops are amber, routine hand-offs stay blue.
  const tone =
    stall.success ||
    pause.observation === "promised_without_tools" ||
    ["blocked", "no_progress", "round_limit", "check_blocked", "needs_user"].includes(reason)
      ? "warn"
      : "info";
  return (
    <p className={styles.pauseBand} data-tone={tone} role="status">
      {stall.success
        ? t("execution.pause.stalledStep", { step: stall.data.index, title: stall.data.title })
        : pause.observation === "promised_without_tools"
          ? t("execution.pause.noToolExecution")
          : reason === "approval" && typeof pause.durationMs === "number"
            ? t("execution.pause.approvalResumed", { seconds: Math.floor(pause.durationMs / 1000) })
            : t(`execution.pause.${reason}`)}
      {summary ? ` ${summary}` : ""}
    </p>
  );
}
