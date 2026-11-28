import { type MethodResults, RpcError, RpcErrorCodes } from "@pibot/protocol";
import {
  actionError,
  useAction,
  useNavigation,
  useRpc,
  useSettings,
  useWorkspace,
} from "@pibot/renderer-kit";
import {
  RoutineTopicLabel,
  RoutineTopicLabelProvider,
  routineTopicTitle,
} from "@pibot/routines/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTimelineDay } from "../../chat/messages/MessageTime.tsx";
import { useTopicRestore } from "../../chat/topics/use-topic-archive.ts";
import { importedTopicLabel, rememberTopicTitle } from "../../chat/topics/use-topic-title.ts";
import { TopicListView } from "./TopicListView.tsx";
import {
  isTransientRevealError,
  TOPIC_PAGE_SIZE,
  TOPIC_READ_TIMEOUT_MS,
  TopicScopeMismatchError,
  useTopicPage,
} from "./use-topic-page.ts";

function logRevealFailure(botId: string, error: unknown) {
  console.warn(
    JSON.stringify({
      module: "topics",
      event: "topic_reveal_failed",
      botId,
      ...(error instanceof RpcError ? { code: error.code } : {}),
    }),
  );
}

export function Topics({
  botId,
  conversationId,
  draft = false,
  importId,
}: {
  botId: string;
  conversationId?: string;
  draft?: boolean;
  importId?: string;
}) {
  const { t } = useSettings();
  useTimelineDay();
  const { peer } = useRpc();
  const { navigate } = useNavigation();
  const workspace = useWorkspace();
  const statuses = new Map<string, "queued" | "running">();
  for (const status of Object.values(workspace.statuses))
    if (status.botId === botId && !status.groupId && status.state !== "idle") {
      const prior = statuses.get(status.conversationId);
      if (prior !== "running") statuses.set(status.conversationId, status.state);
    }
  const waitingTopics = new Set(
    workspace.inbox.flatMap((item) =>
      (item.kind === "approval" || item.kind === "routine_approval") &&
      item.approval.botId === botId &&
      item.approval.status === "pending"
        ? [item.conversationId]
        : [],
    ),
  );
  const folderName = (topic: MethodResults["topics.list"][number]) => {
    if (topic.importSource) return importedTopicLabel(t, topic.importSource);
    const id = topic.workplaceFolderId;
    if (!id || id === "home") return t("agentWork.ownFolder");
    return topic.workplaceFolderName ?? t("agentWork.folderUnavailable");
  };
  const task = useAction();
  const restoring = useTopicRestore(peer, botId);
  const [archived, setArchived] = useState(false);
  const [showImported, setShowImported] = useState(!!importId);
  const batch = showImported ? importId : undefined;
  const [query, setQuery] = useState("");
  const scope = useMemo(
    () => ({ peer, botId, query, archived, batch }),
    [peer, botId, query, archived, batch],
  );
  const { page, read, update, refresh, append, reveal, isAppending } =
    useTopicPage<MethodResults["topics.list"][number]>(scope);
  const { topics, more, appendedCurrentId } = page;
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [namesUnavailable, setNamesUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [namesRevision, setNamesRevision] = useState(0);
  const namesEpoch = useRef(0);
  const [editing, setEditing] = useState<string>();
  const [title, setTitle] = useState("");
  const revealCancelRef = useRef<AbortController | null>(null);
  const renameLock = useRef(false);
  const revalidate = useRef({ requested: 0, completed: 0 });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((v) => v + 1), 250);
    };
    const off = [
      peer?.on("sidebar.changed", (event) => {
        if (!event.conversationKey || event.conversationKey === `dm:${botId}`) {
          if (event.resetHistory) revalidate.current.requested++;
          refresh();
        }
      }),
      peer?.on("sidebar.topicsChanged", (event) => {
        if (event.conversationKey === `dm:${botId}`) {
          revalidate.current.requested++;
          refresh();
        }
      }),
      peer?.on("changes.changed", (event) => {
        if (event.reason === "folder" && event.conversationKey === `dm:${botId}`) {
          // Rebinding leaves updatedAt unchanged, so the cached continuation may still match.
          revalidate.current.requested++;
          refresh();
        }
      }),
      peer?.on("chat.status", (event) => {
        if (!event.groupId && event.botId === botId) refresh();
      }),
      peer?.on("chat.done", (event) => {
        if (!event.groupId && event.botId === botId) refresh();
      }),
      peer?.on("chat.error", (event) => {
        if (!event.groupId && event.botId === botId) refresh();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const unsubscribe of off) unsubscribe?.();
    };
  }, [peer, botId]);
  useEffect(() => {
    setNamesUnavailable(false);
    let controller: AbortController | undefined;
    const refreshNames = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const loaded = read().topics;
      if (!peer || loaded.length === 0) return;
      // Stay below the shared GUI queue budget even after many pages have been loaded.
      const pageCount = Math.ceil(loaded.length / 50);
      const refreshPages = async () => {
        const results: MethodResults["topics.list"][] = [];
        let nextPage = 0;
        let failed = false;
        await Promise.all(
          Array.from({ length: Math.min(4, pageCount) }, async () => {
            while (!failed) {
              request.signal.throwIfAborted();
              const page = nextPage++;
              if (page >= pageCount) return;
              try {
                results[page] = await peer.call(
                  "topics.list",
                  {
                    botId,
                    limit: 50,
                    query,
                    archived,
                    importId: batch,
                    before: loaded[page * 50 - 1]?.id,
                  },
                  { signal: request.signal, timeoutMs: 10000 },
                );
              } catch (error) {
                failed = true;
                throw error;
              }
            }
          }),
        );
        return results;
      };
      void refreshPages().then(
        (results) => {
          if (request.signal.aborted) return;
          setNamesUnavailable(false);
          const names = new Map(
            results.flatMap((page) =>
              page
                .filter((topic) => topic.botId === botId && !!topic.archivedAt === archived)
                .map((topic) => [topic.id, topic.workplaceFolderName] as const),
            ),
          );
          update((current) => ({
            ...current,
            topics: current.topics.map((topic) =>
              names.has(topic.id) ? { ...topic, workplaceFolderName: names.get(topic.id) } : topic,
            ),
          }));
        },
        () => {
          if (!request.signal.aborted) setNamesUnavailable(true);
        },
      );
    };
    const changed = () => {
      namesEpoch.current++;
      refreshNames();
    };
    if (namesRevision > 0) refreshNames();
    const off = [
      peer?.on("bots.changed", (event) => {
        if (event.botId === botId) changed();
      }),
      peer?.on("permissions.changed", changed),
    ];
    return () => {
      controller?.abort();
      for (const unsubscribe of off) unsubscribe?.();
    };
  }, [peer, botId, query, archived, batch, namesRevision, read, update]);
  const fetchPage = useCallback(
    async (before: string | undefined, limit: number, signal: AbortSignal) => {
      const { peer, botId, query, archived, batch } = scope;
      if (!peer) throw new Error("Topic connection unavailable");
      const rows = await peer.call(
        "topics.list",
        { botId, before, limit, query, archived, importId: batch },
        { signal, timeoutMs: TOPIC_READ_TIMEOUT_MS },
      );
      if (
        !rows.every(
          (topic) =>
            topic.botId === botId && topic.kind === "dm" && !!topic.archivedAt === archived,
        )
      ) {
        console.warn(JSON.stringify({ module: "topics", event: "topic_scope_mismatch", botId }));
        throw new TopicScopeMismatchError();
      }
      return rows;
    },
    [scope],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection and draft changes refresh the current marker and accepted first message.
  useEffect(() => {
    const folderVersion = namesEpoch.current;
    const cancel = new AbortController();
    setUnavailable(false);
    setLoading(read().topics.length === 0);
    const matchesCurrent = (topic: MethodResults["topics.list"][number]) =>
      conversationId ? topic.id === conversationId : topic.isCurrent;
    const timer = setTimeout(
      () => {
        if (!peer) {
          setUnavailable(true);
          setLoading(false);
          return;
        }
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
          if (folderVersion !== namesEpoch.current) setNamesRevision((value) => value + 1);
          if (query || (draft && !conversationId) || isAppending()) return;
          const start = read();
          const currentIndex = start.topics.findIndex(matchesCurrent);
          const setImplicitCurrent = (id: string | undefined) => {
            update((page) => {
              if (!page.topics.some((topic) => topic.isCurrent !== (topic.id === id))) return page;
              return {
                ...page,
                topics: page.topics.map((topic) =>
                  topic.isCurrent === (topic.id === id)
                    ? topic
                    : { ...topic, isCurrent: topic.id === id },
                ),
              };
            });
          };
          if (currentIndex >= 0 && currentIndex < TOPIC_PAGE_SIZE) {
            if (!conversationId) setImplicitCurrent(start.topics[currentIndex]?.id);
            return;
          }
          if (conversationId && currentIndex >= 0) return;
          if (!start.more && (conversationId || currentIndex < 0)) return;

          const revealCancel = new AbortController();
          revealCancelRef.current = revealCancel;
          const revealSignal = AbortSignal.any([
            cancel.signal,
            revealCancel.signal,
            AbortSignal.timeout(TOPIC_READ_TIMEOUT_MS),
          ]);
          let canFindCurrent = true;
          if (conversationId) {
            // Confirm in O(1) whether the explicit routed topic can belong to this filter
            // (active vs archived, and imported vs native); `currentOnly` checks only the Bot's
            // live current topic and would wrongly skip routed history topics.
            try {
              const metadata = await peer.call(
                "topics.metadata",
                { botId, topicId: conversationId },
                { signal: revealSignal, timeoutMs: 10_000 },
              );
              if (cancel.signal.aborted || revealCancel.signal.aborted) return;
              if (!archived && metadata === null) canFindCurrent = false;
              if (archived && metadata !== null) canFindCurrent = false;
              if (batch && metadata !== null && !metadata.importSource) canFindCurrent = false;
            } catch (probeError) {
              if (cancel.signal.aborted || revealCancel.signal.aborted || revealSignal.aborted)
                return;
              if (
                isTransientRevealError(probeError, revealSignal) ||
                (probeError instanceof RpcError && probeError.code === RpcErrorCodes.methodNotFound)
              ) {
                // Transient metadata read failure or older peer without metadata lookup: proceed
                // with bounded reveal rather than hiding a routed topic.
              } else {
                if (!cancel.signal.aborted) logRevealFailure(botId, probeError);
                throw probeError;
              }
            }
          } else {
            // Confirm in O(1) that the live current topic belongs to this filter (e.g. an import batch)
            // before fetching additional pages to reveal it.
            try {
              const probe = await peer.call(
                "topics.list",
                { botId, limit: 1, query, archived, importId: batch, currentOnly: true },
                { signal: revealSignal, timeoutMs: 10_000 },
              );
              if (cancel.signal.aborted || revealCancel.signal.aborted) return;
              if (
                probe.some(
                  (topic) =>
                    topic.botId !== botId || topic.kind !== "dm" || !!topic.archivedAt !== archived,
                )
              )
                throw new TopicScopeMismatchError();
              const liveId = probe[0]?.id;
              setImplicitCurrent(liveId);
              const latest = read();
              canFindCurrent = !!liveId && latest.more && !latest.topics.some(matchesCurrent);
            } catch (probeError) {
              if (probeError instanceof TopicScopeMismatchError) throw probeError;
              if (
                cancel.signal.aborted ||
                revealCancel.signal.aborted ||
                isTransientRevealError(probeError, revealSignal)
              ) {
                // First page (or preserved refresh list) is already displayed; ignore cancellation
                // and expected transient transport failures.
                return;
              }
              if (!cancel.signal.aborted) logRevealFailure(botId, probeError);
              throw probeError;
            }
          }
          if (!canFindCurrent) return;

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
            if (!cancel.signal.aborted) logRevealFailure(botId, revealError);
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
    botId,
    conversationId,
    draft,
    query,
    archived,
    batch,
    revision,
    fetchPage,
    refresh,
    reveal,
    read,
    update,
    isAppending,
  ]);
  const rename = async (topicId: string) => {
    if (!peer || renameLock.current) return;
    if (!title.trim()) {
      task.setError("workspace.invalid");
      return;
    }
    const topic = topics.find((topic) => topic.id === topicId);
    if (!topic || title.trim() === topic.title) {
      setEditing(undefined);
      return;
    }
    renameLock.current = true;
    const result = await task.run(() =>
      peer.call("topics.rename", { botId, topicId, title: title.trim() }),
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
      setRevision((v) => v + 1);
    }
  };
  const currentId = useMemo(
    () => conversationId ?? (!draft ? topics.find((topic) => topic.isCurrent)?.id : undefined),
    [conversationId, draft, topics],
  );
  return (
    <RoutineTopicLabelProvider botId={botId}>
      <TopicListView
        topics={topics}
        currentId={currentId}
        appendedCurrentId={appendedCurrentId}
        archived={archived}
        setArchived={setArchived}
        imported={
          importId
            ? {
                active: showImported,
                setActive: setShowImported,
              }
            : undefined
        }
        query={query}
        setQuery={setQuery}
        loading={loading}
        error={
          task.error ??
          restoring.error ??
          (unavailable || namesUnavailable ? "workspace.unavailable" : undefined)
        }
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
        available={!!peer}
        folderName={folderName}
        status={(topic) => (waitingTopics.has(topic.id) ? "waiting" : statuses.get(topic.id))}
        displayTitle={(topic) =>
          topic.routineId
            ? routineTopicTitle(t, topic.title ?? "")
            : topic.title || t("workspace.untitled")
        }
        canRename={(topic) => !topic.routineId}
        extra={(topic) =>
          topic.routineId ? <RoutineTopicLabel id={topic.routineId} botId={botId} /> : null
        }
        open={(topic) => {
          if (peer)
            void task
              .run(() => peer.call("topics.switch", { botId, topicId: topic.id }))
              .then((result) => {
                if (result) {
                  rememberTopicTitle(peer, botId, result);
                  navigate({ name: "chat", botId, topicId: result.id });
                  void workspace.refresh();
                }
              });
        }}
        restore={(id) => void restoring.run(id)}
        more={more}
        loadMore={() => {
          revealCancelRef.current?.abort();
          revealCancelRef.current = null;
          const folderVersion = namesEpoch.current;
          void task
            .run(
              (signal) =>
                append(fetchPage, signal, (added) =>
                  !currentId && !draft ? added.find((topic) => topic.isCurrent)?.id : undefined,
                ),
              (error) =>
                error instanceof TopicScopeMismatchError
                  ? "workspace.unavailable"
                  : actionError(error),
            )
            .then(() => {
              if (folderVersion !== namesEpoch.current) setNamesRevision((value) => value + 1);
            });
        }}
      />
    </RoutineTopicLabelProvider>
  );
}
