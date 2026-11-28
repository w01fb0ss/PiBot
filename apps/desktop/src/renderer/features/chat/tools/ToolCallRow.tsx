import {
  activeToolLabel,
  displayToolTarget,
  isPlanReadOnly,
  type ToolPaths,
  toolDenialReason,
  toolNameKey,
  toolStatusKey,
  toolSummaryLabel,
} from "@pibot/client-core";
import { EnableVideoModel } from "@pibot/models/ui";
import type { ToolCallRecord } from "@pibot/protocol";
import { approvalStyles as styles, useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useHistoryOutput } from "../../run-log/use-history-output.ts";
import { RunLogButton } from "../../run-log/Viewer.tsx";
import { BackgroundLine } from "../status/BackgroundLine.tsx";
import { useAgentSteps } from "./agent-steps.ts";
import { ForegroundButton } from "./ForegroundButton.tsx";
import lively from "./lively.module.css";
import type { ActivityTool } from "./local-activity.ts";
import { OfficeRenderStep } from "./OfficeRenderStep.tsx";
import { openToolResource } from "./open-tool-resource.ts";
import { ReadMessagesSearchStep } from "./ReadMessagesSearchStep.tsx";
import { ToolOutput } from "./ToolOutput.tsx";
import { toolIcon } from "./tool-icon.ts";

export function ToolCallRow({
  tool,
  messageId,
  runId,
  botId,
  step,
  target,
  paths = {},
  current = false,
  forceOpen = false,
  focusOpen = false,
  expanded,
  onExpandedChange,
  steps,
  children,
  notice,
}: {
  tool: ActivityTool | ToolCallRecord;
  messageId: string;
  runId: string;
  botId: string;
  step: number;
  target?: string;
  paths?: ToolPaths;
  current?: boolean;
  forceOpen?: boolean;
  focusOpen?: boolean;
  expanded: boolean;
  onExpandedChange(value: boolean): void;
  /** Computer steps and thumbnails follow the same disclosure as other tool details. */
  steps?: ReactNode;
  children?: ReactNode;
  notice?: ReactNode;
}) {
  const t = useT();
  const { peer } = useRpc();
  const { openPage, openSettings, navigate } = useNavigation();
  const settingsAction = tool.settingsAction;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const contentId = useId();
  const openDetails = forceOpen || expanded || focusOpen;
  useEffect(() => {
    if (focusOpen && !expanded) onExpandedChange(true);
  }, [focusOpen, expanded, onExpandedChange]);
  const generation = useRef(0);
  const opening = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: cancel the file lookup when its peer is replaced
  useEffect(() => {
    generation.current++;
    setBusy(false);
    return () => {
      generation.current++;
      opening.current?.abort();
    };
  }, [peer]);
  const planBlocked = isPlanReadOnly(tool);
  const command = tool.tool === "run_command";
  // This gates the open-file button (only writable results can be opened), not the row
  // icon — reading `file` for the icon was why every non-command step showed the gear.
  const writesFile = ["write_file", "edit_file", "office_create", "office_edit"].includes(
    tool.tool,
  );
  // An external agent's step has no Pi Bot command log; its output is what the agent reported.
  const agentSteps = useAgentSteps();
  const agent = tool.toolCallId.startsWith("acp-")
    ? (agentSteps.agentName ?? agentSteps.agentNames?.get(botId))
    : undefined;
  const preview = useHistoryOutput(
    peer,
    runId,
    tool.toolCallId,
    !agent &&
      command &&
      openDetails &&
      typeof tool.exitCode === "number" &&
      (!("output" in tool) || !tool.output),
  );
  const live = "output" in tool && tool.output ? tool.output : undefined;
  const detail = agent ? agentSteps.details.get(runId)?.get(tool.toolCallId) : undefined;
  const output = agent
    ? (live ?? detail?.output ?? t("externalAgents.receipt.notReported", { name: agent }))
    : (live ?? preview.text);
  // Some adapters send the command only as the execution step's title.
  const shownTarget =
    detail?.input ??
    target ??
    (agent && command && tool.summary !== "…" ? tool.summary : undefined);
  // The current protocol omits logPath. A numeric command exit code only comes from
  // an exec result that created a log; duration/output alone also occur on failures before exec.
  const hasLog = !agent && command && typeof tool.exitCode === "number";
  const waitingFor =
    "waitingFor" in tool && tool.status === "running" ? tool.waitingFor : undefined;
  // Brain replaces a SKILL.md read's summary with "used skill X", and a finished phone read
  // says what came back; the generic name and target alone would hide that.
  const skillUse = toolSummaryLabel(tool);
  // A refused non-command step says why it was refused, not just "Denied".
  // Hand the whole record over — dropping it to `{ status }` for card-less steps was why
  // a direct refusal (denialReason on the record) still showed only "Denied".
  const denial = planBlocked ? undefined : toolDenialReason(tool, t);
  const stepTarget = target && !skillUse ? displayToolTarget(tool.tool, target, paths) : undefined;
  const action = skillUse ?? t(toolNameKey(tool.tool));
  const label = t("tool.step", {
    action: !current
      ? action
      : skillUse
        ? t("tool.executing", { action, target: "" })
        : activeToolLabel(tool.tool, stepTarget, t),
    target: !current && stepTarget ? ` ${stepTarget}` : "",
    step,
  });
  const statusLabel = planBlocked
    ? t("agentWork.planBlocked")
    : waitingFor === undefined
      ? t(toolStatusKey(tool))
      : waitingFor
        ? t(
            tool.tool === "review_start"
              ? "tool.status.waitingReviewFolder"
              : "tool.status.waitingFolder",
            { bot: waitingFor },
          )
        : t(
            tool.tool === "review_start"
              ? "tool.status.waitingReviewFolderUnknown"
              : "tool.status.waitingFolderUnknown",
          );
  const heading = (
    <>
      <Icon name={planBlocked ? "audit" : toolIcon(tool.tool)} />
      <span className={styles.stepLabel} title={label}>
        {label}
      </span>
      <small className={styles.stepStatus}>
        {statusLabel}
        {tool.codeAnalysis && (
          <>
            {" "}
            · <span title={t("tool.syntaxApproximateNote")}>{t("tool.syntaxApproximate")}</span>
          </>
        )}
        {denial && waitingFor === undefined && ` · ${denial}`}
      </small>
    </>
  );
  const open = async (kind: "file") => {
    if (!peer || opening.current) return;
    const version = generation.current;
    const controller = new AbortController();
    opening.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setBusy(true);
    setError(false);
    try {
      await openToolResource(
        peer,
        { kind, botId, runId, toolCallId: tool.toolCallId },
        controller.signal,
      );
    } catch {
      if (version === generation.current) setError(true);
    } finally {
      clearTimeout(timeout);
      if (opening.current === controller) opening.current = undefined;
      if (version === generation.current) setBusy(false);
    }
  };
  return (
    <div
      className={`${styles.tool} ${lively.step} ${current ? styles.currentTool : ""}`}
      data-tool-call-id={tool.toolCallId}
      aria-current={current ? "step" : undefined}
    >
      {forceOpen ? (
        <div className={styles.stepHeading}>{heading}</div>
      ) : (
        <button
          type="button"
          className={styles.stepToggle}
          aria-expanded={openDetails}
          aria-controls={contentId}
          onClick={() => onExpandedChange(!expanded)}
        >
          {heading}
          <Icon
            name="chevron"
            size={12}
            style={{ transform: openDetails ? undefined : "rotate(-90deg)" }}
          />
        </button>
      )}
      {command && tool.status === "running" && (
        <ForegroundButton botId={botId} runId={runId} toolCallId={tool.toolCallId} />
      )}
      {command && <BackgroundLine botId={botId} runId={runId} toolCallId={tool.toolCallId} />}
      {notice}
      {settingsAction?.kind === "enable_video_model" && (
        <EnableVideoModel providerId={settingsAction.providerId} model={settingsAction.model} />
      )}
      {settingsAction?.kind === "open_settings" && (
        <Button
          variant="ghost"
          onClick={() =>
            settingsAction.page === "connections"
              ? openPage("connectors")
              : openSettings(settingsAction.page)
          }
        >
          {t("piSettings.openSettings")}
        </Button>
      )}
      {(settingsAction?.kind === "repoint_knowledge" ||
        settingsAction?.kind === "open_knowledge") && (
        <div className={styles.actions} role="alert">
          <span>
            {t(
              settingsAction.kind === "repoint_knowledge"
                ? "knowledge.vaultChangedTitle"
                : "knowledge.notionWriteRecovery",
            )}
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              openPage("connectors");
              navigate({ name: "connectors", knowledgeSourceId: settingsAction.sourceId });
            }}
          >
            {t("knowledge.openKnowledge")}
          </Button>
        </div>
      )}

      <div id={contentId} hidden={!openDetails}>
        {steps}
        {tool.codeAnalysis && <p>{t("tool.syntaxApproximateNote")}</p>}
        {tool.inputTranslation && (
          <p>{t("tool.inputTranslation", { text: tool.inputTranslation })}</p>
        )}
        {openDetails && tool.tool === "office_render" && tool.status === "done" && (
          <OfficeRenderStep
            key={tool.toolCallId}
            runId={runId}
            messageId={messageId}
            toolCallId={tool.toolCallId}
          />
        )}
        {tool.tool === "read_messages" && output && openDetails && (
          <ReadMessagesSearchStep output={output} />
        )}
        {command && shownTarget && <pre className={styles.output}>{shownTarget}</pre>}
        {command &&
          (preview.loading ? (
            <p role="status">{t("common.loading")}</p>
          ) : preview.error ? (
            <p role="alert" className={styles.risk}>
              {t(preview.error === "missing" ? "log.missing" : "log.error")}{" "}
              <Button variant="ghost" onClick={preview.retry}>
                {t("common.retry")}
              </Button>
            </p>
          ) : (
            <ToolOutput
              output={output}
              expanded={openDetails}
              history={!agent && (!("output" in tool) || !tool.output)}
              {...(agent ? { note: t("externalAgents.receipt.outputNote", { name: agent }) } : {})}
            />
          ))}
        <div className={styles.actions}>
          {tool.exitCode !== null && <span>{t("tool.exit", { code: tool.exitCode })}</span>}
          {tool.durationMs !== null && (
            <span>{t("tool.duration", { seconds: (tool.durationMs / 1000).toFixed(1) })}</span>
          )}
          {hasLog && (
            <RunLogButton
              details={{
                runId,
                toolCallId: tool.toolCallId,
                botId,
                command: target ?? tool.summary,
                exitCode: tool.exitCode,
                durationMs: tool.durationMs,
              }}
            />
          )}
        </div>
        {writesFile && tool.status === "done" && (
          <Button variant="ghost" disabled={!peer || busy} onClick={() => void open("file")}>
            {t("tool.openFile")}
          </Button>
        )}
        {children}
        {error && (
          <p role="alert" className={styles.risk}>
            {t("tool.openError")}
          </p>
        )}
      </div>
    </div>
  );
}
