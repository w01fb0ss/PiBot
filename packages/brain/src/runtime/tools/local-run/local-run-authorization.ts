import type { LocalToolCall } from "@pibot/agent";
import { ExecError, type ExecutionTarget } from "@pibot/execution";
import {
  applyEditorTerminal,
  applyWindowsCommandConsent,
  applyYolo,
  automaticOutsidePatterns,
  automaticOutsideShape,
  browserSecretPolicy,
  EDITOR_TERMINAL_UNISOLATED,
  editorTerminalReadonly,
  explainPolicyResult,
  LISTED_OUTSIDE_SANDBOX_REASON,
  mustAskNow,
  OUTSIDE_SANDBOX_REASON,
  OUTSIDE_WRITE_REASON,
  type PolicyResult,
  REVEAL_CONFIRMATION_REASON,
  recordPolicyStep,
  WINDOWS_ORDINARY_COMMAND,
  WINDOWS_READ_ONLY,
} from "@pibot/policy";
import { BrowserNetworkConsentText, RpcError } from "@pibot/protocol-base";
import { BotsRepo, ChatNoticesRepo, SettingsRepo } from "@pibot/storage";
import { BROWSER_RESOURCE_BUSY, loginChoiceText } from "@pibot/tools/browser";
import type { ConnectorCardDisplay } from "../../../core/approvals.ts";
import { collaborationRefusal } from "../../../core/assignment-refusal.ts";
import { auditProviderName, auditText, auditToolFields } from "../../../core/audit-fields.ts";
import { allowFolderForRun, auditAutoAllow, isAutoAllowed } from "../../../core/auto-allow.ts";
import { GroupToolError } from "../../../core/collaboration-tool-error.ts";
import type { PreparedTool } from "../../../core/local-types.ts";
import { allowedByYolo, runYolo } from "../../../core/yolo.ts";
import {
  acceptSearch,
  confirmSearch,
  needsSearchDisclosure,
  type SearchConsentReceipt,
} from "../../../integrations/search/search-consent.ts";
import type { SearchRecipient } from "../../../integrations/search/search-service.ts";
import { isComputerTool } from "../../computer/computer-grants-policy.ts";
import { loginNeedsChoice, loginTitle } from "../browser/browser-login.ts";
import { CommandInputError } from "../command-input.ts";
import { connectionRuled } from "../connectors/capability-adapter.ts";
import { noteDependency } from "../dependency-notices.ts";
import { executionPaused } from "../execution-paused.ts";
import {
  approvedUnchanged,
  authorizationSnapshot,
  toolFingerprint as fingerprint,
} from "../local-prepare.ts";
import type { LocalRunOperations } from "../local-run.ts";
import { policyWebsiteGuidance } from "../policy-website-notices.ts";
import { openPrivateTargets } from "../private-network.ts";
import { linkSandboxApproval } from "../sandbox-notices.ts";
import { RunnerToolUnsupportedError, runnerFailure } from "../target-tools.ts";
import { authorizationCheckText } from "../tool-error-text.ts";
import { blockedReason, isCollaboration, toolInputFailure } from "../tools.ts";
import { approvalPathFacts } from "./approval-paths.ts";
import {
  approvalContext,
  approvalResult,
  isCommandCall,
  PLAN_READ_ONLY,
  type State,
} from "./local-run-shared.ts";

/**
 * The session's working folders (primary and the editor's additional directories) and the
 * platform the editor terminal runs on, as policy judges an ACP command against them.
 */
function editorTerminalScope(this: LocalRunOperations, prepared: PreparedTool) {
  return {
    roots: prepared.boundary?.readRoots ?? prepared.roots,
    platform: prepared.boundary?.location?.platform ?? this.local.deps.platform,
  };
}

/** Apply the explicit approval boundary of ACP and Windows targets; neither is ever a grant. */
export function applyExplicitUnisolatedTarget(
  this: LocalRunOperations,
  prepared: PreparedTool,
  reason: string | undefined,
) {
  if (
    !isCommandCall(prepared.call.tool) ||
    prepared.result.decision === "deny" ||
    prepared.docker ||
    (reason !== "windows_unisolated" && reason !== EDITOR_TERMINAL_UNISOLATED)
  )
    return;
  const consent =
    runYolo(this.local, this.context) &&
    new SettingsRepo(this.local.deps.db).get().yoloUnisolatedCommands === true;
  const bounded =
    reason === EDITOR_TERMINAL_UNISOLATED
      ? applyYolo(
          applyEditorTerminal(prepared.result, {
            ...editorTerminalScope.call(this, prepared),
            sessionShapes: this.local.approvals.editorSessionShapes(this.context),
          }),
          consent,
          { unisolatedCommands: true },
        )
      : applyWindowsCommandConsent(prepared.result, consent);
  prepared.result = browserSecretPolicy(bounded, prepared.browserSecretUses?.length ?? 0);
}

export async function authorizeStep(
  this: LocalRunOperations,
  call: LocalToolCall,
  signal: AbortSignal,
  confirmation = false,
  recipient?: SearchRecipient,
  retriedWebsite = false,
): Promise<{ allow: boolean; reason?: string }> {
  if (this.closed) return { allow: false, reason: "已停止 / Stopped" };
  const state = this.state(call);
  const refuse = (code: string, reason: string) => {
    state.auditFacts = {
      ...state.auditFacts,
      policySteps: [...new Set([...(state.auditFacts?.policySteps ?? []), code])],
      // The audit and the step record keep the structured code; no display text is parsed.
      // A more specific code (the policy deny that produced this refusal) wins over the generic
      // refuser, so "记录" can name the actual reason.
      ...(state.auditFacts?.reasonCode ? {} : { reasonCode: code }),
    };
    return { allow: false, reason };
  };
  if (this.local.approvals.deniedOnResume(this.context, call))
    return refuse(
      "approval_user_denied",
      "用户拒绝了暂停的这一步，请换办法 / The user denied this paused operation; use another approach",
    );
  let failedRecheck: { check: string; text: string } | undefined;
  const recheckRefusal = (result: PolicyResult, error: ExecError): PolicyResult => {
    const check = error.check;
    failedRecheck = { check, text: authorizationCheckText(error) };
    return explainPolicyResult(
      { ...result, decision: "deny", reason: check, canRemember: false },
      "boundary",
      check,
    );
  };
  await this.local.tasks.guard(this.context, signal);
  if (!this.ports.definitions.some((tool) => tool.name === call.tool)) {
    const reason =
      "当前未加载此工具：先用 tool_discover 查找；确实不可用时请在 Bot / 群权限与连接详情中核对启用和访问范围。 / Tool not loaded: use tool_discover first; if unavailable, check Bot/group permissions and the connection’s enabled tools and access.";
    const denied = refuse("tool_not_loaded", reason);
    this.blocked(call, reason);
    return denied;
  }
  if (
    this.context.executionTaskId &&
    (call.tool === "read_messages" || isCollaboration(call.tool))
  ) {
    return refuse(
      "task_conversation_scope",
      "子任务只能使用父任务明确提供的对话引用 / A subtask can use only conversation references provided by its parent",
    );
  }
  if (!this.local.execution.allows(this.context, call.tool)) {
    state.auditFacts = { policySteps: ["plan_readonly"] };
    const denied = refuse("plan_readonly", PLAN_READ_ONLY);
    this.blocked(call, PLAN_READ_ONLY);
    return denied;
  }
  state.preauthId = undefined;
  state.preauthWriteRoot = undefined;
  // A retry of the same call id is a new call; what was opened before is not reused.
  state.outsideWriteRoots = undefined;
  state.modelCallInput = undefined;
  const failure = toolInputFailure(call.tool, call.input, this.local.deps.capabilityTools);
  if (failure) {
    const reported =
      this.local.collaboration?.planInputFailure?.(this.context, call, failure) ?? failure;
    this.failInput(state, { ...failure, text: reported.text });
    return refuse("invalid_tool_input", reported.text);
  }
  if (isComputerTool(call.tool)) return this.authorizeComputer(state, call, signal);
  let prepared: PreparedTool;
  try {
    prepared = await this.prepare(call, signal, recipient);
  } catch (error) {
    // Commands are paused while a background cleanup is unconfirmed; reporting that as a refused
    // approval is what hid the real cause for hours.
    const paused = executionPaused(error);
    if (paused) {
      signal.throwIfAborted();
      const denied = refuse("cleanup_failed", paused);
      this.blocked(call, paused);
      return denied;
    }
    if (error instanceof CommandInputError) {
      const failure = toolInputFailure(
        call.tool,
        call.input,
        this.local.deps.capabilityTools,
        error.validation,
      );
      if (failure) {
        this.failInput(state, failure);
        return refuse("invalid_tool_input", failure.text);
      }
    }
    const assignment = collaborationRefusal(call.tool, error);
    if (assignment && !signal.aborted) return refuse("tool_authorization_refused", assignment);
    if (error instanceof RpcError && error.message === "background_input_unavailable")
      return refuse(
        "background_input_unavailable",
        "找不到当前 Bot 在此话题的存活后台进程，或当前运行不支持交互输入 / No live background process owned by this Bot in this conversation, or this run does not support interactive input",
      );
    if (error instanceof RpcError && error.message === "browser_resource_busy")
      return refuse("browser_resource_busy", BROWSER_RESOURCE_BUSY);
    // The catalog hides these for a runner workplace; a direct or retried call still gets the
    // tool's name instead of the generic "tool approval failed" text.
    if (error instanceof RunnerToolUnsupportedError)
      return refuse("runner_tool_unsupported", error.message);
    // Preparing the call resolves the runner target, so offline / revoked / dropped surfaces here.
    if (error instanceof RpcError && ["endpoint_offline", "capability_off"].includes(error.message))
      return refuse(error.message, error.message);
    if (error instanceof RpcError && error.message === "phone_wake_timeout")
      return refuse(
        "phone_wake_timeout",
        "已尝试唤醒，手机没有及时上线；请打开 App 或开启保持连接 / Wake attempted, but the phone did not connect in time; open the app or enable Stay connected",
      );
    if (error instanceof RpcError && error.message === "phone_wake_unavailable")
      return refuse(
        "phone_wake_unavailable",
        "无法后台唤醒手机（未开启通知或数据、达到频率限制，或不支持推送）；请打开 App 或开启保持连接。无 Google 服务的安卓手机不支持后台推送 / Cannot wake the phone (notifications or data off, rate limited, or push unavailable); open the app or enable Stay connected. Android without Google services cannot receive background pushes",
      );
    const runnerFailed = runnerFailure(error);
    if (runnerFailed) return refuse(runnerFailed.code, runnerFailed.text);
    // The execution device refuses its own private paths (credentials, its data
    // folder, a drive root, another machine's share) the same way policy protects this computer's.
    // Thrown, that correct refusal reached the model as "Tool approval failed" and logged at error
    // level, as if the gate had crashed.
    if (error instanceof RpcError && error.message === "runner_path_unavailable")
      return refuse(
        "protected_path",
        "执行端拒绝了这个位置：它在执行端设备上受保护或不可用（凭据、Pi Bot 数据目录、盘符根目录、其他设备的共享，或工作位置之外）。请改用工作文件夹里的具体子路径，或请用户自己处理 / The execution target refused this location: on that device it is protected or unavailable (credentials, Pi Bot's data folder, a drive root, another device's share, or outside the workplace). Use a specific path inside the working folder, or ask the user to handle it",
      );
    if (error instanceof GroupToolError)
      return refuse("tool_authorization_refused", this.local.deps.redactor.redact(error.message));
    if (
      isCollaboration(call.tool) &&
      error instanceof RpcError &&
      (error.code === -32602 || error.code === -32011)
    )
      return refuse(
        "tool_authorization_refused",
        "协作身份、归属或周期不可用，或存在循环 / Collaboration identity, ownership or cycle unavailable, or cyclic request",
      );
    throw error;
  }
  state.auditFacts = {
    ...auditToolFields(
      call,
      this.local.deps.redactor,
      prepared.result,
      this.local.deps.capabilityTools,
    ),
    source: this.context.routineSource ?? this.context.auditSource ?? "chat",
    ...(this.context.routineRunId ? { routineRunId: this.context.routineRunId } : {}),
    ...(prepared.result.decision === "deny" ? { reasonCode: prepared.result.reason } : {}),
  };
  if (prepared.result.decision === "deny") {
    state.settingsAction = prepared.settingsAction;
    const website = policyWebsiteGuidance(
      this.local,
      this.context,
      prepared,
      retriedWebsite || state.synthetic ? undefined : signal,
    );
    if (website.retry) {
      this.context.executionClock?.pause("website_approval");
      let confirmed: boolean;
      try {
        confirmed = await website.retry;
      } finally {
        this.context.executionClock?.resume("website_approval");
      }
      if (confirmed) return authorizeStep.call(this, call, signal, confirmation, recipient, true);
    }
    return refuse(
      prepared.result.reason,
      prepared.refusalText ??
        (prepared.result.reason === "browser_login_choose"
          ? loginChoiceText(prepared.login?.accounts.map((account) => account.label) ?? [])
          : blockedReason(prepared.result.reason, prepared.result.category) + website.help),
    );
  }
  if (prepared.commandSkill?.missing) {
    const skill = prepared.commandSkill.missing;
    if (this.context.conversationId && !this.context.routineSource) {
      const notice = new ChatNoticesRepo(this.local.deps.db).addAgentWarning({
        runId: this.context.runId,
        botId: this.context.botId,
        conversationId: this.context.conversationId,
        text: `Skill runtime required (${this.context.runId} ${skill.skillId} ${skill.runtime ?? ""})`,
        skillRuntime: { ...skill, name: this.local.deps.redactor.redact(skill.name).slice(0, 80) },
      });
      if (notice) this.local.deps.peer.emit("chat.notice", notice);
    }
    const message =
      "技能需要先准备运行环境。请用户使用准备按钮后再运行。 / This skill needs its runtime prepared. Ask the user to use the preparation button before running it again.";
    return refuse("skill_runtime_required", message);
  }
  if (needsSearchDisclosure(prepared.result.reason) && !confirmation && this.local.deps.search)
    return this.local.deps.search.confirmation(
      signal,
      (current) => this.authorize(call, current, true, recipient),
      this.timing(call.id),
    );
  let isolation: Awaited<ReturnType<ExecutionTarget["isolationStatus"]>>;
  try {
    isolation = isCommandCall(call.tool)
      ? await this.owner.target.isolationStatus(signal)
      : { available: true, reason: "command_isolation_not_applicable" };
  } catch (error) {
    const paused = executionPaused(error);
    if (!paused) throw error;
    signal.throwIfAborted();
    const denied = refuse("cleanup_failed", paused);
    this.blocked(call, paused);
    return denied;
  }
  state.isolated = isolation.available;
  const readonlyRoots =
    isCommandCall(call.tool) && prepared.boundary?.roots.some((root) => root.role === "readonly");
  // Readonly references normally rely on the sandbox to stop writes. In an editor terminal a
  // command the analysis proved read-only cannot write there, so only those may still run.
  const editorScope = editorTerminalScope.call(this, prepared);
  const editorReadonly =
    readonlyRoots &&
    !prepared.docker &&
    isolation.reason === EDITOR_TERMINAL_UNISOLATED &&
    editorTerminalReadonly(prepared.result, editorScope.roots, editorScope.platform);
  if (
    authorizationSnapshot(this.local, this.context.botId, this.context) !== prepared.authorization
  )
    return refuse("changed", blockedReason("changed"));
  if (isCommandCall(call.tool) && !isolation.available && !prepared.docker) {
    if (
      this.local.deps.platform === "linux" &&
      !this.local.deps.executionLocation &&
      !this.context.runWorkplace?.boundary.location?.target.startsWith("runner:") &&
      (isolation.reason === "linux_bubblewrap_missing" ||
        isolation.reason === "linux_socat_missing" ||
        isolation.reason === "linux_userns_restricted")
    )
      noteDependency(this.local, this.context, isolation.reason);
    // Windows and an ACP editor terminal are explicit execution targets that cannot attest to
    // Pi Bot's local sandbox. Both stay on the unisolated approval path; an arbitrary local
    // sandbox failure is still a hard stop that no approval or YOLO may bypass.
    // A run outside the sandbox needs a working sandbox that blocked this very call
    // first, so it never reaches this branch.
    if (
      isolation.reason !== "windows_unisolated" &&
      isolation.reason !== "acp_editor_terminal_unisolated"
    ) {
      // A Linux host that cannot isolate looks identical to a broken one unless the cause
      // and the fix travel with the refusal; the caller cannot see the runner's log.
      const remote =
        this.local.deps.executionLocation ||
        this.context.runWorkplace?.boundary.location?.target.startsWith("runner:");
      if (!remote)
        return refuse(
          "isolation_unavailable",
          this.context.language === "zh"
            ? "系统保护没有启动，命令没有运行。请在「设置 › 权限」检查原因。"
            : "System protection could not start, so the command did not run. Check Settings → Permissions for the cause.",
        );
      const dependency =
        isolation.reason === "linux_bubblewrap_missing"
          ? "bubblewrap"
          : isolation.reason === "linux_socat_missing"
            ? "socat"
            : undefined;
      const name = this.context.executionDevice?.name;
      const computer = name && auditText(name, this.local.deps.redactor);
      return refuse(
        "isolation_unavailable",
        this.context.language === "zh"
          ? `${computer ? `「${computer}」` : "运行这项任务的电脑"}未能启动系统保护，命令没有运行。${dependency ? `请让管理员在那台电脑上安装 ${dependency}，再重试。` : "请让管理员在那台电脑上恢复系统保护，再重试。"}`
          : `System protection couldn’t start on ${computer || "the computer running this task"}, so the command did not run. ${dependency ? `Ask an administrator to install ${dependency} on that computer, then retry.` : "Ask an administrator to restore system protection on that computer, then retry."}`,
      );
    }
    if (readonlyRoots && !editorReadonly)
      return refuse(
        "readonly_isolation_required",
        this.context.language === "zh"
          ? "这个命令需要保护附加的只读文件夹。请用文件工具读取资料，并把结果写入主文件夹。"
          : "This command needs protection for the additional read-only folder. Use file tools to read it and write results into the main folder.",
      );
    const unisolatedReason =
      isolation.reason === "acp_editor_terminal_unisolated"
        ? "acp_editor_terminal_unisolated"
        : "windows_unisolated";
    // An explicitly unisolated execution target is an ask; YOLO approves it only when the
    // user has turned on "YOLO auto-approves commands (no isolation)".
    applyExplicitUnisolatedTarget.call(this, prepared, unisolatedReason);
    if (
      allowedByYolo(prepared.result) ||
      (prepared.result.decision === "allow" && prepared.result.reason === WINDOWS_READ_ONLY)
    )
      state.unisolatedApproved = true;
  }
  if (readonlyRoots && !editorReadonly && (this.owner.platform !== "darwin" || prepared.docker))
    return refuse(
      "readonly_isolation_required",
      this.context.language === "zh"
        ? "当前运行方式无法保护附加的只读文件夹。请用文件工具读取资料，并把结果写入主文件夹。"
        : "This execution mode can’t protect the additional read-only folder. Use file tools to read it and write results into the main folder.",
    );
  // Isolation inspection may yield while the user enables YOLO. Re-check immediately before
  // creating a card, otherwise the newly created card would miss releasePending().
  // Naming a saved display name settles the choice; only an unnamed call still stops here.
  if (loginNeedsChoice(prepared) && runYolo(this.local, this.context))
    return refuse(
      "browser_login_choose",
      loginChoiceText(prepared.login?.accounts.map((account) => account.label) ?? []),
    );
  prepared.result = applyYolo(prepared.result, runYolo(this.local, this.context));
  // A capability tool served by a connection asks about the connection first. Secrets the
  // connection's own configuration references ride on that answer (`secret_connector_config`).
  if (
    prepared.connectorPolicy?.decision === "ask" &&
    prepared.capabilityConnector &&
    !connectionRuled(prepared.capabilityConnector.capabilityId)
  ) {
    const original = prepared;
    const before = fingerprint(original);
    if (mustAskNow(prepared.connectorPolicy)) {
      const status = await this.local.approvals.request(
        approvalContext(this.context, signal),
        call,
        approvalResult(this.context, prepared.connectorPolicy),
        isolation,
        async () => {
          let current: PreparedTool;
          try {
            current = await this.prepare(call, signal, recipient);
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof ExecError)) throw error;
            return recheckRefusal(original.result, error);
          }
          return fingerprint(current) === before && current.connectorPolicy
            ? current.connectorPolicy
            : explainPolicyResult(
                { ...original.result, decision: "deny", reason: "changed", canRemember: false },
                "boundary",
                "changed",
              );
        },
        undefined,
        undefined,
        undefined,
        prepared.connector ? { connector: connectorCardDisplay(prepared.connector) } : undefined,
      );
      if (status !== "allowed")
        return status === "denied" && failedRecheck
          ? refuse(failedRecheck.check, failedRecheck.text)
          : refuse("changed", blockedReason("changed"));
      prepared = await this.prepare(call, signal, recipient);
      if (prepared.result.decision === "deny" || !approvedUnchanged(prepared, original, before))
        return refuse("changed", blockedReason("changed"));
      // Only a person answers this card (YOLO and pre-authorization leave it pending), so its
      // draft is that same confirmation and is sent without a second card.
      prepared.confirmedNow = true;
    }
  }
  const resumed = this.local.unattendedAuthorization.resumed(
    this.context,
    prepared,
    isolation.available,
  );
  if (resumed !== undefined)
    recordPolicyStep(
      prepared.result,
      "grant",
      resumed ? "routine_resumed_allowed" : "routine_resumed_denied",
      "info",
    );
  state.auditFacts = {
    ...state.auditFacts,
    policySteps: prepared.result.explanation.map((step) => step.code),
  };
  if (resumed === true) {
    if (prepared.memorySafety) prepared.confirmedNow = true;
    state.unisolatedApproved = isCommandCall(call.tool) && !isolation.available;
    // The parked card was answered by the person; its hash covers the roots it named.
    state.outsideWriteRoots = openedByPerson(prepared.result);
    openPrivateTargets(this.local, this.context, prepared.result, prepared.result);
  }
  if (resumed === false)
    return refuse(
      "tool_authorization_refused",
      "用户拒绝或未响应，请换办法，不要重复请求 / The user denied or did not respond; use another approach and do not repeat the request",
    );
  const preauth =
    resumed === undefined
      ? this.local.unattendedAuthorization.match(this.context, prepared, isolation.available)
      : undefined;
  if (preauth && prepared.result.decision === "ask") {
    recordPolicyStep(prepared.result, "grant", "routine_preauth", "info");
    state.preauthId = preauth.id;
    if (preauth.operation.scope.kind === "workplace" || preauth.operation.scope.kind === "programs")
      state.preauthWriteRoot = preauth.operation.scope.root;
    this.local.unattendedAuthorization.audit(this.context, "routine.preauth.allowed", {
      preauthId: preauth.id,
      reasonCode: "routine_preauth",
      policySteps: prepared.result.explanation.map((step) => step.code),
    });
  }
  // A card answered by YOLO turning on is audited as that approval, not again as a step.
  // The connection card above already answered this exact call's mandatory question.
  const carded =
    prepared.result.decision === "ask" &&
    !preauth &&
    resumed !== true &&
    !(prepared.confirmedNow && mustAskNow(prepared.result));
  if (carded) {
    const invalid = this.local.toolCards.get(call.tool)?.(
      this.context,
      call.input,
      this.context.language,
      prepared.capabilityPolicyData,
    ).invalid;
    if (invalid) return refuse(invalid.code, invalid.text);
    let original = prepared;
    let approvedFingerprint = fingerprint(original);
    const originalInput = JSON.stringify(original.call.input);
    const modelOptions = original.capabilityModelOptions?.();
    const shownModel = modelOptions?.find(
      (option) => option.binding === original.capabilityPolicyBinding,
    );
    const alternatives = modelOptions?.filter((option) => option !== shownModel) ?? [];
    let receipt: SearchConsentReceipt | undefined;
    let folderAdded = false;
    let approvalId: string | undefined;
    let windowsYoloCard = false;
    let rememberDirectRun = false;
    const directRunPattern =
      original.result.reason === OUTSIDE_SANDBOX_REASON &&
      !this.context.routineRunId &&
      !this.context.permissionGroupId &&
      !this.context.groupId &&
      !this.context.approvalCardContext &&
      !original.secretUses?.length &&
      this.context.runWorkplace?.cwd === original.cwd
        ? availableDirectRunPattern.call(this, original)
        : undefined;
    const lifecycle = this.local.unattended?.approvalLifecycle(
      this.context,
      call,
      prepared,
      isolation,
    );
    const card = shownModel
      ? {
          text: (language: "zh" | "en") => shownModel.localized[language],
          modelOptions: alternatives.map(({ id, label, localized }) => ({ id, label, localized })),
          pauseBinding: shownModel.id,
          evaluateModel: async (id: string) => {
            const option = alternatives.find((candidate) => candidate.id === id);
            if (!option) throw new RpcError(-32602, "video_approval_changed");
            const current = await this.prepare({ ...call, input: option.input }, signal, recipient);
            if (
              current.capabilityPolicyBinding !== option.binding ||
              current.authorization !== original.authorization ||
              current.result.reason !== "video_generation_confirmation" ||
              current.result.decision !== "ask"
            )
              throw new RpcError(-32602, "video_approval_changed");
            return {
              result: current.result,
              commit: () => {
                original = current;
                approvedFingerprint = fingerprint(current);
                state.modelCallInput = originalInput;
              },
            };
          },
        }
      : this.consentCard(original);
    const pathFacts =
      this.local.deps.platform === "win32" && original.boundary?.location?.target === "local"
        ? await approvalPathFacts(original, signal)
        : undefined;
    const status = await this.local.approvals.request(
      // Settings recheck the live diff; an interrupted card must be proposed again.
      approvalContext(
        prepared.result.category === "settings_change"
          ? { ...this.context, pauseForApproval: undefined }
          : this.context,
        signal,
      ),
      call,
      approvalResult(this.context, prepared.result),
      isolation,
      async () => {
        let current: PreparedTool;
        try {
          current = await this.prepare(call, signal, recipient);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ExecError) return recheckRefusal(original.result, error);
          // A revoked managed source/root invalidates this card; it must not stay pending.
          if (call.tool === "image_result" && error instanceof RpcError && error.code === -32602)
            return explainPolicyResult(
              {
                ...original.result,
                decision: "deny",
                reason: "changed",
                canRemember: false,
              },
              "boundary",
              "changed",
            );
          throw error;
        }
        let currentIsolation = isolation;
        if (isCommandCall(call.tool)) {
          try {
            currentIsolation = await this.owner.target.isolationStatus(signal);
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof ExecError)) throw error;
            return recheckRefusal(current.result, error);
          }
        }
        if (!currentIsolation.available)
          applyExplicitUnisolatedTarget.call(this, current, currentIsolation.reason);
        current.result = applyYolo(current.result, runYolo(this.local, this.context));
        if (
          fingerprint(current) !== approvedFingerprint ||
          currentIsolation.available !== isolation.available ||
          currentIsolation.reason !== isolation.reason
        )
          return explainPolicyResult(
            { ...current.result, decision: "deny", reason: "changed", canRemember: false },
            "boundary",
            "changed",
          );
        return current.result;
      },
      needsSearchDisclosure(original.result.reason)
        ? () => {
            // A waiting disclosure released by YOLO is temporary authorization, not consent
            // to persist a global search setting for other conversations.
            if (runYolo(this.local, this.context)) return;
            receipt = acceptSearch(this.owner, original, approvedFingerprint);
          }
        : directRunPattern
          ? (remember) => {
              rememberDirectRun = remember === true;
            }
          : undefined,
      {
        ...lifecycle,
        requested: (approval) => {
          lifecycle?.requested(approval);
          linkSandboxApproval(this.local, this.context, original, approval);
        },
        resolved: (approval, by) => {
          if (approval.status === "allowed") approvalId = approval.id;
          if (approval.status === "allowed" && rememberDirectRun)
            state.directRunSaveRequested = approval.id;
          windowsYoloCard =
            by === "yolo" &&
            isolation.reason === "windows_unisolated" &&
            original.result.explanation.some((step) => step.code === WINDOWS_ORDINARY_COMMAND);
          lifecycle?.resolved(approval);
        },
      },
      {
        available:
          !!this.context.routineRunId &&
          this.context.routineSource === "routine" &&
          !!this.local.unattendedAuthorization.operation(prepared, isolation.available),
        allow: (approval) =>
          this.local.unattendedAuthorization.remember(
            this.context,
            original,
            approval,
            isolation.available,
          ),
      },
      {
        ...card,
        ...(pathFacts ? { facts: pathFacts } : {}),
        ...(original.result.reason === OUTSIDE_SANDBOX_REASON ||
        original.result.reason === LISTED_OUTSIDE_SANDBOX_REASON
          ? {
              directRunRemember: directRunPattern
                ? { folder: original.cwd, program: directRunPattern.slice(0, -2) }
                : (false as const),
            }
          : {}),
      },
      this.owner.folderChange(original, () => {
        folderAdded = true;
      }),
    );
    if (folderAdded)
      return refuse(
        "workspace_folder_added",
        "用户已把文件夹加入工作范围，请重试 / The user added the folder to this topic’s writable workspace; retry with a new tool call",
      );
    if (status === "denied" && failedRecheck)
      return refuse(failedRecheck.check, failedRecheck.text);
    if (status !== "allowed")
      return refuse(
        loginNeedsChoice(original) && runYolo(this.local, this.context)
          ? "browser_login_choose"
          : status === "cancelled"
            ? "approval_cancelled"
            : status === "expired" || status === "auto_denied"
              ? "approval_expired"
              : "approval_user_denied",
        loginNeedsChoice(original) && runYolo(this.local, this.context)
          ? loginChoiceText(original.login?.accounts.map((account) => account.label) ?? [])
          : needsSearchDisclosure(original.result.reason)
            ? `用户没有同意把查询发给 ${auditProviderName(recipient ?? "") ?? recipient} / The user did not consent to sending the query to ${auditProviderName(recipient ?? "") ?? recipient}`
            : status === "cancelled"
              ? "已停止 / Stopped"
              : status === "expired" || status === "auto_denied"
                ? "用户未响应，请换办法，不要重复请求 / The user did not respond; use another approach rather than repeating the request"
                : "用户拒绝了这次请求。不要自行重试；只有用户之后明确再次请求时，才提交新的审批。 / The user denied this request. Do not retry automatically. Submit a fresh request only if the person explicitly asks again in a later turn.",
      );
    state.unisolatedApproved = isCommandCall(call.tool) && !isolation.available;
    if (prepared.result.domain) state.onceDomains.add(prepared.result.domain);
    if (prepared.result.url) state.onceUrls.add(prepared.result.url);
    if (needsSearchDisclosure(original.result.reason)) {
      if (receipt)
        prepared = await confirmSearch(this.owner, original, signal, approvedFingerprint, receipt);
      else {
        prepared = await this.prepare(call, signal, recipient);
        if (!allowedByYolo(prepared.result)) return refuse("changed", blockedReason("changed"));
        state.yolo = prepared.result.risk;
      }
      if (fingerprint(prepared, original.authorization) !== approvedFingerprint)
        return refuse("changed", blockedReason("changed"));
    } else {
      prepared = await this.prepare(original.call, signal, recipient);
      if (!isolation.available)
        applyExplicitUnisolatedTarget.call(this, prepared, isolation.reason);
      prepared.result = applyYolo(prepared.result, runYolo(this.local, this.context));
      if (
        prepared.result.decision === "deny" ||
        (windowsYoloCard && !allowedByYolo(prepared.result)) ||
        !approvedUnchanged(prepared, original, approvedFingerprint)
      )
        return refuse("changed", blockedReason("changed"));
      // The card was let through by YOLO turning on; its step says so while live.
      if (allowedByYolo(prepared.result)) state.yolo = prepared.result.risk;
      else allowFolderForRun(this.local, this.context, call.tool, original.result);
      // YOLO never releases this card (`mustAskNow`), so "allowed" is the person's answer.
      if (original.result.reason === OUTSIDE_WRITE_REASON)
        state.outsideWriteRoots = openedByPerson(prepared.result);
      // YOLO never releases a must-ask card, so "allowed" here is the person's answer to this
      // exact call; its draft is the same confirmation and is not asked again.
      // SSH cards are ordinary ask cards, not must-ask, but the final dispatch still has to
      // know that this exact call was approved. YOLO can also release an ordinary card, and
      // that is not the person answering this card, so only the non-YOLO SSH case sets the
      // mark. The fingerprint recheck above binds it to this call, host and recipe; it is
      // never remembered for a later call.
      openPrivateTargets(this.local, this.context, original.result, prepared.result);
      if (
        (mustAskNow(original.result) && mustAskNow(prepared.result)) ||
        (original.hostSsh !== undefined &&
          prepared.hostSsh !== undefined &&
          !allowedByYolo(prepared.result))
      )
        prepared.confirmedNow = true;
      if (rememberDirectRun && directRunPattern && prepared.confirmedNow)
        prepared.rememberDirectRun = directRunPattern;
    }
    if (approvalId) prepared.approvalId = approvalId;
  }
  // Card/connector finalization may re-prepare the call. Restore the execution-target fact before
  // binding the value used by the final side-effect dispatch; otherwise the same safe transform
  // would look like a permission change at execution time.
  if (!isolation.available) applyExplicitUnisolatedTarget.call(this, prepared, isolation.reason);
  prepared.result = applyYolo(prepared.result, runYolo(this.local, this.context));
  signal.throwIfAborted();
  if (this.context.routineRunId)
    this.local.unattendedAuthorization.allowed(this.context, prepared, isolation.available);
  if (!carded && allowedByYolo(prepared.result)) this.markYolo(call, prepared.result);
  if (!carded && isAutoAllowed(prepared.result))
    auditAutoAllow(this.local, this.context, call, prepared.result);
  if (call.tool === "web_fetch" && state.yolo) state.initialPageYolo = prepared.result.url;
  state.auditFacts = {
    ...state.auditFacts,
    ...(state.modelCallInput
      ? auditToolFields(
          prepared.call,
          this.local.deps.redactor,
          prepared.result,
          this.local.deps.capabilityTools,
        )
      : {}),
    policySteps: prepared.result.explanation.map((step) => step.code),
  };
  state.prepared = prepared;
  // The SDK owns its argument object; bind a value, not a mutable object reference.
  state.fingerprint = fingerprint(prepared);
  if (state.startSeen) this.start(state);
  return { allow: true };
}

function availableDirectRunPattern(this: LocalRunOperations, prepared: PreparedTool) {
  const entries = new SettingsRepo(this.local.deps.db).get().sandboxAutoOutsideCommands ?? [];
  if (
    automaticOutsidePatterns(entries, prepared.cwd).length >= 32 ||
    !prepared.cwd ||
    prepared.cwd.length > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(prepared.cwd) ||
    this.local.deps.redactor.redact(prepared.cwd) !== prepared.cwd
  )
    return undefined;
  const command = prepared.call.input.command;
  if (typeof command !== "string") return undefined;
  const pattern = automaticOutsideShape(
    command,
    prepared.result.analysis,
    this.local.deps.platform,
  );
  return entries.length < 256 ||
    entries.some(
      (entry) =>
        entry.source === "auto" && entry.folder === prepared.cwd && entry.pattern === pattern,
    )
    ? pattern
    : undefined;
}

/** The folders a person's answer to an outside-write card opens for that one call. */
function openedByPerson(result: PolicyResult) {
  return mustAskNow(result) && result.reason === OUTSIDE_WRITE_REASON
    ? result.outsideWriteRoots
    : undefined;
}

/**
 * Operating the computer is decided by the computer gate (grant, card, always-list,
 * routine preauth, blocklist); the ordinary prepare only records what `execute` re-checks.
 */
export async function authorizeComputerStep(
  this: LocalRunOperations,
  state: State,
  call: LocalToolCall,
  signal: AbortSignal,
): Promise<{ allow: boolean; reason?: string }> {
  state.auditFacts = {
    ...auditToolFields(call, this.local.deps.redactor, undefined, this.local.deps.capabilityTools),
    category: "computer",
    source: this.context.routineSource ?? this.context.auditSource ?? "chat",
    ...(this.context.routineRunId ? { routineRunId: this.context.routineRunId } : {}),
  };
  const decision = await this.local.computerGrants.authorize(this.context, call, signal);
  if (!decision.allow) return decision;
  if (decision.yolo)
    this.markYolo(
      call,
      explainPolicyResult(
        {
          decision: "allow",
          reason: "yolo",
          risk: decision.yolo,
          facts: [],
          canRemember: false,
        },
        "yolo",
        "yolo",
      ),
    );
  const prepared = await this.prepare(call, signal);
  // The gate already handled "ask"; only a policy deny that appeared meanwhile still wins.
  if (prepared.result.decision === "deny") {
    state.auditFacts = {
      ...state.auditFacts,
      reasonCode: prepared.result.reason,
      policySteps: prepared.result.explanation.map((step) => step.code),
    };
    return {
      allow: false,
      reason: blockedReason(prepared.result.reason, prepared.result.category),
    };
  }
  signal.throwIfAborted();
  state.auditFacts = {
    ...state.auditFacts,
    policySteps: prepared.result.explanation.map((step) => step.code),
  };
  state.prepared = prepared;
  state.fingerprint = fingerprint(prepared);
  if (state.startSeen) this.start(state);
  return { allow: true };
}

function connectorCardDisplay(
  prepared: NonNullable<PreparedTool["connector"]>,
): ConnectorCardDisplay {
  return {
    id: prepared.connector.id,
    name: prepared.connector.name,
    tool: prepared.tool.tool,
    ...(prepared.tool.displayDescription ? { label: prepared.tool.displayDescription } : {}),
  };
}

/** First-login card title with the Bot's (redacted) display name. */
export function consentCardStep(this: LocalRunOperations, prepared: PreparedTool) {
  const { login, searchRecipient, result } = prepared;
  const describe = this.local.toolCards.get(prepared.call.tool);
  if (describe) {
    const context = this.context;
    const input = prepared.call.input;
    return {
      text: (language: "zh" | "en") =>
        describe(context, input, language, prepared.capabilityPolicyData),
    };
  }
  const skillBinding = prepared.commandSkill?.secretBindings;
  if (prepared.skillSecretUses?.length && skillBinding) {
    const name = this.local.deps.redactor.redact(skillBinding.name);
    const variables = prepared.skillSecretUses.map(({ variable }) => variable).join(", ");
    return {
      title: (language: "zh" | "en") =>
        skillBinding.consent[language]
          .replace("{name}", () => name)
          .replace("{variables}", () => variables),
    };
  }
  if (prepared.browserSecretUses?.length) {
    const sources = prepared.browserSecretUses
      .map((use) =>
        auditText(
          `${use.site} · ${use.kind} · ${use.name} → ${use.destination}`,
          this.local.deps.redactor,
        ),
      )
      .join("; ");
    return {
      title: (language: "zh" | "en") =>
        BrowserNetworkConsentText[language].use.replace("{sources}", sources),
    };
  }
  if (
    prepared.call.tool === "browser_secret" ||
    (prepared.call.tool === "browser_request" && result.reason === "browser_sensitive_confirmation")
  ) {
    const input = prepared.call.input;
    const site = this.local.deps.redactor.redact(String(input.origin ?? ""));
    const kind = auditText(
      String(input.kind ?? input.method ?? "request"),
      this.local.deps.redactor,
    );
    const name = auditText(String(input.name ?? ""), this.local.deps.redactor);
    return {
      title: (language: "zh" | "en") =>
        BrowserNetworkConsentText[language][
          prepared.call.tool === "browser_secret" ? "reveal" : "request"
        ]
          .replace("{site}", site)
          .replace("{kind}", kind)
          .replace("{name}", name),
    };
  }
  if (prepared.call.tool === "reveal_in_folder" && result.reason === REVEAL_CONFIRMATION_REASON) {
    const path = auditText(result.path?.path ?? "", this.local.deps.redactor);
    const platform = this.local.deps.platform;
    return {
      title: (language: "zh" | "en") => {
        const manager =
          language === "zh"
            ? platform === "darwin"
              ? "访达"
              : platform === "win32"
                ? "资源管理器"
                : "文件管理器"
            : platform === "darwin"
              ? "Finder"
              : platform === "win32"
                ? "File Explorer"
                : "the file manager";
        return language === "zh"
          ? `要在${manager}中打开 ${path} 吗？`
          : `Open ${path} in ${manager}?`;
      },
    };
  }
  if (login) return { login, title: (language: "zh" | "en") => this.loginTitle(login, language) };
  if (prepared.connector) return { connector: connectorCardDisplay(prepared.connector) };
  if (result.reason !== "search_provider_disclosure_required" || !searchRecipient) return;
  const provider = auditProviderName(searchRecipient) ?? searchRecipient;
  const recipient = `${provider} (${result.domain ?? ""})`;
  return {
    title: (language: "zh" | "en") =>
      language === "zh" ? `查询词会发送给 ${recipient}` : `Queries will be sent to ${recipient}`,
  };
}

export function loginTitleStep(
  this: LocalRunOperations,
  login: NonNullable<PreparedTool["login"]>,
  language: "zh" | "en",
) {
  const name = new BotsRepo(this.local.deps.db).get(this.context.botId)?.name ?? "Bot";
  return loginTitle(auditText(name, this.local.deps.redactor), login, language);
}
