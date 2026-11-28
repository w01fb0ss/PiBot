import type { TranslationKey } from "@pibot/i18n";
import type { Bot } from "@pibot/plugins-contract/full";
import {
  BotAvatar,
  hostPlatform,
  Overlay,
  type Peer,
  useComboboxText,
  useNavigation,
  useRpc,
  useRpcEvent,
  useSettings,
} from "@pibot/renderer-kit";
import type {
  SkillImportDetails,
  SkillLinkListing,
  SkillLinkResolution,
} from "@pibot/skills-contract";
import { Button, Combobox, TextField } from "@pibot/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImportPlugin } from "../../setup/ImportPlugin.tsx";
import { useConnectorRead } from "../../shell/remote.ts";
import styles from "./connections.module.css";

type Compat = NonNullable<SkillImportDetails["compatibility"]>;
type CompatEntry = Compat["unavailable"][number];
type Candidate = SkillLinkListing["skills"][number];

/**
 * The brain sends stable codes as the RPC message. Only codes the UI has words for are shown;
 * anything else becomes a generic failure, so a new server code never surfaces as raw English text.
 */
const CODES = new Set([
  "skill_import_invalid",
  "skill_secret_invalid",
  "skill_secret_windows",
  "skill_import_unsupported",
  "skill_import_too_large",
  "skill_import_file_too_large",
  "skill_import_too_many_files",
  "skill_import_unsafe",
  "skill_import_unreadable",
  "skill_import_cancelled",
  "skill_import_timeout",
  "skill_preview_expired",
  "skill_picker_unavailable",
  "skill_picker_busy",
  "skill_link_size_changed",
  "skill_link_ref_invalid",
  "skill_link_subpath_invalid",
  "skill_link_host_not_allowed",
  "skill_link_private_address",
  "skill_link_unsupported_url",
  "skill_link_redirect_limit",
  "skill_link_timeout",
  "skill_link_cancelled",
  "skill_link_unsupported",
  "skill_link_private_unsupported",
  "skill_link_private_or_missing",
  "skill_link_download_failed",
  "skill_link_manifest_invalid",
  "skill_link_no_skills",
  "skill_link_too_many_skills",
  "skill_link_commit_unavailable",
  "skill_link_expired",
  "skill_link_busy",
  "skill_link_candidate_missing",
]);
function errorKey(error: unknown): TranslationKey {
  // A code may carry a detail line (the file that broke a rule); only the first line is the code.
  const code = error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
  return CODES.has(code) ? (`skills.error.${code}` as TranslationKey) : "skills.error.failed";
}

/**
 * A failed import only counts as "nothing was written" when the brain said so. A timeout,
 * a dropped connection or our own cancel may have committed the copy already, and offering the
 * same preview again would then save a second copy under a new name.
 */
const NOTHING_WRITTEN = new Set([
  "skill_import_invalid",
  "skill_secret_invalid",
  "skill_import_unsupported",
  "skill_import_too_large",
  "skill_import_file_too_large",
  "skill_import_too_many_files",
  "skill_import_unsafe",
  "skill_import_unreadable",
  "skill_preview_expired",
]);
function writtenState(error: unknown): "none" | "unknown" {
  const code = error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
  return NOTHING_WRITTEN.has(code) ? "none" : "unknown";
}

/** People read sizes; bytes stay internal and exact. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Every entry carries fixed vocabulary only, so a line is a key plus its names. */
function compatibilityLine(entry: CompatEntry): {
  key: TranslationKey;
  vars?: Record<string, string>;
} {
  if (entry.code === "allowed_tools")
    return entry.params.tools?.length
      ? {
          key: "skills.compatibility.allowed_tools.values",
          vars: { tools: entry.params.tools.join(", ") },
        }
      : { key: "skills.compatibility.allowed_tools" };
  return {
    key: `skills.compatibility.${entry.code}` as TranslationKey,
    vars: {
      field: entry.params.field ?? "",
      tool: entry.params.tool ?? "",
      replacement: entry.params.replacement ?? "",
      runtime: entry.params.runtime ?? "",
    },
  };
}

/** Advisory by contract: it never blocks import, so it folds away by default. */
function Compatibility({ report }: { report: Compat | undefined }) {
  const { t } = useSettings();
  if (!report) return null;
  const rows = [
    ...report.unavailable.map((entry) => ({
      entry,
      level: "skills.compatibility.unavailable" as const,
    })),
    ...report.partial.map((entry) => ({ entry, level: "skills.compatibility.partial" as const })),
    ...report.notice.map((entry) => ({ entry, level: "skills.compatibility.notice" as const })),
  ];
  if (!rows.length) return null;
  return (
    <section className={styles.card}>
      <h3>{t("skills.compatibility.title")}</h3>
      {[...new Set(rows.map(({ entry }) => entry.code))].map((code) => (
        <p key={code} className={styles.note}>
          {t(`skills.compatibility.impact.${code}`)}
        </p>
      ))}
      <details>
        <summary>{t("skills.compatibility.details")}</summary>
        <p className={styles.note}>{t("skills.compatibility.advisory")}</p>
        {rows.map(({ entry, level }) => {
          const line = compatibilityLine(entry);
          return (
            // One entry per code and names combination; the report never repeats an identical line.
            <p
              key={`${level}:${entry.code}:${entry.params.field ?? ""}:${entry.params.tool ?? ""}:${entry.params.runtime ?? ""}:${entry.params.replacement ?? ""}`}
              className={styles.note}
            >
              <strong>{t(level)}</strong> · {t(line.key, line.vars)}
            </p>
          );
        })}
      </details>
    </section>
  );
}

/**
 * One preview for every source — folder, zip and link all read the same details.
 * 带过来 (another AI tool's skill) reuses it too, so every way in shows the same facts.
 */
export function PreviewBody({
  details,
  source,
  botName,
}: {
  details: SkillImportDetails;
  source: string;
  botName: string;
}) {
  const { t } = useSettings();
  const summary = details.summary;
  const largest = summary?.largestFolders[0];
  const licenses = summary?.licenses.filter((license) => license.gpl || license.agpl) ?? [];
  const environment = summary?.environmentVariables ?? [];
  return (
    <>
      <section className={styles.card}>
        <h3>{t("skills.import.title", { name: details.document.name })}</h3>
        <p className={styles.note}>
          <strong>{t("skills.preview.source")}</strong> · {source}
        </p>
        {summary && (
          <>
            <p className={styles.note}>
              <strong>{t("skills.preview.size")}</strong> ·{" "}
              {t("skills.preview.sizeValue", {
                size: size(summary.totalBytes),
                count: summary.fileCount,
              })}
            </p>
            {largest && (
              <p className={styles.note}>
                <strong>{t("skills.preview.largest")}</strong> ·{" "}
                {t("skills.preview.largestValue", {
                  name: largest.name,
                  size: size(largest.bytes),
                })}
              </p>
            )}
          </>
        )}
        <p className={styles.note}>{t("skills.preview.storage")}</p>
      </section>
      <section className={styles.card}>
        <h3>{t("skills.preview.runtime")}</h3>
        {summary?.runtimeRequirements?.length ? (
          summary.runtimeRequirements.map((runtime) => (
            <p key={runtime.runtime} className={styles.note}>
              {t("skills.preview.runtimeValue", {
                name: runtime.runtime === "node" ? "Node.js" : "Python",
                version: runtime.version ?? "",
              })}
              {runtime.packages?.length
                ? ` · ${t("skills.preview.packages", { names: runtime.packages.join(", ") })}`
                : ""}
            </p>
          ))
        ) : (
          <p className={styles.note}>{t("skills.preview.noRuntime")}</p>
        )}
        {environment.length > 0 && (
          <p className={styles.note}>
            {t("skills.preview.environment", {
              names: environment.map((item) => item.name).join(", "),
            })}
          </p>
        )}
      </section>
      {licenses.length > 0 && (
        <section className={styles.card}>
          <p className={styles.note}>{t("skills.preview.licenseImpact")}</p>
          <details>
            <summary>{t("skills.compatibility.details")}</summary>
            <p className={styles.note}>
              {t("skills.preview.licenseWarn", {
                files: licenses.map((license) => license.path).join(", "),
              })}
            </p>
          </details>
        </section>
      )}
      <Compatibility report={details.compatibility} />
      <p className={styles.note}>
        <strong>{t("skills.preview.assign")}</strong> · {botName}
      </p>
      {details.skipped > 0 && (
        <p className={styles.note}>{t("skills.import.skipped", { count: details.skipped })}</p>
      )}
    </>
  );
}

export function importSecretBindings(draft: Readonly<Record<string, string>> | undefined) {
  return Object.entries(draft ?? {})
    .filter(([, secretName]) => secretName)
    .map(([variable, secretName]) => ({ variable, secretName }));
}

export function PreviewSecretBindings({
  details,
  draft,
  disabled,
  onChange,
  openTokens,
}: {
  details: SkillImportDetails;
  draft?: Readonly<Record<string, string>>;
  disabled: boolean;
  onChange(variable: string, secretName: string): void;
  openTokens(): void;
}) {
  const { t } = useSettings();
  const windows = hostPlatform() === "win32";
  const variables = details.summary?.bindableEnvironmentVariables;
  const botId = variables?.length && !windows ? details.botId : undefined;
  const read = useCallback(
    (peer: Peer, signal: AbortSignal) =>
      botId ? peer.call("skills.secretChoices", { botId }, { signal }) : Promise.resolve([]),
    [botId],
  );
  const choices = useConnectorRead(read);
  const available = choices.value ?? [];
  useRpcEvent("secrets.changed", choices.refresh);
  if (!variables?.length) return null;
  return (
    <section className={styles.card}>
      <h3>{t("skills.secrets.title")}</h3>
      <p className={styles.note}>{t(windows ? "skills.secrets.windows" : "skills.secrets.info")}</p>
      {botId && choices.loading && <p role="status">{t("common.loading")}</p>}
      {botId && choices.error && (
        <p role="alert" className={styles.error}>
          {t("skills.secrets.loadFailed")}{" "}
          <Button variant="pill" disabled={disabled || choices.loading} onClick={choices.refresh}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {botId && !choices.loading && !choices.error && choices.value?.length === 0 && (
        <>
          <p className={styles.note}>{t("skills.secrets.noChoices")}</p>
          <Button variant="secondary" disabled={disabled} onClick={openTokens}>
            {t("connections.tokens.title")}
          </Button>
        </>
      )}
      {botId &&
        variables
          .filter((name) => available.length > 0 || draft?.[name])
          .map((name) => (
            <label className={styles.tokenField} key={name}>
              {name}
              <select
                value={draft?.[name] ?? ""}
                disabled={disabled || choices.loading || !!choices.error}
                onChange={(event) => onChange(name, event.currentTarget.value)}
              >
                <option value="">{t("skills.secrets.unbound")}</option>
                {draft?.[name] && !available.includes(draft[name]) && (
                  <option value={draft[name]}>{draft[name]}</option>
                )}
                {available.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </label>
          ))}
    </section>
  );
}

export type ImportedRuntimeSkill = { skillId: string; botId: string; name: string };

export function RuntimePrepareSuggestions({
  skills,
  beforeOpen,
}: {
  skills: readonly ImportedRuntimeSkill[];
  beforeOpen?(): void;
}) {
  const { t } = useSettings();
  const navigation = useNavigation();
  return skills.map((skill) => (
    <div key={skill.skillId} className={styles.card}>
      <p>{t("skills.runtime.chatNeeds", { name: skill.name })}</p>
      <Button
        onClick={() => {
          beforeOpen?.();
          navigation.navigate({
            name: "connectors",
            skillConnection: { ...skill, prepareRuntime: true },
          });
        }}
      >
        {t("skills.runtime.prepareNow")}
      </Button>
    </div>
  ));
}

type Phase =
  | { at: "input" }
  | { at: "found"; resolution: SkillLinkResolution }
  | { at: "listing"; sourceId: string; source: string; listing: SkillLinkListing }
  | { at: "preview"; details: SkillImportDetails; source: string; rest: Candidate[] }
  | { at: "plugin"; selectionId: string }
  | { at: "done" };

/**
 * The link flow runs the same preview the file and folder pickers use, so what a person
 * sees before importing never depends on where the package came from. Every step that holds brain
 * state is cancelled on close, which is what keeps a dismissed dialog from leaving work running.
 */
export function SkillImportDialog({
  bots,
  initial = "link",
  close,
  imported,
  openTokens,
}: {
  /** Who gets the skill: the brain copies it into one Bot's own store, so it is chosen up front. */
  bots: Bot[];
  /** 「导入文件」/「导入文件夹」 open the picker first and land in the same preview. */
  initial?: "link" | "file" | "folder";
  close(): void;
  imported(): void;
  openTokens(): void;
}) {
  const [runtimeSkills, setRuntimeSkills] = useState<ImportedRuntimeSkill[]>([]);
  const { t } = useSettings();
  const { peer } = useRpc();
  // Bot names are not unique across workspaces; the Combobox matches on name and id both.
  const comboboxText = useComboboxText();
  const botOptions = useMemo(
    () =>
      bots.map((bot) => ({
        value: bot.id,
        label: bot.name,
        keywords: [bot.id],
        leading: <BotAvatar bot={bot} size={20} />,
      })),
    [bots],
  );
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState(bots.find((bot) => bot.isMain && !bot.archivedAt)?.id ?? "");
  const botName = bots.find((bot) => bot.id === target)?.name ?? "";
  const [phase, setPhase] = useState<Phase>({ at: "input" });
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number | null }>();
  const [error, setError] = useState<TranslationKey>();
  const [busy, setBusy] = useState<
    "resolve" | "download" | "preview" | "import" | "pick" | undefined
  >();
  const [tally, setTally] = useState({
    done: 0,
    renamed: [] as { from: string; to: string }[],
    failed: [] as string[],
  });
  // A dismissed dialog must not leave a download or a copy running; both are keyed by these ids.
  // `previewBatchId` covers the phase before a preview id exists (picker, first copy): it is named
  // before dispatch so the cancel receipt can still wait for that work to unwind.
  const live = useRef<{ sourceId?: string; previewId?: string; previewBatchId?: string }>({});
  const pickedFiles = useRef(false);
  // One call at a time, and it can be aborted. Closing or asking to stop aborts it, which
  // is how the brain learns to unwind its own download or copy instead of finishing unwatched.
  const call = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  // A stop request may be started from several buttons and from unmount; only the first one owns it.
  const stopping = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [stopUnconfirmed, setStopUnconfirmed] = useState(false);

  useRpcEvent("skills.linkProgress", (payload) => {
    if (payload.sourceId !== live.current.sourceId) return;
    setProgress({ done: payload.bytes, total: payload.totalBytes });
  });
  useRpcEvent("skills.importProgress", (payload) => {
    if (payload.previewId !== live.current.previewId) return;
    setProgress({ done: payload.files, total: payload.totalFiles });
  });

  /**
   * Asks the brain to unwind what this dialog started and resolves only after it answered.
   * `peer.call` aborting rejects locally and merely sends a stop frame (`cancelRequest`), so the
   * local failure of the original call proves nothing about the copy, download or rollback. These
   * cancel calls wait on the brain's own cleanup; `false` means we cannot say it finished.
   */
  const stopRemote = useCallback(async (): Promise<boolean> => {
    if (!peer) return !Object.values(live.current).some(Boolean);
    const work: {
      key: "sourceId" | "previewId" | "previewBatchId";
      id: string;
      call: () => Promise<unknown>;
    }[] = [];
    const { sourceId, previewId, previewBatchId } = live.current;
    if (sourceId)
      work.push({
        key: "sourceId",
        id: sourceId,
        call: () => peer.call("skills.cancelLink", { sourceId }, { timeoutMs: 30_000 }),
      });
    // Rollback is bounded by the import itself, so this waits rather than declaring it done early.
    if (previewId)
      work.push({
        key: "previewId",
        id: previewId,
        call: () => peer.call("skills.cancelPreview", { previewId }, { timeoutMs: 600_000 }),
      });
    if (previewBatchId)
      work.push({
        key: "previewBatchId",
        id: previewBatchId,
        call: () =>
          peer.call(
            "skills.cancelPreviewBatch",
            { batchId: previewBatchId },
            { timeoutMs: 600_000 },
          ),
      });
    if (!work.length) return true;
    const outcomes = await Promise.allSettled(work.map((item) => item.call()));
    let confirmed = true;
    for (const [index, outcome] of outcomes.entries()) {
      const item = work[index];
      if (!item) continue;
      if (outcome.status !== "fulfilled") {
        // Keeping the id is what makes a second "stop" retry this cleanup instead of closing over
        // work nobody confirmed had ended.
        confirmed = false;
        continue;
      }
      if (live.current[item.key] === item.id) delete live.current[item.key];
    }
    return confirmed;
  }, [peer]);

  useEffect(() => {
    alive.current = true;
    return () => {
      // Escape, the backdrop or a route change can close the dialog without going through a
      // button: whatever it started is aborted here, and no state is set on the gone tree.
      alive.current = false;
      call.current?.abort();
      // The dialog is gone but the brain may still be unwinding; this keeps waiting for its answer.
      void stopRemote();
    };
  }, [stopRemote]);

  const beginCall = () => {
    call.current?.abort();
    const controller = new AbortController();
    call.current = controller;
    return controller;
  };

  /** Ends one operation. Closing is not decided here: a stop request owns that, after its receipts. */
  const settle = () => {
    if (!alive.current) return;
    setBusy(undefined);
  };

  const requestClose = () => {
    if (stopping.current) return;
    // Nothing this dialog holds: closing cannot hide work, so there is nothing to wait for.
    if (
      !busy &&
      !live.current.sourceId &&
      !live.current.previewId &&
      !live.current.previewBatchId
    ) {
      close();
      return;
    }
    stopping.current = true;
    setCancelling(true);
    call.current?.abort();
    void (async () => {
      const confirmed = await stopRemote();
      if (!alive.current) return;
      if (confirmed) {
        close();
        return;
      }
      // Saying "closed" here would claim a cleanup nobody confirmed; the person decides with this
      // warning in front of them instead.
      stopping.current = false;
      setCancelling(false);
      setStopUnconfirmed(true);
    })();
  };

  const pick = async (from: "file" | "folder") => {
    if (!peer || stopping.current || live.current.previewBatchId) return;
    const controller = beginCall();
    // Named before dispatch: the picker and the first copy have no id of their own to cancel by.
    const batchId = globalThis.crypto.randomUUID();
    live.current.previewBatchId = batchId;
    setBusy("pick");
    setError(undefined);
    try {
      const details = await peer.call(
        "skills.preview",
        { botId: target, from, batchId },
        { timeoutMs: 135 * 60_000, signal: controller.signal },
      );
      if (!alive.current || controller.signal.aborted) return;
      // The response hands off cancellation from the batch id to the exact preview id.
      if (details) live.current.previewId = details.previewId;
      if (live.current.previewBatchId === batchId) delete live.current.previewBatchId;
      if (!details) return;
      setSecretDraft({});
      setPhase({
        at: "preview",
        details,
        source: t(`skills.preview.local.${from}` as TranslationKey),
        rest: [],
      });
    } catch (failure) {
      // A stop request is not an error to report: the dialog is closing.
      if (controller.signal.aborted || !alive.current) return;
      setError(errorKey(failure));
      // An error can be a lost reply. Retire the batch before another picker can replace its id.
      const confirmed = await stopRemote();
      if (!confirmed && alive.current) setStopUnconfirmed(true);
    } finally {
      if (call.current === controller) call.current = undefined;
      settle();
    }
  };
  if (initial !== "link" && !pickedFiles.current && peer) {
    pickedFiles.current = true;
    void pick(initial);
  }

  const resolve = async () => {
    if (!peer || !url.trim()) return;
    const controller = beginCall();
    setBusy("resolve");
    setError(undefined);
    try {
      const resolution = await peer.call(
        "skills.resolveLink",
        { url },
        { timeoutMs: 120_000, signal: controller.signal },
      );
      if (!alive.current || controller.signal.aborted) return;
      live.current.sourceId = resolution.sourceId;
      setPhase({ at: "found", resolution });
    } catch (failure) {
      if (controller.signal.aborted || !alive.current) return;
      setError(errorKey(failure));
    } finally {
      if (call.current === controller) call.current = undefined;
      settle();
    }
  };

  const previewOf = async (
    sourceId: string,
    candidate: Candidate,
    rest: Candidate[],
    source: string,
  ) => {
    if (!peer) return false;
    const controller = beginCall();
    setBusy("preview");
    setError(undefined);
    setUncertain(false);
    try {
      const details = await peer.call(
        "skills.previewLink",
        { sourceId, candidateId: candidate.id, botId: target },
        { timeoutMs: 125 * 60_000, signal: controller.signal },
      );
      if (!alive.current || controller.signal.aborted) return false;
      live.current.previewId = details.previewId;
      setProgress(undefined);
      setSecretDraft({});
      setPhase({ at: "preview", details, source, rest });
      return true;
    } catch (failure) {
      if (controller.signal.aborted || !alive.current) return false;
      setError(errorKey(failure));
      return false;
    } finally {
      if (call.current === controller) call.current = undefined;
      settle();
    }
  };

  const download = async (resolution: SkillLinkResolution) => {
    if (!peer) return;
    const controller = beginCall();
    setBusy("download");
    setError(undefined);
    // The bar starts from the same total the "found" screen showed, so a retry never jumps to 0%.
    const total = resolution.estimateBytes ?? resolution.bytes;
    setProgress({ done: 0, total });
    const source = [resolution.owner, resolution.repo].filter(Boolean).join("/") || resolution.host;
    try {
      const listing = await peer.call(
        "skills.downloadLink",
        { sourceId: resolution.sourceId, confirmed: true },
        { timeoutMs: 125 * 60_000, signal: controller.signal },
      );
      if (!alive.current || controller.signal.aborted) return;
      if (listing.selectionId) {
        setPhase({ at: "plugin", selectionId: listing.selectionId });
        return;
      }
      setPhase({ at: "listing", sourceId: resolution.sourceId, source, listing });
      setPicked(new Set(listing.skills.filter((skill) => skill.selected).map((skill) => skill.id)));
    } catch (failure) {
      if (controller.signal.aborted || !alive.current) return;
      setError(errorKey(failure));
    } finally {
      if (call.current === controller) call.current = undefined;
      setProgress(undefined);
      settle();
    }
  };

  const runImport = async () => {
    if (!peer || phase.at !== "preview") return;
    const { details, source, rest } = phase;
    const controller = beginCall();
    setBusy("import");
    setError(undefined);
    setUncertain(false);
    setProgress({ done: 0, total: details.files.length });
    try {
      const skill = await peer.call(
        "skills.import",
        {
          previewId: details.previewId,
          bindings: importSecretBindings(secretDraft),
        },
        { timeoutMs: 125 * 60_000, signal: controller.signal },
      );
      if (!alive.current || controller.signal.aborted) return;
      live.current.previewId = undefined;
      if (details.summary?.runtimeRequirements?.length)
        setRuntimeSkills((current) => [
          ...current,
          { skillId: skill.id, botId: skill.botId, name: skill.name },
        ]);
      setTally((current) => ({
        done: current.done + 1,
        // The brain renames instead of overwriting, so a different name means it already existed.
        renamed:
          skill.name === details.document.name
            ? current.renamed
            : [...current.renamed, { from: details.document.name, to: skill.name }],
        failed: current.failed,
      }));
      imported();
      const next = rest[0];
      const moved =
        next && live.current.sourceId
          ? await previewOf(live.current.sourceId, next, rest.slice(1), source)
          : false;
      if (!moved && alive.current) setPhase({ at: "done" });
    } catch (failure) {
      if (controller.signal.aborted || !alive.current) return;
      setTally((current) => ({ ...current, failed: [...current.failed, details.document.name] }));
      if (writtenState(failure) === "unknown") {
        // The copy may have landed. Keep the person on this screen with a plain warning
        // and drop the queue: importing again would save a second copy under a new name.
        live.current.previewId = undefined;
        setUncertain(true);
        setPhase({ at: "preview", details, source, rest: [] });
      } else {
        setError(errorKey(failure));
      }
    } finally {
      if (call.current === controller) call.current = undefined;
      setProgress(undefined);
      settle();
    }
  };

  const share = (done: number, total: number) =>
    `${Math.min(100, Math.round((done / Math.max(1, total)) * 100))}%`;
  // A known total is what makes a percentage meaningful; otherwise the bar must not look full.
  const downloadTotal = progress?.total ?? 0;
  // The total is an estimate and can under-count, so the bar stops at 99% until the listing arrives.
  const downloadPercent =
    progress && downloadTotal > 0
      ? Math.min(99, Math.round((progress.done / Math.max(1, downloadTotal)) * 100))
      : 0;
  const foundBytes =
    phase.at === "found" ? (phase.resolution.estimateBytes ?? phase.resolution.bytes) : null;

  if (phase.at === "plugin")
    return (
      <ImportPlugin
        initialSelectionId={phase.selectionId}
        close={requestClose}
        changed={imported}
        presetTarget={target ? { kind: "bot", id: target } : undefined}
      />
    );
  return (
    <Overlay
      icon="link"
      tone="violet"
      title={t("skills.link.title")}
      close={requestClose}
      // Esc and the close button stay usable while busy: they mean "stop". The lock only comes on
      // once a stop was asked for, when the dialog is already on its way out.
      busy={cancelling}
    >
      {stopUnconfirmed && (
        <p role="alert" className={styles.error}>
          {t("skills.preview.stopUnconfirmed")}
        </p>
      )}
      {phase.at === "input" && (
        <>
          <p className={styles.note}>{t("skills.link.subtitle")}</p>
          <TextField
            label={t("skills.link.label")}
            type="url"
            value={url}
            disabled={!!busy}
            placeholder="https://github.com/owner/repo"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setUrl(event.target.value)}
          />
          {/* The Bot is picked by a face and a name, here as everywhere else skills get assigned. */}
          <Combobox
            label={t("skills.preview.assign")}
            options={botOptions}
            value={target}
            disabled={!!busy}
            onValueChange={setTarget}
            placeholder={t("skills.preview.assign")}
            {...comboboxText}
          />
          {error && (
            <p role="alert" className={styles.error}>
              {t(error)}
            </p>
          )}
          <div className={styles.dialogFoot}>
            <span>{t("skills.link.info")}</span>
            <Button variant="secondary" disabled={cancelling} onClick={requestClose}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="secondary"
              disabled={!!busy || stopUnconfirmed}
              onClick={() => void pick("file")}
            >
              {t("skills.import")}
            </Button>
            <Button
              variant="secondary"
              disabled={!!busy || stopUnconfirmed}
              onClick={() => void pick("folder")}
            >
              {t("skills.importFolder")}
            </Button>
            <Button
              loading={busy === "resolve"}
              disabled={!url.trim() || !target || !!busy}
              onClick={() => void resolve()}
            >
              {t("skills.link.resolve")}
            </Button>
          </div>
        </>
      )}
      {phase.at === "found" && (
        <>
          <section className={styles.card}>
            <h3>{t("skills.link.found")}</h3>
            <p className={styles.note}>
              <strong>{t("skills.link.repo")}</strong> ·{" "}
              {[phase.resolution.owner, phase.resolution.repo].filter(Boolean).join("/") ||
                phase.resolution.host}
              {phase.resolution.ref ? ` · ${phase.resolution.ref}` : ""}
            </p>
            <p className={styles.note}>
              {foundBytes === null
                ? t("skills.link.sizeUnknown")
                : t("skills.link.size", { size: size(foundBytes) })}
            </p>
          </section>
          {progress && (
            <div>
              <div className={downloadTotal > 0 ? styles.bar : styles.barPending}>
                <div
                  className={downloadTotal > 0 ? styles.barFill : styles.barPendingFill}
                  style={downloadTotal > 0 ? { width: `${downloadPercent}%` } : undefined}
                />
              </div>
              <p className={styles.note}>
                {downloadTotal > 0
                  ? t("skills.link.downloadingTotal", {
                      done: size(progress.done),
                      total: size(downloadTotal),
                      percent: String(downloadPercent),
                    })
                  : t("skills.link.downloading", { size: size(progress.done) })}
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {t(error)}
            </p>
          )}
          <div className={styles.dialogFoot}>
            <span>{t("skills.link.info")}</span>
            <Button variant="secondary" disabled={cancelling} onClick={requestClose}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={busy === "download"}
              disabled={!!busy}
              onClick={() => void download(phase.resolution)}
            >
              {t("skills.link.download")}
            </Button>
          </div>
        </>
      )}
      {phase.at === "listing" && (
        <>
          <p className={styles.note}>
            {t("skills.link.picked", {
              count: picked.size,
              size: size(
                phase.listing.skills
                  .filter((skill) => picked.has(skill.id))
                  .reduce((sum, skill) => sum + skill.bytes, 0),
              ),
            })}
          </p>
          <div className={styles.dialogList}>
            {phase.listing.skills.map((skill) => (
              <label key={skill.id} className={styles.check}>
                <input
                  type="checkbox"
                  checked={picked.has(skill.id)}
                  disabled={!!busy}
                  onChange={() =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (next.has(skill.id)) next.delete(skill.id);
                      else next.add(skill.id);
                      return next;
                    })
                  }
                />
                <span>
                  {skill.name}
                  <small>{skill.description}</small>
                </span>
                <span className={styles.tag}>
                  {[size(skill.bytes), ...skill.runtimes].join(" · ")}
                </span>
              </label>
            ))}
          </div>
          {phase.listing.externalSources.length > 0 && (
            <p className={styles.note}>
              {t("skills.link.externalSources", { count: phase.listing.externalSources.length })}
            </p>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {t(error)}
            </p>
          )}
          <div className={styles.dialogFoot}>
            <span>{t("skills.link.info")}</span>
            <Button variant="secondary" disabled={cancelling} onClick={requestClose}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={busy === "preview"}
              disabled={!picked.size || !!busy}
              onClick={() => {
                const chosen = phase.listing.skills.filter((skill) => picked.has(skill.id));
                const first = chosen[0];
                if (first)
                  void previewOf(phase.listing.sourceId, first, chosen.slice(1), phase.source);
              }}
            >
              {t("skills.link.next")}
            </Button>
          </div>
        </>
      )}
      {phase.at === "preview" && (
        <>
          <PreviewBody details={phase.details} source={phase.source} botName={botName} />
          <PreviewSecretBindings
            key={phase.details.previewId}
            details={phase.details}
            draft={secretDraft}
            disabled={!!busy}
            openTokens={openTokens}
            onChange={(name, value) => setSecretDraft((current) => ({ ...current, [name]: value }))}
          />
          {progress && (
            <div>
              <div className={styles.bar}>
                <div
                  className={styles.barFill}
                  style={{ width: share(progress.done, progress.total ?? 0) }}
                />
              </div>
              <p className={styles.note}>
                {t("skills.preview.progress", {
                  done: progress.done,
                  total: progress.total ?? "?",
                })}
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {t(error)}
            </p>
          )}
          {uncertain && (
            // The copy may have landed; say so plainly instead of offering the same
            // preview again, which would save a second copy under a new name.
            <p role="alert" className={styles.error}>
              {t("skills.preview.uncertain", { name: phase.details.document.name })}
            </p>
          )}
          <div className={styles.dialogFoot}>
            <span>
              {phase.rest.length > 0
                ? t("skills.preview.queue", { count: phase.rest.length })
                : t("skills.preview.only")}
            </span>
            <Button variant="secondary" disabled={cancelling} onClick={requestClose}>
              {t("common.cancel")}
            </Button>
            {uncertain ? (
              <Button variant="secondary" onClick={() => requestClose()}>
                {t("skills.preview.close")}
              </Button>
            ) : (
              <Button
                loading={busy === "import"}
                disabled={!!busy || cancelling}
                onClick={() => void runImport()}
              >
                {error ? t("common.retry") : t("skills.import.confirm")}
              </Button>
            )}
          </div>
        </>
      )}
      {phase.at === "done" && (
        <>
          <p role="status" className={styles.status}>
            {t("skills.preview.done", { count: tally.done })}
          </p>
          {tally.renamed.map((item) => (
            <p key={item.from} className={styles.note}>
              {t("skills.preview.existed", { name: item.from, saved: item.to })}
            </p>
          ))}
          {tally.failed.map((name) => (
            <p key={name} role="alert" className={styles.error}>
              {t("skills.preview.failed", { name })}
            </p>
          ))}
          {error && (
            // The queue stopped before the next preview: the import that finished is listed above,
            // this says why the rest did not open.
            <p role="alert" className={styles.error}>
              {t(error)}
            </p>
          )}
          <RuntimePrepareSuggestions skills={runtimeSkills} beforeOpen={close} />
          <div className={styles.dialogFoot}>
            <Button variant="secondary" onClick={close}>
              {t("skills.preview.close")}
            </Button>
          </div>
        </>
      )}
    </Overlay>
  );
}
