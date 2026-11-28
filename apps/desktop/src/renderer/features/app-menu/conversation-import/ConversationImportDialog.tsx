import { hostPlatform, useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useId, useState } from "react";
import { AppDialog } from "../AppDialog.tsx";
import styles from "./conversation-import.module.css";
import { ImportHistory } from "./ImportHistory.tsx";
import { ImportPreview } from "./ImportPreview.tsx";
import { ImportProgress } from "./ImportProgress.tsx";
import {
  type ConsumerSource,
  codingSources,
  consumerSources,
  importErrorForSource,
  isConsumerSource,
  isLocalSource,
  type LocalSource,
  marks,
  type Source,
  type Status,
  sourceLogos,
  startParams,
} from "./import-state.ts";
import { LocalConversationPicker } from "./LocalConversationPicker.tsx";
import { UndoImportConfirmation } from "./UndoImportConfirmation.tsx";
import { useImportDraft } from "./use-import-draft.ts";
import { useImportJob } from "./use-import-job.ts";

const EXPORT_URLS: Record<ConsumerSource, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
  gemini: "https://takeout.google.com/",
};

const sessionPaths: Record<LocalSource, readonly string[]> = {
  "claude-code": [".claude", "projects", "<project>", "<session-id>.jsonl"],
  codex: [".codex", "sessions", "<year>", "<month>", "<day>", "rollout-*.jsonl"],
  cursor: [".cursor", "projects", "<project>", "agent-transcripts", "<session-id>.jsonl"],
  opencode: [".local", "share", "opencode", "opencode.db"],
  antigravity: [".gemini", "antigravity-cli", "conversation_summaries.db"],
};

function pickerHint(source: Source, t: ReturnType<typeof useT>) {
  if (!isLocalSource(source)) return;
  const separator = hostPlatform() === "win32" ? "\\" : "/";
  return t(`conversationImport.pickHint.${source}`, {
    path: ["~", ...sessionPaths[source]].join(separator),
    rule: [".cursor", "rules", "*.mdc"].join(separator),
    notes: ["~", ".claude", "projects", "<project>", "memory", "*.md"].join(separator),
  });
}

function SourceTile({
  source,
  selected,
  disabled,
  onClick,
}: {
  source: Source;
  selected: boolean;
  disabled: boolean;
  onClick(): void;
}) {
  const t = useT();
  const logo = sourceLogos[source];
  return (
    <button
      type="button"
      className={styles.sourceTile}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {logo ? (
        <img className={styles.sourceLogo} src={logo} alt="" aria-hidden="true" />
      ) : (
        <span className={styles.sourceMark} aria-hidden="true">
          {marks[source]}
        </span>
      )}
      <span className={styles.sourceText}>
        <strong>{t(`conversationImport.source.${source}`)}</strong>
        <span className={styles.sourceNote}>{t(`conversationImport.sourceNote.${source}`)}</span>
      </span>
    </button>
  );
}

export function ConversationImportDialog({ open, close }: { open: boolean; close(): void }) {
  const t = useT();
  const { peer } = useRpc();
  const { openImportedTopic, openWorkspace } = useNavigation();
  const draft = useImportDraft();
  const hintId = useId();
  const running = useImportJob(draft.refreshProjectReviews);
  const [undoTarget, setUndoTarget] = useState<Status>();
  const [codingOpen, setCodingOpen] = useState(false);
  const [pathsOpen, setPathsOpen] = useState(false);
  const [linkErrorSource, setLinkErrorSource] = useState<ConsumerSource>();
  // Keep the batch subscription mounted when the existing inbox opens for project approval.
  if (!open) return null;
  const { preview } = draft;
  const hint = pickerHint(draft.source, t);
  const consumerSource = isConsumerSource(draft.source) ? draft.source : undefined;
  const localSelected = isLocalSource(draft.source);
  const showCoding = codingOpen;
  const openExportLink = (target: ConsumerSource) => {
    if (!peer) return;
    setLinkErrorSource(undefined);
    void peer.call("app.openLink", { url: EXPORT_URLS[target] }).catch(() => {
      setLinkErrorSource(target);
    });
  };
  const status = running.job?.status;
  const title = undoTarget
    ? "conversationImport.undoConfirm.title"
    : status?.cleanupBlocked
      ? "conversationImport.cleanupBlocked"
      : status?.cleanup === "discarding"
        ? "conversationImport.cleaning"
        : status
          ? (`conversationImport.state.${status.state}` as const)
          : running.job
            ? "conversationImport.confirming"
            : "conversationImport.title";
  const busy = !!draft.busy || !!running.busy || !peer;
  const params =
    preview &&
    startParams({
      preview,
      plan: draft.plan,
      botId: draft.botId,
      conversations: draft.conversations,
      projects: draft.projects,
      memories: draft.memories
        .filter((memory) => draft.memoryOn(memory))
        .map((memory) => ({ id: memory.id, target: draft.memoryTarget(memory) })),
      persona:
        draft.persona.on && draft.persona.review
          ? { reviewId: draft.persona.review.reviewId, botId: draft.persona.botId }
          : undefined,
      quote: draft.distillationOn ? draft.quote : undefined,
    });
  const release = () => {
    setUndoTarget(undefined);
    setLinkErrorSource(undefined);
    setPathsOpen(false);
    setCodingOpen(false);
    if (!running.job) draft.back();
    close();
  };
  const openTopics = (status: Status) => {
    const topic = status.importedTopics?.[0];
    if (!topic) return;
    close();
    openImportedTopic(topic.botId, topic.topicId, status.topics > 1 ? status.importId : undefined);
  };
  const error = (draft.error || running.error) && (
    <p className={styles.error} role="alert">
      {t(
        importErrorForSource(
          draft.error ?? running.error ?? "conversationImport.error.internal",
          preview?.source ?? draft.listSource ?? draft.source,
        ),
      )}
    </p>
  );
  return (
    <AppDialog
      title={t(title)}
      kind="conversation-import"
      mark={{ icon: "download", tone: "teal" }}
      busy={draft.busy === "preview" || draft.busy === "list" || running.busy === "start"}
      close={release}
    >
      {undoTarget ? (
        <UndoImportConfirmation
          status={undoTarget}
          disabled={busy}
          cancel={() => setUndoTarget(undefined)}
          confirm={() => {
            setUndoTarget(undefined);
            if (status?.importId === undoTarget.importId) running.undo();
            else running.undoPast(undoTarget);
          }}
        />
      ) : running.job ? (
        <ImportProgress
          running={running}
          confirmUndo={setUndoTarget}
          restart={() => {
            running.clear();
            draft.back();
            if (status?.reason === "project_review_changed") draft.pick();
          }}
          openInbox={() => {
            close();
            openWorkspace({ name: "inbox" });
          }}
          openTopics={openTopics}
          close={close}
        />
      ) : preview ? (
        <ImportPreview
          draft={draft}
          preview={preview}
          disabled={busy && draft.busy !== "project"}
          error={error}
          cancel={release}
          start={params && draft.busy !== "project" ? () => running.start(params) : undefined}
        />
      ) : draft.conversationList && draft.listSource ? (
        <LocalConversationPicker
          source={draft.listSource}
          list={draft.conversationList}
          draft={draft}
          disabled={busy}
          error={error}
        />
      ) : (
        <>
          <p className={styles.intro}>{t("conversationImport.chooseSource")}</p>
          <div className={styles.sourceGroup}>
            <div className={styles.sourceGroupHead}>{t("conversationImport.group.consumer")}</div>
            <fieldset
              className={styles.sources}
              aria-label={t("conversationImport.group.consumer")}
              disabled={busy}
            >
              {consumerSources.map((source) => (
                <SourceTile
                  key={source}
                  source={source}
                  selected={source === draft.source}
                  disabled={busy}
                  onClick={() => {
                    setLinkErrorSource(undefined);
                    setPathsOpen(false);
                    draft.selectSource(source);
                  }}
                />
              ))}
            </fieldset>
          </div>
          {consumerSource && (
            <div className={styles.guide} id={hintId}>
              <div className={styles.guideHead}>
                <strong>
                  {t("conversationImport.exportGuide.title", {
                    source: t(`conversationImport.source.${consumerSource}`),
                  })}
                </strong>
                {peer && (
                  <button
                    type="button"
                    className={styles.link}
                    disabled={busy}
                    onClick={() => openExportLink(consumerSource)}
                  >
                    {t(`conversationImport.exportGuide.openLink.${consumerSource}`)}
                  </button>
                )}
              </div>
              <p className={styles.guideSteps}>
                {t(`conversationImport.exportGuide.${consumerSource}`)}
              </p>
              {linkErrorSource === consumerSource && (
                <div className={styles.guideError} role="alert">
                  <span>{t("conversationImport.exportGuide.openLinkError")}</span>
                  {peer && (
                    <button
                      type="button"
                      className={styles.link}
                      disabled={busy}
                      onClick={() => openExportLink(consumerSource)}
                    >
                      {t("common.retry")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className={styles.sourceGroup}>
            <button
              type="button"
              className={styles.codingToggle}
              aria-expanded={showCoding}
              onClick={() => setCodingOpen((openState) => !openState)}
            >
              <Icon
                name="chevronRight"
                size={13}
                className={styles.codingCaret}
                style={{ transform: showCoding ? "rotate(90deg)" : undefined }}
              />
              <span>{t("conversationImport.group.coding")}</span>
              {!showCoding && (
                <small className={styles.codingSummary}>
                  {localSelected
                    ? t(`conversationImport.source.${draft.source}`)
                    : t("conversationImport.group.codingSummary")}
                </small>
              )}
            </button>
            {showCoding && (
              <fieldset
                className={styles.sources}
                aria-label={t("conversationImport.group.coding")}
                disabled={busy}
              >
                {codingSources.map((source) => (
                  <SourceTile
                    key={source}
                    source={source}
                    selected={source === draft.source}
                    disabled={busy}
                    onClick={() => {
                      setLinkErrorSource(undefined);
                      setPathsOpen(false);
                      setCodingOpen(true);
                      draft.selectSource(source);
                    }}
                  />
                ))}
              </fieldset>
            )}
          </div>
          {localSelected && (
            <div className={styles.localHintWrap}>
              <p className={styles.intro} id={hintId}>
                {t("conversationImport.localHintPlain", {
                  source: t(`conversationImport.source.${draft.source}`),
                })}
                {draft.source === "claude-code" && ` ${t("conversationImport.listClaudePrivacy")}`}
              </p>
              {hint && (
                <div className={styles.advancedWrap}>
                  <button
                    type="button"
                    className={styles.advancedToggle}
                    aria-expanded={pathsOpen}
                    onClick={() => setPathsOpen((openState) => !openState)}
                  >
                    <Icon
                      name="chevronRight"
                      size={12}
                      className={styles.codingCaret}
                      style={{ transform: pathsOpen ? "rotate(90deg)" : undefined }}
                    />
                    <span>{t("conversationImport.localHintAdvancedToggle")}</span>
                  </button>
                  {pathsOpen && <p className={styles.advancedBody}>{hint}</p>}
                </div>
              )}
            </div>
          )}
          {draft.busy && (
            <p className={styles.intro} role="status">
              {t(`conversationImport.loading.${draft.busy}`)}
            </p>
          )}
          {error}
          <div className={styles.actions}>
            <Button variant="secondary" disabled={busy && !!peer} onClick={release}>
              {t("common.cancel")}
            </Button>
            {localSelected ? (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={draft.pick}
                  aria-describedby={hint ? hintId : undefined}
                >
                  {t("conversationImport.pickLocal")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={draft.openConversationList}
                  aria-describedby={hint ? hintId : undefined}
                >
                  {t("conversationImport.listConversations")}
                </Button>
              </>
            ) : (
              <Button
                disabled={busy}
                onClick={draft.pick}
                aria-describedby={consumerSource ? hintId : undefined}
              >
                {t("conversationImport.pickExport")}
              </Button>
            )}
          </div>
          <div className={styles.history}>
            <ImportHistory
              openTopics={openTopics}
              undo={(item) => {
                if (item.state === "completed" && !item.cleanup) setUndoTarget(item);
                else running.undoPast(item);
              }}
              disabled={busy}
            />
          </div>
        </>
      )}
    </AppDialog>
  );
}
