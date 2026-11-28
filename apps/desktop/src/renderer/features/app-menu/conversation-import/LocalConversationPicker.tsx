import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./conversation-import.module.css";
import {
  type ConversationList,
  type LocalSource,
  MAX_CONVERSATION_SELECTION,
  marks,
  sourceLogos,
} from "./import-state.ts";
import type { ImportDraft } from "./use-import-draft.ts";

function formatUpdatedAt(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function LocalConversationPicker({
  source,
  list,
  draft,
  disabled,
  error,
}: {
  source: LocalSource;
  list: ConversationList;
  draft: ImportDraft;
  disabled: boolean;
  error?: ReactNode;
}) {
  const t = useT();
  const [queryInput, setQueryInput] = useState(draft.listQuery);
  const mounted = useRef(false);
  const search = draft.searchConversations;

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const timer = setTimeout(() => search(queryInput), 220);
    return () => clearTimeout(timer);
  }, [queryInput, search]);

  const sourceLabel = t(`conversationImport.source.${source}`);
  const logo = sourceLogos[source];
  const selectedSet = new Set(draft.selectedIds);
  const atLimit = draft.selectedIds.length >= MAX_CONVERSATION_SELECTION;
  const canProceed =
    (list.canExportContent && draft.selectedIds.length > 0) ||
    draft.includeMemory ||
    draft.includeProjectRules;
  const introKey =
    list.hasMemory && list.hasProjectRules
      ? "conversationImport.listIntro"
      : list.hasMemory
        ? "conversationImport.listIntroMemoryOnly"
        : list.hasProjectRules
          ? "conversationImport.listIntroRulesOnly"
          : "conversationImport.listIntroChatsOnly";

  return (
    <div className={styles.listView} data-dialog-body="split">
      <div className={styles.scrollBody}>
        <div className={styles.strip}>
          {logo ? (
            <img className={styles.stripLogo} src={logo} alt="" />
          ) : (
            <span className={styles.monogram} aria-hidden="true">
              {marks[source]}
            </span>
          )}
          <span className={styles.stripText}>
            <strong>{t("conversationImport.listTitle", { source: sourceLabel })}</strong>
            <small>{t(introKey, { max: MAX_CONVERSATION_SELECTION })}</small>
            {source === "claude-code" && <small>{t("conversationImport.listClaudePrivacy")}</small>}
          </span>
        </div>

        {!list.canExportContent && (
          <p className={styles.notice} role="status">
            {t(
              `conversationImport.cannotExport.${list.cannotExportReason ?? "unsupported"}` as const,
              { source: sourceLabel },
            )}
          </p>
        )}

        {(list.hasMemory || list.hasProjectRules) && (
          <div className={styles.listExtras}>
            {list.hasMemory && (
              <label className={styles.extraOption}>
                <input
                  type="checkbox"
                  checked={draft.includeMemory}
                  disabled={disabled}
                  onChange={(event) => draft.setIncludeMemory(event.target.checked)}
                />
                <span className={styles.extraText}>
                  <strong>
                    {t("conversationImport.includeLocalMemory", { source: sourceLabel })}
                  </strong>
                  <small>{t("conversationImport.includeLocalMemoryNote")}</small>
                </span>
              </label>
            )}
            {list.hasProjectRules && (
              <label className={styles.extraOption}>
                <input
                  type="checkbox"
                  checked={draft.includeProjectRules}
                  disabled={disabled}
                  onChange={(event) => draft.setIncludeProjectRules(event.target.checked)}
                />
                <span className={styles.extraText}>
                  <strong>{t("conversationImport.includeProjectRules")}</strong>
                  <small>{t("conversationImport.includeProjectRulesNote")}</small>
                </span>
              </label>
            )}
          </div>
        )}

        <div className={styles.listToolbar}>
          <input
            type="search"
            className={styles.searchInput}
            value={queryInput}
            placeholder={t("conversationImport.listSearch")}
            aria-label={t("conversationImport.listSearch")}
            onChange={(event) => setQueryInput(event.target.value)}
          />
          <span className={styles.listMeta} role="status">
            {t("conversationImport.listCount", {
              total: list.total,
              selected: draft.selectedIds.length,
              max: MAX_CONVERSATION_SELECTION,
            })}
          </span>
          {draft.selectedIds.length > 0 && (
            <button
              type="button"
              className={styles.link}
              disabled={disabled}
              onClick={draft.clearSelectedConversations}
            >
              {t("conversationImport.listClear")}
            </button>
          )}
        </div>

        {list.items.length === 0 ? (
          <p className={styles.intro}>
            {t(
              queryInput.trim() ? "conversationImport.listNoMatch" : "conversationImport.listEmpty",
            )}
          </p>
        ) : (
          <ul className={styles.convList}>
            {list.items.map((item) => {
              const checked = selectedSet.has(item.id);
              const rowDisabled =
                disabled || !list.canExportContent || !!item.inProgress || (!checked && atLimit);
              const metaParts = [formatUpdatedAt(item.updatedAt), item.project].filter(Boolean);
              return (
                <li key={item.id} className={styles.convItem}>
                  <label
                    className={styles.convRow}
                    data-disabled={rowDisabled || undefined}
                    title={
                      item.inProgress ? t("conversationImport.error.source_in_use") : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={rowDisabled}
                      onChange={() => draft.toggleConversation(item.id)}
                    />
                    <span className={styles.convBody}>
                      <span className={styles.convTitleRow}>
                        <span className={styles.convTitle} dir="auto">
                          {item.title}
                        </span>
                        {item.inProgress && (
                          <span className={styles.inProgressBadge}>
                            {t("conversationImport.listInProgress")}
                          </span>
                        )}
                      </span>
                      {metaParts.length > 0 && (
                        <span className={styles.convMeta} dir="auto">
                          {metaParts.join(" · ")}
                        </span>
                      )}
                      {item.inProgress && (
                        <span className={styles.convInUseNote}>
                          {t("conversationImport.error.source_in_use")}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
            {list.next !== null && (
              <li className={styles.more}>
                <Button variant="ghost" disabled={disabled} onClick={draft.loadMoreConversations}>
                  {t("conversationImport.listMore")}
                </Button>
              </li>
            )}
          </ul>
        )}

        {draft.busy && (
          <p className={styles.intro} role="status">
            {t(`conversationImport.loading.${draft.busy}`)}
          </p>
        )}
        {error}
      </div>

      <footer className={styles.footer}>
        <Button variant="secondary" disabled={disabled} onClick={draft.closeConversationList}>
          {t("conversationImport.listBack")}
        </Button>
        <Button variant="secondary" disabled={disabled} onClick={draft.pick}>
          {t("conversationImport.pickLocal")}
        </Button>
        <span className={styles.footerSpacer} />
        <Button disabled={disabled || !canProceed} onClick={draft.previewSelected}>
          {t("conversationImport.listNext")}
        </Button>
      </footer>
    </div>
  );
}
