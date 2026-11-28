import type { ChatPeer } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import type { FolderSelection, MethodResults, WorkingFolder, Workplaces } from "@pibot/protocol";
import {
  type FolderEntry,
  type FolderModel,
  folderError,
  type RunnerPickTarget,
  useRunners,
  useT,
  without,
  withPrimary,
  withReadonly,
  withWritable,
} from "@pibot/renderer-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Initial = MethodResults["topics.workplace.initial"];
type TopicPlace = MethodResults["topics.workplace.get"];

/**
 * The folder model of a DM chat: a saved topic (changed with `topics.workplace.update`) or a
 * new-topic draft (kept in the chat controller until its first message creates the topic).
 */
export function useChatFolders({
  peer,
  botId,
  topic,
  draft,
  registry,
  running,
  refreshTopic,
}: {
  peer: ChatPeer | null;
  botId?: string;
  /** The saved topic's folders, when the chat has a topic. */
  topic?: TopicPlace;
  draft?: { key: string; selection?: FolderSelection; set(selection: FolderSelection): void };
  /** The Bot's used folders (`workplaces.list`): names and the "recently used" list. */
  registry?: Workplaces;
  running: boolean;
  refreshTopic(): void;
}) {
  const t = useT();
  const [initial, setInitial] = useState<{ key: string; value: Initial }>();
  const [picked, setPicked] = useState(() => new Map<string, WorkingFolder>());
  const [pending, setPending] = useState(false);
  const runners = useRunners(peer);
  const [error, setError] = useState<{ owner: string; key: TranslationKey }>();
  const owner = JSON.stringify([botId, topic?.topicId ?? null, draft?.key ?? null]);
  const lifetime = useRef<AbortController | undefined>(undefined);
  // A new conversation owns new requests; a late reply of the old one changes nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the owner key is the lifetime.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setPending(false);
    return () => controller.abort();
  }, [owner, peer]);
  const draftKey = draft?.key;
  useEffect(() => {
    if (!peer || !botId || !draftKey) return;
    const abort = new AbortController();
    void peer
      .call("topics.workplace.initial", { botId }, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setInitial({ key: `${botId}:${draftKey}`, value });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError({ owner: JSON.stringify([botId, null, draftKey]), key: "folders.failed" });
      });
    return () => abort.abort();
  }, [peer, botId, draftKey]);
  const inherited = draftKey && initial?.key === `${botId}:${draftKey}` ? initial.value : undefined;
  const selection: FolderSelection | undefined = topic
    ? {
        primary: topic.folderId ?? "home",
        readonly: topic.readonly ?? [],
        writable: topic.writable ?? [],
      }
    : (draft?.selection ?? inherited?.selection);
  const names = useMemo(() => {
    const map = new Map<string, FolderEntry>();
    const runnerNames = new Map(runners.map((entry) => [entry.id, entry.name]));
    const add = (
      folder: Pick<WorkingFolder, "id" | "name" | "path" | "location" | "displayPath">,
    ) =>
      map.set(folder.id, {
        id: folder.id,
        name: folder.location?.startsWith("runner:")
          ? `${runnerNames.get(folder.location) ?? t("remote.runner.kind")} · ${folder.name}`
          : folder.name,
        path: folder.displayPath ?? folder.path,
        location: folder.location,
      });
    for (const folder of registry?.folders ?? []) add(folder);
    for (const folder of inherited?.workplace.folders ?? []) add(folder);
    for (const folder of topic?.workplace.folders ?? []) add(folder);
    for (const folder of picked.values()) add(folder);
    return map;
  }, [registry, inherited, topic, picked, runners, t]);
  const apply = useCallback(
    async (next: FolderSelection) => {
      if (draft) {
        draft.set(next);
        return;
      }
      if (!peer || !botId || !topic) return;
      const signal = lifetime.current?.signal;
      setPending(true);
      setError(undefined);
      try {
        const result = await peer.call(
          "topics.workplace.update",
          { botId, topicId: topic.topicId, selection: next },
          { signal },
        );
        if (signal?.aborted) return;
        if (result.topicId !== topic.topicId) throw new Error("Topic identity changed");
        refreshTopic();
      } catch (failure) {
        if (!signal?.aborted) setError({ owner, key: folderError(failure) });
      } finally {
        if (!signal?.aborted) setPending(false);
      }
    },
    [draft, peer, botId, topic, refreshTopic, owner],
  );
  const model = useMemo((): FolderModel | undefined => {
    if (!selection) return undefined;
    const entry = (id: string): FolderEntry =>
      id === "home"
        ? { id, name: t("folders.home") }
        : (names.get(id) ?? { id, name: t("topicWorkplace.missing") });
    const writable = selection.writable ?? [];
    const local = (names.get(selection.primary)?.location ?? "local") === "local";
    const used = new Set([selection.primary, ...selection.readonly, ...writable]);
    const recent = [...(registry?.folders ?? [])]
      .filter((folder) => !used.has(folder.id))
      .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
      .slice(0, 8)
      .map((folder) => entry(folder.id));
    const pick = (target: "primary" | "readonly" | "writable" | "only", create = false) => {
      if (!peer || !botId) return;
      const signal = lifetime.current?.signal;
      setPending(true);
      setError(undefined);
      void peer
        .call("workplaces.pick", { botId, create }, { signal, timeoutMs: 680_000 })
        .then(async ({ folder }) => {
          if (signal?.aborted || !folder) return;
          setPicked((map) => new Map(map).set(folder.id, folder));
          const next =
            target === "only"
              ? { primary: folder.id, readonly: [], writable: [] }
              : target === "primary"
                ? (folder.location ?? "local") !==
                  (names.get(selection.primary)?.location ?? "local")
                  ? { primary: folder.id, readonly: [], writable: [] }
                  : withPrimary(selection, folder.id)
                : target === "writable"
                  ? withWritable(selection, folder.id)
                  : withReadonly(selection, folder.id);
          if (!next)
            setError({
              owner,
              key: target === "writable" ? "folders.writableFull" : "folders.full",
            });
          else {
            setPending(false);
            await apply(next);
          }
        })
        .catch((failure: unknown) => {
          if (!signal?.aborted) setError({ owner, key: folderError(failure) });
        })
        .finally(() => {
          if (!signal?.aborted) setPending(false);
        });
    };
    return {
      runners,
      browseRunner: peer
        ? (location, path, signal) =>
            peer.call(
              "workplaces.browse",
              { location, ...(path !== undefined && { path }) },
              { signal },
            )
        : undefined,
      pickRunner: (location: string, path: string, target: RunnerPickTarget) => {
        if (!peer || !botId) return;
        const signal = lifetime.current?.signal;
        setPending(true);
        setError(undefined);
        void peer
          .call("workplaces.pick", { botId, location, path }, { signal })
          .then(async ({ folder }) => {
            if (!folder || signal?.aborted) return;
            setPicked((map) => new Map(map).set(folder.id, folder));
            // A reference joins the runner primary; a new primary starts its own workspace.
            const next =
              target === "readonly"
                ? withReadonly(selection, folder.id)
                : { primary: folder.id, readonly: [], writable: [] };
            if (!next) setError({ owner, key: "folders.full" });
            else await apply(next);
          })
          .catch((failure: unknown) => {
            if (!signal?.aborted) setError({ owner, key: folderError(failure) });
          })
          .finally(() => {
            if (!signal?.aborted) setPending(false);
          });
      },
      primary: entry(selection.primary),
      readonly: selection.readonly.map(entry),
      writable: writable.map(entry),
      pickWritable: local ? () => pick("writable") : undefined,
      recent,
      busy: !draft && (running || !!topic?.busy),
      pending,
      // A topic left on an offline runner still opens the picker so the user can move it back.
      error:
        error?.owner === owner
          ? error.key
          : topic?.runnerOffline
            ? "workplaces.runnerOffline"
            : undefined,
      setPrimary: (id) =>
        void apply(
          (names.get(id)?.location ?? "local") !==
            (names.get(selection.primary)?.location ?? "local")
            ? { primary: id, readonly: [], writable: [] }
            : withPrimary(selection, id),
        ),
      setOnly: (id) => void apply({ primary: id, readonly: [], writable: [] }),
      setReadonly: (id) => {
        const next = withReadonly(selection, id);
        if (next) void apply(next);
        else setError({ owner, key: "folders.full" });
      },
      remove: (id) => void apply(without(selection, id)),
      pick,
    };
  }, [
    runners,
    selection,
    names,
    registry,
    peer,
    botId,
    draft,
    running,
    topic,
    pending,
    error,
    owner,
    apply,
    t,
  ]);
  const inherit =
    draft && inherited
      ? {
          name:
            inherited.selection.primary === "home"
              ? t("folders.home")
              : (names.get(inherited.selection.primary)?.name ?? t("folders.home")),
          active:
            !draft.selection ||
            JSON.stringify(draft.selection) === JSON.stringify(inherited.selection),
          select: () => draft.set(inherited.selection),
        }
      : undefined;
  return { model, inherit };
}
