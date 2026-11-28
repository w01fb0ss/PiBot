import { approvalText } from "@pibot/client-core";
import { useRouter } from "expo-router";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { useOffline } from "../../offline/OfflineProvider.tsx";
import { useLanguage, useMobileSelector, useRuntime, useText } from "../../runtime/context.tsx";
import { space, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Banner, EmptyState, ErrorLine, SearchField } from "../../ui/controls.tsx";
import { ComputerStatus, HeaderPill, OfflineBanner, TabHeader } from "../../ui/headers.tsx";
import { StatRow } from "../../ui/stats.tsx";
import { useTabBarInset } from "../../ui/tab-bar.tsx";
import { useApprovals } from "../approvals/approvals-context.tsx";
import { useRemoteValue } from "../chat/controls/use-remote-value.ts";
import { OfflineDetailsSheet } from "../offline/OfflineDetailsSheet.tsx";
import { greetingKey, taskCounts } from "../tasks/counts.ts";
import { useTaskCenter } from "../tasks/tasks-context.tsx";
import { ConversationRow } from "./ConversationRow.tsx";
import { useConversations } from "./conversations-context.tsx";
import { type Conversation, conversationKey } from "./model.ts";

/** Placeholder rows while the first connection runs and nothing is cached yet. */
function Skeleton() {
  const colors = useColors();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: space.rowPad }}
    >
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.tert }} />
      <View style={{ flex: 1, gap: 8 }}>
        <View style={{ width: "40%", height: 14, borderRadius: 8, backgroundColor: colors.tert }} />
        <View style={{ width: "75%", height: 12, borderRadius: 8, backgroundColor: colors.tert }} />
      </View>
    </View>
  );
}
/** One line on what needs the user, then working / waiting / done today. */
function HomeSummary() {
  const colors = useColors(),
    t = useText(),
    tasks = useTaskCenter(),
    approvals = useApprovals(),
    list = useConversations();
  const running = Object.values(list.running).filter(Boolean).length;
  const counts = taskCounts(tasks.center, approvals.waiting, running);
  const greet = t(greetingKey());
  const line = counts.waiting
    ? t("homeWaiting", { greet, count: counts.waiting })
    : counts.working
      ? t("homeWorking", { greet, count: counts.working })
      : t("homeIdle", { greet });
  return (
    <View style={{ paddingTop: 10 }}>
      <Text style={[type.caption, { color: colors.text2, paddingHorizontal: 20 }]}>{line}</Text>
      <StatRow
        stats={[
          { label: t("statWorking"), value: counts.working },
          { label: t("statWaiting"), value: counts.waiting, warn: true },
          { label: t("statDoneToday"), value: counts.doneToday },
        ]}
      />
    </View>
  );
}
/** A list row that re-renders only when its conversation or marks change, not with the page. */
const Row = memo(function Row({
  row,
  pinned,
  unread,
  running,
  waiting,
  unavailable,
  onOpen,
}: {
  row: Conversation;
  pinned: boolean;
  unread: boolean;
  running: boolean;
  waiting?: string;
  unavailable: boolean;
  onOpen: (row: Conversation) => void;
}) {
  return (
    <ConversationRow
      row={row}
      pinned={pinned}
      unread={unread}
      running={running}
      waiting={waiting}
      unavailable={unavailable}
      onPress={() => onOpen(row)}
    />
  );
});
const rowKey = (row: Conversation) => row.key;
const RowGap = () => <View style={{ height: 2 }} />;
const SKELETON = ["a", "b", "c", "d", "e"].map((key) => <Skeleton key={key} />);
/** The desktop sidebar as a page: pinned chats first, then every chat by last activity. */
export function ChatListScreen() {
  const colors = useColors(),
    t = useText(),
    language = useLanguage(),
    router = useRouter(),
    runtime = useRuntime(),
    mobile = useMobileSelector((s) => ({
      status: s.status,
      reconnecting: s.reconnecting,
      devices: s.devices,
      selectedId: s.selectedId,
    })),
    list = useConversations(),
    approvals = useApprovals(),
    offline = useOffline();
  const [query, setQuery] = useState("");
  const [offlineDetails, setOfflineDetails] = useState(false);
  const opening = useRef(0);
  const tabInset = useTabBarInset();
  const online = mobile.status === "online";
  const connecting = mobile.status === "connecting";
  const canReplyOffline = offline.unreachable && offline.ready.length > 0;
  const computer = mobile.devices.find((d) => d.id === mobile.selectedId)?.name ?? "";
  const inbox = useRemoteValue(
    approvals.total > 0 ? "chat-list-approval-origins" : undefined,
    (signal) => runtime.call("inbox.list", { kind: "approval", limit: 50 }, signal),
    ["inbox.changed", "approval.requested", "approval.resolved"],
  );
  const rows = useMemo(() => {
    if (query) {
      const match = query.trim().toLowerCase();
      return list.rows.filter((row) => row.name.toLowerCase().includes(match));
    }
    // Old cached pins keep their activity order until the next sync supplies their positions.
    const pinned = list.rows
      .filter((row) => row.pinned)
      .sort(
        (a, b) => (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER),
      );
    return [...pinned, ...list.rows.filter((row) => !row.pinned)];
  }, [list.rows, query]);
  // One pass over the approvals instead of a search per row: the waiting line of each chat.
  const waitingByKey = useMemo(() => {
    const groupTopics = new Set(
      list.rows.flatMap((row) => (row.kind === "group" && row.topicId ? [row.topicId] : [])),
    );
    const groupByTopic = new Map(
      list.rows.flatMap((row) =>
        row.kind === "group" && row.topicId ? [[row.topicId, row.key] as const] : [],
      ),
    );
    const byKey = new Map<string, string>();
    const grouped = new Set<string>();
    for (const item of inbox.value ?? []) {
      if (item.kind !== "approval") continue;
      const { approval, origin } = item;
      if (!origin?.groupId) continue;
      grouped.add(approval.id);
      const key = conversationKey("group", origin.groupId);
      if (!byKey.has(key))
        byKey.set(
          key,
          `${origin.botName ?? t("gpMember")} · ${approvalText(approval, language).title}`,
        );
    }
    for (const card of approvals.items) {
      const groupKey = groupByTopic.get(card.conversationId ?? "");
      const botKey =
        grouped.has(card.id) || groupTopics.has(card.conversationId ?? "")
          ? undefined
          : conversationKey("bot", card.botId);
      const title = approvalText(card, language).title;
      const bot = list.bots.get(card.botId)?.name;
      // The first pending card of a chat names it, as the per-row search did.
      if (groupKey && !byKey.has(groupKey)) byKey.set(groupKey, bot ? `${bot}：${title}` : title);
      if (botKey && !byKey.has(botKey)) byKey.set(botKey, title);
    }
    return byKey;
  }, [list.rows, list.bots, approvals.items, inbox.value, language, t]);
  const open = useCallback(
    async (row: Conversation) => {
      const request = ++opening.current;
      const pathname = "/conversation/[kind]/[id]";
      const params = { kind: row.kind, id: row.id };
      // Older or disconnected computers can still open the chat normally.
      const approval =
        row.kind === "group" && online && waitingByKey.has(row.key)
          ? await runtime
              .call("approvals.groupFocus", { groupId: row.id }, undefined, 4_000)
              .catch(() => null)
          : null;
      if (request !== opening.current) return;
      router.push({
        pathname,
        params: approval
          ? { ...params, topic: approval.topicId, approvalFocus: approval.approvalId }
          : params,
      });
    },
    [online, router, runtime, waitingByKey],
  );
  const header = (
    <View style={{ paddingBottom: 2 }}>
      <SearchField value={query} onChangeText={setQuery} placeholder={t("search")} />
      {!online && (
        <View style={{ marginHorizontal: space.page, marginBottom: 10 }}>
          {connecting ? (
            <Banner
              tone="accent"
              icon="spinner"
              text={
                mobile.reconnecting ? t("reconnecting") : t("listConnecting", { name: computer })
              }
            />
          ) : (
            // "sends when the computer is back" only when the phone cannot answer itself.
            <OfflineBanner
              text={t(canReplyOffline ? "listOfflinePhone" : "listOffline")}
              onDetails={() => setOfflineDetails(true)}
              singleLine
            />
          )}
        </View>
      )}
      <ErrorLine text={list.action.error && t(list.action.error)} />
    </View>
  );
  const empty =
    connecting && !list.rows.length ? (
      <View style={{ gap: 2 }}>{SKELETON}</View>
    ) : !rows.length && !list.action.busy ? (
      <EmptyState
        icon="message"
        title={query ? t("noMatch") : t("noChats")}
        hint={query ? undefined : t("noChatsHint")}
      />
    ) : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader
        title={t("chat")}
        tab="chat"
        subtitle={<ComputerStatus />}
        actions={
          <>
            <HeaderPill title={t("contacts")} onPress={() => router.push("/contacts")} />
            <HeaderPill
              icon="plus"
              label={t("newGroup")}
              disabled={!online}
              onPress={() => router.push("/settings/new-group")}
            />
          </>
        }
      >
        <HomeSummary />
      </TabHeader>
      <OfflineDetailsSheet
        visible={offlineDetails}
        can={canReplyOffline ? t("offlineDetailsList") : undefined}
        wait={!canReplyOffline ? t("offlineDetailsListWait") : undefined}
        onClose={() => setOfflineDetails(false)}
      />
      {/* Virtualized: a computer with hundreds of Bots and groups mounts only the rows on screen. */}
      <FlatList
        data={rows}
        keyExtractor={rowKey}
        renderItem={({ item: row }) => (
          <Row
            row={row}
            pinned={!query && !!row.pinned}
            unread={list.unread.has(row.key)}
            running={
              online &&
              !!list.running[row.key] &&
              (row.kind !== "group" || !waitingByKey.has(row.key))
            }
            waiting={waitingByKey.get(row.key)}
            unavailable={!online && !!row.agent}
            onOpen={open}
          />
        )}
        ItemSeparatorComponent={RowGap}
        ListHeaderComponent={header}
        ListFooterComponent={rows.length ? <View style={{ height: 8 }} /> : undefined}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: tabInset }}
        initialNumToRender={14}
        maxToRenderPerBatch={10}
        windowSize={11}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => void list.load()}
            tintColor={colors.text2}
          />
        }
      />
    </View>
  );
}
