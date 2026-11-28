import type { ChatPeer } from "@pibot/client-core";
import type { GroupTask } from "@pibot/protocol";
import { BotAvatar, botAvatarLook, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { CollectionActions } from "../../execution/CollectionActions.tsx";
import { RunApprovals } from "../../execution/RunApprovals.tsx";
import { TaskDetails } from "../../execution/TaskDetails.tsx";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";
import { type GroupTaskNode, groupTaskNodeActive, groupTaskTree } from "./group-task-tree.ts";
import { HandoffState } from "./TaskHandoff.tsx";
import { TaskRecovery } from "./TaskRecovery.tsx";
import { TaskStatus } from "./TaskStatus.tsx";
import { useGroupExecutionTasks } from "./use-group-execution-tasks.ts";
import { useTaskList } from "./use-task-list.ts";
import type { useTaskSummary } from "./use-task-summary.ts";

export function UnifiedGroupTasks({
  peer,
  data,
  taskSummary,
  open,
}: {
  peer: ChatPeer;
  data: GroupSnapshot;
  taskSummary: ReturnType<typeof useTaskSummary>;
  open(task: GroupTask): void;
}) {
  const t = useT(),
    [closed, setClosed] = useState(false),
    [selected, setSelected] = useState<string>(),
    [revision, refresh] = useState(0);
  const group = data.group;
  const list = useTaskList(peer, group?.id ?? "", "all", closed, taskSummary.revision + revision);
  const execution = useGroupExecutionTasks(peer, group, taskSummary.revision + revision);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = peer.on("execution.task.changed", () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh((v) => v + 1), 250);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [peer]);
  const nodes = groupTaskTree(
    [...list.open, ...list.closed],
    execution.page?.items ?? [],
    group?.coordinatorBotId ?? "",
  );
  const bots = new Map(data.bots.map((bot) => [bot.id, bot]));
  const render = (node: GroupTaskNode, ancestors: Set<string>): ReactNode => {
    if (ancestors.has(node.id) || ancestors.size > 8) return null;
    const next = new Set(ancestors);
    next.add(node.id);
    const task = node.assignment,
      child = node.execution,
      bot = bots.get(task?.assigneeBotId ?? child?.botId ?? "");
    const expanded = selected === node.id;
    return (
      <li key={node.id} className={styles.executionTaskNode}>
        <div
          className={styles.taskRow}
          // Each task card carries a left bar in its assignee's colour.
          style={{ "--bar": `var(--avatar-${botAvatarLook(bot, !bot).color})` } as CSSProperties}
        >
          <button
            type="button"
            className={styles.task}
            onClick={() => (task ? open(task) : setSelected(expanded ? undefined : node.id))}
            aria-expanded={child ? expanded : undefined}
          >
            <BotAvatar bot={bot} unknown label={bot?.name ?? t("group.member")} size={22} />
            <span className={styles.taskText}>
              <b title={task?.title ?? child?.title}>{task?.title ?? child?.title}</b>
              <strong>{bot?.name ?? t("group.member")}</strong>
              {task?.modelOverride && (
                <span>{t("chat.taskModel.current", { model: task.modelOverride.id })}</span>
              )}
            </span>
            {task ? (
              <>
                {task.handoff &&
                  task.handoff.state !== "pending" &&
                  task.handoff.state !== "unmet" && <HandoffState task={task} />}
                <TaskStatus task={task} data={data} />
              </>
            ) : (
              child && (
                <span
                  className={styles.taskStatus}
                  data-status={child.status === "interrupted" ? "error" : child.status}
                >
                  {t(`execution.task.${child.status}`)}
                </span>
              )
            )}
            <Icon name="chevronRight" size={14} />
          </button>
          {child && (
            <CollectionActions
              target={{
                botId: child.botId,
                conversationId: child.conversationId,
                kind: "task",
                id: child.id,
                expectedVersion: child.version,
              }}
              disabled={["queued", "running", "stopping"].includes(child.status)}
            />
          )}
        </div>
        {task && (
          <TaskRecovery
            peer={peer}
            task={task}
            bot={bot}
            refresh={async () => {
              taskSummary.retry();
              refresh((v) => v + 1);
            }}
          />
        )}
        {task?.status === "open" && (
          <RunApprovals
            botId={task.assigneeBotId}
            conversationId={task.threadConversationId}
            context={{ botName: bot?.name ?? t("group.member"), groupName: group?.name ?? "" }}
          />
        )}
        {expanded && child && <TaskDetails key={child.id} task={child} />}
        {!!node.children.length && (
          <ul className={styles.executionTaskTree}>
            {node.children
              .filter((child) => closed || groupTaskNodeActive(child))
              .map((n) => render(n, next))}
          </ul>
        )}
      </li>
    );
  };
  const active = nodes.filter(groupTaskNodeActive),
    done = nodes.filter((node) => !groupTaskNodeActive(node)),
    main = active.filter((node) => node.main),
    children = active.filter((node) => !node.main),
    nestedChildren = main.some((node) => node.children.some(groupTaskNodeActive)),
    doneMain = done.filter((node) => node.main),
    doneChildren = done.filter((node) => !node.main);
  return (
    <section aria-busy={list.busy || execution.busy}>
      {(list.error || execution.error) && (
        <p role="alert" className={styles.error}>
          {t("execution.loadError")}{" "}
          <Button
            variant="ghost"
            onClick={() => {
              taskSummary.retry();
              refresh((v) => v + 1);
            }}
          >
            {t("common.retry")}
          </Button>
        </p>
      )}
      {list.busy && !nodes.length && <p role="status">{t("common.loading")}</p>}
      <h3 data-tone="teal">{t("group.mainTasks")}</h3>
      {!list.busy && !main.length && <p className={styles.note}>{t("group.noOpenMainTasks")}</p>}
      <ul className={styles.executionTaskTree}>{main.map((node) => render(node, new Set()))}</ul>
      {(!nestedChildren || !!children.length) && (
        <>
          <h3 data-tone="blue">{t("execution.children")}</h3>
          {!list.busy && !children.length && (
            <p className={styles.note}>{t("group.noOpenSubtasks")}</p>
          )}
          <ul className={styles.executionTaskTree}>
            {children.map((node) => render(node, new Set()))}
          </ul>
        </>
      )}
      <button
        type="button"
        className={styles.closedTasks}
        aria-expanded={closed}
        onClick={() => setClosed((v) => !v)}
      >
        <Icon name={closed ? "chevron" : "chevronRight"} size={14} />
        {t("group.completedTasks")}
      </button>
      {closed && (
        <>
          {!!doneMain.length && <h3>{t("group.mainTasks")}</h3>}
          <ul className={styles.executionTaskTree}>
            {doneMain.map((node) => render(node, new Set()))}
          </ul>
          {!!doneChildren.length && <h3>{t("execution.children")}</h3>}
          <ul className={styles.executionTaskTree}>
            {doneChildren.map((node) => render(node, new Set()))}
          </ul>
        </>
      )}
      {(list.open.length < (taskSummary.summary?.openCount ?? 0) ||
        execution.hasMore ||
        (closed && list.closed.length < (taskSummary.summary?.closedCount ?? 0))) && (
        <Button
          variant="ghost"
          disabled={list.busy || execution.busy}
          onClick={() => {
            list.more("open");
            if (closed) list.more("closed");
            execution.more();
          }}
        >
          {t("execution.older")}
        </Button>
      )}
    </section>
  );
}
