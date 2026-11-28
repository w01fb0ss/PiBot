import type { ChatPeer } from "@pibot/client-core";
import { type Group, type GroupTopic, RpcError } from "@pibot/protocol";
import { actionError, useAction, useNavigation, useT, useWorkspace } from "@pibot/renderer-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTimelineDay } from "../../chat/messages/MessageTime.tsx";
import { topicArchiveError } from "../../chat/topics/use-topic-archive.ts";
import { TopicListView } from "../../workspace/topics/TopicListView.tsx";
import {
  isTransientRevealError,
  TOPIC_READ_TIMEOUT_MS,
  TopicScopeMismatchError,
  useTopicPage,
} from "../../workspace/topics/use-topic-page.ts";

function logRevealFailure(groupId: string, error: unknown) {
  console.warn(
    JSON.stringify({
      module: "group-topics",
      event: "topic_reveal_failed",
      groupId,
      ...(error instanceof RpcError ? { code: error.code } : {}),
    }),
  );
}

export function GroupTopicList({
  peer,
  group,
  conversationId,
  selected,
  changed,
  draft,
}: {
  peer: ChatPeer;
  group: Group;
  conversationId?: string;
  selected?: GroupTopic;
  changed(): void;
  draft?: boolean;
}) {
  const t = useT(),
    workspace = useWorkspace(),
    { view } = useNavigation(),
    latest = useRef(view);
  latest.current = view;
  useTimelineDay();
  const task = useAction(),
    restoring = useAction(),
    [archived, setArchived] = useState(false),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(true),
    [unavailable, setUnavailable] = useState(false),
    [revision, setRevision] = useState(0),
    [editing, setEditing] = useState<string>(),
    [title, setTitle] = useState("");
  const scope = useMemo(
    () => ({ peer, groupId: group.id, query, archived }),
    [peer, group.id, query, archived],
  );
  const { page, read, update, refresh, append, reveal, isAppending } =
    useTopicPage<GroupTopic>(scope);
  const { topics, more } = page;
  const revealCancelRef = useRef<AbortController | null>(null),
    renameLock = useRef(false),
    lifetime = useRef(new AbortController());
  const revalidate = useRef({ requested: 0, completed: 0 });
  const targetId = draft ? undefined : (conversationId ?? selected?.id ?? group.conversationId);
  const targetArchived =
    targetId === selected?.id
      ? !!selected?.archivedAt
      : targetId === group.conversationId
        ? !!group.topicArchivedAt
        : undefined;
  useEffect(() => {
    const signal = new AbortController();
    lifetime.current = signal;
    return () => signal.abort();
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((v) => v + 1), 250);
    };
    const off = [
      peer.on("groups.changed", (event) => {
        if (event.groupId === group.id) refresh();
      }),
      peer.on("sidebar.topicsChanged", (event) => {
        if (event.conversationKey === `group:${group.id}`) {
          revalidate.current.requested++;
          refresh();
        }
      }),
      peer.on("chat.status", (event) => {
        if (event.groupId === group.id) refresh();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const stop of off) stop();
    };
  }, [peer, group.id]);
  const fetchPage = useCallback(
    async (before: string | undefined, limit: number, signal: AbortSignal) => {
      const { peer, groupId, query, archived } = scope;
      const rows = await peer.call(
        "groups.topics.list",
        { groupId, before, limit, query, archived },
        { signal, timeoutMs: TOPIC_READ_TIMEOUT_MS },
      );
      if (
        !rows.every(
          (topic) =>
            topic.groupId === groupId && topic.kind === "group" && !!topic.archivedAt === archived,
        )
      ) {
        console.warn(
          JSON.stringify({ module: "group-topics", event: "topic_scope_mismatch", groupId }),
        );
        throw new TopicScopeMismatchError();
      }
      return rows;
    },
    [scope],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: accepted topic creation/selection invalidates current marker
  useEffect(() => {
    const cancel = new AbortController();
    setUnavailable(false);
    setLoading(read().topics.length === 0);
    const matchesCurrent = (topic: GroupTopic) => topic.id === targetId;
    const timer = setTimeout(
      () => {
        const loadInitial = async () => {
          const requested = revalidate.current.requested;
          await refresh(
            fetchPage,
            AbortSignal.any([cancel.signal, AbortSignal.timeout(TOPIC_READ_TIMEOUT_MS)]),
            requested !== revalidate.current.completed,
          );
          if (cancel.signal.aborted) return;
          revalidate.current.completed = requested;
          setLoading(false);
          if (query || !targetId || (targetArchived !== undefined && targetArchived !== archived))
            return;
          const start = read();
          if (!start.more || start.topics.some(matchesCurrent) || isAppending()) return;

          const revealCancel = new AbortController();
          revealCancelRef.current = revealCancel;
          const revealSignal = AbortSignal.any([
            cancel.signal,
            revealCancel.signal,
            AbortSignal.timeout(TOPIC_READ_TIMEOUT_MS),
          ]);
          try {
            await reveal(fetchPage, matchesCurrent, revealSignal);
          } catch (revealError) {
            if (revealError instanceof TopicScopeMismatchError) throw revealError;
            if (
              cancel.signal.aborted ||
              revealCancel.signal.aborted ||
              isTransientRevealError(revealError, revealSignal)
            ) {
              // First page (or preserved refresh list) is already displayed; ignore cancellation
              // and expected transient transport failures.
              return;
            }
            if (!cancel.signal.aborted) logRevealFailure(group.id, revealError);
            throw revealError;
          }
        };
        void loadInitial()
          .catch(() => {
            if (!cancel.signal.aborted) setUnavailable(true);
          })
          .finally(() => {
            if (!cancel.signal.aborted) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      cancel.abort();
      revealCancelRef.current?.abort();
      revealCancelRef.current = null;
    };
  }, [
    peer,
    group.id,
    group.conversationId,
    targetId,
    targetArchived,
    draft,
    query,
    archived,
    revision,
    fetchPage,
    refresh,
    reveal,
    read,
    update,
    isAppending,
  ]);
  const select = async (topic: GroupTopic) => {
    const original = latest.current;
    const result = await task.run(
      (signal) =>
        peer.call(
          "groups.topics.switch",
          { groupId: group.id, topicId: topic.id },
          { signal, timeoutMs: 30000 },
        ),
      topicArchiveError,
    );
    if (result && latest.current === original && !lifetime.current.signal.aborted) {
      changed();
      void workspace.refresh();
    }
  };
  const restore = async (topicId: string) => {
    const original = latest.current;
    const result = await restoring.run(async (signal) => {
      const topic = await peer.call(
        "groups.topics.restore",
        { groupId: group.id, topicId },
        { signal, timeoutMs: 30000 },
      );
      if (topic.groupId !== group.id || topic.id !== topicId || topic.archivedAt)
        throw new Error("Restored topic mismatch");
      revalidate.current.requested++;
      setRevision((value) => value + 1);
      if (latest.current !== original || signal.aborted) return undefined;
      return peer.call(
        "groups.topics.switch",
        { groupId: group.id, topicId },
        { signal, timeoutMs: 30000 },
      );
    }, topicArchiveError);
    if (result && latest.current === original && !lifetime.current.signal.aborted) {
      changed();
      void workspace.refresh();
    }
  };
  const rename = async (topicId: string) => {
    if (renameLock.current) return;
    if (!title.trim()) {
      task.setError("workspace.invalid");
      return;
    }
    const topic = topics.find((value) => value.id === topicId);
    if (!topic || title.trim() === topic.title) {
      setEditing(undefined);
      return;
    }
    renameLock.current = true;
    const result = await task.run((signal) =>
      peer.call(
        "groups.topics.rename",
        { groupId: group.id, topicId, title: title.trim() },
        { signal, timeoutMs: 30000 },
      ),
    );
    renameLock.current = false;
    if (result && result.id === topicId) {
      update((current) => ({
        ...current,
        topics: current.topics.map((topic) =>
          topic.id === topicId ? { ...topic, title: result.title } : topic,
        ),
      }));
      if (query) revalidate.current.requested++;
      setEditing(undefined);
      setRevision((value) => value + 1);
    }
  };
  const statuses = new Map<string, "queued" | "running">();
  for (const status of Object.values(workspace.statuses))
    if (
      status.groupId === group.id &&
      status.state !== "idle" &&
      statuses.get(status.conversationId) !== "running"
    )
      statuses.set(status.conversationId, status.state);
  const waiting = new Set(
    workspace.inbox.flatMap((item) =>
      (item.kind === "approval" || item.kind === "routine_approval") &&
      item.approval.status === "pending"
        ? [item.conversationId]
        : [],
    ),
  );
  return (
    <TopicListView
      topics={topics}
      currentId={targetId}
      archived={archived}
      setArchived={setArchived}
      query={query}
      setQuery={setQuery}
      loading={loading}
      error={task.error ?? restoring.error ?? (unavailable ? "workspace.unavailable" : undefined)}
      retry={() => setRevision((value) => value + 1)}
      editing={editing}
      title={title}
      setTitle={setTitle}
      rename={(id) => void rename(id)}
      startRename={(topic) => {
        setTitle(topic.title ?? "");
        setEditing(topic.id);
      }}
      cancelRename={() => setEditing(undefined)}
      busy={task.busy}
      restoring={restoring.busy}
      available
      folderName={(topic) =>
        topic.folders.find((folder) => folder.id === topic.primaryFolderId)?.name ??
        t("folders.groupHome")
      }
      status={(topic) => (waiting.has(topic.id) ? "waiting" : statuses.get(topic.id))}
      open={(topic) => void select(topic)}
      restore={(id) => void restore(id)}
      more={more}
      loadMore={() => {
        revealCancelRef.current?.abort();
        revealCancelRef.current = null;
        void task.run(
          (signal) => append(fetchPage, signal),
          (error) =>
            error instanceof TopicScopeMismatchError ? "workspace.unavailable" : actionError(error),
        );
      }}
    />
  );
}
