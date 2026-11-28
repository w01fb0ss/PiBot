import { ImportSourceSchema, type Message } from "@pibot/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Text, View } from "react-native";
import { z } from "zod";
import { useOffline, useOfflineEngine } from "../../offline/OfflineProvider.tsx";
import { useSharedText, useText } from "../../runtime/context.tsx";
import { PageTint } from "../../theme/page-tint.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { Banner, EmptyState, ErrorLine } from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { LeaveGuard } from "../../ui/leave-guard.tsx";
import { useToast } from "../../ui/toast.tsx";
import { AttachmentTray } from "../compose/AttachmentTray.tsx";
import { ConversationAvatar } from "../conversations/ConversationRow.tsx";
import { OfflineChatView } from "../offline/OfflineChatView.tsx";
import { OfflineDetailsSheet } from "../offline/OfflineDetailsSheet.tsx";
import { usePlanBots } from "../offline/plan-bots.ts";
import { ChatThread, type ThreadHandle } from "./ChatThread.tsx";
import { Composer } from "./Composer.tsx";
import { ControlStrip } from "./ControlStrip.tsx";
import type { ChatScope } from "./controls/scope.ts";
import { ChatSheets, type SheetState } from "./sheets/ChatSheets.tsx";
import { type ChatPage, useChatPage } from "./use-chat-page.ts";

// `topic` and `focus`: a record opens its own topic at the related message.
const ParamsSchema = z.object({
  kind: z.enum(["bot", "group"]),
  id: z.uuid(),
  topic: z.uuid().optional(),
  focus: z.uuid().optional(),
  approvalFocus: z.uuid().optional(),
  /** 新开计划 from the inbox: the old plan's goal, put in the input to edit and send. */
  draft: z.string().max(8_000).optional(),
});
export function ChatScreen() {
  const params = ParamsSchema.safeParse(useLocalSearchParams());
  const router = useRouter(),
    t = useText();
  // With the computer unreachable, a Bot that is ready on the phone answers here instead.
  useOffline(); // re-render when the phone's offline state changes
  const offline = useOfflineEngine();
  // The typed text survives the switch between the computer's chat and the phone's offline chat
  // (v0.0.2: a message waiting in the composer was lost when the link came back).
  const draft = useRef(params.success ? (params.data.draft ?? "") : "");
  if (params.success && params.data.kind === "bot" && offline.canReply(params.data.id))
    return <OfflineChatView botId={params.data.id} topic={params.data.topic} draft={draft} />;
  if (!params.success)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title="" onBack={() => router.back()} />
        <EmptyState icon="message" title={t("stale")} />
      </View>
    );
  return (
    <ChatView
      key={`${params.data.kind}:${params.data.id}:${params.data.topic ?? ""}:${params.data.focus ?? ""}:${params.data.approvalFocus ?? ""}`}
      kind={params.data.kind}
      id={params.data.id}
      topic={params.data.topic}
      focus={params.data.focus}
      approvalFocus={params.data.approvalFocus}
      draft={draft}
    />
  );
}
/**
 * In v0.0.2 the chip said "Bot's own folder" before the folders were read and for a folder the
 * list hides, while the run used a folder on an offline runner. It names only what it knows.
 */
function folderChip(workplace: ChatPage["workplace"], t: ReturnType<typeof useText>) {
  if (!workplace.enabled || workplace.isHome === undefined) return t("folderTitle");
  const name = workplace.isHome ? t("folderHome") : (workplace.currentName ?? t("folderOther"));
  return workplace.runnerOffline ? t("folderRunnerOffline", { name }) : name;
}
function subtitle(
  page: ChatPage,
  t: ReturnType<typeof useText>,
  translate: ReturnType<typeof useSharedText>,
) {
  const status = !page.online
    ? t(
        page.reconnecting
          ? "reconnecting"
          : page.connecting
            ? "connecting"
            : page.entry?.agent
              ? "agentNeedsComputer"
              : "offline",
      )
    : page.chat.runId
      ? t("replying")
      : page.kind === "group"
        ? t("groupMembers", { count: page.entry?.looks.length ?? 0 })
        : t("idle");
  const source = ImportSourceSchema.safeParse(page.topics.importSource);
  const imported = source.success
    ? translate("conversationImport.topicSource", {
        source: translate(`conversationImport.source.${source.data}`),
      })
    : page.topics.importSource
      ? translate("conversationImport.importedTopic")
      : undefined;
  return [imported, `# ${page.topics.title || t("untitledTopic")}`, status]
    .filter(Boolean)
    .join(" · ");
}
/** Where the composer sits while an agent Bot's computer is offline. */
function AgentOfflineBar() {
  const colors = useColors(),
    t = useText();
  return (
    <View
      accessibilityRole="text"
      style={{
        marginHorizontal: 12,
        marginBottom: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: colors.b1,
        backgroundColor: colors.tert,
      }}
    >
      <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text2, textAlign: "center" }}>
        {t("offlineHintAgent")}
      </Text>
    </View>
  );
}
/**
 * Computer offline and this chat cannot be answered on the phone (else ChatScreen shows the
 * offline chat): say why at once, so nobody waits for a reply that only the computer can give.
 */
function OfflineHint({
  kind,
  botId,
  onDetails,
}: {
  kind: "bot" | "group";
  botId: string;
  onDetails: () => void;
}) {
  const offline = useOffline(),
    t = useText();
  const manifest = offline.manifest;
  const bot = manifest?.bots.find((row) => row.id === botId);
  const plan = usePlanBots(offline.computerId, kind === "bot" ? [botId] : []);
  const key =
    kind === "group"
      ? "offlineHintGroup"
      : !manifest
        ? "offlineHintNotSynced"
        : bot?.offline && !bot.grantId && plan.has(botId)
          ? "offlineHintPlan"
          : !manifest.models.some((model) => model.delivered)
            ? "offlineHintNoModel"
            : !bot?.offline
              ? "offlineHintBotOff"
              : "offlineHintNotReady";
  return (
    <Banner text={t(key)} singleLine action={{ title: t("offlineHintOpen"), onPress: onDetails }} />
  );
}
function ChatView({
  kind,
  id,
  topic,
  focus,
  approvalFocus,
  draft,
}: {
  kind: "bot" | "group";
  id: string;
  topic?: string;
  focus?: string;
  approvalFocus?: string;
  draft: RefObject<string>;
}) {
  const page = useChatPage(kind, id, topic);
  const colors = useColors(),
    t = useText(),
    shared = useSharedText(),
    toast = useToast(),
    router = useRouter();
  const [sheet, setSheet] = useState<SheetState>();
  const [offlineDetails, setOfflineDetails] = useState(false);
  const thread = useRef<ThreadHandle>(null);
  const { composer, chat } = page;
  // After the composer's own reset on mount (its effect runs first).
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeded once, on mount.
  useEffect(() => {
    if (draft.current) composer.setText(draft.current);
  }, []);
  useEffect(() => {
    draft.current = composer.text;
  }, [composer.text, draft]);
  // A Bot without any topic yet gets one on its first message, as on the desktop.
  const canCreate = kind === "bot" && page.online;
  const send = async () => {
    // Maintainers 2026-11-12: after sending, the thread showed the previous message. The bottom was
    // re-pinned only after the send returned, but the new message and reply arrived during it.
    thread.current?.toLatest();
    let topic: ChatScope | undefined;
    if (!page.scope) {
      const topicId = canCreate ? await page.topics.create() : undefined;
      if (!topicId) return;
      topic = { kind, id, topicId };
    }
    const outcome = await composer.send(topic);
    if (outcome === "followUp") toast(t("followUpQueued"));
    thread.current?.toLatest();
  };
  const stop = async () => {
    if (!chat.runId) return;
    if ((await chat.stop(chat.runId)) === undefined) return;
    toast(t("stopped"));
    page.setStopNotice(true);
  };
  const retry = async (source: Message) => {
    if ((await page.retry.prepare(source.id)) !== undefined) setSheet({ kind: "retry" });
  };
  // The computer's Bot browser, live; the phone itself never opens the page.
  const openBrowser = () =>
    router.push(
      `/browser/${id}${page.scope?.topicId ? `?topic=${encodeURIComponent(page.scope.topicId)}` : ""}`,
    );
  const placeholder = !page.online
    ? t(page.reconnecting ? "reconnecting" : page.connecting ? "connecting" : "placeholderOffline")
    : kind === "group"
      ? t("placeholderGroup")
      : t("placeholder");
  // An external agent runs only on the computer; offline its history stays readable and
  // the composer gives way to one line saying why (never the phone's own model, never a spinner).
  const agentOffline = kind === "bot" && !!page.entry?.agent && !page.online && !page.connecting;
  // The chat carries the Bot's colour (a group's is violet, as its bubbles).
  const tint = kind === "bot" ? (page.entry?.looks[0]?.color ?? "violet") : "violet";
  return (
    <PageTint name={tint}>
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: colors.bg }}
        // Android 15+ draws edge-to-edge, so the system no longer resizes the window for the
        // keyboard; the composer must be lifted on both platforms.
        behavior="padding"
      >
        <NavBar
          title={page.entry?.name ?? ""}
          subtitle={subtitle(page, t, shared)}
          lead={
            page.entry && (
              <ConversationAvatar
                row={page.entry}
                size={32}
                state={page.online && chat.runId ? "working" : "idle"}
              />
            )
          }
          titleHint={t("switchTopic")}
          onBack={() => router.back()}
          onTitlePress={() => setSheet({ kind: "topics" })}
          onMore={() => setSheet({ kind: "more" })}
        />
        <ControlStrip
          folder={folderChip(page.workplace, t)}
          plan={
            page.plan.items.length
              ? { done: page.plan.done, total: page.plan.items.length }
              : undefined
          }
          tasks={
            page.groupPlan.view
              ? {
                  done: page.groupPlan.view.done,
                  total: page.groupPlan.view.total,
                  attention: page.groupPlan.view.retryable.size > 0,
                }
              : undefined
          }
          changes={page.changes.files.length}
          yolo={page.yolo.enabled}
          open={(kind) => setSheet({ kind })}
          browser={
            page.browser.open
              ? { takeover: page.browser.takeover, onPress: openBrowser }
              : undefined
          }
        />
        {!page.online && !page.connecting && !agentOffline && (
          <View style={{ marginHorizontal: 16, marginTop: 4 }}>
            <OfflineHint kind={kind} botId={id} onDetails={() => setOfflineDetails(true)} />
          </View>
        )}
        <ErrorLine text={page.error && t(page.error)} />
        <ChatThread
          ref={thread}
          page={page}
          focus={focus}
          approvalFocus={approvalFocus}
          onMessage={(message) => setSheet({ kind: "message", message })}
          onRetry={(source) => void retry(source)}
        />
        {agentOffline ? (
          <AgentOfflineBar />
        ) : (
          <Composer
            text={composer.text}
            onChangeText={composer.setText}
            onCaret={composer.setCaret}
            mentions={composer.mentionOptions}
            onMention={composer.pickMention}
            placeholder={placeholder}
            modeLabel={t(page.mode.mode === "plan" ? "modePlan" : "modeExecute")}
            running={!!chat.runId}
            sending={
              composer.action.busy ||
              composer.attachments.preparing ||
              page.topics.write.busy ||
              (!page.scope && !canCreate)
            }
            attached={composer.attachments.files.length > 0}
            tray={
              <AttachmentTray
                files={composer.attachments.files}
                preparing={composer.attachments.preparing}
                disabled={composer.action.busy}
                hint={composer.steering ? t("attachAfterReply") : undefined}
                onRemove={composer.attachments.remove}
              />
            }
            stopping={chat.stopAction.busy}
            onPlus={() => setSheet({ kind: "plus" })}
            onMode={() => setSheet({ kind: "mode" })}
            onSend={() => void send()}
            onStop={() => void stop()}
            suggestion={
              page.suggestion && {
                text: shared(page.suggestion.key),
                label: t("suggest", { text: shared(page.suggestion.key) }),
                onAccept: () => {
                  const key = page.suggestion?.key;
                  page.dismissSuggestion();
                  if (key) composer.setText(shared(key));
                },
              }
            }
          />
        )}
        <ChatSheets
          page={page}
          sheet={sheet}
          setSheet={setSheet}
          onBrowser={openBrowser}
          onApproval={(id) => thread.current?.focusApproval(id)}
        />
        <OfflineDetailsSheet
          visible={offlineDetails}
          wait={t("offlineUnavailable")}
          onClose={() => setOfflineDetails(false)}
        />
        <LeaveGuard
          // A send in flight owns its text and files already; only what is still typed is a draft.
          dirty={
            !composer.action.busy &&
            (!!composer.text.trim() ||
              composer.attachments.files.length > 0 ||
              composer.attachments.preparing)
          }
          title={t("leaveDraftTitle")}
          text={t("leaveDraftText")}
        />
      </KeyboardAvoidingView>
    </PageTint>
  );
}
