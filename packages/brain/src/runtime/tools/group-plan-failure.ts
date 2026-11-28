import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import { GroupPlanInputError, GroupPlanStartFailureSchema, RpcError } from "@pibot/protocol-base";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

const reasons: Record<string, string> = {
  group_plan_verdict_repair_invalid:
    "结论修复计划不符合要求：保留旧步骤，每个不通过项追加原作者修复和原验证者复验；复验保留原验收合同，依赖修复步骤并引用其产物 / Invalid verdict repair: retain old steps and append one original-author repair plus original-verifier recheck per failed step, preserving recheck requirements and referencing the repair output",
  group_plan_method_inputs_invalid:
    "方法的资料输入不匹配，请核对输入名和位置，或将本次资料作为附件提交；输入不能冲突或超过上限 / Method inputs do not match; check the input name and location or attach the source files to this request, without conflicts or exceeding input limits",
  group_plan_method_input_empty: "方法输入为空 / The method input is empty",
  group_plan_method_input_unavailable:
    "方法输入不存在或不可读 / The method input is missing or unreadable",
  group_plan_method_unavailable:
    "步骤负责人的方法已不可用，请重新核对方法后提交计划 / The step owner's method is unavailable; check the method and submit the plan again",
  group_plan_workplace_revoked:
    "计划的目录权限已撤销，请使用当前目录发起新计划 / Plan folder access was revoked; start a new plan in the current folder",
  group_plan_workplace_unavailable:
    "工作目录不可用，请检查目录权限或重新关联文件夹 / Working folder unavailable; check its permissions or associate a folder again",
  workflow_group_folder_required:
    "工作目录不可用，请重新关联文件夹 / Working folder unavailable; associate a folder again",
  workflow_folder_unavailable:
    "产物目录不可用，请检查工作文件夹 / Artifact folder unavailable; check the working folder",
  workspace_boundary_changed:
    "工作目录已变化，请核对位置后再试 / Working folder changed; check its location before retrying",
  group_plan_workplace_changed:
    "计划确认期间工作位置已变化，请重新提交计划 / Working folder changed during confirmation; submit a new plan",
  group_plan_output_folder_changed:
    "产物目录已被占用，请重新提交计划 / Artifact folder is now occupied; submit a new plan",
  group_plan_budget_unavailable:
    "运行预算不可用，请检查预算或重新发起请求 / Run budget unavailable; check the budget or start a new request",
  group_plan_execute_required:
    "当前为计划模式，请切换到执行模式 / Switch from planning to execution mode",
  group_plan_engine_unavailable:
    "执行引擎暂不可用，请稍后重试 / Execution engine unavailable; retry later",
  group_plan_stale: "计划已过期，请重新发起请求 / Plan is stale; start a new request",
  group_plan_scope_invalid:
    "当前运行不能提交群计划，请回到群主对话 / This run cannot submit a group plan; return to the main group conversation",
  group_plan_already_started:
    "计划已经开始，请查看进度，不要重复分派 / The plan has started; check its progress instead of assigning again",
  group_plan_admission_unknown:
    "启动结果尚不能确认，请在原计划卡片上核对；不要重复提交或分派 / Admission is not confirmed; check the original plan card. Do not submit or dispatch another plan",
  group_plan_admission_invalid:
    "执行条件已变化，计划未能登记；请核对成员、周期、执行模式和原预算后重提 / Execution conditions changed; the plan was not admitted. Check members, cycle, execution mode and the original budget before resubmitting",
  group_plan_confirmation_required:
    "当前预算要求用户重新确认，请重新提交计划并等待卡片确认 / The current budget requires renewed user confirmation; resubmit and wait for the plan card confirmation",
  group_plan_relaxation_confirmation_required:
    "放宽验收必须由用户确认，请重新提交并等待卡片确认 / Relaxed checks require user confirmation; resubmit and wait for the plan card confirmation",
  group_plan_owners_changed:
    "计划负责人已变化，请按当前成员重新提交计划 / Plan owners changed; resubmit for the current members",
  group_plan_start_failed:
    "计划未能开始，请检查执行条件后重新提交；不要声称已经启动 / The plan did not start; check execution conditions and resubmit. Do not claim it has started",
  group_plan_start_cancelled:
    "计划启动已取消或超时，尚未登记执行 / Plan start was cancelled or timed out before admission",
  group_plan_busy:
    "群正在处理其他操作，请稍后核对计划状态 / The group is busy; check the plan status shortly",
};

function methodInputMessage(code: string, input: GroupPlanInputError["input"]) {
  if (
    input.required === undefined ||
    (code !== "group_plan_method_input_empty" && code !== "group_plan_method_input_unavailable")
  )
    return undefined;
  const label = JSON.stringify(input.name);
  const empty = code === "group_plan_method_input_empty";
  const statusZh = input.required ? "必填" : "可选";
  const statusEn = input.required ? "required" : "optional";
  const action = input.required
    ? {
        zh: "如果用户未提供此输入，请改用无需该输入的方法，从计划中移除此输入并重新提交。",
        en: "If the person did not supply it, choose a method that can run without it, remove the input from the plan, and resubmit.",
      }
    : {
        zh: "如果用户未提供此输入，请从计划中移除此输入并重新提交。",
        en: "If the person did not supply it, remove the input from the plan and resubmit.",
      };
  return {
    zh: `方法输入 ${label}（${statusZh}）${empty ? "为空" : "不存在或不可读"}。若用户已提供资料，请修正绑定后重新提交。${action.zh}`,
    en: `Method input ${label} (${statusEn}) is ${empty ? "empty" : "missing or unreadable"}. If the person supplied it, correct the binding and resubmit. ${action.en}`,
  };
}

/** Shared by tool feedback and the persisted card; unknown exception text is never exposed. */
export function groupPlanStartFailure(error: unknown, redact: (value: string) => string) {
  const reason =
    error instanceof RpcError
      ? error.message === "Group workplace unavailable"
        ? "group_plan_workplace_unavailable"
        : error.message
      : "";
  const code = Object.hasOwn(reasons, reason)
    ? reason
    : error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ? "group_plan_start_cancelled"
      : "group_plan_start_failed";
  const instruction = reasons[code] as string;
  const separator = instruction.indexOf(" / ");
  const detail = error instanceof GroupPlanInputError ? error.input : undefined;
  const input = detail && {
    ...detail,
    name: redact(detail.name).slice(0, 200),
    expected: redact(detail.expected).slice(0, 4096),
    found: detail.found.map((value) => redact(value).slice(0, 4096)),
  };
  return GroupPlanStartFailureSchema.parse({
    code,
    message: (input && methodInputMessage(code, input)) ?? {
      zh: instruction.slice(0, separator),
      en: instruction.slice(separator + 3),
    },
    ...(input ? { input } : {}),
  });
}

/** Exceptions describe system admission failures; invalid plan results keep their rewrite count. */
export function groupPlanFailure(
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
  error: unknown,
): LocalToolResult | undefined {
  if (call.tool !== "group_plan" || context.signal.aborted || !(error instanceof RpcError))
    return undefined;
  const reason =
    error.message === "Group workplace unavailable"
      ? "group_plan_workplace_unavailable"
      : error.message;
  const failure = groupPlanStartFailure(error, (value) => local.deps.redactor.redact(value));
  const known = Object.hasOwn(reasons, reason);
  const code = known
    ? reason
    : error.code === -32011
      ? "group_plan_busy"
      : "group_plan_unavailable";
  local.deps.logger.warn(
    JSON.stringify({
      module: "group-plan",
      event: "admission_blocked",
      botId: context.botId,
      runId: context.runId,
      rpcCode: error.code,
      reasonCode: code,
    }),
  );
  local.approvals.audit.append({
    botId: context.botId,
    runId: context.runId,
    kind: "execution.todo.changed",
    summary: "Group plan admission blocked / 群计划接纳受阻",
    detail: {
      groupId: context.groupId,
      toolCallId: call.id,
      reasonCode: "group_plan_system_failure",
      actor: "automatic",
    },
  });
  return {
    isError: true,
    text: JSON.stringify({
      code,
      instruction: known
        ? `${failure.message.zh} / ${failure.message.en}`
        : (reasons[code] ??
          "暂时无法确认计划状态；请先核对现有计划，不要反复改写或重复分派 / Cannot confirm plan status right now; check the existing plan before retrying. Do not repeatedly rewrite or duplicate assignments"),
      ...(failure.input ? { input: failure.input } : {}),
      ...(failure.input && code === "group_plan_method_inputs_invalid"
        ? {
            correction:
              "请按期望位置放入资料，或把这些资料作为本次请求的附件重新提交 / Put the inputs at the expected location, or attach them to this request and resubmit",
          }
        : {}),
      countsAsRewrite: false,
    }),
  };
}
