import type {
  Bot,
  Group,
  KnowledgeDetectResult,
  KnowledgeKind,
  KnowledgeSource,
  KnowledgeTargets,
} from "@pibot/plugins-contract/full";
import { useSettings } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectorAction } from "../../shell/remote.ts";
import { ConnectorFeedback } from "../ConnectorFeedback.tsx";
import { ConnectorPanel } from "../ConnectorPanel.tsx";
import styles from "../connections/connections.module.css";
import { FacePicker, Faces, resolveAccess } from "../connections/Faces.tsx";
import { knowledgeError } from "./errors.ts";
import { KnowledgeDetails } from "./KnowledgeDetails.tsx";
import { KIND_ICON, KIND_TONE } from "./kinds.ts";

/** A request from the page's 添加 menu; `at` makes the same kind clickable twice in a row. */
export type KnowledgeAddRequest = { kind: KnowledgeKind; at: number };

type PendingAdd =
  | { kind: "obsidian"; detected?: { name: string; path: string } }
  | { kind: "folder" }
  | { kind: "notion" };

function defaultTargetBots(bots: readonly Bot[]): string[] {
  const main = bots.find((bot) => bot.isMain) ?? bots[0];
  return main ? [main.id] : [];
}

/**
 * The 知识库 tab. Each row is a source the person already keeps elsewhere, with who may use it on
 * the right; adding happens here because only this tab knows what a source is.
 */
export function KnowledgeTab({
  sources,
  loading,
  error,
  retry,
  snapshot,
  changed,
  more,
  request,
  requestHandled,
  initialOpen,
  bots,
  groups,
  detection,
  detecting,
}: {
  sources: KnowledgeSource[];
  loading: boolean;
  error?: Parameters<typeof ConnectorFeedback>[0]["error"];
  retry(): void;
  snapshot: number;
  changed(): void;
  /** Loads the next page; absent once every source is in, so the button never dangles. */
  more?: () => void;
  request?: KnowledgeAddRequest;
  /** The page drops the request once this tab has taken it. */
  requestHandled?(): void;
  /** Opens a specific source's Details panel when deep-linked from chat. */
  initialOpen?: string;
  bots: Bot[];
  groups: Group[];
  /** What the host found on this computer; absent until the scan answers. */
  detection?: KnowledgeDetectResult;
  detecting: boolean;
}) {
  const { t, language } = useSettings();
  const action = useConnectorAction(changed, knowledgeError);
  const [open, setOpen] = useState<string | undefined>(initialOpen);
  const [repeatAdd, setRepeatAdd] = useState<string>();
  useEffect(() => {
    if (initialOpen) setOpen(initialOpen);
  }, [initialOpen]);
  const [notice, setNotice] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<PendingAdd>();
  const [selectedBots, setSelectedBots] = useState<string[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  // A brief confirmation, not a lasting notice: it fades on its own, as on the page itself.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const startAdd = useCallback(
    (next: PendingAdd) => {
      // If a Notion source already exists, still call `knowledge.addNotion` so a separately
      // removed managed connector is recreated (preserving the source and its assignments) before
      // opening Details.
      if (next.kind === "notion") {
        const existingNotion = sources.find((source) => source.kind === "notion");
        if (existingNotion) {
          void action
            .run((peer, signal) => peer.call("knowledge.addNotion", {}, { signal }))
            .then((result) => {
              if (result) setOpen(result.source.id);
            });
          return;
        }
      }
      setSelectedBots(defaultTargetBots(bots));
      setSelectedGroups([]);
      setPendingAdd(next);
    },
    [action, bots, sources],
  );

  const confirmAdd = useCallback(async () => {
    if (!pendingAdd) return;
    setRepeatAdd(undefined);
    const targets: KnowledgeTargets = {
      all: false,
      bots: selectedBots,
      groups: selectedGroups,
    };
    const current = pendingAdd;
    setPendingAdd(undefined);
    if (current.kind === "obsidian" || current.kind === "folder") {
      if (current.kind === "obsidian" && current.detected) {
        const detectedPath = current.detected.path;
        const result = await action.run((peer, signal) =>
          peer.call(
            "knowledge.addObsidian",
            { detectedPath, kind: "obsidian", targets },
            { signal },
          ),
        );
        if (result?.source) {
          if (result.alreadyAdded) setRepeatAdd(result.source.id);
          setOpen(result.source.id);
        }
        return;
      }
      setPicking(true);
      // The host owns the folder dialog, so the wait is the person's time, not a slow call.
      const timeoutMs = 660_000;
      const result = await action.run(
        (peer, signal) =>
          peer.call(
            "knowledge.addObsidian",
            { kind: current.kind, targets },
            { signal, timeoutMs },
          ),
        timeoutMs,
      );
      setPicking(false);
      if (result?.source) {
        if (result.alreadyAdded) setRepeatAdd(result.source.id);
        setOpen(result.source.id);
      }
      return;
    }
    const result = await action.run((peer, signal) =>
      peer.call("knowledge.addNotion", { targets }, { signal }),
    );
    // The new source's detail is where the Notion sign-in happens.
    if (result) setOpen(result.source.id);
  }, [action, pendingAdd, selectedBots, selectedGroups]);

  const toggleInitialTarget = (kind: "bot" | "group", targetId: string) => {
    if (kind === "bot") {
      setSelectedBots((prev) =>
        prev.includes(targetId) ? prev.filter((item) => item !== targetId) : [...prev, targetId],
      );
    } else {
      setSelectedGroups((prev) =>
        prev.includes(targetId) ? prev.filter((item) => item !== targetId) : [...prev, targetId],
      );
    }
  };

  const startAddRef = useRef(startAdd);
  startAddRef.current = startAdd;
  const handled = useRef<number>(undefined);
  const handledRef = useRef(requestHandled);
  handledRef.current = requestHandled;
  useEffect(() => {
    if (!request || request.at === handled.current) return;
    handled.current = request.at;
    handledRef.current?.();
    startAddRef.current({ kind: request.kind });
  }, [request]);

  const row = (source: KnowledgeSource) => {
    const resolved = resolveAccess(
      {
        mode: source.targets.all ? "all" : "selected",
        bots: source.targets.bots,
        groups: source.targets.groups,
      },
      bots,
      groups,
    );
    const used = resolved.bots.length > 0 || resolved.groups.length > 0;
    return (
      <div key={source.id} className={styles.row}>
        <button type="button" className={styles.rowOpen} onClick={() => setOpen(source.id)}>
          <IconTile icon={KIND_ICON[source.kind]} tone={KIND_TONE[source.kind]} size="lg" />
          <span className={styles.rowText}>
            <b>{source.name}</b>
            <div>
              {[
                t(`knowledge.kind.${source.kind}`),
                source.lastUsedAt
                  ? t("knowledge.lastUsed", {
                      time: new Date(source.lastUsedAt).toLocaleString(language),
                    })
                  : t("knowledge.neverUsed"),
              ].join(" · ")}
            </div>
          </span>
        </button>
        {used ? (
          <Faces bots={resolved.bots} groups={resolved.groups} />
        ) : (
          <Button variant="secondary" onClick={() => setOpen(source.id)}>
            {t("connections.action.give")}
          </Button>
        )}
      </div>
    );
  };
  const pending = detection?.obsidian.vaults.filter((vault) => !vault.added) ?? [];
  const addCard = (
    <div className={styles.softCard}>
      <button
        type="button"
        className={`${styles.tileRow} ${styles.tileAction}`}
        disabled={action.disabled}
        onClick={() => startAdd({ kind: "folder" })}
      >
        <IconTile icon={KIND_ICON.folder} tone={KIND_TONE.folder} size="lg" />
        <span className={styles.tileText}>
          <b>{t("knowledge.empty.addFolder")}</b>
          <small>{t("knowledge.add.folderHint")}</small>
        </span>
        <Icon name="chevronRight" size={16} className={styles.tileChevron} />
      </button>
      <button
        type="button"
        className={`${styles.tileRow} ${styles.tileAction}`}
        disabled={action.disabled}
        onClick={() => startAdd({ kind: "obsidian" })}
      >
        <IconTile icon={KIND_ICON.obsidian} tone={KIND_TONE.obsidian} size="lg" />
        <span className={styles.tileText}>
          <b>{t("knowledge.empty.addObsidian")}</b>
          <small>{t("knowledge.add.obsidianHint")}</small>
        </span>
        <Icon name="chevronRight" size={16} className={styles.tileChevron} />
      </button>
      <button
        type="button"
        className={`${styles.tileRow} ${styles.tileAction}`}
        disabled={action.disabled}
        onClick={() => startAdd({ kind: "notion" })}
      >
        <IconTile icon={KIND_ICON.notion} tone={KIND_TONE.notion} size="lg" />
        <span className={styles.tileText}>
          <b>{t("knowledge.empty.addNotion")}</b>
          <small>{t("knowledge.add.notionHint")}</small>
        </span>
        <Icon name="chevronRight" size={16} className={styles.tileChevron} />
      </button>
    </div>
  );
  const detectedRow = (vault: { name: string; path: string }) => (
    <div key={vault.path} className={styles.tileRow}>
      <IconTile icon={KIND_ICON.obsidian} tone={KIND_TONE.obsidian} size="lg" />
      <span className={styles.tileText}>
        <b>{vault.name}</b>
        <small>{vault.path}</small>
      </span>
      <Button
        variant="secondary"
        disabled={action.disabled}
        onClick={() => startAdd({ kind: "obsidian", detected: vault })}
      >
        {t("knowledge.add")}
      </Button>
    </div>
  );

  const addDialog = pendingAdd ? (
    <ConnectorPanel
      title={t(`knowledge.add.dialogTitle.${pendingAdd.kind}`)}
      close={() => setPendingAdd(undefined)}
      busy={action.busy || picking}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={action.busy || picking}
            onClick={() => setPendingAdd(undefined)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            loading={action.busy || picking}
            disabled={action.disabled}
            onClick={() => void confirmAdd()}
          >
            {pendingAdd.kind === "notion"
              ? t("knowledge.add.confirmNotion")
              : pendingAdd.kind === "obsidian" && pendingAdd.detected
                ? t("knowledge.add.confirmDetected")
                : t("knowledge.add.confirmFolder")}
          </Button>
        </>
      }
    >
      <div className={styles.softCard}>
        <div className={styles.tileRow}>
          <IconTile icon={KIND_ICON[pendingAdd.kind]} tone={KIND_TONE[pendingAdd.kind]} size="lg" />
          <span className={styles.tileText}>
            {pendingAdd.kind === "obsidian" && pendingAdd.detected ? (
              <>
                <b>{pendingAdd.detected.name}</b>
                <small className={styles.mono}>{pendingAdd.detected.path}</small>
              </>
            ) : (
              <>
                <b>{t(`knowledge.kind.${pendingAdd.kind}`)}</b>
                <small>{t(`knowledge.add.${pendingAdd.kind}Hint`)}</small>
              </>
            )}
          </span>
        </div>
      </div>
      <section className={styles.block}>
        <h3 className={styles.blockTitle} data-mark="violet">
          <span>{t("knowledge.add.pickBots")}</span>
        </h3>
        <div className={styles.softCard}>
          <div className={styles.tileRow}>
            <FacePicker
              bots={bots}
              groups={groups}
              isOn={(kind, faceId) =>
                kind === "bot" ? selectedBots.includes(faceId) : selectedGroups.includes(faceId)
              }
              toggle={toggleInitialTarget}
              disabled={action.disabled}
            />
          </div>
        </div>
        <p className={styles.quiet}>{t("knowledge.add.pickBotsNote")}</p>
      </section>
    </ConnectorPanel>
  ) : null;

  // A person with no source and nothing on this computer gets the one explanation of what a
  // knowledge source is, plus the three ways in; the scan answer is waited for so it does not flash.
  if (
    !open &&
    !pendingAdd &&
    !detecting &&
    !loading &&
    !error &&
    !sources.length &&
    !pending.length
  )
    return (
      <div className={styles.block}>
        <div className={styles.blankState}>
          <IconTile icon="file" tone="blue" size="lg" />
          <b>{t("knowledge.emptyTitle")}</b>
          <span>{t("knowledge.empty")}</span>
        </div>
        {addCard}
        <ConnectorFeedback loading={false} error={action.error} retry={retry} />
      </div>
    );
  return (
    <>
      <ConnectorFeedback
        loading={loading || picking || detecting}
        error={error ?? action.error}
        retry={retry}
      />
      {picking && (
        <p role="status" className={styles.note}>
          {t("knowledge.picking")}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.note}>
          {t("knowledge.removed", { name: notice })}
        </p>
      )}
      {pending.length > 0 && (
        <section className={styles.block}>
          <h3 className={styles.blockTitle} data-mark="amber">
            <span>{t("knowledge.detected")}</span>
          </h3>
          <div className={styles.softCard} data-tint="amber">
            {pending.map(detectedRow)}
          </div>
          <p className={styles.quiet}>{t("knowledge.detected.note")}</p>
        </section>
      )}
      {sources.length > 0 && (
        <section className={styles.block}>
          <h3 className={styles.blockTitle}>
            <span>{t("knowledge.added")}</span>
          </h3>
          <div className={styles.rows}>{sources.map(row)}</div>
          {more && (
            <div className={styles.actions}>
              <Button variant="secondary" onClick={more}>
                {t("workspace.more")}
              </Button>
            </div>
          )}
          <p className={styles.quiet}>{t("knowledge.readOnlyNote")}</p>
        </section>
      )}
      {!loading && !error && !sources.length && (
        <section className={styles.block}>
          <h3 className={styles.blockTitle} data-mark="teal">
            <span>{t("knowledge.addTitle")}</span>
          </h3>
          {!pending.length && <p className={styles.quiet}>{t("knowledge.empty")}</p>}
          {addCard}
          <p className={styles.quiet}>{t("knowledge.readOnlyNote")}</p>
        </section>
      )}
      {addDialog}
      {open && (
        <KnowledgeDetails
          key={open}
          id={open}
          alreadyAdded={repeatAdd === open}
          snapshot={snapshot}
          changed={changed}
          close={() => {
            setRepeatAdd(undefined);
            setOpen(undefined);
          }}
          removed={(name) => {
            setOpen(undefined);
            setNotice(name);
            changed();
          }}
        />
      )}
    </>
  );
}
