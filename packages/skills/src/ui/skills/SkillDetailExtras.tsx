import type { TranslationKey, TranslationVars } from "@pibot/i18n";
import { useAction, useNavigation, useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import type {
  SkillCompatibilityEntry,
  SkillLinkOrigin,
  SkillManagedRuntime,
  SkillRuntimeStatus,
  SkillUpdatePending,
  SkillUpdateState,
} from "@pibot/skills-contract/full";
import { Button, SegmentedControl } from "@pibot/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  type RuntimeLoadFailure,
  runtimeLoadFailure,
  sizeText,
  skillError,
} from "./presentation.ts";
import { SkillFileList } from "./SkillFileList.tsx";
import { SkillSecretBindings } from "./SkillSecretBindings.tsx";
import { SkillUpdateDialog } from "./SkillUpdateDialog.tsx";
import styles from "./skills.module.css";
import {
  type SkillDetailData,
  useSkillDetailRead,
  useSkillResources,
} from "./use-skill-detail-read.ts";

/**
 * The connections page owns updating and the runtime, so its skill panel injects this
 * block instead of reimplementing it; the Bot panel shows it without the actions.
 */
export type SkillExtrasSlot = (controls: {
  skillId: string;
  groupId?: string;
  botId: string;
  name: string;
  prepareRuntime?: boolean;
  runtime?: "python" | "node";
}) => ReactNode;

type T = (key: TranslationKey, vars?: TranslationVars) => string;

/**
 * A package imported a moment ago is verified in the background, so its runtime read
 * fails until that ends. Re-read on its own (bounded) instead of asking for a click on a wait
 * the user cannot shorten; anything else waits for 重试.
 */
const RUNTIME_RETRY_MS = 3000;
const RUNTIME_RETRY_LIMIT = 10;

const RUNTIME_REASONS = new Set([
  "uv_download_failed",
  "uv_checksum_mismatch",
  "uv_network_failed",
  "uv_unsupported_platform",
  "uv_isolation_unavailable",
  "uv_cleanup_unconfirmed",
  "windows_proxy_credentials",
  "python_requirement_unsupported",
  "python_workspace_boundary",
  "node_not_found",
  "node_version_unsatisfied",
  "node_isolation_unavailable",
  "node_dependencies_unreviewable",
  "install_failed",
  "install_network_failed",
  "install_package_missing",
  "install_wheel_missing",
  "cancelled",
  "plan_changed",
]);

function dateText(language: string, iso: string) {
  return new Date(iso).toLocaleDateString(language);
}

function originText(t: T, origin: SkillLinkOrigin | undefined) {
  if (!origin) return t("skills.source.local");
  const repo = [origin.owner, origin.repo].filter(Boolean).join("/");
  return repo ? `${origin.host}/${repo}` : origin.host;
}

/** The report's params are a fixed vocabulary, so a missing value never leaks user text. */
function compatibilityText(t: T, entry: SkillCompatibilityEntry) {
  const vars: Record<string, string> = {};
  if (entry.params.field) vars.field = entry.params.field;
  if (entry.params.tool) vars.tool = entry.params.tool;
  if (entry.params.replacement) vars.replacement = entry.params.replacement;
  if (entry.params.runtime) vars.runtime = entry.params.runtime;
  if (entry.params.tools?.length) vars.tools = entry.params.tools.join(", ");
  if (entry.code === "allowed_tools" && entry.params.tools?.length)
    return t("skills.compatibility.allowed_tools.values", vars);
  return t(`skills.compatibility.${entry.code}` as TranslationKey, vars);
}

function reasonText(t: T, reason: string | null) {
  const code = reason && RUNTIME_REASONS.has(reason) ? reason : "install_failed";
  return t(`skills.runtime.reason.${code}` as TranslationKey);
}

export function SkillDetailExtras({
  skillId,
  groupId,
  botId,
  name,
  readOnly = false,
  prepareRuntime = false,
  runtime: initialRuntime,
  detail,
  resources,
  retryDestination,
  onChanged,
}: {
  skillId: string;
  groupId?: string;
  botId: string;
  name: string;
  /** The Bot panel displays runtime state and sends preparation to Connections. */
  readOnly?: boolean;
  prepareRuntime?: boolean;
  runtime?: "python" | "node";
  detail?: SkillDetailData;
  resources?: ReturnType<typeof useSkillResources>;
  retryDestination?: { botName: string; open(runtime?: SkillManagedRuntime): void };
  /** Lets the detail panel re-read the skill after an update switched its package. */
  onChanged?(): void;
}) {
  const { t, language } = useSettings();
  const navigation = useNavigation();
  const { peer } = useRpc();
  const updateTask = useAction();
  const prepareTask = useAction();
  const runtimeTask = useAction();
  const [updateOverride, setUpdate] = useState<SkillUpdateState>();
  const [selectedRuntime, selectRuntime] = useState(initialRuntime);
  const [runtime, setRuntime] = useState<SkillRuntimeStatus>();
  const [runtimeFailure, setRuntimeFailure] = useState<RuntimeLoadFailure>();
  // Auto-retries belong to one skill: switching details starts the count over.
  const runtimeRetries = useRef({ key: "", count: 0 });
  const [revision, setRevision] = useState(0);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const summary = useSkillDetailRead(skillId, groupId, botId, revision, "summary", !detail);
  const localResources = useSkillResources(skillId, groupId, botId, revision, !resources);
  const resourceRead = resources ?? localResources;
  const base = detail ?? summary.data;
  const update = updateOverride ?? base?.update;
  const origin = base?.document.linkOrigin;
  const report = resourceRead.error ? undefined : resourceRead.data?.compatibility;
  const [latest, setLatest] = useState(false);
  const [notice, setNotice] = useState<{ key: TranslationKey; vars?: TranslationVars }>();
  const [updating, setUpdating] = useState<SkillUpdatePending>();
  const [preparing, setPreparing] = useState(false);
  const openPrepareOnce = useRef(prepareRuntime);
  const [useMirror, setUseMirror] = useState(false);
  const [showPackages, setShowPackages] = useState(false);
  const [log, setLog] = useState<{ path: string | null; text: string } | false>(false);
  const [removing, setRemoving] = useState(false);
  // A retry after a lost reply repeats the same request id; the brain then answers from its ledger.
  const applyId = useRef<string | undefined>(undefined);
  const rollbackId = useRef<string | undefined>(undefined);
  const prepareId = useRef<string | undefined>(undefined);

  const reloadRuntime = useCallback(() => setRuntimeRevision((n) => n + 1), []);
  useRpcEvent("skills.changed", (event) => {
    if (event.skillId !== skillId || event.groupId !== groupId || event.botId !== botId) return;
    setUpdate(undefined);
    setRevision((n) => n + 1);
    reloadRuntime();
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision requests a fresh read.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    setRuntimeLoading(true);
    void peer
      .call(
        "skills.runtime",
        { groupId, skillId, runtime: selectedRuntime },
        { signal: controller.signal },
      )
      .then((status) => {
        if (controller.signal.aborted) return;
        setRuntimeFailure(undefined);
        runtimeRetries.current = { key: `${groupId ?? ""}/${skillId}`, count: 0 };
        setRuntime(status);
        if (openPrepareOnce.current) {
          openPrepareOnce.current = false;
          if (status.planHash && ["not_prepared", "needs_prepare", "failed"].includes(status.state))
            setPreparing(true);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = runtimeLoadFailure(error);
        setRuntime(undefined);
        setRuntimeFailure(failure === "unsupported" ? undefined : failure);
        if (failure === "unsupported") return;
        const key = `${groupId ?? ""}/${skillId}`;
        if (runtimeRetries.current.key !== key) runtimeRetries.current = { key, count: 0 };
        if (failure === "verifying" && runtimeRetries.current.count < RUNTIME_RETRY_LIMIT) {
          runtimeRetries.current.count += 1;
          retry = setTimeout(() => {
            if (!controller.signal.aborted) reloadRuntime();
          }, RUNTIME_RETRY_MS);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRuntimeLoading(false);
      });
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [peer, skillId, groupId, selectedRuntime, runtimeRevision, reloadRuntime]);
  useRpcEvent("skills.runtimeProgress", (event) => {
    if (
      event.skillId !== skillId ||
      event.groupId !== groupId ||
      (event.runtime && event.runtime !== runtime?.runtime)
    )
      return;
    setRuntime((current) =>
      current
        ? {
            ...current,
            state: event.state,
            progress: { phase: event.phase, done: event.done, total: event.total },
          }
        : current,
    );
    // The final state carries reasons and paths the progress event does not; read them once more.
    if (event.state !== "preparing") reloadRuntime();
  });

  const check = async (from?: "file" | "folder") => {
    if (!peer) return;
    setNotice(undefined);
    setLatest(false);
    const result = await updateTask.run(
      (signal) =>
        peer.call(
          "skills.checkUpdate",
          { groupId, skillId, ...(from ? { from } : {}) },
          { signal },
        ),
      skillError,
    );
    if (!result) return;
    setUpdate(result);
    if (result.available) setUpdating(result.available);
    else setLatest(true);
  };

  const apply = async () => {
    if (!peer || !updating) return;
    applyId.current ??= crypto.randomUUID();
    const requestId = applyId.current;
    const result = await updateTask.run(
      (signal) => peer.call("skills.applyUpdate", { groupId, skillId, requestId }, { signal }),
      skillError,
    );
    if (!result) return;
    applyId.current = undefined;
    setUpdating(undefined);
    setUpdate(result);
    setNotice({
      key: result.sourceVersion ? "skills.update.applied" : "skills.update.appliedUnknown",
      vars: { version: result.sourceVersion ?? "" },
    });
    onChanged?.();
  };

  const rollback = async () => {
    if (!peer) return;
    rollbackId.current ??= crypto.randomUUID();
    const requestId = rollbackId.current;
    const result = await updateTask.run(
      (signal) => peer.call("skills.rollbackUpdate", { groupId, skillId, requestId }, { signal }),
      skillError,
    );
    if (!result) return;
    rollbackId.current = undefined;
    setUpdate(result);
    setNotice({ key: "skills.update.rolledBack" });
    onChanged?.();
  };

  const prepare = async () => {
    if (!peer || readOnly || !runtime?.planHash) return;
    prepareId.current ??= crypto.randomUUID();
    const requestId = prepareId.current;
    const planHash = runtime.planHash;
    setPreparing(false);
    const result = await prepareTask.run(
      (signal) =>
        peer.call(
          "skills.runtime.prepare",
          {
            groupId,
            skillId,
            runtime: runtime.runtime,
            requestId,
            planHash,
            confirmWithoutIsolation: runtime.requiresUnisolatedConfirmation,
            useMirror: runtime.managedPython && useMirror ? true : undefined,
          },
          { signal },
        ),
      skillError,
    );
    if (!result) {
      prepareId.current = undefined;
      reloadRuntime();
      return;
    }
    prepareId.current = undefined;
    setRuntime(result);
    if (
      runtime.resolvesPythonPackages &&
      result.reviewedPackages &&
      result.state === "not_prepared"
    )
      setPreparing(true);
    onChanged?.();
  };

  const cancel = async () => {
    if (!peer) return;
    const result = await runtimeTask.run(
      (signal) =>
        peer.call(
          "skills.runtime.cancel",
          { groupId, skillId, runtime: runtime?.runtime },
          { signal },
        ),
      skillError,
    );
    if (result) setRuntime(result);
  };

  const remove = async () => {
    if (!peer) return;
    const result = await runtimeTask.run(
      (signal) =>
        peer.call(
          "skills.runtime.remove",
          { groupId, skillId, runtime: runtime?.runtime },
          { signal },
        ),
      skillError,
    );
    if (!result) return;
    setRemoving(false);
    setLog(false);
    setRuntime(result);
    setNotice({ key: "skills.runtime.removeDone" });
  };

  const toggleLog = async () => {
    if (log !== false) {
      setLog(false);
      return;
    }
    if (!peer) return;
    const result = await runtimeTask.run(
      (signal) =>
        peer.call(
          "skills.runtime.log",
          { groupId, skillId, runtime: runtime?.runtime },
          { signal },
        ),
      skillError,
    );
    if (result) setLog(result);
  };

  const requirements = runtime?.requirements ?? [];
  const currentRequirements = requirements.filter(({ runtime: kind }) => kind === runtime?.runtime);
  const packages =
    runtime?.reviewedPackages ?? currentRequirements.flatMap((item) => item.packages ?? []);
  const needText = currentRequirements
    .map((requirement) => {
      const label = t(`skills.runtime.${requirement.runtime}` as TranslationKey);
      const version = requirement.version ? ` ${requirement.version}` : "";
      const count = requirement.packages?.length
        ? ` · ${t("skills.runtime.packageCount", { count: requirement.packages.length })}`
        : "";
      return `${label}${version}${count}`;
    })
    .join(" · ");
  const state = runtime?.state;
  const progress = runtime?.progress;
  const interpreterName = runtime?.runtime ? t(`skills.runtime.${runtime.runtime}`) : undefined;
  const interruptible = !readOnly && !updateTask.busy && !prepareTask.busy;

  return (
    <>
      {readOnly && <p className={styles.note}>{t("skills.update.readonlyNote")}</p>}
      <section className={styles.card}>
        <div className={styles.cardHead}>{t("skills.source.title")}</div>
        <div className={styles.cardBody}>
          {base && (
            <p className={styles.kv}>
              <span>{t("skills.source.from")}</span>
              <span>{originText(t, origin)}</span>
            </p>
          )}
          {summary.error && (
            <p role="alert" className={styles.error}>
              {t(summary.error)}{" "}
              <Button variant="pill" onClick={() => setRevision((n) => n + 1)}>
                {t("common.retry")}
              </Button>
            </p>
          )}
          {!base && !summary.error && (
            <p role="status" className={styles.note}>
              {t("common.loading")}
            </p>
          )}
          {update && (
            <p className={styles.kv}>
              <span>{t("skills.source.version")}</span>
              <span>
                {update.sourceVersion
                  ? t("skills.source.versionValue", {
                      version: update.sourceVersion,
                      digest: update.digest.slice(0, 7),
                      date: dateText(language, update.importedAt),
                    })
                  : t("skills.source.noVersion", {
                      digest: update.digest.slice(0, 7),
                      date: dateText(language, update.importedAt),
                    })}
              </span>
            </p>
          )}
          {update?.checkedAt && (
            <p className={styles.note}>
              {t("skills.source.checked", { when: dateText(language, update.checkedAt) })}
            </p>
          )}
        </div>
        {!readOnly && update && (
          <>
            <div className={styles.cardActions}>
              {update.available ? (
                <Button
                  variant="secondary"
                  className={styles.mini}
                  disabled={!interruptible}
                  onClick={() => setUpdating(update.available ?? undefined)}
                >
                  {update.available.version
                    ? t("skills.update.available", { version: update.available.version })
                    : t("skills.update.availableUnknown")}
                </Button>
              ) : origin ? (
                <Button
                  variant="secondary"
                  className={styles.mini}
                  loading={updateTask.busy}
                  disabled={updateTask.busy || !peer}
                  onClick={() => void check()}
                >
                  {updateTask.busy ? t("skills.update.checking") : t("skills.update.check")}
                </Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    className={styles.mini}
                    loading={updateTask.busy}
                    disabled={updateTask.busy || !peer}
                    onClick={() => void check("folder")}
                  >
                    {t("skills.update.checkFolder")}
                  </Button>
                  <Button
                    variant="ghost"
                    className={styles.mini}
                    disabled={updateTask.busy || !peer}
                    onClick={() => void check("file")}
                  >
                    {t("skills.update.checkFile")}
                  </Button>
                </>
              )}
              {update.rollback && (
                <Button
                  variant="ghost"
                  className={styles.mini}
                  loading={updateTask.busy}
                  disabled={updateTask.busy || !peer}
                  onClick={() => void rollback()}
                >
                  {t("skills.update.rollback")}
                </Button>
              )}
            </div>
            {latest && (
              <p role="status" className={styles.note}>
                {update.sourceVersion
                  ? t("skills.update.latest", { version: update.sourceVersion })
                  : t("skills.update.latestUnknown")}
              </p>
            )}
          </>
        )}
      </section>

      {!runtime && !runtimeFailure && runtimeLoading && (
        <section className={styles.card}>
          <div className={styles.cardHead}>{t("skills.runtime.title")}</div>
          <div className={styles.cardBody}>
            <p role="status" className={styles.note}>
              {t("common.loading")}
            </p>
          </div>
        </section>
      )}
      {base && !base.skill.builtinKey && (
        <SkillSecretBindings key={skillId} skillId={skillId} groupId={groupId} />
      )}
      {runtime && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            {t("skills.runtime.title")}
            <span className={styles.extraBadge} data-state={state}>
              {t(`skills.runtime.badge.${state}` as TranslationKey)}
            </span>
          </div>
          <div className={styles.cardBody}>
            {requirements.length > 1 && runtime.runtime && (
              <SegmentedControl<SkillManagedRuntime>
                label={t("skills.runtime.title")}
                value={runtime.runtime}
                disabled={
                  runtimeLoading || runtimeTask.busy || prepareTask.busy || state === "preparing"
                }
                options={requirements.map(({ runtime: kind }) => ({
                  value: kind,
                  label: t(`skills.runtime.${kind}`),
                }))}
                onValueChange={(kind) => {
                  setRuntimeLoading(true);
                  setShowPackages(false);
                  setLog(false);
                  setRemoving(false);
                  selectRuntime(kind);
                }}
              />
            )}
            {state === "not_required" ? (
              <p className={styles.note}>{t("skills.runtime.notRequired")}</p>
            ) : (
              <>
                {needText && (
                  <p className={styles.kv}>{t("skills.runtime.needs", { what: needText })}</p>
                )}
                {state === "preparing" && progress && (
                  <p role="status" className={styles.note}>
                    {t("skills.runtime.progress", {
                      phase: t(
                        runtime.resolvesPythonPackages && progress.phase === "dependencies"
                          ? "skills.runtime.phase.resolve"
                          : (`skills.runtime.phase.${progress.phase}` as TranslationKey),
                      ),
                      done: progress.done,
                      total: progress.total,
                    })}
                  </p>
                )}
                {state === "preparing" && !progress && (
                  <p role="status" className={styles.note}>
                    {t("skills.runtime.preparing")}
                  </p>
                )}
                {state === "not_prepared" && (
                  <p className={styles.note}>{t("skills.runtime.notPrepared")}</p>
                )}
                {state === "needs_prepare" && (
                  <p className={styles.note}>{t("skills.runtime.needsPrepare")}</p>
                )}
                {state === "failed" && (
                  <p role="alert" className={styles.error}>
                    {reasonText(t, runtime.reason)}
                  </p>
                )}
                {state === "ready" && (
                  <p className={styles.note}>
                    {t("skills.runtime.readyLine", {
                      interpreter: runtime.interpreter
                        ? `${interpreterName ?? runtime.interpreter.command} ${runtime.interpreter.version}`
                        : "—",
                      count: runtime.packages,
                      size: runtime.bytes === null ? "—" : sizeText(runtime.bytes),
                    })}
                  </p>
                )}
                {runtime.interpreter && (state === "not_prepared" || state === "needs_prepare") && (
                  <p className={styles.note}>
                    {t("skills.runtime.found", {
                      command: interpreterName ?? runtime.interpreter.command,
                      version: runtime.interpreter.version,
                    })}
                  </p>
                )}
              </>
            )}
            {showPackages &&
              (packages.length ? (
                <ul className={styles.extraList}>
                  {packages.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              ) : (
                <p className={styles.note}>{t("skills.runtime.noPackages")}</p>
              ))}
            {log !== false && (
              <>
                <p className={styles.note}>{t("skills.runtime.logSummary")}</p>
                {log.path && <p className={styles.note}>{log.path}</p>}
                <pre className={styles.body}>
                  {log.text.trim() ? log.text : t("skills.runtime.logEmpty")}
                </pre>
              </>
            )}
            {removing && (
              <div className={styles.confirm}>
                <p>{t("skills.runtime.removeConfirm")}</p>
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    className={styles.deleteButton}
                    loading={runtimeTask.busy}
                    disabled={runtimeTask.busy || !peer}
                    onClick={() => void remove()}
                  >
                    {t("skills.runtime.remove")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={runtimeTask.busy}
                    onClick={() => setRemoving(false)}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </div>
          {state !== "not_required" && (
            <div className={styles.cardActions}>
              {packages.length > 0 && (
                <Button
                  variant="ghost"
                  className={styles.mini}
                  onClick={() => setShowPackages((value) => !value)}
                >
                  {showPackages ? t("skills.runtime.hidePackages") : t("skills.runtime.packages")}
                </Button>
              )}
              {[
                "uv_network_failed",
                "install_network_failed",
                "windows_proxy_credentials",
              ].includes(runtime.reason ?? "") && (
                <Button
                  variant="secondary"
                  className={styles.mini}
                  onClick={() => navigation.openSettings("general", "network-proxy")}
                >
                  {t("skills.runtime.openProxy")}
                </Button>
              )}
              {runtime.logPath && (
                <Button variant="ghost" className={styles.mini} onClick={() => void toggleLog()}>
                  {log === false ? t("skills.runtime.log") : t("skills.runtime.hideLog")}
                </Button>
              )}
              {!readOnly && state === "preparing" && (
                <Button
                  variant="ghost"
                  className={styles.mini}
                  disabled={runtimeTask.busy || !peer}
                  onClick={() => void cancel()}
                >
                  {t("skills.runtime.cancel")}
                </Button>
              )}
              {!readOnly &&
                (state === "not_prepared" || state === "needs_prepare" || state === "ready") &&
                (runtime.planHash ? (
                  <Button
                    variant="secondary"
                    className={styles.mini}
                    disabled={!peer || runtimeLoading || prepareTask.busy}
                    onClick={() => setPreparing(true)}
                  >
                    {state === "ready"
                      ? t("skills.runtime.reprepare")
                      : t("skills.runtime.prepare")}
                  </Button>
                ) : (
                  // Without a plan there is nothing to approve yet; re-probing is the only action.
                  <Button
                    variant="secondary"
                    className={styles.mini}
                    disabled={runtimeLoading || !peer}
                    onClick={reloadRuntime}
                  >
                    {t("skills.runtime.recheck")}
                  </Button>
                ))}
              {!readOnly && state === "failed" && (
                <Button
                  variant="secondary"
                  className={styles.mini}
                  loading={runtimeLoading}
                  disabled={!peer || runtimeLoading || prepareTask.busy}
                  onClick={runtime.planHash ? () => setPreparing(true) : reloadRuntime}
                >
                  {t(runtime.planHash ? "skills.runtime.retry" : "skills.runtime.recheck")}
                </Button>
              )}
              {readOnly &&
                (state === "failed" || state === "not_prepared" || state === "needs_prepare") &&
                retryDestination && (
                  <Button
                    variant="secondary"
                    className={styles.mini}
                    onClick={() => retryDestination.open(runtime.runtime)}
                  >
                    {t("skills.runtime.retryInSkills", { bot: retryDestination.botName })}
                  </Button>
                )}
              {!readOnly && state === "ready" && (
                <Button
                  variant="ghost"
                  className={`${styles.mini} ${styles.danger}`}
                  disabled={runtimeTask.busy}
                  onClick={() => setRemoving(true)}
                >
                  {t("skills.runtime.remove")}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      {/* The block stays and names a fixed reason, so a failed read never hides the way
          to prepare the runtime; 重试 is the same read as opening the detail again. */}
      {runtimeFailure && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            {t("skills.runtime.title")}
            <span className={styles.extraBadge}>{t("skills.runtime.badge.unavailable")}</span>
          </div>
          <div className={styles.cardBody}>
            <p role="alert" className={styles.error}>
              {t(`skills.runtime.loadFailed.${runtimeFailure}` as TranslationKey)}
            </p>
          </div>
          <div className={styles.cardActions}>
            <Button
              variant="secondary"
              className={styles.mini}
              disabled={!peer || runtimeLoading}
              onClick={reloadRuntime}
            >
              {t("skills.runtime.retry")}
            </Button>
          </div>
        </section>
      )}

      {(!resourceRead.data || resourceRead.error) && (base || resourceRead.error) && (
        <section className={styles.card}>
          <div className={styles.cardHead}>{t("skills.compatibility.title")}</div>
          {resourceRead.error && (
            <p role="alert" className={styles.error}>
              {t(resourceRead.error)}
            </p>
          )}
          <div className={styles.cardActions}>
            <Button
              variant="secondary"
              className={styles.mini}
              loading={resourceRead.loading}
              disabled={!peer || resourceRead.loading}
              onClick={resourceRead.load}
            >
              {t(
                resourceRead.loading
                  ? "common.loading"
                  : resourceRead.error
                    ? "common.retry"
                    : "skills.compatibility.load",
              )}
            </Button>
          </div>
        </section>
      )}
      {!resources && !resourceRead.error && !!resourceRead.data?.files.length && (
        <section className={styles.card}>
          <h3 className={styles.cardHead}>
            {t("skills.detail.files", { count: resourceRead.data.files.length })}
          </h3>
          <SkillFileList
            files={resourceRead.data.files}
            label={t("skills.detail.files", { count: resourceRead.data.files.length })}
          />
        </section>
      )}
      {report &&
        (report.unavailable.length + report.partial.length + report.notice.length > 0 ? (
          <section className={styles.card}>
            <div className={styles.cardHead}>{t("skills.compatibility.title")}</div>
            {[
              ...new Set(
                [...report.unavailable, ...report.partial, ...report.notice].map(
                  (entry) => entry.code,
                ),
              ),
            ].map((code) => (
              <p key={code} className={styles.note}>
                {t(`skills.compatibility.impact.${code}`)}
              </p>
            ))}
            <details className={styles.extraCard}>
              <summary>
                {t("skills.compatibility.details")}
                <span className={styles.extraBadge}>
                  {t("skills.compatibility.counts", {
                    unavailable: report.unavailable.length,
                    partial: report.partial.length,
                    notice: report.notice.length,
                  })}
                </span>
              </summary>
              {[
                ["unavailable", report.unavailable],
                ["partial", report.partial],
                ["notice", report.notice],
              ].map(([kind, entries]) =>
                (entries as SkillCompatibilityEntry[]).length ? (
                  <div key={kind as string} className={styles.extraGroup}>
                    <h4>{t(`skills.compatibility.${kind}` as TranslationKey)}</h4>
                    <ul className={styles.extraList}>
                      {(entries as SkillCompatibilityEntry[]).map((entry) => (
                        <li key={`${entry.code}:${JSON.stringify(entry.params)}`}>
                          {compatibilityText(t, entry)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
              <p className={styles.note}>{t("skills.compatibility.advisory")}</p>
            </details>
          </section>
        ) : (
          <p className={styles.note}>{t("skills.compatibility.none")}</p>
        ))}

      {notice && (
        <p role="status" className={styles.status}>
          {t(notice.key, notice.vars)}
        </p>
      )}
      {(updateTask.error || runtimeTask.error || prepareTask.error) && (
        <p role="alert" className={styles.error}>
          {t((updateTask.error ?? runtimeTask.error ?? prepareTask.error) as TranslationKey)}
        </p>
      )}

      {updating && (
        <SkillUpdateDialog
          name={name}
          fromVersion={update?.sourceVersion ?? null}
          pending={updating}
          busy={updateTask.busy}
          error={updateTask.error}
          keep={() => setUpdating(undefined)}
          apply={() => void apply()}
        />
      )}
      {preparing && runtime?.planHash && runtime.state !== "preparing" && (
        <RuntimePrepareDialog
          name={name}
          status={runtime}
          busy={prepareTask.busy}
          error={prepareTask.error}
          close={() => setPreparing(false)}
          confirm={() => void prepare()}
          useMirror={useMirror}
          setUseMirror={setUseMirror}
        />
      )}
    </>
  );
}

/** The approval card before anything is installed; it names the interpreter and the writes. */
function RuntimePrepareDialog({
  name,
  status,
  busy,
  error,
  close,
  confirm,
  useMirror,
  setUseMirror,
}: {
  name: string;
  status: SkillRuntimeStatus;
  useMirror: boolean;
  setUseMirror(value: boolean): void;
  busy: boolean;
  error?: TranslationKey;
  close(): void;
  confirm(): void;
}) {
  const { t } = useSettings();
  const python = status.runtime === "python";
  const managed = status.managedPython;
  const windows = status.requiresUnisolatedConfirmation;
  const resolving = status.resolvesPythonPackages;
  const packages = windows
    ? (status.reviewedPackages ?? [])
    : (status.requirements.find((item) => item.runtime === status.runtime)?.packages ?? []);
  const network = status.networkDomains;
  const domains = (useMirror ? network?.withMirror : undefined) ?? network?.primary;
  return (
    <div className={styles.overlay} role="presentation">
      <div
        className={`${styles.dialog} ${styles.wideDialog}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("skills.runtime.approval.title", { name })}
      >
        <h2>{t("skills.runtime.approval.title", { name })}</h2>
        <p className={styles.kv}>
          <span>{t("skills.runtime.approval.uses")}</span>
          <span>
            {managed
              ? t("skills.runtime.approval.managedPython", {
                  version: managed.uvVersion,
                  size: Math.round(managed.uvBytes / 1_000_000),
                  python: managed.pythonRequest,
                })
              : t("skills.runtime.approval.usesValue", {
                  interpreter: status.interpreter
                    ? `${status.runtime ? t(`skills.runtime.${status.runtime}`) : status.interpreter.command} ${status.interpreter.version}`
                    : "—",
                })}
          </span>
        </p>
        <p className={styles.kv}>
          <span>{t("skills.runtime.approval.runs")}</span>
          <span>
            {resolving
              ? t("skills.runtime.approval.resolvePythonBody")
              : windows && !packages.length
                ? t("skills.runtime.approval.noPackages")
                : python
                  ? t("skills.runtime.approval.runsPython", { count: status.packages })
                  : t(
                      windows
                        ? "skills.runtime.approval.runsWindowsNode"
                        : "skills.runtime.approval.runsNode",
                    )}
            {packages.length && !windows ? ` · ${packages.join(", ")}` : ""}
          </span>
        </p>
        {windows && packages.length > 0 && (
          <p className={styles.kv}>
            <span>{t("skills.runtime.approval.reviewedPackages")}</span>
            <span>{packages.join(", ")}</span>
          </p>
        )}
        <p className={styles.warn}>
          {t(windows ? "skills.runtime.approval.windows" : "skills.runtime.approval.risk")}
        </p>
        {domains && (
          <p className={styles.kv}>
            <span>{t("skills.runtime.approval.network")}</span>
            <span>
              {t("skills.runtime.approval.networkDomains", { domains: domains.join(", ") })}
            </span>
          </p>
        )}
        {(!windows || managed) && (
          <details>
            <summary>{t("skills.runtime.advanced")}</summary>
            {!windows && (
              <p className={styles.kv}>
                <span>{t("skills.runtime.approval.writes")}</span>
                <span>
                  {t(
                    python
                      ? "skills.runtime.approval.writesPython"
                      : "skills.runtime.approval.writesValue",
                  )}
                </span>
              </p>
            )}
            {managed && (
              <label>
                <input
                  type="checkbox"
                  checked={useMirror}
                  disabled={busy}
                  onChange={(event) => setUseMirror(event.currentTarget.checked)}
                />
                {t("skills.runtime.mirror")}
              </label>
            )}
          </details>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button variant="ghost" disabled={busy} onClick={close}>
            {t("skills.runtime.approval.notNow")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!status.planHash || busy}
            onClick={confirm}
          >
            {t(
              resolving
                ? "skills.runtime.approval.resolvePython"
                : "skills.runtime.approval.confirm",
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
