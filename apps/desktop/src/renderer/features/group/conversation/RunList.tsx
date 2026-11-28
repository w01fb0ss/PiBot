import type { ChatPeer } from "@pibot/client-core";
import type { Message } from "@pibot/protocol";
import { BotAvatar, botAvatarLook, useT, waitRpc } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { GroupSnapshot, PublicRun } from "../data.ts";
import styles from "../group.module.css";
import { groupTaskIsChild } from "../tasks/group-task-tree.ts";
import { TaskRecovery } from "../tasks/TaskRecovery.tsx";
import { TaskStatus } from "../tasks/TaskStatus.tsx";

export function GroupRunStop({
  peer,
  run,
  name,
  bot,
  refresh,
  task,
  showLabel = true,
  siblings = [],
}: {
  peer: ChatPeer;
  run: PublicRun;
  name: string;
  /** G-main: the replying pill takes this member's colour. */
  bot?: GroupSnapshot["bots"][number];
  refresh(): Promise<void>;
  task: boolean;
  showLabel?: boolean;
  /** Other runs of the same task (a queued wake): stopping the card must not let them restart it. */
  siblings?: PublicRun[];
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const lifetime = useRef(new AbortController());
  const locked = useRef(false);
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  const stop = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(12_000)]);
    try {
      await Promise.all(
        [run, ...siblings].map((target) =>
          waitRpc(() => peer.call("chat.abort", { runId: target.id }, { signal }), signal),
        ),
      );
    } catch {
      if (!lifetime.current.signal.aborted) setError(true);
    } finally {
      if (!lifetime.current.signal.aborted) {
        setBusy(false);
        await refresh();
      }
      locked.current = false;
    }
  };
  const color = bot ? botAvatarLook(bot).color : undefined;
  return (
    <div
      className={styles.run}
      style={
        color
          ? ({
              "--chat-c": `var(--avatar-${color})`,
              "--chat-ink": `var(--ink-${color})`,
            } as CSSProperties)
          : undefined
      }
    >
      {showLabel && (
        <span>
          {t(
            run.status === "queued"
              ? "group.runQueued"
              : task
                ? "group.runTask"
                : "group.runRunning",
            { name },
          )}
        </span>
      )}
      <Button variant="ghost" className={styles.stopRun} loading={busy} onClick={() => void stop()}>
        <Icon name="stop" size={12} />
        {t("group.stopRun", { name })}
      </Button>
      {error && (
        <span role="alert" className={styles.error}>
          {t("group.stopFailed")}
        </span>
      )}
    </div>
  );
}
export function GroupRuns({
  peer,
  data,
  conversationId,
  refresh,
  messages,
  openTask,
  openApproval,
  pendingByRun,
}: {
  peer: ChatPeer;
  data: GroupSnapshot;
  conversationId: string;
  refresh(): Promise<void>;
  messages: Message[];
  openTask?(threadId: string): void;
  openApproval(id: string): void;
  pendingByRun: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const visible = new Set(messages.map((message) => message.runId));
  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  const active = data.runs.filter(
    (r) =>
      (r.conversationId === conversationId || conversationId === data.group?.conversationId) &&
      (r.status === "queued" || r.status === "running") &&
      !visible.has(r.id),
  );
  // A task can have a running turn and a queued wake at once; the user sees one task, one card.
  const primary = new Map<string, PublicRun>();
  const siblings = new Map<string, PublicRun[]>();
  for (const run of active) {
    if (!run.taskId) continue;
    const current = primary.get(run.taskId);
    if (!current || (current.status !== "running" && run.status === "running"))
      primary.set(run.taskId, run);
  }
  for (const run of active)
    if (run.taskId && primary.get(run.taskId) !== run)
      siblings.set(run.taskId, [...(siblings.get(run.taskId) ?? []), run]);
  return (
    <div className={styles.runs}>
      {active
        .filter((r) => !r.taskId || primary.get(r.taskId) === r)
        .map((run) =>
          run.taskId && run.conversationId !== data.group?.conversationId ? (
            <div key={run.id} className={styles.taskRun}>
              <button
                type="button"
                className={styles.task}
                onClick={() => {
                  const approval = pendingByRun.get(run.id);
                  if (approval) openApproval(approval);
                  else
                    openTask?.(
                      tasks.get(run.taskId as string)?.threadConversationId ?? run.conversationId,
                    );
                }}
              >
                <span className={styles.taskText}>
                  <b>{tasks.get(run.taskId as string)?.title ?? t("group.taskViewDetails")}</b>
                  <strong>
                    {data.bots.find((bot) => bot.id === run.botId)?.name ?? t("group.member")}
                  </strong>
                </span>
                {pendingByRun.has(run.id) ? (
                  <span className={styles.taskStatus} data-status="waiting">
                    {t("group.taskWaitingUser")}
                  </span>
                ) : tasks.has(run.taskId as string) ? (
                  <TaskStatus
                    task={
                      tasks.get(run.taskId as string) as NonNullable<ReturnType<typeof tasks.get>>
                    }
                    data={data}
                  />
                ) : (
                  <span className={styles.taskStatus}>
                    {t(
                      run.status === "queued"
                        ? "group.taskState.waiting"
                        : "group.taskState.running",
                    )}
                  </span>
                )}
                <Icon name="chevronRight" size={12} />
              </button>
              <GroupRunStop
                peer={peer}
                run={run}
                name={data.bots.find((bot) => bot.id === run.botId)?.name ?? t("group.member")}
                bot={data.bots.find((bot) => bot.id === run.botId)}
                refresh={refresh}
                task
                showLabel={false}
                siblings={siblings.get(run.taskId as string)}
              />
            </div>
          ) : (
            <div key={run.id} className={styles.workingMessage}>
              <BotAvatar
                bot={data.bots.find((bot) => bot.id === run.botId)}
                unknown
                state={run.status === "running" ? "working" : "idle"}
                label={data.bots.find((bot) => bot.id === run.botId)?.name ?? t("group.member")}
                size={28}
              />
              <div>
                <GroupRunStop
                  peer={peer}
                  run={run}
                  task={run.conversationId !== data.group?.conversationId}
                  name={data.bots.find((b) => b.id === run.botId)?.name ?? t("group.member")}
                  bot={data.bots.find((b) => b.id === run.botId)}
                  refresh={refresh}
                />
                {openTask && run.conversationId !== data.group?.conversationId && (
                  <Button variant="ghost" onClick={() => openTask(run.conversationId)}>
                    {t("group.taskViewDetails")}
                  </Button>
                )}
              </div>
            </div>
          ),
        )}
      {conversationId === data.group?.conversationId &&
        data.tasks
          .filter((task) => groupTaskIsChild(task, data.group?.coordinatorBotId ?? ""))
          .map((task) => (
            <TaskRecovery
              key={task.id}
              peer={peer}
              task={task}
              bot={data.bots.find((bot) => bot.id === task.assigneeBotId)}
              refresh={refresh}
              cancellable
            />
          ))}
      {(data.runsLoading || data.partialRuns) && (
        <p role="status" className={styles.note}>
          {t(data.runsLoading ? "group.loadingRuns" : "group.partialRuns")}
        </p>
      )}
    </div>
  );
}
