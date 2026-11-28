import { flattenInputIssues, inputIssueFacts } from "@pibot/brain/orchestration-kit";
import {
  type Bot,
  GROUP_PLAN_MAX_CHARS,
  type GroupPlan,
  GroupPlanSchema,
} from "@pibot/protocol-base";
import type { z } from "zod";
import { planFieldHint } from "./group-plan-error-hints.ts";
import { repairGroupPlan } from "./group-plan-repairs.ts";
import { verdictOwnerIssues } from "./group-plan-verdict-owner.ts";

export interface PlanIssue {
  code: string;
  path: (string | number)[];
  /** Schema type, bounds, a legal example of this very field, never the received value. */
  expected?: string;
  /** One sentence saying what to change, so a coordinator does not retry the same shape. */
  message?: string;
  kind?: string;
}

/**
 * Deterministic repairs run first (see `group-plan-repairs.ts`), then the schema decides.
 * A remaining schema error is reported alone, with words and one example: the model used to get a
 * list of "expected: custom" and gave up after three submissions.
 */
export function validateGroupPlan(
  value: unknown,
  members: readonly Bot[],
  /** Whether an agent member can take a step here; absent (re-checks) means it can. */
  agentReady?: (botId: string) => "ok" | "unconfirmed" | "unavailable",
  implementationAuthorBotId?: string | readonly string[],
):
  | {
      ok: true;
      plan: GroupPlan;
      owners: { stepId: string; botId: string }[];
      corrections: string[];
      droppedDependencies: number;
    }
  | { ok: false; issues: PlanIssue[] } {
  const repaired = repairGroupPlan(value);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(repaired.value);
  } catch {
    /* Non-JSON values fail closed below. */
  }
  if (!serialized || serialized.length > GROUP_PLAN_MAX_CHARS)
    return { ok: false, issues: [{ code: "plan_size_invalid", path: [] }] };
  const parsed = GroupPlanSchema.safeParse(repaired.value);
  if (!parsed.success) {
    const [first] = flattenInputIssues(parsed.error.issues);
    return {
      ok: false,
      issues: first
        ? [describeIssue(first, repaired.value)]
        : [{ code: "plan_schema_invalid", path: [] }],
    };
  }
  const issues: PlanIssue[] = [];
  const owners: { stepId: string; botId: string }[] = [];
  parsed.data.steps.forEach((step, index) => {
    const owner = step.owner;
    const candidates = members.filter(
      (bot) =>
        !bot.archivedAt &&
        ("botId" in owner ? bot.id === owner.botId : bot.role?.id === owner.role),
    );
    const bot = candidates.length === 1 ? candidates[0] : undefined;
    if (!bot)
      issues.push({
        code: candidates.length > 1 ? "plan_owner_ambiguous" : "plan_owner_unavailable",
        path: ["steps", index, "owner"],
        expected: '{"botId": "<本群成员 id>"}',
        message:
          candidates.length > 1
            ? `第 ${index + 1} 步的 owner 对应多个成员：改成 {"botId":"<成员 id>"} / ${`step ${index + 1}`} owner matches several members: use {"botId":"<member id>"}`
            : `第 ${index + 1} 步的 owner 不是本群成员：从群成员 id 里选一个 / ${`step ${index + 1}`} owner is not a member of this group: use a member id`,
      });
    else if (bot.category === "image")
      // An image member bills per generation and writes no file its acceptance checks can
      // read, so a step owned by it can never pass the plan; the coordinator asks it per picture
      // outside the plan instead of registering it here.
      issues.push({
        code: "plan_image_member_step",
        path: ["steps", index, "owner"],
        expected: '{"botId": "<本群非图像成员 id>"}',
        message: `第 ${index + 1} 步的负责人是图像成员：「图像成员不作为计划步骤；需要配图时在计划外单独请求它出图」 / ${`step ${index + 1}`} owner is an image member: "Image members never take plan steps; ask one for a picture separately, outside the plan"`,
      });
    else if (bot.kind === "agent" && agentReady && agentReady(bot.id) !== "ok")
      // An agent Bot takes plan steps through its own ACP session (maintainers 2026-11-14), but
      // not one that cannot start here (Windows before the user confirmed it, no isolation).
      issues.push({
        code: "plan_agent_member_step",
        path: ["steps", index, "owner"],
        expected: '{"botId": "<本群可用成员 id>"}',
        message: `第 ${index + 1} 步的负责人是现在不能运行的外部 Agent（Windows 上需要用户先确认，或这台电脑不能隔离运行它）：交给其他成员 / ${`step ${index + 1}`} owner is an external agent that cannot run here yet (on Windows the user must confirm it first, or it cannot be isolated on this computer): give it to another member`,
      });
    else if (bot.kind === "agent" && "method" in step && step.method)
      // Pi Bot skill workflows run inside Pi Bot's model loop, which an external agent does not use.
      issues.push({
        code: "plan_agent_member_method",
        path: ["steps", index, "method"],
        expected: "no method for an external agent's step",
        message: `第 ${index + 1} 步交给外部 Agent 时不能指定方法（Pi Bot 技能工作流只在 Pi Bot 的模型里运行）：去掉 method / ${`step ${index + 1}`} is owned by an external agent, which cannot run a Pi Bot skill method: drop the method`,
      });
    else owners.push({ stepId: step.id, botId: bot.id });
  });
  if (!issues.length)
    issues.push(...verdictOwnerIssues(parsed.data, members, owners, implementationAuthorBotId));
  // Shape: one issue only, with an example, so the coordinator corrects instead of guessing.
  return issues.length
    ? { ok: false, issues: issues.slice(0, 1) }
    : {
        ok: true,
        plan: parsed.data,
        owners,
        corrections: repaired.notes,
        droppedDependencies: repaired.droppedDependencies,
      };
}

function describeIssue(issue: z.core.$ZodIssue, input: unknown): PlanIssue {
  const hint = planFieldHint(issue, input);
  return {
    code:
      issue.code === "custom" && /^plan_[a-z_]+$/.test(issue.message)
        ? issue.message
        : "plan_schema_invalid",
    ...inputIssueFacts(issue),
    ...(hint ? { message: hint.message, expected: hint.example } : {}),
  };
}

/** Appended after the existing fixed text so its cacheable prefix stays byte-identical. */
export const GROUP_SHARED_WORK_INSTRUCTION =
  "所有多成员群的成果工作都按专长分工，不由统筹全做；上文可直接做只指只读查询和简单对话。交付后自动推进，由非作者核对来源、数字、准确性、完整性并给结论；不通过交原作者修复和同人复验。 / For artifact work in every multi-member group, distribute work by expertise rather than doing it all as coordinator. Direct work above means read-only queries and simple conversation. Advance automatically, require a non-author verdict checking sources, numbers, accuracy and completeness, and return failures to the author and the same verifier. 重规划只需交新增或未完成步骤，程序从存档保留已完成/跳过步骤，可引用其 id。 / Replans need only new or unfinished steps; the program retains archived completed/skipped steps, whose ids remain valid dependencies.";

/** Built-in methods are references only; normal skill and tool permissions still apply. */
// Detailed scenario guidance belongs in skills: the fixed profile has a small byte budget.
export const GROUP_PLAN_COMPACT_INSTRUCTION =
  "If the user asks to review/confirm first, or you promise to wait, set requiresConfirmation:true; never execute before their Start. Before multi-member group work submit group_plan with current owners, direct dependencies, outputs and program checks. method imports the owner's deliverables/checks; paths are relative to the step output folder. Program validation reports independent format attempts remaining (six initially); accepted plans allow two rewrites. At a limit wait for the user's program card: extend permits planning only; only solo permits coordinator execution. pending waits for Start/Modify; started means registered, never completed. Only the engine dispatches an admitted plan, never bypass via assign_task/ask_bot. Coordinator tool work does not complete plan steps. Replan with new or unfinished steps only; the program keeps passed steps, so do not resubmit them. Relaxed checks need explicit user confirmation, never YOLO. Declared human checks are confirmed together by the user at plan end, never by the coordinator. All permissions and original budgets remain. / 多人协作先提交计划；上限等用户卡片，延长只能重提计划，自行完成须明确选择；程序派活，重规划只交新的或未完成的步骤（已完成的由程序保留）；人工项在末尾统一由用户核对，不越权或重置预算。" +
  "\n" +
  GROUP_SHARED_WORK_INSTRUCTION;
/**
 * An image member bills for every generation and cannot verify or report on deliverables, so the
 * coordinator asks it per picture instead of giving it a plan step. Only groups that have
 * an image member get this line, so other groups' planning instructions stay unchanged.
 */
export const GROUP_IMAGE_ON_DEMAND_INSTRUCTION =
  "Request images through ask_bot once a deliverable needs them, using imageGeneration for a batch or model comparison. Never give image members plan steps or count images as step outputs. / 确有配图需求时用 ask_bot 交办，批量出图或模型对比用 imageGeneration。不要给图片成员计划步骤，也不要把图片算作步骤产出。";
export const GROUP_IMAGE_ON_DEMAND_COMPACT =
  "图片按需请求，不写作计划步骤。 / Images on demand, never plan steps.";
/** One member's usable method keys, named the way the group prompt already names it. */
export interface GroupPlanMethodOwner {
  /** Bot name, the fallback label when the Bot was not created from a built-in role. */
  name: string;
  /** Role mark; the program validates a method against this owner, so it leads the label. */
  roleId?: string;
  keys: readonly string[];
}

/**
 * The hint lists the keys the group's members have right now, not every key their roles
 * might ship. A removed member, a group-local skill store or a disabled skill therefore never leaves
 * the prompt naming a method nobody can run; the program still validates each key against its owner.
 */
export function groupPlanInstruction(owners: readonly GroupPlanMethodOwner[]): string {
  const listed = owners.map((owner) => {
    const label = owner.roleId ?? owner.name;
    return `${owner.keys.join(", ")} (${label})`;
  });
  return [
    "For multi-member group requests submit group_plan before assigning work; work you can finish alone, including several steps you do yourself, may be done directly without a plan. Do not implement plan steps outside their assigned runs; actual coordinator tool work is recorded separately and does not complete the plan. It takes {plan:{name,estimatedCostUsd,requiresConfirmation?,steps:[{id,title,owner:{botId}|{role},task,method?,dependsOn,inputs:[{stepId,deliverableId}],deliverables:[{id,path,kind,sections?}],acceptance:[{id,check,deliverable?,text?}],maxFixRounds}]}}.",
    "Use at most 20 steps, current member UUIDs or uniquely mapped role ids, no cycles. inputs reference direct dependencies' deliverables. Every output needs a program check: exists, sections, citations, minCitations (only it has min:1..200), sectionsSourced, tableColumns (only it has columns:1..20 names), hasChart, fileNaming (any kind), gbt7714 (md/docx only), verdict (md only; standalone Verdict: PASS/FAIL); manual is supplementary. sectionsSourced requires sections and md/docx; minCitations requires md/docx; tableColumns requires md/xlsx; hasChart requires md/docx/xlsx. Cite only fetched URLs, input files or passed upstream outputs from this run. Estimate cost honestly; estimates do not raise budgets.",
    `Built-in method keys: ${listed.length ? listed.join(", ") : "none"}. Use keys without role prefixes / 方法键不带角色前缀. The user never picks one; you choose. Set method to the owner's method key (or own skill name) and the program adds its deliverables and acceptance to the step (deliverables/acceptance may then be omitted; initial plans only tighten same ids: extra sections, higher min, more columns; on plan_output_collision give that deliverable id a distinct path). Read installed skills through normal authorized paths; methods grant no permissions. For PDF batches list sources first, assign <=20 papers per step, split larger collections and retain partial-read coverage in each card.`,
    "When the program requests replanning, keep every passed step exactly unchanged, including its id, owner, dependencies and deliverables. Never replay completed side effects. Revise unfinished steps only, then submit group_plan again. On replanning you may remove a method or explicitly relax checks, but the program lists the changes and requires the user to choose Start anyway; YOLO and automatic starts cannot confirm them. Complex replacements also need a new confirmation. The whole run permits at most two replans and retains its original limits.",
    "On validation errors correct only from the fixed issue codes/paths and use the independent format-correction allowance reported by the program. At the limit, explain the block and wait for the user card; never execute the work yourself. pending means wait for the user's Start / Modify card. started means registered, not completed. Do not call assign_task to bypass pending/rejected plans. If the engine is unavailable, explain the block and stop.",
    "群里的多成员任务先调用 group_plan 提交结构化计划；步骤可用 method 引用负责人的方法，程序自动带上它的交付物与验收；验收、依赖和负责人由程序校验，格式修正使用程序反馈的独立剩余次数。达到上限后只说明阻塞并等待用户卡片选择，不得自行执行。显式人工核对项在计划末尾统一请用户确认，不可自行声称已确认。复杂计划必须等用户点开始 / 修改。不要在步骤运行之外自行代做；统筹主话题工具事实不会让计划变成已完成。模板和计划都不授予权限；不要绕过卡片自行分派。",
    // "before assigning work" let the coordinator do a multi-step request itself and never
    // plan (dev-lite / dev-squad / research-group runs recorded no plan). Fixed text appended after
    // the existing instructions, so the stable prefix above stays byte-identical for prompt caching.
    "群里由你统筹时，只要需要别的成员参与，第一步就先提交 group_plan；一个人自己能做完的事（包括自己连着做几步）可以直接做，不必建计划，拿不准按需要计划处理。 / When you coordinate a group, submit group_plan first whenever another member is involved; work one person can finish alone, including several steps you do yourself, is done directly without a plan, and when in doubt plan.",
    // Coordinators read the engine's parallelism and still chain steps; a dependency is a
    // real input relation, not a habit of listing the previous step.
    "步骤之间只写真实的输入关系：下一步用不到上一步的交付物就不要写 dependsOn（除审查 / 测试 / 汇总类步骤），否则它们本来可以同时进行。程序会自动去掉这类不需要的依赖。 / Declare only real input relations: unless the step is a review, test or summary, do not add dependsOn for a step it never reads from — those steps can run in parallel. The program removes such unnecessary dependencies itself.",
    GROUP_SHARED_WORK_INSTRUCTION,
  ].join("\n");
}

/** No skills port (or a group with no methods): the same instruction without invented keys. */
export const GROUP_PLAN_INSTRUCTION = groupPlanInstruction([]);
