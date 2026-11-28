import { type LocalToolResult, toolErrorLog } from "@pibot/agent";
import {
  ExecError,
  isProxyAuthenticationFailure,
  isProxyUnavailable,
  ProxyCredentialsError,
} from "@pibot/execution";
import { SemanticError } from "@pibot/execution/semantic";
import {
  type AuditDetail,
  RpcError,
  RpcErrorCodes,
  RunnerExecutionErrorSchema,
  runnerExecutionCheck,
} from "@pibot/protocol-base";
import { collaborationRefusal } from "../../core/assignment-refusal.ts";
import { GroupToolError } from "../../core/collaboration-tool-error.ts";
import type { PreparedTool } from "../../core/local-types.ts";
import { SearchRunError } from "../../integrations/search/search-run.ts";
import { ReviewCaptureError } from "../review/review-capture.ts";
import { ConnectorSchemaError } from "./connectors/connector-schema.ts";
import { ConnectorToolError, connectorError } from "./connectors/connector-tools.ts";
import { groupPlanFailure } from "./group-plan-failure.ts";
import type { LocalRun } from "./local-run.ts";
import { runnerFailure } from "./target-tools.ts";
import { readableError, semanticErrorText } from "./tool-error-text.ts";
import type { parseTool } from "./tools.ts";

/**
 * The failure half of a tool call: which message the model sees, which audit records are written
 * and how the failure is logged. Kept apart from the dispatch itself so the dispatch reads as the
 * list of tools and this file as the list of reasons a call can fail.
 */
export function toolFailure(
  run: LocalRun,
  prepared: PreparedTool,
  input: ReturnType<typeof parseTool>,
  error: unknown,
  signal: AbortSignal,
  started: number,
  auditFields: AuditDetail,
): LocalToolResult {
  const { local, context } = run;
  const planFailure = groupPlanFailure(local, context, prepared.call, error);
  if (planFailure) return planFailure;
  if (input.tool === "run_command") run.clearCommandChecks();
  if (error instanceof RpcError && error.code === RpcErrorCodes.draftDenied)
    return {
      isError: true,
      text:
        error.message === "send_permission_denied"
          ? "未发送：设置 › 权限 › 对外发送为不允许（也请核对当前 Bot / 群的权限）。请告诉用户在该处修改，不要猜测板名、路径或系统权限。 / Not sent: Settings > Permissions > Send out is set to Never (also check this Bot/group's permissions). Tell the user where to change it; do not blame the destination, paths or OS permissions."
          : "未发送：当前连接或发送授权不允许此操作。请在 设置 › 权限，以及左侧栏「连接」里点开该连接，核对权限与确认方式。 / Not sent: current connection or sending authorization does not allow this action. Check Settings > Permissions, and the connection's access and confirmation in the sidebar's Connections page.",
    };
  if (error instanceof ConnectorToolError)
    return connectorError(error.code, error.serviceMessage, error.blockedNetworkMessage);
  if (error instanceof ConnectorSchemaError) return connectorError(error.code);
  const authenticationFailed =
    isProxyAuthenticationFailure(error) ||
    (error instanceof ExecError && error.reason === "proxy_auth_failed");
  const credentialFailed =
    error instanceof ProxyCredentialsError ||
    (error instanceof ExecError && error.reason === "proxy_credentials_unavailable");
  const proxyFailed =
    isProxyUnavailable(error) ||
    (error instanceof ExecError && error.reason === "proxy_unavailable");
  const address = proxyFailed
    ? new URL(local.deps.proxy?.()?.url ?? "http://proxy.invalid").origin
    : "";
  // Unmapped finish_task guidance (e.g. pending subtasks, the open-task list) is authored text, as
  // at the authorization gate; the generic "check the path" made members give up.
  const assignment =
    collaborationRefusal(input.tool, error) ??
    (input.tool === "finish_task" && error instanceof GroupToolError
      ? local.deps.redactor.redact(error.message)
      : undefined);
  // A runner failure names whether it is offline, revoked or dropped, not the path.
  const runnerFailed = runnerFailure(error);
  const message = signal.aborted
    ? "已停止 / Stopped"
    : runnerFailed
      ? runnerFailed.text
      : assignment
        ? assignment
        : input.tool === "review_start" && error instanceof ReviewCaptureError
          ? error.text(context.language)
          : authenticationFailed
            ? context.language === "zh"
              ? "代理账号或密码未通过验证，请在网络代理设置中更新账号"
              : "The proxy rejected your account or password. Update the account in Network proxy settings."
            : credentialFailed
              ? context.language === "zh"
                ? "代理账号暂时无法解密，请解锁系统密钥库或移除代理账号"
                : "Proxy credentials could not be decrypted. Unlock the system key store or remove the saved account."
              : proxyFailed
                ? context.language === "zh"
                  ? `连不上你设置的代理（${address}），请检查代理软件是否在运行`
                  : `Cannot connect to your proxy (${address}); check that your proxy software is running.`
                : error instanceof SearchRunError
                  ? error.text(context.language)
                  : error instanceof SemanticError
                    ? semanticErrorText(error.code, context.language)
                    : input.tool === "send_file" && error instanceof RpcError
                      ? error.message === "attachment_too_large"
                        ? "文件太大：图片最多10 MiB，文件最多20 MiB / Too large: images up to 10 MiB, files up to 20 MiB"
                        : error.message === "attachments_already_sent"
                          ? "本条回复最多发送5个文件 / Send up to five files per reply"
                          : error.code === -32019
                            ? "此主机不支持图片转换 / Image conversion is unsupported on this host"
                            : "附件格式或图片转换无效 / Invalid attachment or image conversion"
                      : error instanceof ExecError
                        ? readableError(error, input.tool, run.platform)
                        : "工具执行失败，请检查路径、权限或文件格式 / Tool execution failed; check the path, permissions, or file format";
  // Some runner errors retain their RPC control code (busy, unsupported, dispatchDenied).
  const remoteCheck =
    error instanceof RpcError ? RunnerExecutionErrorSchema.safeParse(error.data) : undefined;
  const check = signal.aborted
    ? undefined
    : error instanceof ExecError
      ? error.check
      : remoteCheck?.success
        ? runnerExecutionCheck(remoteCheck.data)
        : undefined;
  if (input.tool === "run_command" || check)
    run.auditCommand(
      "finished",
      input.tool === "run_command" ? message : "Tool execution check failed / 工具执行检查失败",
      {
        ...auditFields,
        toolCallId: prepared.call.id,
        durationMs: Math.round(performance.now() - started),
        stopped: signal.aborted,
        ...(check
          ? {
              reasonCode: check,
              policySteps: [...new Set([...(auditFields.policySteps ?? []), check])],
            }
          : {}),
      },
    );
  if (input.tool === "read_messages")
    local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "messages.read",
      summary: "Chat query stopped or failed / 聊天查询停止或失败",
      detail: {
        ...auditFields,
        messageCount: 0,
        conversationCount: 0,
        reasonCode: signal.aborted ? "stopped" : "failed",
      },
    });
  if (input.tool === "review_start" && error instanceof ReviewCaptureError)
    local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "exec.finished",
      summary: "Independent review did not start / 独立审查未启动",
      detail: {
        ...auditFields,
        toolCallId: prepared.call.id,
        reasonCode: error.message,
        durationMs: Math.round(performance.now() - started),
      },
    });
  // The generic text is all the model got for the first commands of a Windows
  // runner session, and the log line named neither the error nor its code — a later occurrence
  // could not be traced to a layer. Same redacted identifiers as the gate's own log.
  const errorCode = signal.aborted
    ? "cancelled"
    : runnerFailed
      ? runnerFailed.code
      : error instanceof SemanticError
        ? error.code
        : error instanceof ExecError
          ? error.code
          : "tool_failed";
  local.deps.logger.warn(
    JSON.stringify({
      module: "tool-execute",
      botId: context.botId,
      runId: context.runId,
      ...toolErrorLog("tool_execution_failed", prepared.call, error),
      errorCode,
      ...(check ? { check } : {}),
    }),
  );
  return {
    text: message,
    ...(input.tool === "web_search" ? { summary: `web_search: ${message}` } : {}),
    isError: true,
    details: {
      durationMs: Math.round(performance.now() - started),
      errorCode,
      ...(check ? { executionCheck: check } : {}),
    },
  };
}
