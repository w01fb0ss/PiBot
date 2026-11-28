import styles from "./approval.module.css";

/** Presentation only: the shared client formatter owns the reason-code vocabulary. */
export function ApprovalExplanation({
  summary,
  label,
  steps,
  collapsedTitle,
}: {
  summary: string;
  label: string;
  steps: string[];
  /** A pending card folds the whole explanation under this question, so the request leads. */
  collapsedTitle?: string;
}) {
  if (!summary && !steps.length) return null;
  const list = steps.length > 0 && (
    <ol>
      {steps.map((text, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Ordered immutable trace entries can repeat the same translated text.
        <li key={`${index}:${text}`}>{text}</li>
      ))}
    </ol>
  );
  if (collapsedTitle)
    return (
      <div className={styles.explanation}>
        <details>
          <summary>{collapsedTitle}</summary>
          {summary && <p>{summary}</p>}
          {list}
        </details>
      </div>
    );
  return (
    <div className={styles.explanation}>
      {summary && <p>{summary}</p>}
      {list && (
        <details>
          <summary>{label}</summary>
          {list}
        </details>
      )}
    </div>
  );
}
