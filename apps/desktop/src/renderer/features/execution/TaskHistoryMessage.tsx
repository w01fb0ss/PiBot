import { toolStatusKey } from "@pibot/client-core";
import type { Message } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { RunLogButton } from "../run-log/Viewer.tsx";
import styles from "./execution.module.css";

const TIMELINE_TOOLS = 3;

/**
 * The group task panel's execution record as a timeline — time, a coloured node, the
 * request or reply in two lines, then one compact row per tool (the first three, the rest folded).
 */
function TimelineMessage({ message, botId }: { message: Message; botId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [allTools, setAllTools] = useState(false);
  const tools = message.tools ?? [];
  const shown = allTools ? tools : tools.slice(0, TIMELINE_TOOLS);
  const long = (message.content?.length ?? 0) > 120 || (message.content ?? "").includes("\n");
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const tone = message.errorCode || message.status === "aborted" ? "warn" : message.role;
  return (
    <article className={styles.timelineItem}>
      <time className={styles.timelineTime} dateTime={message.createdAt}>
        {time}
      </time>
      <span className={styles.timelineRail} data-tone={tone} aria-hidden="true" />
      <div className={styles.timelineBody}>
        <strong>
          {message.role === "user" ? t("execution.taskRequest") : t("execution.taskReply")}
        </strong>
        {message.errorCode && (
          <p className={styles.timelineWarn}>{t(`errors.${message.errorCode}`)}</p>
        )}
        {message.status === "aborted" && !message.errorCode && (
          <p className={styles.timelineWarn}>{t("errors.aborted")}</p>
        )}
        {message.content && (
          <p className={open ? styles.timelineText : styles.timelineTextClamp}>{message.content}</p>
        )}
        {long && (
          <button type="button" className={styles.timelineLink} onClick={() => setOpen(!open)}>
            {t(open ? "execution.timelineCollapse" : "execution.timelineExpand")}
          </button>
        )}
        {shown.map((tool) => (
          <div key={tool.id} className={styles.timelineTool}>
            <code>
              {tool.summary || tool.tool}
              {tool.inputTranslation && (
                <>
                  <br />
                  {t("tool.inputTranslation", { text: tool.inputTranslation })}
                </>
              )}
            </code>
            <em>
              {tool.exitCode !== null
                ? t("tool.exit", { code: tool.exitCode })
                : t(toolStatusKey(tool))}
              {tool.durationMs !== null && ` · ${(tool.durationMs / 1000).toFixed(1)}s`}
            </em>
            {tool.exitCode !== null && message.runId && (
              <RunLogButton
                details={{
                  runId: message.runId,
                  toolCallId: tool.toolCallId,
                  botId,
                  command: tool.summary,
                  exitCode: tool.exitCode,
                  durationMs: tool.durationMs,
                }}
              />
            )}
          </div>
        ))}
        {!allTools && tools.length > TIMELINE_TOOLS && (
          <button type="button" className={styles.timelineLink} onClick={() => setAllTools(true)}>
            {t("execution.timelineMoreTools", { count: tools.length - TIMELINE_TOOLS })}
          </button>
        )}
      </div>
    </article>
  );
}

/** Read-only records: replaying an approval or tool action is never offered in task history. */
export function TaskHistoryMessage({
  message,
  botId,
  timeline = false,
}: {
  message: Message;
  botId: string;
  timeline?: boolean;
}) {
  if (timeline) return <TimelineMessage message={message} botId={botId} />;
  return <ListMessage message={message} botId={botId} />;
}

function ListMessage({ message, botId }: { message: Message; botId: string }) {
  const t = useT();
  const [visibleTools, setVisibleTools] = useState(50);
  const [toolsOpen, setToolsOpen] = useState(false);
  // A message-level button cannot say which step it means once the run holds several commands;
  // those messages get one button per step instead.
  const commands = (message.tools ?? []).filter((tool) => tool.exitCode !== null);
  return (
    <article className={styles.historyMessage}>
      <span className={styles.hint}>
        {message.role === "user" ? t("execution.taskRequest") : t("execution.taskReply")}
      </span>
      {message.errorCode && <p className={styles.error}>{t(`errors.${message.errorCode}`)}</p>}
      {message.status === "aborted" && !message.errorCode && <p>{t("errors.aborted")}</p>}
      {message.content && <pre className={styles.output}>{message.content}</pre>}
      {!!message.tools?.length && (
        <button
          type="button"
          className={styles.toolToggle}
          aria-expanded={toolsOpen}
          onClick={() => setToolsOpen(!toolsOpen)}
        >
          {message.tools.length} · {t("agentWork.tools")}
        </button>
      )}
      {!!message.tools?.length && toolsOpen && (
        <ul>
          {message.tools.slice(0, visibleTools).map((tool) => (
            <li key={tool.id}>
              <strong>
                {tool.tool} · {t(toolStatusKey(tool))}
              </strong>
              <pre className={styles.output}>{tool.summary}</pre>
              {tool.inputTranslation && (
                <p>{t("tool.inputTranslation", { text: tool.inputTranslation })}</p>
              )}
              {tool.exitCode !== null && <p>{t("tool.exit", { code: tool.exitCode })}</p>}
              {commands.length > 1 && tool.exitCode !== null && message.runId && (
                <RunLogButton
                  details={{
                    runId: message.runId,
                    toolCallId: tool.toolCallId,
                    botId,
                    command: tool.summary,
                    exitCode: tool.exitCode,
                    durationMs: tool.durationMs,
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {toolsOpen && (message.tools?.length ?? 0) > visibleTools && (
        <Button variant="ghost" onClick={() => setVisibleTools((count) => count + 50)}>
          {t("execution.moreToolRecords")}
        </Button>
      )}
      {message.runId && commands.length === 1 && (
        <RunLogButton
          details={{
            runId: message.runId,
            toolCallId: commands[0]?.toolCallId,
            botId,
            command: t("execution.taskHistory"),
            exitCode: null,
            durationMs: null,
          }}
        />
      )}
    </article>
  );
}
