import { useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ConversationList,
  type Destination,
  type FolderTarget,
  isLocalSource,
  known,
  type LocalSource,
  MAX_CONVERSATION_SELECTION,
  type MemoryChoice,
  type Plan,
  type PlanMemory,
  type Preview,
  type ProjectChoice,
  type Quote,
  type Review,
  reviewOptions,
  type Source,
  sameFolder,
  selectionPreviewOptions,
  startError,
} from "./import-state.ts";

type Action = "list" | "preview" | "plan" | "persona" | "project" | "quote" | "pick";
type QuoteResult = { scope: string } & ({ quote: Quote | null } | { failed: true });

const LIST_PAGE_SIZE = 25;

/**
 * Projects default to a matching work folder and its Bot, else the source folder, else new. A
 * local session whose working directory is gone stays in the Bot's own folder: an old worktree
 * or temp checkout should not reappear under ~/Documents.
 */
function initialProjects(preview: Preview, plan: Plan, botId: string) {
  const projects: Record<string, ProjectChoice> = {};
  for (const project of preview.projects ?? []) {
    const target = plan.projects.find(({ key }) => key === project.key);
    const match = target?.match ? plan.folders.find(({ id }) => id === target.match) : undefined;
    const folder: FolderTarget = match
      ? { kind: "folder", folderId: match.id }
      : target?.source
        ? { kind: "source" }
        : target?.sourceMissing
          ? { kind: "home" }
          : { kind: "new" };
    projects[project.key] = {
      on: true,
      botId: match?.botId ?? botId,
      folder,
      confirmed: false,
      open: false,
    };
  }
  return projects;
}

export function useImportDraft() {
  const { peer } = useRpc();
  const t = useT();
  const workspace = useWorkspace();
  // The main Bot leads every Bot menu, as in the approved destination menu.
  const bots = useMemo(
    () =>
      workspace.bots
        .filter(({ archivedAt, category }) => !archivedAt && category !== "image")
        .sort((left, right) => Number(right.isMain) - Number(left.isMain)),
    [workspace.bots],
  );
  const mainBot = bots.find((bot) => bot.isMain)?.id ?? bots[0]?.id ?? "";
  const [source, setSource] = useState<Source>("chatgpt");
  const [listSource, setListSource] = useState<LocalSource>();
  const [conversationList, setConversationList] = useState<ConversationList>();
  const [listQuery, setListQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [includeMemory, setIncludeMemory] = useState(false);
  const [includeProjectRules, setIncludeProjectRules] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [plan, setPlan] = useState<Plan>();
  const [botId, setBotId] = useState("");
  const [conversations, setConversations] = useState(true);
  const [projects, setProjects] = useState<Record<string, ProjectChoice>>({});
  const [memoryChoices, setMemoryChoices] = useState<Record<string, MemoryChoice>>({});
  const [persona, setPersona] = useState<{
    on: boolean;
    botId: string;
    review?: Review;
    open: boolean;
  }>({ on: false, botId: "", open: false });
  const [quoteResult, setQuoteResult] = useState<QuoteResult>();
  const [consent, setConsent] = useState<string>();
  const [busy, setBusy] = useState<Action>();
  const [error, setError] = useState<ReturnType<typeof startError>>();
  const request = useRef<AbortController | undefined>(undefined);
  // The brain reviews one thing at a time; project diffs and other reviews wait their turn.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef(0);
  useEffect(() => () => request.current?.abort(), []);

  const run = useCallback((kind: Action, work: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    const turn = generation.current;
    const next = queue.current.then(async () => {
      if (controller.signal.aborted || turn !== generation.current) return;
      request.current = controller;
      setBusy(kind);
      try {
        await work(controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted && turn === generation.current)
          setError(startError(failure));
        throw failure;
      } finally {
        if (request.current === controller) request.current = undefined;
        setBusy(undefined);
      }
    });
    // The next turn runs after this one either way; the failure was shown above.
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const reset = () => {
    generation.current++;
    request.current?.abort();
    setPlan(undefined);
    setProjects({});
    setMemoryChoices({});
    setPersona({ on: false, botId: "", open: false });
    setQuoteResult(undefined);
    setConsent(undefined);
    setError(undefined);
  };

  const resetList = () => {
    setListSource(undefined);
    setConversationList(undefined);
    setListQuery("");
    setSelectedIds([]);
    setIncludeMemory(false);
    setIncludeProjectRules(false);
  };

  async function hydratePreview(next: Preview, signal: AbortSignal) {
    if (!peer || signal.aborted) return;
    setPreview(next);
    setConversations(true);
    setBotId(mainBot);
    setPersona({ on: false, botId: mainBot, open: false });
    const reviewed = await peer.call(
      "import.reviewPlan",
      { importId: next.importId },
      { ...reviewOptions, signal },
    );
    if (signal.aborted) return;
    setPlan(reviewed);
    setProjects(initialProjects(next, reviewed, mainBot));
  }

  function pick() {
    if (!peer || busy) return;
    reset();
    void run("preview", async (signal) => {
      // preview performs source detection and opens the native picker only after this click.
      const next = await peer.call(
        "import.preview",
        { source, filterLabel: t("conversationImport.exportFilter") },
        { ...reviewOptions, signal },
      );
      if (signal.aborted || !next) return;
      resetList();
      await hydratePreview(next, signal);
    }).catch(() => undefined);
  }

  function openConversationList() {
    if (!peer || busy || !isLocalSource(source)) return;
    const target = source;
    reset();
    resetList();
    void run("list", async (signal) => {
      const result = await peer.call(
        "import.listConversations",
        { source: target, cursor: 0, limit: LIST_PAGE_SIZE },
        { ...reviewOptions, signal },
      );
      if (signal.aborted) return;
      setListSource(target);
      setConversationList(result);
    }).catch(() => undefined);
  }

  const searchConversations = useCallback(
    (query: string) => {
      if (!peer || !listSource) return;
      setListQuery(query);
      setError(undefined);
      generation.current++;
      request.current?.abort();
      void run("list", async (signal) => {
        const result = await peer.call(
          "import.listConversations",
          {
            source: listSource,
            cursor: 0,
            limit: LIST_PAGE_SIZE,
            ...(query.trim() ? { query: query.trim() } : {}),
          },
          { ...reviewOptions, signal },
        );
        if (signal.aborted) return;
        setConversationList(result);
      }).catch(() => undefined);
    },
    [listSource, peer, run],
  );

  function loadMoreConversations() {
    if (!peer || busy || !listSource || conversationList?.next === null || !conversationList)
      return;
    const nextCursor = conversationList.next;
    void run("list", async (signal) => {
      const page = await peer.call(
        "import.listConversations",
        {
          source: listSource,
          cursor: nextCursor,
          limit: LIST_PAGE_SIZE,
          ...(listQuery.trim() ? { query: listQuery.trim() } : {}),
        },
        { ...reviewOptions, signal },
      );
      if (signal.aborted) return;
      setConversationList((current) =>
        current
          ? {
              ...page,
              items: [
                ...current.items,
                ...page.items.filter(
                  (item) => !current.items.some((existing) => existing.id === item.id),
                ),
              ],
            }
          : page,
      );
    }).catch(() => undefined);
  }

  function toggleConversation(id: string) {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= MAX_CONVERSATION_SELECTION) return current;
      return [...current, id];
    });
  }

  function previewSelected() {
    if (!peer || busy || !listSource) return;
    if (!selectedIds.length && !includeMemory && !includeProjectRules) return;
    const target = listSource;
    const ids = selectedIds;
    const withMemory = includeMemory;
    const withRules = includeProjectRules;
    reset();
    void run("preview", async (signal) => {
      const next = await peer.call(
        "import.previewSelection",
        {
          source: target,
          conversationIds: ids,
          ...(withMemory ? { includeMemory: true } : {}),
          ...(withRules ? { includeProjectRules: true } : {}),
        },
        { ...selectionPreviewOptions, signal },
      );
      if (signal.aborted) return;
      await hydratePreview(next, signal);
    }).catch(() => undefined);
  }

  const updateProject = useCallback(
    (key: string, change: Partial<ProjectChoice>) =>
      setProjects((current) => {
        const value = current[key];
        return value ? { ...current, [key]: { ...value, ...change } } : current;
      }),
    [],
  );

  // Each included project with knowledge gets its AGENTS.md diff for the folder it points at.
  const pending = Object.entries(projects).find(([key, choice]) => {
    const knowledge = preview?.projects?.find((project) => project.key === key)?.knowledge ?? 0;
    return (
      knowledge > 0 &&
      choice.on &&
      choice.folder.kind !== "home" &&
      !choice.diffFailed &&
      !(choice.diffFor && sameFolder(choice.diffFor, choice.folder))
    );
  });
  const pendingKey = pending?.[0];
  const pendingFolder = pending?.[1].folder;
  useEffect(() => {
    if (!peer || !preview || !plan || !pendingKey || !pendingFolder || busy) return;
    const folder = pendingFolder;
    void run("project", async (signal) => {
      try {
        const diff = await peer.call(
          "import.reviewProject",
          { importId: preview.importId, key: pendingKey, folder },
          { ...reviewOptions, signal },
        );
        if (!signal.aborted)
          updateProject(pendingKey, { diff, diffFor: folder, confirmed: false, diffFailed: false });
      } catch {
        // The row says the file could not be prepared; the rest of the import stays usable.
        if (!signal.aborted)
          updateProject(pendingKey, { diff: undefined, diffFor: folder, diffFailed: true });
      }
    }).catch(() => undefined);
  }, [peer, preview, plan, pendingKey, pendingFolder, busy, run, updateProject]);

  /** Preferences go to 关于你, ways of working to the Bot that does that project. */
  const defaultTarget = (memory: PlanMemory): Destination =>
    memory.kind === "preference"
      ? "user"
      : ((memory.project && projects[memory.project]?.botId) ?? botId);
  const memoryTarget = (memory: PlanMemory) =>
    memoryChoices[memory.id]?.target ?? defaultTarget(memory);
  const memoryOn = (memory: PlanMemory) => {
    const target = memoryTarget(memory);
    if (known(memory, target)?.outcome === "duplicate") return false;
    return memoryChoices[memory.id]?.on ?? true;
  };

  const projectTopics = (preview?.projects ?? []).reduce((sum, { topics }) => sum + topics, 0);
  const quoteOtherChats = conversations && (preview?.topics ?? 0) > projectTopics;
  const quotedProjects = (preview?.projects ?? [])
    .filter(({ key, topics }) => topics > 0 && projects[key]?.on)
    .map(({ key }) => key);
  const quoteScope = JSON.stringify([preview?.importId, botId, quoteOtherChats, quotedProjects]);
  const importId = preview?.importId;
  const canQuote =
    !!plan && !!importId && !!botId && (quoteOtherChats || quotedProjects.length > 0);
  const currentQuote = canQuote && quoteResult?.scope === quoteScope ? quoteResult : undefined;
  const quote =
    currentQuote && "quote" in currentQuote ? (currentQuote.quote ?? undefined) : undefined;

  const requestQuote = useCallback(() => {
    if (!peer || !canQuote || !importId) return;
    setQuoteResult(undefined);
    const [, , includeChats, projectKeys] = JSON.parse(quoteScope) as [
      string,
      string,
      boolean,
      string[],
    ];
    void run("quote", async (signal) => {
      try {
        const estimate = await peer.call(
          "import.estimateDistillation",
          { importId, botId, conversations: includeChats, projectKeys },
          { ...selectionPreviewOptions, signal },
        );
        if (!signal.aborted) setQuoteResult({ scope: quoteScope, quote: estimate });
      } catch {
        // Keep the selection usable and let the user retry the same estimate.
        if (!signal.aborted) setQuoteResult({ scope: quoteScope, failed: true });
      }
    }).catch(() => undefined);
  }, [peer, canQuote, importId, botId, quoteScope, run]);

  useEffect(requestQuote, [requestQuote]);

  function toggleQuote(enabled: boolean) {
    setConsent(enabled ? quote?.quoteId : undefined);
  }

  function comparePersona(targetBot = persona.botId, on = true) {
    if (!peer || !preview || !targetBot) return;
    setPersona({ on, botId: targetBot, open: true });
    void run("persona", async (signal) => {
      const review = await peer.call(
        "import.reviewMemories",
        { importId: preview.importId, botId: targetBot, scope: "persona" },
        { ...reviewOptions, signal },
      );
      if (!signal.aborted)
        setPersona((current) => (current.botId === targetBot ? { ...current, review } : current));
    }).catch(() => setPersona((current) => ({ ...current, on: false })));
  }

  /** "选择其他文件夹…": the system dialog registers the folder for the project's Bot. */
  function pickFolder(key: string) {
    const choice = projects[key];
    if (!peer || !choice) return;
    void run("pick", async (signal) => {
      const { folder } = await peer.call(
        "workplaces.pick",
        { botId: choice.botId, create: true },
        { signal, timeoutMs: 680_000 },
      );
      if (signal.aborted || !folder) return;
      setPlan((current) =>
        current && !current.folders.some(({ id }) => id === folder.id)
          ? {
              ...current,
              folders: [
                { id: folder.id, botId: choice.botId, name: folder.name, display: folder.path },
                ...current.folders,
              ],
            }
          : current,
      );
      updateProject(key, {
        folder: { kind: "folder", folderId: folder.id },
        confirmed: false,
        needsReview: false,
        open: false,
        diffFailed: false,
      });
    }).catch(() => undefined);
  }

  const memories = plan?.memories ?? [];
  return {
    preview,
    plan,
    source,
    listSource,
    conversationList,
    listQuery,
    selectedIds,
    includeMemory,
    includeProjectRules,
    bots,
    botId,
    conversations,
    projects,
    memories,
    memoryTarget,
    memoryOn,
    persona,
    quote,
    distillationOn: !!quote && consent === quote.quoteId,
    quoteLoading: canQuote && !currentQuote,
    quoteFailed: !!currentQuote && "failed" in currentQuote,
    retryQuote: requestQuote,
    busy,
    error,
    pick,
    openConversationList,
    searchConversations,
    loadMoreConversations,
    toggleConversation,
    clearSelectedConversations: () => setSelectedIds([]),
    setIncludeMemory,
    setIncludeProjectRules,
    previewSelected,
    closeConversationList() {
      reset();
      resetList();
    },
    toggleQuote,
    comparePersona,
    pickFolder,
    refreshProjectReviews() {
      setProjects((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, choice]) => [
            key,
            choice.on && choice.confirmed
              ? {
                  ...choice,
                  diff: undefined,
                  diffFor: undefined,
                  diffFailed: false,
                  confirmed: false,
                  needsReview: true,
                  open: true,
                }
              : choice,
          ]),
        ),
      );
    },
    selectSource(value: Source) {
      setSource(value);
      setError(undefined);
    },
    changeBot(value: string) {
      setBotId(value);
      setConsent(undefined);
    },
    changeConversations(value: boolean) {
      setConversations(value);
      setConsent(undefined);
    },
    setProject(key: string, change: Partial<ProjectChoice>) {
      if (change.on !== undefined) setConsent(undefined);
      // A different folder needs a new diff; a different Bot keeps it.
      updateProject(
        key,
        change.folder
          ? { ...change, confirmed: false, needsReview: false, open: false, diffFailed: false }
          : change,
      );
    },
    setMemory(id: string, change: MemoryChoice) {
      setMemoryChoices((current) => ({ ...current, [id]: { ...current[id], ...change } }));
    },
    setPersona(change: { on?: boolean; botId?: string; open?: boolean }) {
      if (change.botId && change.botId !== persona.botId) {
        // Another Bot's role has to be compared again before it can be replaced.
        if (persona.on || persona.open) comparePersona(change.botId, persona.on);
        else setPersona({ on: false, botId: change.botId, open: false });
        return;
      }
      if (change.on && !persona.review) {
        comparePersona(persona.botId, true);
        return;
      }
      setPersona((current) => ({ ...current, ...change }));
    },
    back() {
      reset();
      resetList();
      setPreview(undefined);
    },
  };
}

export type ImportDraft = ReturnType<typeof useImportDraft>;
