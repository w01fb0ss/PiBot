import type { Bot, Group, SidebarEntry } from "@pibot/protocol";
import { useEffect, useRef, useState } from "react";
import { useLinkState, useRuntime } from "../../runtime/context.tsx";
import type { MobileRuntime } from "../../runtime/runtime.ts";
import { useAction } from "../../runtime/use-action.ts";
import { storeKeys } from "../../storage/phone-store.ts";
import {
  botRow,
  CachedConversationsSchema,
  type Conversation,
  conversationKey,
  groupRow,
  lastActivity,
  preview,
} from "./model.ts";

const PAGE = 50,
  MAX_PAGES = 4,
  PREVIEWS = 40,
  PARALLEL = 4,
  STORED = 400;
async function pages<T extends { id: string }>(read: (before: string | undefined) => Promise<T[]>) {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await read(rows.at(-1)?.id);
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}
const target = (row: Pick<Conversation, "kind" | "id">) =>
  row.kind === "bot" ? { botId: row.id } : { groupId: row.id };
/** Last message of one conversation; a preview is decoration, so a failure keeps the old one. */
async function previewOf(runtime: MobileRuntime, row: Conversation, signal: AbortSignal) {
  const page = await runtime
    .call("chat.history", { ...target(row), limit: 1 }, signal)
    .catch((error: unknown) => {
      if (signal.aborted) throw error;
      return [];
    });
  return page[0] ? preview(page[0]) : row.preview;
}
/** Last message of each conversation, a few requests at a time (the gateway caps concurrency). */
async function withPreviews(runtime: MobileRuntime, rows: Conversation[], signal: AbortSignal) {
  const result = rows.slice();
  let next = 0;
  const worker = async () => {
    while (next < Math.min(result.length, PREVIEWS)) {
      const index = next++;
      const row = result[index] as Conversation;
      result[index] = { ...row, preview: await previewOf(runtime, row, signal) };
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return result;
}
function markRows(rows: Conversation[], entries: SidebarEntry[]) {
  const unread = new Set<string>();
  const pins = new Map<string, number>();
  for (const entry of entries) {
    if (entry.unread) unread.add(entry.conversationKey);
    // The server already orders pins by pinnedAt and resolves ties.
    if (entry.pinnedAt) pins.set(entry.conversationKey, pins.size);
  }
  const marked = rows
    .map((row) => ({
      ...row,
      unread: unread.has(row.key),
      pinned: pins.has(row.key),
      pinOrder: pins.get(row.key),
    }))
    .sort((a, b) => lastActivity(b) - lastActivity(a));
  return { rows: marked, unread };
}
export function useConversationsState() {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const store = runtime.storage.store;
  const copy = (id: string | undefined) =>
    id ? (store.peek(storeKeys.conversations(id), CachedConversationsSchema) ?? []) : [];
  // Proposal 10: the list cold start warmed (runtime.select) is there in the first frame.
  const [rows, setRows] = useState<Conversation[]>(() => copy(mobile.selectedId));
  const [bots, setBots] = useState<Map<string, Bot>>(new Map());
  const [unread, setUnread] = useState<Set<string>>(
    () => new Set(rows.filter((row) => row.unread).map((row) => row.key)),
  );
  const [running, setRunning] = useState<Record<string, string | null>>({});
  const action = useAction(mobile.selectedId, mobile.peer);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const shownFor = useRef(mobile.selectedId);
  const show = (next: Conversation[], marks?: Set<string>) => {
    rowsRef.current = next;
    setRows(next);
    setUnread(marks ?? new Set(next.filter((row) => row.unread).map((row) => row.key)));
  };
  const save = (id: string, next: Conversation[]) =>
    store.write(
      storeKeys.conversations(id),
      CachedConversationsSchema.parse(next.slice(0, STORED)),
    );
  const load = () =>
    action.read(async (signal) => {
      const id = mobile.selectedId;
      if (!id) return;
      if (mobile.status !== "online" || !rowsRef.current.length) {
        const cached =
          (await store.read(storeKeys.conversations(id), CachedConversationsSchema)) ?? [];
        signal.throwIfAborted();
        if (mobile.status !== "online" || !rowsRef.current.length) show(cached);
        if (mobile.status !== "online") return;
      }
      // Connect or reconnect: the whole list once (Bots and groups can change while away).
      const [botList, groups, sidebar] = await Promise.all([
        pages((before) => runtime.call("bots.list", { before, limit: PAGE }, signal)),
        pages<Group>((before) => runtime.call("groups.list", { before, limit: PAGE }, signal)),
        runtime.call("sidebar.list", { limit: 200 }, signal),
      ]);
      const byId = new Map(botList.map((bot) => [bot.id, bot]));
      const base = [...botList.map(botRow), ...groups.map((group) => groupRow(group, byId))];
      const known = new Map(rowsRef.current.map((row) => [row.key, row.preview]));
      const merged = await withPreviews(
        runtime,
        base.map((row) => ({ ...row, preview: known.get(row.key) })),
        signal,
      );
      signal.throwIfAborted();
      const { rows: next, unread: marks } = markRows(merged, sidebar.entries);
      setBots(byId);
      show(next, marks);
      await save(id, next);
    });
  /**
   * Proposal 4: a reply or a read mark changes one row, so only that row's last message and the
   * sidebar marks are read (two calls), not every Bot, group and preview again.
   */
  const touch = (keys: ReadonlySet<string>) =>
    action.read(async (signal) => {
      const id = mobile.selectedId;
      if (!id || mobile.status !== "online") return;
      const changed = rowsRef.current.filter((row) => keys.has(row.key));
      const previews = new Map<string, Conversation["preview"]>();
      for (const row of changed) previews.set(row.key, await previewOf(runtime, row, signal));
      const sidebar = await runtime.call("sidebar.list", { limit: 200 }, signal);
      signal.throwIfAborted();
      if (shownFor.current !== id) return;
      const { rows: next, unread: marks } = markRows(
        rowsRef.current.map((row) =>
          previews.has(row.key) ? { ...row, preview: previews.get(row.key) } : row,
        ),
        sidebar.entries,
      );
      show(next, marks);
      await save(id, next);
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: effects own the canonical device/peer/route, not transient request state.
  useEffect(() => {
    // Another computer's rows never show; a reconnect keeps what is on screen.
    if (shownFor.current !== mobile.selectedId) {
      shownFor.current = mobile.selectedId;
      show(copy(mobile.selectedId));
      setBots(new Map());
    }
    setRunning({});
    void load();
    const peer = mobile.peer;
    if (!peer) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let full = false;
    const dirty = new Set<string>();
    // Many events arrive per reply; one read after they settle keeps previews current.
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const keys = new Set(dirty);
        dirty.clear();
        if (full) {
          full = false;
          void load();
        } else void touch(keys);
      }, 800);
    };
    const row = (event: { botId?: string; groupId?: string }) => {
      const key = event.groupId
        ? conversationKey("group", event.groupId)
        : event.botId
          ? conversationKey("bot", event.botId)
          : undefined;
      if (key) dirty.add(key);
      settle();
    };
    const reload = () => {
      full = true;
      settle();
    };
    const off = [
      peer.on("chat.status", (event) => {
        const key = event.groupId
          ? conversationKey("group", event.groupId)
          : conversationKey("bot", event.botId);
        setRunning((state) => ({ ...state, [key]: event.state === "idle" ? null : event.runId }));
        if (event.state === "idle") row(event);
      }),
      peer.on("chat.done", row),
      peer.on("chat.error", row),
      // Names, looks, members and the list itself: rare, read whole.
      peer.on("bots.changed", reload),
      peer.on("groups.changed", reload),
      peer.on("sidebar.changed", (event) => {
        if (event.conversationKey) dirty.add(event.conversationKey);
        settle();
      }),
    ];
    return () => {
      clearTimeout(timer);
      for (const fn of off) fn();
    };
  }, [mobile.selectedId, mobile.peer, mobile.refreshVersion]);
  return {
    rows,
    bots,
    unread,
    running,
    action,
    load,
    find: (kind: "bot" | "group", id: string) =>
      rows.find((row) => row.key === conversationKey(kind, id)),
  };
}
