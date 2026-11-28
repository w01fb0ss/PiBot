import { type ReadMessagesSearchItem, ReadMessagesSearchResultSchema } from "@pibot/protocol";
import {
  approvalStyles as styles,
  useAction,
  useNavigation,
  useRpc,
  useSettings,
} from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useRef } from "react";
import { importedTopicLabel } from "../topics/use-topic-title.ts";

function readSearchOutput(output: string) {
  try {
    const result = ReadMessagesSearchResultSchema.safeParse(JSON.parse(output));
    return result.success ? result.data : undefined;
  } catch {
    // The generic activity stream also carries errors and non-search output.
    return undefined;
  }
}

export function ReadMessagesSearchStep({ output }: { output: string }) {
  const { t, language } = useSettings();
  const { navigate, view } = useNavigation();
  const currentView = useRef(view);
  currentView.current = view;
  const { peer } = useRpc();
  const action = useAction();
  const result = readSearchOutput(output);
  if (!result) return null;

  const open = (item: ReadMessagesSearchItem) => {
    if (!peer) return;
    const sourceView = currentView.current;
    const route =
      item.source.kind === "dm"
        ? { botId: item.source.botId, topicId: item.conversationId }
        : { groupId: item.source.groupId, topicId: item.conversationId };
    void action
      .run(async (signal) => {
        // Resolve the exact topic through the existing authenticated history route. Never open a
        // model-supplied URL or fall back to whichever topic happens to be active.
        const rows = await peer.call("chat.history", { ...route, limit: 1 }, { signal });
        signal.throwIfAborted();
        if (!rows.some((row) => row.conversationId === item.conversationId))
          throw new Error("Conversation unavailable");
        return route;
      })
      .then((target) => {
        if (target && currentView.current === sourceView)
          navigate({ name: "chat", ...target, focus: { messageId: item.source.messageId } });
      });
  };
  const date = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div>
      <small className={styles.note}>{t("tool.searchHistoryReference")}</small>
      {result.backfillPending && (
        <small className={styles.note}>{t("tool.searchHistoryPending")}</small>
      )}
      {result.items.length ? (
        <ul className={styles.output}>
          {result.items.map((item) => (
            <li key={item.source.messageId}>
              <Button variant="ghost" disabled={!peer || action.busy} onClick={() => open(item)}>
                {item.title || t("tool.searchHistoryOpen")}
              </Button>{" "}
              {item.importedFrom && (
                <span>{importedTopicLabel(t, item.importedFrom.source)} · </span>
              )}
              <time dateTime={item.createdAt}>{date.format(new Date(item.createdAt))}</time>
              <p>{item.snippet}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("tool.searchHistoryEmpty")}</p>
      )}
      {action.error && <p role="alert">{t(action.error)}</p>}
    </div>
  );
}
